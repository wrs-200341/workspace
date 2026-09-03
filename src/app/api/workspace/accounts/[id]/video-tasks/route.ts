import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount, workspaceOwnerIdForUser } from '@/lib/workspace/access';
import { getServerWorkspaceTasks } from '@/lib/workspace/serverTasks';
import { businessDate } from '@/lib/workspace/tasks';
import { createProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { getProviderConfig, isProviderLiveEnabled, type ProviderId } from '@/lib/providers/config';
import { normalizeProviderResponse, submitVideo, syncProviderTask } from '@/lib/providers/client';
import { validateGenerationRequest } from '@/lib/providers/validation';
import { publishAssetReference } from '@/lib/workspace/referenceBridge';
import { processMockProviderTask } from '@/lib/providers/taskProcessor';
import { getDefaultProductionAspectRatio, getDefaultVideoResolution } from '@/lib/workspace/production/defaults';
import { firstReferenceImageName } from '@/lib/workspace/taskMetadata';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const date = request.nextUrl.searchParams.get('date');
  const ownerScope = request.nextUrl.searchParams.get('scope') === 'owner';
  const ownerId = ownerScope ? workspaceOwnerIdForUser(auth) ?? workspaceOwnerIdForAccount(id) : undefined;
  if (ownerScope && !ownerId) return NextResponse.json({ success: false, error: 'workspace_account_not_found' }, { status: 404 });
  const tasks = getServerWorkspaceTasks(ownerScope ? { ownerId, mode: 'video' } : { accountId: id, mode: 'video' }).filter((task) => !date || businessDate(task.createdAt) === date);
  await syncLiveVideoTasks(tasks);
  const refreshed = getServerWorkspaceTasks(ownerScope ? { ownerId, mode: 'video' } : { accountId: id, mode: 'video' }).filter((task) => !date || businessDate(task.createdAt) === date);
  return NextResponse.json({ success: true, data: refreshed, tasks: refreshed });
}

async function syncLiveVideoTasks(tasks: ReturnType<typeof getServerWorkspaceTasks>): Promise<void> {
  const active = tasks.filter((task) => task.provider && task.providerTaskId && ['submitting', 'queued', 'submitted', 'processing', 'running'].includes(task.status) && isProviderLiveEnabled(task.provider as ProviderId));
  await Promise.all(active.map(async (task) => {
    try {
      const status = await syncProviderTask(task.provider as ProviderId, task.providerTaskId!);
      updateProviderTask(task.id, { status: status.status === 'unknown' ? task.status : status.status, progress: status.progress, providerTaskId: status.providerTaskId ?? task.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64, error: status.error });
    } catch {
      // Keep the last known local state on transient status failures.
    }
  }));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { prompt?: unknown; provider?: unknown; model?: unknown; duration?: unknown; seconds?: unknown; aspectRatio?: unknown; resolution?: unknown; referenceImages?: unknown; referenceAudios?: unknown; assetIds?: unknown; pid?: unknown };
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return NextResponse.json({ success: false, error: 'prompt_required' }, { status: 400 });
  const requestedProvider: ProviderId = body.provider === 'mgrouter-grok-video' || body.provider === 'wan3-video' || body.provider === 'oairegbox-omni' || body.provider === 'minimax-h3' || body.provider === 'quality-v4' ? body.provider : 'grok-video';
  const rawReferenceImages = Array.isArray(body.referenceImages) && body.referenceImages.every((item) => typeof item === 'string') ? body.referenceImages as string[] : [];
  const referenceAudios = Array.isArray(body.referenceAudios) && body.referenceAudios.every((item) => typeof item === 'string') ? body.referenceAudios as string[] : [];
  const assetIds = Array.isArray(body.assetIds) && body.assetIds.every((item) => typeof item === 'string') ? body.assetIds as string[] : [];
  const rawDuration = typeof body.duration === 'number' && Number.isFinite(body.duration)
    ? body.duration
    : typeof body.seconds === 'number' && Number.isFinite(body.seconds)
      ? body.seconds
      : undefined;
  const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
  const provider: ProviderId = requestedProvider === 'grok-video' && requestedModel?.toLowerCase() === 'sd-mini' ? 'quality-v4' : requestedProvider;
  const config = getProviderConfig(provider);
  const model = provider === 'quality-v4' && requestedModel?.toLowerCase() === 'sd-mini' ? config.model : provider === 'grok-video' && requestedModel === 'grok' ? config.model : requestedModel ?? config.model;
  const isSdMini = provider === 'grok-video' && model.toLowerCase() === 'sd-mini';
  const duration = rawDuration !== undefined ? Math.round(rawDuration) : (isSdMini ? undefined : config.supports.durations?.[0] ?? 10);
  const aspectRatio = typeof body.aspectRatio === 'string' && body.aspectRatio.trim()
    ? body.aspectRatio.trim()
    : getDefaultProductionAspectRatio(config.supports.ratios);
  const resolution = typeof body.resolution === 'string' && body.resolution.trim()
    ? body.resolution.trim()
    : getDefaultVideoResolution(config.supports.resolutions);
  try {
    const ownerId = workspaceOwnerIdForAccount(id);
    const referenceImageName = firstReferenceImageName({ accountId: id, assetIds, rawReferenceImages });
    const publishedReferences = isProviderLiveEnabled(provider)
      ? assetIds.map((assetId) => publishAssetReference({ accountId: id, assetId, allowedKinds: ['image'] }))
      : [];
    const referenceImages = [...rawReferenceImages, ...publishedReferences.map((item) => item.url)];
    const normalized = validateGenerationRequest({ provider, model, duration, aspectRatio, resolution, referenceImages, referenceAudios });
    const result = await submitVideo({ provider, model, prompt: body.prompt, duration: normalized.duration!, aspectRatio: normalized.aspectRatio!, resolution: normalized.resolution!, referenceImages, referenceAudios, media: [...referenceImages.map((url) => ({ type: 'reference_image' as const, url })), ...referenceAudios.map((url) => ({ type: 'audio' as const, url }))] });
    const status = normalizeProviderResponse(provider, result.response);
    const task = createProviderTask({ accountId: id, mode: 'video', provider, model, prompt: body.prompt, status: status.status === 'unknown' ? 'queued' : status.status, progress: status.progress, providerTaskId: status.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64, error: status.error, metadata: { ...(ownerId ? { ownerId } : {}), ...(referenceImageName ? { referenceImageName } : {}), sequence: 1, execution: result.mode, ...(assetIds.length ? { assetIds, referenceTokens: publishedReferences.map((item) => item.token) } : {}), ...(typeof body.pid === 'string' && body.pid.trim() ? { pid: body.pid.trim() } : {}) } });
    if (result.mode === 'mock') void processMockProviderTask(task.id);
    return NextResponse.json({ success: true, data: task }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const known = ['provider_not_configured', 'provider_unauthorized', 'provider_model_unavailable', 'provider_upstream_failed', 'provider_invalid_request', 'reference_public_base_invalid', 'reference_asset_not_found', 'reference_asset_kind_invalid', 'reference_asset_path_invalid', 'reference_asset_file_invalid', 'reference_images_must_be_https', 'reference_videos_must_be_https', 'reference_audios_must_be_https', 'too_many_reference_images', 'too_many_reference_videos', 'too_many_reference_audios', 'unsupported_duration', 'unsupported_aspect_ratio', 'unsupported_resolution', 'duration_required', 'sdmini_reference_media_unsupported', 'sdmini_model_invalid', 'sdmini_prompt_required', 'sdmini_invalid_seconds', 'sdmini_invalid_resolution', 'sdmini_720p_requires_10s', 'sdmini_invalid_aspect_ratio', 'sdmini_too_many_reference_images', 'sdmini_reference_images_must_be_http', 'qualityv4_prompt_required', 'qualityv4_invalid_duration', 'qualityv4_invalid_resolution', 'qualityv4_720p_requires_10s', 'qualityv4_invalid_size', 'qualityv4_too_many_reference_images', 'qualityv4_too_many_reference_videos', 'qualityv4_too_many_reference_audios'];
    return NextResponse.json({ success: false, error: known.includes(message) ? message : 'provider_request_failed' }, { status: 400 });
  }
}
