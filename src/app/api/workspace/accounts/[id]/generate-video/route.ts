import crypto from 'node:crypto';
import { lookupProductSummary } from '@/lib/workspace/productSummary';
import { parseAssetOrder, promptProviderHint, promptModelHintFor } from '@/lib/providers/videoTaskExecution';
import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount } from '@/lib/workspace/access';
import { getProviderConfig, isProviderLiveEnabled, type ProviderId } from '@/lib/providers/config';
import { createProviderTasks, flushProviderTaskStore, getProviderTask, listProviderTasks } from '@/lib/providers/taskStore';
import { validateGenerationRequest } from '@/lib/providers/validation';
import { getVideoCapability, validateVideoCapability } from '@/lib/workspace/production/video-capabilities';
import { getDefaultProductionAspectRatio, getDefaultProductionDuration, getDefaultVideoResolution } from '@/lib/workspace/production/defaults';
import { getDailyQuotaUsage } from '@/lib/workspace/production/dailyQuota';
import { listAssets } from '@/lib/workspace/assetStore';
import { firstReferenceImageName } from '@/lib/workspace/taskMetadata';
import * as productSummaryModule from '@/lib/workspace/productSummary';
import { enqueueProviderTask, requeueProviderTask, SCHEDULER_RUNTIME_ID } from '@/lib/providers/concurrency';
import { normalizeTaskName, parseTaskNameMode, validateTaskNaming } from '@/lib/workspace/taskNaming';
import { classifyTaskError } from '@/lib/providers/taskErrorInfo';
import { businessDate } from '@/lib/workspace/tasks';

type VideoProvider = 'grok-video' | 'yuanai-grok-video' | 'mgrouter-grok-video' | 'wan3-video' | 'wan-3-nsfw' | 'apiaw-seedance-video' | 'minimax-h3' | 'miku-minimax' | 'pro666-video' | 'quality-v4' | 'oairegbox-omni' | 'dola-sd2';
const VIDEO_PROVIDERS: readonly VideoProvider[] = ['grok-video', 'yuanai-grok-video', 'mgrouter-grok-video', 'wan3-video', 'wan-3-nsfw', 'apiaw-seedance-video', 'minimax-h3', 'miku-minimax', 'pro666-video', 'quality-v4', 'oairegbox-omni', 'dola-sd2'];

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  if (body && typeof body === 'object' && (body as { action?: unknown }).action === 'recover-safe') {
    const ownerId = workspaceOwnerIdForAccount(id);
    const requestedDate = typeof (body as { date?: unknown }).date === 'string' ? (body as { date: string }).date : undefined;
    const candidates = listProviderTasks({ mode: 'video', status: 'failed' }).filter((task) => {
      if (requestedDate && businessDate(task.createdAt) !== requestedDate) return false;
      if (ownerId) return (workspaceOwnerIdForAccount(task.accountId) || task.metadata?.ownerId) === ownerId;
      return task.accountId === id;
    });
    const safe = candidates.filter((task) => classifyTaskError(task)?.safeToRetry && !task.providerTaskId);
    const skipped = candidates.length - safe.length;
    const batchId = `safe-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let recovered = 0;
    for (const task of safe) if (requeueProviderTask(task.id)) recovered += 1;
    await flushProviderTaskStore();
    return NextResponse.json({ success: true, data: { batchId, started: recovered, recovered, skipped: skipped + safe.length - recovered } });

  }
  if (!body || typeof body !== 'object' || typeof (body as { prompt?: unknown }).prompt !== 'string' || !(body as { prompt: string }).prompt.trim()) {
    return NextResponse.json({ success: false, error: 'prompt_required' }, { status: 400 });
  }
  const input = body as { prompt: string; provider?: unknown; model?: unknown; modelId?: unknown; supplierId?: unknown; promptMode?: unknown; promptModel?: unknown; templateId?: unknown; childPrompt?: unknown; finalPrompt?: unknown; originalPrompt?: unknown; suffixEnabled?: unknown; suffix?: unknown; count?: unknown; duration?: unknown; seconds?: unknown; aspectRatio?: unknown; resolution?: unknown; referenceImages?: unknown; referenceVideos?: unknown; referenceAudios?: unknown; assetIds?: unknown; referenceAssetIds?: unknown; referenceVideoAssetIds?: unknown; referenceAudioAssetIds?: unknown; productImageAssetIds?: unknown; referenceAssetOrder?: unknown; pid?: unknown; taskNameMode?: unknown; taskName?: unknown };
  const requestedProvider: VideoProvider = VIDEO_PROVIDERS.includes(input.provider as VideoProvider) ? input.provider as VideoProvider : 'grok-video';
  const rawReferenceImages = Array.isArray(input.referenceImages) && input.referenceImages.every((value) => typeof value === 'string') ? input.referenceImages as string[] : [];
  const rawReferenceVideos = Array.isArray(input.referenceVideos) && input.referenceVideos.every((value) => typeof value === 'string') ? input.referenceVideos as string[] : [];
  const rawReferenceAudios = Array.isArray(input.referenceAudios) && input.referenceAudios.every((value) => typeof value === 'string') ? input.referenceAudios as string[] : [];
  const assetIds = Array.isArray(input.assetIds) && input.assetIds.every((value) => typeof value === 'string') ? input.assetIds as string[] : [];
  const referenceAssetIds = Array.isArray(input.referenceAssetIds) && input.referenceAssetIds.every((value) => typeof value === 'string') ? input.referenceAssetIds as string[] : [];
  const referenceVideoAssetIds = Array.isArray(input.referenceVideoAssetIds) && input.referenceVideoAssetIds.every((value) => typeof value === 'string') ? input.referenceVideoAssetIds as string[] : [];
  const referenceAudioAssetIds = Array.isArray(input.referenceAudioAssetIds) && input.referenceAudioAssetIds.every((value) => typeof value === 'string') ? input.referenceAudioAssetIds as string[] : [];
  const productImageAssetIds = Array.isArray(input.productImageAssetIds) && input.productImageAssetIds.every((value) => typeof value === 'string') ? input.productImageAssetIds as string[] : [];
  const referenceAssetOrder = parseAssetOrder(input.referenceAssetOrder);
  const safeReferenceAssetOrder = referenceAssetOrder.filter((item) => {
    if (item.kind === 'image') return referenceAssetIds.includes(item.id);
    if (item.kind === 'product-image') return productImageAssetIds.includes(item.id);
    if (item.kind === 'inventory-video') return referenceVideoAssetIds.includes(item.id);
    return referenceAudioAssetIds.includes(item.id);
  });
  const orderedImageAssets = (safeReferenceAssetOrder.length
    ? safeReferenceAssetOrder.filter((item) => item.kind === 'image' || item.kind === 'product-image')
    : [...referenceAssetIds.map((id) => ({ id, kind: 'image' as const })), ...productImageAssetIds.map((id) => ({ id, kind: 'product-image' as const }))])
    .filter((item) => referenceAssetIds.includes(item.id) || productImageAssetIds.includes(item.id));
  const orderedReferenceAssetIds = orderedImageAssets.filter((item) => item.kind === 'image').map((item) => item.id);
  const orderedProductImageAssetIds = orderedImageAssets.filter((item) => item.kind === 'product-image').map((item) => item.id);
  const taskNameMode = parseTaskNameMode(input.taskNameMode);
  if (input.taskNameMode !== undefined && !taskNameMode) return NextResponse.json({ success: false, error: 'task_name_mode_invalid' }, { status: 400 });
  const taskName = normalizeTaskName(input.taskName);
  const taskNameError = validateTaskNaming(taskNameMode, taskName, rawReferenceImages.length + orderedImageAssets.length);
  if (taskNameError) return NextResponse.json({ success: false, error: taskNameError }, { status: 400 });
  const rawDuration = typeof input.duration === 'number' && Number.isFinite(input.duration)
    ? input.duration
    : typeof input.seconds === 'number' && Number.isFinite(input.seconds)
      ? input.seconds
      : undefined;
  const requestedModel = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined;
  // sd-mini is a native snumom (grok-video) model. Do not route it through
  // Quality V4: that supplier does not expose the sd-mini model.
  const provider: VideoProvider = requestedProvider;
  const config = getProviderConfig(provider);
  // `grok` is a historical UI/provider alias, not a model id accepted by
  // snumom. Resolve it to the configured model before submitting upstream.
  const model = provider === 'wan-3-nsfw' || provider === 'apiaw-seedance-video' || provider === 'minimax-h3' || provider === 'pro666-video' || provider === 'yuanai-grok-video' || provider === 'dola-sd2'
    ? config.model
    : provider === 'grok-video' && requestedModel === 'grok'
      ? config.model
      : requestedModel ?? config.model;
  const isSdMini = provider === 'grok-video' && model.toLowerCase() === 'sd-mini';
  // sd-mini requires seconds explicitly; unlike legacy providers, do not
  // silently inject the provider's first duration when the field is omitted.
  const duration = provider === 'dola-sd2' ? rawDuration ?? 5 : rawDuration !== undefined ? Math.round(rawDuration) : (isSdMini ? undefined : getDefaultProductionDuration(config.supports.durations));
  const aspectRatio = typeof input.aspectRatio === 'string' && input.aspectRatio.trim()
    ? input.aspectRatio.trim()
    : getDefaultProductionAspectRatio(config.supports.ratios);
  const resolution = typeof input.resolution === 'string' && input.resolution.trim()
    ? input.resolution.trim()
    : getDefaultVideoResolution(config.supports.resolutions);
  try {
    const count = typeof input.count === 'number' && Number.isFinite(input.count) ? Math.min(4, Math.max(1, Math.round(input.count))) : 1;
    const ownerId = workspaceOwnerIdForAccount(id);
    // Metered models are capped per operator per day. Check before any upstream
    // work so a rejected batch costs nothing.
    const quotaModelId = typeof input.modelId === 'string' && input.modelId.trim() ? input.modelId.trim() : model;
    const quota = getDailyQuotaUsage(ownerId ?? id, quotaModelId);
    if (quota && quota.remaining < count) {
      return NextResponse.json({
        success: false,
        error: 'daily_model_quota_exceeded',
        data: { model: quota.model, limit: quota.limit, used: quota.used, remaining: quota.remaining, requested: count, date: quota.date },
      }, { status: 429 });
    }
    const referenceImageName = firstReferenceImageName({ accountId: id, referenceAssetIds: orderedReferenceAssetIds, assetIds, productImageAssetIds: orderedProductImageAssetIds, referenceAssetOrder: safeReferenceAssetOrder, rawReferenceImages });
    const accountLookup = (productSummaryModule as typeof productSummaryModule & { lookupProductSummaryForAccount?: typeof lookupProductSummary }).lookupProductSummaryForAccount;
    const productSummary = typeof accountLookup === 'function' ? accountLookup(id, referenceImageName) : lookupProductSummary(referenceImageName);
    const automaticPrompt = input.promptMode === 'asset-template-child-prompt';
    // Excel 标题和描述只用于生成子提示词，不再拼入最终提交给视频模型的 prompt。
    const manualVideoPrompt = input.prompt.trim();
    const requestedPromptModel = typeof input.promptModel === 'string' && input.promptModel.trim() ? input.promptModel.trim() : 'pomoai-gpt';
    const promptTemplateContent = automaticPrompt && typeof input.templateId === 'string'
      ? listAssets(id, 'prompt').find((asset) => asset.id === input.templateId)?.content?.trim().slice(0, 32_000) ?? ''
      : '';
    const referenceImages = [...rawReferenceImages, ...orderedImageAssets.map(() => 'https://pending.invalid/reference-image')];
    const referenceVideos = [...rawReferenceVideos, ...referenceVideoAssetIds.map(() => 'https://pending.invalid/reference-video')];
    const referenceAudios = [...rawReferenceAudios, ...referenceAudioAssetIds.map(() => 'https://pending.invalid/reference-audio')];
    const normalized = validateGenerationRequest({ provider, model, duration, aspectRatio, resolution, referenceImages, referenceVideos, referenceAudios });
    validateVideoCapability(getVideoCapability(provider, model), {
      duration: normalized.duration!, aspectRatio: normalized.aspectRatio!,
      resolution: provider === 'wan3-video' ? String(normalized.resolution).toUpperCase() : String(normalized.resolution),
      referenceCount: referenceImages.length, referenceVideoCount: referenceVideos.length, referenceAudioCount: referenceAudios.length,
    });
    const promptBatchId = crypto.randomUUID();
    const taskStatus = automaticPrompt ? 'prompting' as const : 'queued' as const;
    const taskPrompt = manualVideoPrompt;
    const promptHint = automaticPrompt ? promptProviderHint(requestedPromptModel) : undefined;
    const promptModelHint = automaticPrompt ? promptModelHintFor(requestedPromptModel) : undefined;
    const tasks = createProviderTasks(Array.from({ length: count }, (_, index) => ({ accountId: id, mode: 'video' as const, provider, model, prompt: taskPrompt, status: taskStatus, progress: automaticPrompt ? 2 : 0, metadata: { ...(ownerId ? { ownerId } : {}), ...(referenceImageName ? { referenceImageName } : {}), ...(taskNameMode ? { taskNameMode } : {}), ...(taskNameMode === 'manual' && taskName ? { taskName } : {}), sequence: index + 1, execution: 'pending', schedulerState: 'waiting', schedulerOwnerId: ownerId ?? id, schedulerMode: 'video', schedulerModel: model, schedulerRuntimeId: SCHEDULER_RUNTIME_ID, modelId: typeof input.modelId === 'string' ? input.modelId : model, supplierId: typeof input.supplierId === 'string' ? input.supplierId : provider, promptTitle: input.prompt, promptMode: typeof input.promptMode === 'string' ? input.promptMode : 'manual', promptModel: requestedPromptModel, promptModelSelection: requestedPromptModel, templateId: typeof input.templateId === 'string' ? input.templateId : undefined, childPrompt: typeof input.childPrompt === 'string' ? input.childPrompt : undefined, finalPrompt: manualVideoPrompt, originalPrompt: typeof input.originalPrompt === 'string' ? input.originalPrompt : input.prompt, suffixEnabled: input.suffixEnabled === true, count, aspectRatio: normalized.aspectRatio, resolution: normalized.resolution, duration: normalized.duration, assetIds, referenceAssetIds, referenceVideoAssetIds, referenceAudioAssetIds, productImageAssetIds, referenceAssetOrder: safeReferenceAssetOrder, promptBatchId, ...(automaticPrompt ? { promptGenerationPending: true, ...(promptHint ? { promptProvider: promptHint } : {}), ...(promptModelHint ? { promptModel: promptModelHint } : {}), promptTemplateContent } : {}), ...(productSummary ? { productSummary } : { productSummaryLookup: referenceImageName ? 'not_found' : 'no_reference_name' }), ...(rawReferenceImages.length ? { externalReferenceImages: [...rawReferenceImages] } : {}), ...(rawReferenceVideos.length ? { externalReferenceVideos: [...rawReferenceVideos] } : {}), ...(rawReferenceAudios.length ? { externalReferenceAudios: [...rawReferenceAudios] } : {}), ...(typeof input.pid === 'string' && input.pid.trim() ? { pid: input.pid.trim() } : {}) } })));
    for (const task of tasks) enqueueProviderTask({ taskId: task.id, ownerId: ownerId ?? id, mode: 'video', model });
    await flushProviderTaskStore();
    const persistedTasks = tasks.map((task) => getProviderTask(task.id) ?? task);
    const first = persistedTasks[0];
    const queueFull = persistedTasks.some((task) => task.status === 'failed' && task.error === 'scheduler_queue_full');
    return NextResponse.json({ success: !queueFull, data: { taskId: first.id, taskIds: persistedTasks.map((task) => task.id), count: persistedTasks.length, accountId: id, status: first.status, provider: first.provider, execution: 'pending', model: first.model, providerTaskId: first.providerTaskId, progress: first.progress }, ...(queueFull ? { error: 'scheduler_queue_full' } : {}) }, { status: queueFull ? 503 : 202 });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : '';
    const known = ['provider_not_configured', 'provider_unauthorized', 'provider_model_unavailable', 'provider_upstream_failed', 'provider_invalid_request', 'reference_public_base_invalid', 'reference_asset_not_found', 'reference_asset_kind_invalid', 'reference_files_required', 'reference_images_must_be_https', 'reference_videos_must_be_https', 'reference_audios_must_be_https', 'too_many_reference_images', 'too_many_reference_videos', 'too_many_reference_audios', 'wan_reference_audio_requires_visual', 'seedance_reference_audio_requires_visual', 'unsupported_duration', 'unsupported_aspect_ratio', 'unsupported_resolution', 'duration_required', 'yuanai_grok_reference_media_unsupported', 'yuanai_grok_prompt_required', 'yuanai_grok_invalid_duration', 'yuanai_grok_invalid_aspect_ratio', 'yuanai_grok_invalid_resolution', 'yuanai_grok_too_many_reference_images', 'yuanai_grok_reference_urls_must_be_https', 'sdmini_reference_media_unsupported', 'sdmini_model_invalid', 'sdmini_prompt_required', 'sdmini_invalid_seconds', 'sdmini_invalid_resolution', 'sdmini_720p_requires_10s', 'sdmini_invalid_aspect_ratio', 'sdmini_too_many_reference_images', 'sdmini_reference_images_must_be_http', 'seedance_prompt_required', 'seedance_model_invalid', 'seedance_invalid_duration', 'seedance_invalid_aspect_ratio', 'seedance_invalid_resolution', 'seedance_too_many_reference_images', 'seedance_too_many_reference_videos', 'seedance_too_many_reference_audios', 'seedance_reference_urls_must_be_https', 'minimax_prompt_required', 'minimax_invalid_duration', 'minimax_invalid_aspect_ratio', 'minimax_too_many_reference_images', 'minimax_too_many_reference_audios', 'minimax_reference_urls_must_be_https', 'miku_prompt_required', 'miku_invalid_duration', 'miku_invalid_aspect_ratio', 'miku_invalid_resolution', 'miku_too_many_reference_images', 'miku_too_many_reference_videos', 'miku_too_many_reference_audios', 'miku_reference_urls_must_be_https', 'pro666_reference_video_unsupported', 'pro666_prompt_required', 'pro666_too_many_reference_images', 'pro666_too_many_reference_audios', 'pro666_reference_urls_must_be_https', 'mgrouter_reference_audio_unsupported', 'qualityv4_prompt_required', 'qualityv4_invalid_duration', 'qualityv4_invalid_resolution', 'qualityv4_720p_requires_10s', 'qualityv4_invalid_size', 'qualityv4_too_many_reference_images', 'qualityv4_too_many_reference_videos', 'qualityv4_too_many_reference_audios'];
    const responseError = message === 'reference_images_required' || known.includes(message) ? message : 'provider_request_failed';
    const status = responseError === 'provider_not_configured' ? 503 : responseError.startsWith('provider_') ? 502 : 400;
    return NextResponse.json({ success: false, error: responseError }, { status });
  }
}
