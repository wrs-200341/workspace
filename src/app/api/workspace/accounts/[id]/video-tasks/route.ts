import { flushProviderTaskStore } from '@/lib/providers/taskStore';
import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount, workspaceOwnerIdForUser } from '@/lib/workspace/access';
import * as serverTasks from '@/lib/workspace/serverTasks';
import { businessDate } from '@/lib/workspace/tasks';
import { createProviderTask, getProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { getProviderConfig, isProviderLiveEnabled, type ProviderId } from '@/lib/providers/config';
import { normalizeProviderResponse, providerResponseSnapshot, sanitizeProviderError, submitVideoWithFallback } from '@/lib/providers/client';
import { validateGenerationRequest } from '@/lib/providers/validation';
import { publishAssetReference } from '@/lib/workspace/referenceBridge';
import { processMockProviderTask } from '@/lib/providers/taskProcessor';
import { getDefaultProductionAspectRatio, getDefaultProductionDuration, getDefaultVideoResolution } from '@/lib/workspace/production/defaults';
import { firstReferenceImageName } from '@/lib/workspace/taskMetadata';
import { lookupProductSummary } from '@/lib/workspace/productSummary';
import { publishProductImageReferences } from '@/lib/workspace/productImages';
import * as productSummaryModule from '@/lib/workspace/productSummary';
import { enqueueProviderTask, pumpProviderTasks, retryProviderTaskOnFailure, SCHEDULER_RUNTIME_ID } from '@/lib/providers/concurrency';
import { cacheVideoTaskOutputsBeforeCompletion, localVideoOutputUrls } from '@/lib/workspace/videoInventory';
import { canonicalTaskProgress } from '@/lib/providers/taskProgress';
import { normalizeTaskName, parseTaskNameMode, validateTaskNaming } from '@/lib/workspace/taskNaming';

type VideoProvider = 'grok-video' | 'yuanai-grok-video' | 'mgrouter-grok-video' | 'wan3-video' | 'wan-3-nsfw' | 'apiaw-seedance-video' | 'minimax-h3' | 'miku-minimax' | 'pro666-video' | 'quality-v4' | 'oairegbox-omni' | 'dola-sd2';


export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = performance.now();
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
  const filters = ownerScope ? { ownerId, mode: 'video' as const, date: date || undefined } : { accountId: id, mode: 'video' as const, date: date || undefined };
  if (request.nextUrl.searchParams.get('queue') === 'delta') {
    const data = serverTasks.getServerWorkspaceQueueDelta(filters, { viewer: `${auth.role}:${auth.username}:${id}`, searchParams: request.nextUrl.searchParams, project: toQueueTask });
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'private, no-store', 'Server-Timing': `queue;dur=${(performance.now() - startedAt).toFixed(1)}` } });
  }
  // Queue cards never need output URLs, Base64 payloads or full provider
  // responses. Keep the response on the lightweight projection; the full
  // task rows are loaded only by review/detail pages or background sync.
  const queueReader = Object.prototype.hasOwnProperty.call(serverTasks, 'getServerWorkspaceQueueTasks')
    ? serverTasks.getServerWorkspaceQueueTasks
    : serverTasks.getServerWorkspaceTasks;
  const { date: _date, ...legacyFilters } = filters;
  const tasks = queueReader(Object.prototype.hasOwnProperty.call(serverTasks, 'getServerWorkspaceQueueTasks') ? filters : legacyFilters).filter((task) => !date || businessDate(task.createdAt) === date);
  const queueTasks = tasks.map(toQueueTask);
  return NextResponse.json({ success: true, data: queueTasks, tasks: queueTasks });
}


function toQueueTask<T extends Record<string, unknown>>(task: T) {
  const { outputUrls: _outputUrls, outputBase64: _outputBase64, metadata, providerResponse: _providerResponse, ...summary } = task;
  // Expose only the non-sensitive scheduler state needed to distinguish a
  // local waiting task from one already queued at the upstream provider.
  const schedulerState = metadata && typeof metadata === 'object' && typeof (metadata as { schedulerState?: unknown }).schedulerState === 'string'
    ? (metadata as { schedulerState: string }).schedulerState
    : undefined;
  const promptProvider = metadata && typeof metadata === 'object' && typeof (metadata as { promptProvider?: unknown }).promptProvider === 'string'
    ? (metadata as { promptProvider: string }).promptProvider
    : undefined;
  const promptModel = metadata && typeof metadata === 'object' && typeof (metadata as { promptModel?: unknown }).promptModel === 'string'
    ? (metadata as { promptModel: string }).promptModel
    : undefined;
  const promptMode = metadata && typeof metadata === 'object' && typeof (metadata as { promptMode?: unknown }).promptMode === 'string'
    ? (metadata as { promptMode: string }).promptMode
    : undefined;
  const promptFallbackProviders = metadata && typeof metadata === 'object' && Array.isArray((metadata as { promptFallbackProviders?: unknown }).promptFallbackProviders)
    ? (metadata as { promptFallbackProviders: unknown[] }).promptFallbackProviders.filter((value): value is string => typeof value === 'string')
    : undefined;
  const promptGenerationUsedTemplate = Boolean(metadata && typeof metadata === 'object' && (metadata as { promptGenerationUsedTemplate?: unknown }).promptGenerationUsedTemplate === true);
  const localOutputReady = Boolean(metadata && typeof metadata === 'object' && (metadata as { localOutputReady?: unknown }).localOutputReady === true);
  const localOutputCount = metadata && typeof metadata === 'object' && typeof (metadata as { localOutputCount?: unknown }).localOutputCount === 'number' ? (metadata as { localOutputCount: number }).localOutputCount : undefined;
  const localOutputExpected = metadata && typeof metadata === 'object' && typeof (metadata as { localOutputExpected?: unknown }).localOutputExpected === 'number' ? (metadata as { localOutputExpected: number }).localOutputExpected : undefined;
  const localOutputPending = localOutputCount !== undefined && localOutputExpected !== undefined && localOutputCount < localOutputExpected;
  const attribution = normalizePromptAttribution(promptProvider, promptModel);
  return {
    ...summary,
    progress: canonicalTaskProgress({ mode: 'video', status: String(summary.status ?? ''), progress: Number(summary.progress ?? 0), providerTaskId: typeof summary.providerTaskId === 'string' ? summary.providerTaskId : undefined, schedulerState, promptGenerationPending: Boolean(metadata && typeof metadata === 'object' && (metadata as { promptGenerationPending?: unknown }).promptGenerationPending === true), localOutputReady: Boolean(localOutputReady), localOutputPending: Boolean(localOutputPending) }),
    ...(schedulerState ? { schedulerState } : {}),
    ...(attribution.provider ? { promptProvider: attribution.provider } : {}),
    ...(attribution.model ? { promptModel: attribution.model } : {}),
    ...(promptMode ? { promptMode } : {}),
    ...(promptFallbackProviders?.length ? { promptFallbackProviders } : {}),
    ...(promptGenerationUsedTemplate ? { promptGenerationUsedTemplate: true } : {}),
    ...(localOutputReady ? { localOutputReady: true } : {}),
    ...(localOutputPending ? { localOutputPending: true } : {}),
  };
}

/**
 * Older queued tasks stored the selector value (for example `bigsnake`) in
 * `promptModel` while leaving the initial provider hint as PomoAI. That made a
 * card read "PomoAI · bigsnake" even though no PomoAI request succeeded. Keep
 * the response backwards compatible by canonicalising those selector aliases
 * to the actual supplier before the queue reaches the browser.
 */
function normalizePromptAttribution(provider?: string, model?: string): { provider?: string; model?: string } {
  const normalizedModel = model?.trim().toLowerCase();
  const aliasProviders: Record<string, { provider: string; model: string }> = {
    'pomoai-gpt': { provider: 'pomoai-gpt-prompt', model: 'gpt-5.5' },
    'oairegbox-gpt': { provider: 'oairegbox-gpt-prompt', model: 'gpt-5.5' },
    'secure-skill-gpt': { provider: 'secure-skill-gpt-prompt', model: 'gpt-5.5' },
    bigsnake: { provider: 'bigsnake-prompt', model: 'gpt-5.5' },
    'gpt-2999': { provider: 'gpt-2999-prompt', model: 'gpt-2999' },
  };
  const alias = normalizedModel ? aliasProviders[normalizedModel] : undefined;
  if (alias && (!provider || provider === 'pomoai-gpt-prompt' || provider === 'oairegbox-gpt-prompt' || provider === 'secure-skill-gpt-prompt')) return alias;
  return { provider, model };
}


export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { prompt?: unknown; provider?: unknown; model?: unknown; duration?: unknown; seconds?: unknown; aspectRatio?: unknown; resolution?: unknown; referenceImages?: unknown; referenceVideos?: unknown; referenceAudios?: unknown; assetIds?: unknown; productImageAssetIds?: unknown; referenceAssetOrder?: unknown; pid?: unknown; taskNameMode?: unknown; taskName?: unknown };
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return NextResponse.json({ success: false, error: 'prompt_required' }, { status: 400 });
  const prompt = body.prompt.trim();
  const VIDEO_PROVIDERS: readonly string[] = ['grok-video', 'yuanai-grok-video', 'mgrouter-grok-video', 'wan3-video', 'wan-3-nsfw', 'apiaw-seedance-video', 'minimax-h3', 'miku-minimax', 'pro666-video', 'quality-v4', 'oairegbox-omni', 'dola-sd2'];
  const requestedProvider: VideoProvider = VIDEO_PROVIDERS.includes(body.provider as string) ? body.provider as VideoProvider : 'grok-video';
  const rawReferenceImages = Array.isArray(body.referenceImages) && body.referenceImages.every((item) => typeof item === 'string') ? body.referenceImages as string[] : [];
  const referenceVideos = Array.isArray(body.referenceVideos) && body.referenceVideos.every((item) => typeof item === 'string') ? body.referenceVideos as string[] : [];
  const referenceAudios = Array.isArray(body.referenceAudios) && body.referenceAudios.every((item) => typeof item === 'string') ? body.referenceAudios as string[] : [];
  const assetIds = Array.isArray(body.assetIds) && body.assetIds.every((item) => typeof item === 'string') ? body.assetIds as string[] : [];
  const productImageAssetIds = Array.isArray(body.productImageAssetIds) && body.productImageAssetIds.every((item) => typeof item === 'string') ? body.productImageAssetIds as string[] : [];
  const taskNameMode = parseTaskNameMode(body.taskNameMode);
  if (body.taskNameMode !== undefined && !taskNameMode) return NextResponse.json({ success: false, error: 'task_name_mode_invalid' }, { status: 400 });
  const taskName = normalizeTaskName(body.taskName);
  const taskNameError = validateTaskNaming(taskNameMode, taskName, rawReferenceImages.length + assetIds.length + productImageAssetIds.length);
  if (taskNameError) return NextResponse.json({ success: false, error: taskNameError }, { status: 400 });
  const referenceAssetOrder = Array.isArray(body.referenceAssetOrder) ? body.referenceAssetOrder.filter((item): item is { id: string; kind: 'image' | 'product-image' } => Boolean(item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' && ['image', 'product-image'].includes(String((item as { kind?: unknown }).kind)))) : [];
  const rawDuration = typeof body.duration === 'number' && Number.isFinite(body.duration)
    ? body.duration
    : typeof body.seconds === 'number' && Number.isFinite(body.seconds)
      ? body.seconds
      : undefined;
  const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
  // sd-mini is handled by snumom's grok-video endpoint, not Quality V4.
  const provider: VideoProvider = requestedProvider;
  const config = getProviderConfig(provider);
  const model = provider === 'wan-3-nsfw' || provider === 'apiaw-seedance-video' || provider === 'minimax-h3' || provider === 'miku-minimax' || provider === 'pro666-video' || provider === 'yuanai-grok-video' || provider === 'dola-sd2'
    ? config.model
    : provider === 'grok-video' && requestedModel === 'grok'
      ? config.model
      : requestedModel ?? config.model;
  const isSdMini = provider === 'grok-video' && model.toLowerCase() === 'sd-mini';
  const duration = provider === 'dola-sd2' ? rawDuration ?? 5 : rawDuration !== undefined ? Math.round(rawDuration) : (isSdMini ? undefined : getDefaultProductionDuration(config.supports.durations));
  const aspectRatio = typeof body.aspectRatio === 'string' && body.aspectRatio.trim()
    ? body.aspectRatio.trim()
    : getDefaultProductionAspectRatio(config.supports.ratios);
  const resolution = typeof body.resolution === 'string' && body.resolution.trim()
    ? body.resolution.trim()
    : getDefaultVideoResolution(config.supports.resolutions);
  try {
    const ownerId = workspaceOwnerIdForAccount(id);
    const referenceImageName = firstReferenceImageName({ accountId: id, assetIds, productImageAssetIds, referenceAssetOrder, rawReferenceImages });
    const accountLookup = (productSummaryModule as typeof productSummaryModule & { lookupProductSummaryForAccount?: typeof lookupProductSummary }).lookupProductSummaryForAccount;
    const productSummary = typeof accountLookup === 'function' ? accountLookup(id, referenceImageName) : lookupProductSummary(referenceImageName);
    const referenceImages = [...rawReferenceImages, ...assetIds.map(() => 'https://pending.invalid/reference-image'), ...productImageAssetIds.map(() => 'https://pending.invalid/reference-image')];
    const normalized = validateGenerationRequest({ provider, model, duration, aspectRatio, resolution, referenceImages, referenceVideos, referenceAudios });
    const task = createProviderTask({ accountId: id, mode: 'video', provider, model, prompt, status: 'queued', progress: 0, metadata: { ...(ownerId ? { ownerId } : {}), ...(referenceImageName ? { referenceImageName } : {}), ...(taskNameMode ? { taskNameMode } : {}), ...(taskNameMode === 'manual' && taskName ? { taskName } : {}), sequence: 1, execution: 'pending', duration: normalized.duration, aspectRatio: normalized.aspectRatio, resolution: normalized.resolution, externalReferenceImages: rawReferenceImages, externalReferenceVideos: referenceVideos, externalReferenceAudios: referenceAudios, maxRetries: 2, schedulerState: 'waiting', schedulerOwnerId: ownerId ?? id, schedulerMode: 'video', schedulerModel: model, schedulerRuntimeId: SCHEDULER_RUNTIME_ID, finalPrompt: prompt, ...(productSummary ? { productSummary } : { productSummaryLookup: referenceImageName ? 'not_found' : 'no_reference_name' }), ...(assetIds.length || productImageAssetIds.length ? { assetIds, productImageAssetIds, referenceAssetOrder } : {}), ...(typeof body.pid === 'string' && body.pid.trim() ? { pid: body.pid.trim() } : {}) } });
    const accepted = enqueueProviderTask({ taskId: task.id, ownerId: ownerId ?? id, mode: 'video', model });
    await flushProviderTaskStore();
    const queuedTask = getProviderTask(task.id) ?? task;
    return NextResponse.json({ success: accepted, data: { ...queuedTask, status: queuedTask.status }, ...(accepted ? {} : { error: queuedTask.error ?? 'scheduler_queue_full' }) }, { status: accepted ? 202 : 503 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const known = ['provider_not_configured', 'provider_unauthorized', 'provider_model_unavailable', 'provider_upstream_failed', 'provider_invalid_request', 'reference_public_base_invalid', 'reference_asset_not_found', 'reference_asset_kind_invalid', 'reference_asset_path_invalid', 'reference_asset_file_invalid', 'reference_images_must_be_https', 'reference_videos_must_be_https', 'reference_audios_must_be_https', 'too_many_reference_images', 'too_many_reference_videos', 'too_many_reference_audios', 'wan_reference_audio_requires_visual', 'seedance_reference_audio_requires_visual', 'unsupported_duration', 'unsupported_aspect_ratio', 'unsupported_resolution', 'duration_required', 'yuanai_grok_reference_media_unsupported', 'yuanai_grok_prompt_required', 'yuanai_grok_invalid_duration', 'yuanai_grok_invalid_aspect_ratio', 'yuanai_grok_invalid_resolution', 'yuanai_grok_too_many_reference_images', 'yuanai_grok_reference_urls_must_be_https', 'sdmini_reference_media_unsupported', 'sdmini_model_invalid', 'sdmini_prompt_required', 'sdmini_invalid_seconds', 'sdmini_invalid_resolution', 'sdmini_720p_requires_10s', 'sdmini_invalid_aspect_ratio', 'sdmini_too_many_reference_images', 'sdmini_reference_images_must_be_http', 'seedance_prompt_required', 'seedance_model_invalid', 'seedance_invalid_duration', 'seedance_invalid_aspect_ratio', 'seedance_invalid_resolution', 'seedance_too_many_reference_images', 'seedance_too_many_reference_videos', 'seedance_too_many_reference_audios', 'seedance_reference_urls_must_be_https', 'pro666_reference_video_unsupported', 'pro666_prompt_required', 'pro666_too_many_reference_images', 'pro666_too_many_reference_audios', 'pro666_reference_urls_must_be_https', 'qualityv4_prompt_required', 'qualityv4_invalid_duration', 'qualityv4_invalid_resolution', 'qualityv4_720p_requires_10s', 'qualityv4_invalid_aspect_ratio', 'qualityv4_invalid_size', 'qualityv4_too_many_reference_images', 'qualityv4_too_many_reference_videos', 'qualityv4_too_many_reference_audios'];
    const responseError = message === 'reference_images_required' || known.includes(message) || message.startsWith('provider_') ? message : 'provider_request_failed';
    const status = responseError.startsWith('provider_') ? 502 : 400;
    return NextResponse.json({ success: false, error: responseError }, { status });
  }
}
