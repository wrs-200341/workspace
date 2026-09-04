import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount, workspaceOwnerIdForUser } from '@/lib/workspace/access';
import { getServerWorkspaceTasks } from '@/lib/workspace/serverTasks';
import { businessDate } from '@/lib/workspace/tasks';
import { createProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { getProviderConfig, isProviderLiveEnabled, type ProviderId } from '@/lib/providers/config';
import { normalizeProviderResponse, providerResponseSnapshot, sanitizeProviderError, submitVideo, syncProviderTask } from '@/lib/providers/client';
import { validateGenerationRequest } from '@/lib/providers/validation';
import { publishAssetReference } from '@/lib/workspace/referenceBridge';
import { processMockProviderTask } from '@/lib/providers/taskProcessor';
import { getDefaultProductionAspectRatio, getDefaultVideoResolution } from '@/lib/workspace/production/defaults';
import { firstReferenceImageName } from '@/lib/workspace/taskMetadata';
import { pumpProviderTasks, retryProviderTaskOnFailure } from '@/lib/providers/concurrency';
import { cacheVideoTaskOutputsBeforeCompletion } from '@/lib/workspace/videoInventory';

const SYNC_THROTTLE_MS = 10_000;
const liveSyncInFlight = new Map<string, Promise<void>>();
const liveSyncLastStartedAt = new Map<string, number>();
let liveSyncRunning = false;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const date = request.nextUrl.searchParams.get('date');
  const ownerScope = request.nextUrl.searchParams.get('scope') === 'owner';
  const requestedOwnerId = request.nextUrl.searchParams.get('ownerId')?.trim() || undefined;
  const ownerId = ownerScope
    ? auth.role === 'operator' && requestedOwnerId ? requestedOwnerId : workspaceOwnerIdForUser(auth) ?? workspaceOwnerIdForAccount(id)
    : undefined;
  if (ownerScope && !ownerId) return NextResponse.json({ success: false, error: 'workspace_account_not_found' }, { status: 404 });
  const tasks = getServerWorkspaceTasks(ownerScope ? { ownerId, mode: 'video' } : { accountId: id, mode: 'video' }).filter((task) => !date || businessDate(task.createdAt) === date);
  // Queue reads must stay fast. Provider synchronization is explicitly
  // opt-in and runs in the background so an upstream provider cannot block
  // the local queue response.
  if (request.nextUrl.searchParams.get('sync') === '1') void syncLiveVideoTasks(tasks);
  const queueTasks = tasks.map(toQueueTask);
  return NextResponse.json({ success: true, data: queueTasks, tasks: queueTasks });
}

function toQueueTask<T extends Record<string, unknown>>(task: T) {
  const { outputUrls: _outputUrls, outputBase64: _outputBase64, metadata: _metadata, providerResponse: _providerResponse, ...summary } = task;
  return summary;
}

function syncLiveVideoTasks(tasks: ReturnType<typeof getServerWorkspaceTasks>): Promise<void> {
  if (liveSyncRunning) return Promise.resolve();
  liveSyncRunning = true;
  const run = runLiveVideoTasks(tasks).finally(() => { liveSyncRunning = false; });
  return run.catch(() => undefined);
}

async function runLiveVideoTasks(tasks: ReturnType<typeof getServerWorkspaceTasks>): Promise<void> {
  const active = tasks.filter((task) => {
    if (!task.provider || !task.providerTaskId || !isProviderLiveEnabled(task.provider as ProviderId)) return false;
    const processing = ['submitting', 'queued', 'submitted', 'processing', 'running'].includes(task.status);
    const legacyGenericError = task.error === 'provider request failed' || task.error === 'provider_request_failed';
    return processing || (task.status === 'failed' && legacyGenericError);
  });
  // A manual refresh should make progress on the visible queue without
  // opening an upstream request for every historical task at once.
  for (const task of active.slice(0, 4)) {
    const key = `${task.provider}:${task.providerTaskId}`;
    const now = Date.now();
    if (liveSyncInFlight.has(key) || now - (liveSyncLastStartedAt.get(key) ?? 0) < SYNC_THROTTLE_MS) continue;
    liveSyncLastStartedAt.set(key, now);
    const run = (async () => {
      try {
        const status = await syncProviderTask(task.provider as ProviderId, task.providerTaskId!);
        const normalizedStatus = status.status === 'unknown' ? task.status : status.status;
        const cacheTask = task.provider && task.updatedAt
          ? { ...task, provider: task.provider as ProviderId, mode: 'video' as const, status: 'completed' as const, progress: 100, updatedAt: task.updatedAt, providerTaskId: status.providerTaskId ?? task.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64 }
          : null;
        const cache = normalizedStatus === 'completed' && cacheTask ? await cacheVideoTaskOutputsBeforeCompletion(task.accountId, cacheTask) : null;
        const cachePending = normalizedStatus === 'completed' && cache && !cache.ready;
        const updated = updateProviderTask(task.id, { status: cachePending ? 'processing' : normalizedStatus, progress: cachePending ? 99 : status.progress, providerTaskId: status.providerTaskId ?? task.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64, error: status.error, providerResponse: status.status === 'failed' ? providerResponseSnapshot(new Error(status.error ?? 'provider_upstream_failed'), { body: status.response, method: 'GET' }) : undefined, metadata: { ...(task.metadata ?? {}), ...(cache ? { localOutputCount: cache.cached, localOutputExpected: cache.expected, localOutputReady: cache.ready } : {}) } });
        if (updated?.status === 'failed') retryProviderTaskOnFailure(task.id);
        pumpProviderTasks(typeof task.metadata?.ownerId === 'string' ? task.metadata.ownerId : task.accountId, 'video');
      } catch (error) {
        const providerResponse = providerResponseSnapshot(error);
        const statusCode = typeof providerResponse.status === 'number' ? providerResponse.status : 0;
        const terminal = statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
        const updated = updateProviderTask(task.id, {
          status: terminal ? 'failed' : task.status,
          progress: terminal ? 100 : task.progress,
          error: sanitizeProviderError(error instanceof Error ? error.message : 'provider_request_failed'),
          providerResponse,
        });
        if (updated?.status === 'failed') retryProviderTaskOnFailure(task.id);
        pumpProviderTasks(typeof task.metadata?.ownerId === 'string' ? task.metadata.ownerId : task.accountId, 'video');
      }
    })();
    liveSyncInFlight.set(key, run);
    try { await run; } finally { liveSyncInFlight.delete(key); }
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
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
  // sd-mini is handled by snumom's grok-video endpoint, not Quality V4.
  const provider: ProviderId = requestedProvider;
  const config = getProviderConfig(provider);
  const model = provider === 'minimax-h3'
    ? config.model
    : provider === 'grok-video' && requestedModel === 'grok'
      ? config.model
      : requestedModel ?? config.model;
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
    const initialStatus = status.status === 'unknown' ? 'queued' : status.status;
    const task = createProviderTask({ accountId: id, mode: 'video', provider, model, prompt: body.prompt, status: initialStatus, progress: status.progress, providerTaskId: status.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64, error: status.error, metadata: { ...(ownerId ? { ownerId } : {}), ...(referenceImageName ? { referenceImageName } : {}), sequence: 1, execution: result.mode, ...(assetIds.length ? { assetIds, referenceTokens: publishedReferences.map((item) => item.token) } : {}), ...(typeof body.pid === 'string' && body.pid.trim() ? { pid: body.pid.trim() } : {}) } });
    let responseTask = task;
    if (initialStatus === 'completed') {
      const cache = await cacheVideoTaskOutputsBeforeCompletion(id, task);
      responseTask = updateProviderTask(task.id, { status: cache.ready ? 'completed' : 'processing', progress: cache.ready ? 100 : 99, metadata: { ...(task.metadata ?? {}), localOutputCount: cache.cached, localOutputExpected: cache.expected, localOutputReady: cache.ready } }) ?? task;
    }
    if (result.mode === 'mock') void processMockProviderTask(task.id);
    return NextResponse.json({ success: true, data: responseTask }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const known = ['provider_not_configured', 'provider_unauthorized', 'provider_model_unavailable', 'provider_upstream_failed', 'provider_invalid_request', 'reference_public_base_invalid', 'reference_asset_not_found', 'reference_asset_kind_invalid', 'reference_asset_path_invalid', 'reference_asset_file_invalid', 'reference_images_must_be_https', 'reference_videos_must_be_https', 'reference_audios_must_be_https', 'too_many_reference_images', 'too_many_reference_videos', 'too_many_reference_audios', 'unsupported_duration', 'unsupported_aspect_ratio', 'unsupported_resolution', 'duration_required', 'sdmini_reference_media_unsupported', 'sdmini_model_invalid', 'sdmini_prompt_required', 'sdmini_invalid_seconds', 'sdmini_invalid_resolution', 'sdmini_720p_requires_10s', 'sdmini_invalid_aspect_ratio', 'sdmini_too_many_reference_images', 'sdmini_reference_images_must_be_http', 'qualityv4_prompt_required', 'qualityv4_invalid_duration', 'qualityv4_invalid_resolution', 'qualityv4_720p_requires_10s', 'qualityv4_invalid_size', 'qualityv4_too_many_reference_images', 'qualityv4_too_many_reference_videos', 'qualityv4_too_many_reference_audios'];
    const responseError = known.includes(message) || message.startsWith('provider_') ? message : 'provider_request_failed';
    const status = responseError.startsWith('provider_') ? 502 : 400;
    return NextResponse.json({ success: false, error: responseError }, { status });
  }
}
