import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount, workspaceOwnerIdForUser } from '@/lib/workspace/access';
import * as serverTasks from '@/lib/workspace/serverTasks';
import { businessDate } from '@/lib/workspace/tasks';
import { createProviderTask, getProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { getProviderConfig, isProviderLiveEnabled, type ProviderId } from '@/lib/providers/config';
import { normalizeProviderResponse, providerResponseSnapshot, sanitizeProviderError, submitVideoWithFallback, syncProviderTask } from '@/lib/providers/client';
import { validateGenerationRequest } from '@/lib/providers/validation';
import { publishAssetReference } from '@/lib/workspace/referenceBridge';
import { processMockProviderTask } from '@/lib/providers/taskProcessor';
import { getDefaultProductionAspectRatio, getDefaultProductionDuration, getDefaultVideoResolution } from '@/lib/workspace/production/defaults';
import { firstReferenceImageName } from '@/lib/workspace/taskMetadata';
import { lookupProductSummary } from '@/lib/workspace/productSummary';
import { publishProductImageReferences } from '@/lib/workspace/productImages';
import * as productSummaryModule from '@/lib/workspace/productSummary';
import { enqueueProviderTask, pumpProviderTasks, recoverOrphanedSchedulerTasks, retryProviderTaskOnFailure, SCHEDULER_RUNTIME_ID } from '@/lib/providers/concurrency';
import { cacheVideoTaskOutputsBeforeCompletion, localVideoOutputUrls, recoverPendingVideoTaskOutputCache } from '@/lib/workspace/videoInventory';
import { canonicalTaskProgress } from '@/lib/providers/taskProgress';
import { normalizeTaskName, parseTaskNameMode, validateTaskNaming } from '@/lib/workspace/taskNaming';

type VideoProvider = 'grok-video' | 'yuanai-grok-video' | 'mgrouter-grok-video' | 'wan3-video' | 'wan-3-nsfw' | 'minimax-h3' | 'miku-minimax' | 'pro666-video' | 'quality-v4' | 'oairegbox-omni';

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
  recoverOrphanedSchedulerTasks();
  const filters = ownerScope ? { ownerId, mode: 'video' as const } : { accountId: id, mode: 'video' as const };
  // Queue cards never need output URLs, Base64 payloads or full provider
  // responses. Keep the response on the lightweight projection; the full
  // task rows are loaded only by review/detail pages or background sync.
  const queueReader = Object.prototype.hasOwnProperty.call(serverTasks, 'getServerWorkspaceQueueTasks')
    ? serverTasks.getServerWorkspaceQueueTasks
    : serverTasks.getServerWorkspaceTasks;
  const tasks = queueReader(filters).filter((task) => !date || businessDate(task.createdAt) === date);
  const needsBackgroundWork = tasks.some((task) => task.status === 'processing' || (task.status === 'failed' && task.error === 'video_output_cache_failed'));
  // Queue reads must stay fast. Provider synchronization and output recovery
  // are explicitly opt-in/background so an upstream provider cannot block the
  // response or make every route transition wait for remote work.
  if (needsBackgroundWork || request.nextUrl.searchParams.get('sync') === '1') {
    void Promise.resolve().then(() => {
      const fullTasks = serverTasks.getServerWorkspaceTasks(filters).filter((task) => !date || businessDate(task.createdAt) === date);
      if (needsBackgroundWork) void recoverPendingVideoCaches(fullTasks);
      if (request.nextUrl.searchParams.get('sync') === '1') void syncLiveVideoTasks(fullTasks);
    });
  }
  const queueTasks = tasks.map(toQueueTask);
  return NextResponse.json({ success: true, data: queueTasks, tasks: queueTasks });
}

async function recoverPendingVideoCaches(tasks: ReturnType<typeof serverTasks.getServerWorkspaceTasks>): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  const pending = tasks.filter((task) => task.mode === 'video' && (task.status === 'processing' || (task.status === 'failed' && task.error === 'video_output_cache_failed')));
  for (const task of pending.slice(0, 8)) {
    await recoverPendingVideoTaskOutputCache(task.id).catch(() => null);
  }
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
    bigsnake: { provider: 'bigsnake-prompt', model: 'gpt-5.5' },
    'gpt-2999': { provider: 'gpt-2999-prompt', model: 'gpt-2999' },
  };
  const alias = normalizedModel ? aliasProviders[normalizedModel] : undefined;
  if (alias && (!provider || provider === 'pomoai-gpt-prompt' || provider === 'oairegbox-gpt-prompt')) return alias;
  return { provider, model };
}

function syncLiveVideoTasks(tasks: ReturnType<typeof serverTasks.getServerWorkspaceTasks>): Promise<void> {
  if (liveSyncRunning) return Promise.resolve();
  liveSyncRunning = true;
  const run = runLiveVideoTasks(tasks).finally(() => { liveSyncRunning = false; });
  return run.catch(() => undefined);
}

async function runLiveVideoTasks(tasks: ReturnType<typeof serverTasks.getServerWorkspaceTasks>): Promise<void> {
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
        const noOutput = normalizedStatus === 'completed' && cache?.expected === 0;
        const cachePending = normalizedStatus === 'completed' && cache && cache.expected > 0 && !cache.ready;
        const outputUrls = cache?.ready && cache.expected > 0 ? localVideoOutputUrls(task.accountId, task.id, cache.expected) : status.outputUrls;
        const outputBase64 = cache?.ready && cache.expected > 0 ? [] : status.outputBase64;
        const finalStatus = noOutput ? 'failed' : cachePending ? 'processing' : normalizedStatus;
        const updated = updateProviderTask(task.id, { status: finalStatus, progress: canonicalTaskProgress({ mode: 'video', status: finalStatus, progress: status.progress, providerTaskId: status.providerTaskId ?? task.providerTaskId, schedulerState: cachePending ? 'provider-active' : undefined, localOutputReady: cache?.ready === true, localOutputPending: cachePending === true }), providerTaskId: status.providerTaskId ?? task.providerTaskId, outputUrls, outputBase64, error: noOutput ? 'provider_upstream_failed' : status.error, providerResponse: status.status === 'failed' || noOutput ? providerResponseSnapshot(new Error(status.error ?? 'provider_upstream_failed'), { body: status.response, method: 'GET' }) : undefined, metadata: { ...(task.metadata ?? {}), ...(status.status === 'failed' || noOutput ? { lastProviderFailure: task.provider } : {}), ...(cache ? { localOutputCount: cache.cached, localOutputExpected: cache.expected, localOutputReady: cache.ready } : {}) } });
        if (updated?.status === 'failed') retryProviderTaskOnFailure(task.id);
        pumpProviderTasks(typeof task.metadata?.ownerId === 'string' ? task.metadata.ownerId : task.accountId, 'video');
      } catch (error) {
        const providerResponse = providerResponseSnapshot(error);
        const updated = updateProviderTask(task.id, {
          // A failed poll is retryable just like a failed submission. Keeping
          // the old processing state here can strand the task forever when a
          // provider times out or briefly drops the connection.
          status: 'failed',
          progress: 100,
          error: sanitizeProviderError(error instanceof Error ? error.message : 'provider_request_failed'),
          providerResponse,
          metadata: { ...(task.metadata ?? {}), lastProviderFailure: task.provider },
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
  const body = await request.json().catch(() => ({})) as { prompt?: unknown; provider?: unknown; model?: unknown; duration?: unknown; seconds?: unknown; aspectRatio?: unknown; resolution?: unknown; referenceImages?: unknown; referenceAudios?: unknown; assetIds?: unknown; productImageAssetIds?: unknown; referenceAssetOrder?: unknown; pid?: unknown; taskNameMode?: unknown; taskName?: unknown };
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return NextResponse.json({ success: false, error: 'prompt_required' }, { status: 400 });
  const prompt = body.prompt.trim();
  const VIDEO_PROVIDERS: readonly string[] = ['grok-video', 'yuanai-grok-video', 'mgrouter-grok-video', 'wan3-video', 'wan-3-nsfw', 'minimax-h3', 'miku-minimax', 'pro666-video', 'quality-v4', 'oairegbox-omni'];
  const requestedProvider: VideoProvider = VIDEO_PROVIDERS.includes(body.provider as string) ? body.provider as VideoProvider : 'grok-video';
  const rawReferenceImages = Array.isArray(body.referenceImages) && body.referenceImages.every((item) => typeof item === 'string') ? body.referenceImages as string[] : [];
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
  const model = provider === 'wan-3-nsfw' || provider === 'minimax-h3' || provider === 'miku-minimax' || provider === 'pro666-video' || provider === 'yuanai-grok-video'
    ? config.model
    : provider === 'grok-video' && requestedModel === 'grok'
      ? config.model
      : requestedModel ?? config.model;
  const isSdMini = provider === 'grok-video' && model.toLowerCase() === 'sd-mini';
  const duration = rawDuration !== undefined ? Math.round(rawDuration) : (isSdMini ? undefined : getDefaultProductionDuration(config.supports.durations));
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
    const publishedReferences = isProviderLiveEnabled(provider)
      ? assetIds.map((assetId) => publishAssetReference({ accountId: id, assetId, allowedKinds: ['image'] }))
      : [];
    const publishedProductReferences = isProviderLiveEnabled(provider) ? publishProductImageReferences(productImageAssetIds, id) : [];
    const referenceImages = [...rawReferenceImages, ...publishedReferences.map((item) => item.url), ...publishedProductReferences.map((item) => item.url)];
    const normalized = validateGenerationRequest({ provider, model, duration, aspectRatio, resolution, referenceImages, referenceAudios });
    const task = createProviderTask({ accountId: id, mode: 'video', provider, model, prompt, status: 'queued', progress: 0, metadata: { ...(ownerId ? { ownerId } : {}), ...(referenceImageName ? { referenceImageName } : {}), ...(taskNameMode ? { taskNameMode } : {}), ...(taskNameMode === 'manual' && taskName ? { taskName } : {}), sequence: 1, execution: 'pending', maxRetries: 2, schedulerState: 'waiting', schedulerOwnerId: ownerId ?? id, schedulerMode: 'video', schedulerModel: model, schedulerRuntimeId: SCHEDULER_RUNTIME_ID, finalPrompt: prompt, ...(productSummary ? { productSummary } : { productSummaryLookup: referenceImageName ? 'not_found' : 'no_reference_name' }), ...(assetIds.length || productImageAssetIds.length ? { assetIds, productImageAssetIds, referenceTokens: [...publishedReferences, ...publishedProductReferences].map((item) => item.token) } : {}), ...(typeof body.pid === 'string' && body.pid.trim() ? { pid: body.pid.trim() } : {}) } });
    const accepted = enqueueProviderTask({
      taskId: task.id,
      ownerId: ownerId ?? id,
      mode: 'video',
      model,
      run: () => submitLegacyVideoTask({ taskId: task.id, accountId: id, provider, model, prompt, duration: normalized.duration!, aspectRatio: normalized.aspectRatio!, resolution: normalized.resolution!, referenceImages, referenceAudios }),
    });
    const queuedTask = getProviderTask(task.id) ?? task;
    return NextResponse.json({ success: accepted, data: { ...queuedTask, status: queuedTask.status }, ...(accepted ? {} : { error: queuedTask.error ?? 'scheduler_queue_full' }) }, { status: accepted ? 202 : 503 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const known = ['provider_not_configured', 'provider_unauthorized', 'provider_model_unavailable', 'provider_upstream_failed', 'provider_invalid_request', 'reference_public_base_invalid', 'reference_asset_not_found', 'reference_asset_kind_invalid', 'reference_asset_path_invalid', 'reference_asset_file_invalid', 'reference_images_must_be_https', 'reference_videos_must_be_https', 'reference_audios_must_be_https', 'too_many_reference_images', 'too_many_reference_videos', 'too_many_reference_audios', 'wan_reference_audio_requires_visual', 'unsupported_duration', 'unsupported_aspect_ratio', 'unsupported_resolution', 'duration_required', 'yuanai_grok_reference_media_unsupported', 'yuanai_grok_prompt_required', 'yuanai_grok_invalid_duration', 'yuanai_grok_invalid_aspect_ratio', 'yuanai_grok_invalid_resolution', 'yuanai_grok_too_many_reference_images', 'yuanai_grok_reference_urls_must_be_https', 'sdmini_reference_media_unsupported', 'sdmini_model_invalid', 'sdmini_prompt_required', 'sdmini_invalid_seconds', 'sdmini_invalid_resolution', 'sdmini_720p_requires_10s', 'sdmini_invalid_aspect_ratio', 'sdmini_too_many_reference_images', 'sdmini_reference_images_must_be_http', 'pro666_reference_video_unsupported', 'pro666_prompt_required', 'pro666_too_many_reference_images', 'pro666_too_many_reference_audios', 'pro666_reference_urls_must_be_https', 'qualityv4_prompt_required', 'qualityv4_invalid_duration', 'qualityv4_invalid_resolution', 'qualityv4_720p_requires_10s', 'qualityv4_invalid_size', 'qualityv4_too_many_reference_images', 'qualityv4_too_many_reference_videos', 'qualityv4_too_many_reference_audios'];
    const responseError = known.includes(message) || message.startsWith('provider_') ? message : 'provider_request_failed';
    const status = responseError.startsWith('provider_') ? 502 : 400;
    return NextResponse.json({ success: false, error: responseError }, { status });
  }
}

async function submitLegacyVideoTask(input: {
  taskId: string;
  accountId: string;
  provider: VideoProvider;
  model: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  referenceImages: string[];
  referenceAudios: string[];
}): Promise<void> {
  let providerResponse: unknown;
  try {
    const previousProvider = getProviderTask(input.taskId)?.metadata?.lastProviderFailure;
    const skipProviders = typeof previousProvider === 'string' && ['grok-video', 'yuanai-grok-video', 'mgrouter-grok-video'].includes(previousProvider) ? [previousProvider as ProviderId] : undefined;
    const submitted = await submitVideoWithFallback({
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      duration: input.duration,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      referenceImages: input.referenceImages,
      referenceAudios: input.referenceAudios,
      media: [
        ...input.referenceImages.map((url) => ({ type: 'reference_image' as const, url })),
        ...input.referenceAudios.map((url) => ({ type: 'audio' as const, url })),
      ],
    }, skipProviders ? { skipProviders } : undefined);
    providerResponse = submitted.response;
    const status = normalizeProviderResponse(submitted.provider, submitted.response);
    const current = getProviderTask(input.taskId);
    if (!current) return;
    const normalizedStatus = status.status === 'unknown' ? 'queued' : status.status;
    const cacheTask = { ...current, provider: submitted.provider, model: submitted.model, status: 'completed' as const, progress: 100, providerTaskId: status.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64 };
    const cache = normalizedStatus === 'completed' ? await cacheVideoTaskOutputsBeforeCompletion(input.accountId, cacheTask) : null;
    const noOutput = normalizedStatus === 'completed' && cache?.expected === 0;
    const cachePending = normalizedStatus === 'completed' && cache && cache.expected > 0 && !cache.ready;
    const outputUrls = cache?.ready && cache.expected > 0 ? localVideoOutputUrls(input.accountId, input.taskId, cache.expected) : status.outputUrls;
    const outputBase64 = cache?.ready && cache.expected > 0 ? [] : status.outputBase64;
    updateProviderTask(input.taskId, {
      status: noOutput ? 'failed' : cachePending ? 'processing' : normalizedStatus,
      progress: noOutput ? 100 : cachePending ? 99 : status.progress,
      provider: submitted.provider,
      model: submitted.model,
      providerTaskId: status.providerTaskId,
      outputUrls,
      outputBase64,
      error: noOutput ? 'provider_upstream_failed' : status.error,
      providerResponse: status.status === 'failed' || noOutput ? providerResponseSnapshot(new Error(status.error ?? 'provider_upstream_failed'), { body: providerResponse, method: 'POST' }) : undefined,
      metadata: { ...(current.metadata ?? {}), execution: submitted.mode, ...(submitted.fallbackFrom ? { fallbackFrom: submitted.fallbackFrom, fallbackProviders: submitted.fallbackProviders, fallbackParameters: submitted.fallbackParameters } : {}), ...(cache ? { localOutputCount: cache.cached, localOutputExpected: cache.expected, localOutputReady: cache.ready } : {}) },
    });
    if (submitted.mode === 'mock') void processMockProviderTask(input.taskId);
  } catch (error) {
    updateProviderTask(input.taskId, {
      status: 'failed',
      progress: 100,
      error: sanitizeProviderError(error instanceof Error ? error.message : 'provider_request_failed'),
      providerResponse: providerResponseSnapshot(error, providerResponse === undefined ? undefined : { body: providerResponse, method: 'POST' }),
    });
  }
}
