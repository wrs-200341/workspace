import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount } from '@/lib/workspace/access';
import { generateBigSnakePrompt, generateGeminiPrompt, generateGPTPrompt, generateOAIRegboxGPTPrompt, generatePromptWithFallback, normalizeProviderResponse, providerResponseSnapshot, sanitizeProviderError, submitVideoWithFallback } from '@/lib/providers/client';
import { getProviderConfig, isProviderLiveEnabled, type ProviderId } from '@/lib/providers/config';
import { createProviderTasks, getProviderTask, listProviderTasks, updateProviderTask, type ProviderTask } from '@/lib/providers/taskStore';
import { validateGenerationRequest } from '@/lib/providers/validation';
import { publishAssetReferences } from '@/lib/workspace/referenceBridge';
import { processMockProviderTask } from '@/lib/providers/taskProcessor';
import { getVideoCapability, validateVideoCapability } from '@/lib/workspace/production/video-capabilities';
import { getDefaultProductionAspectRatio, getDefaultProductionDuration, getDefaultVideoResolution } from '@/lib/workspace/production/defaults';
import { publishProductImageReferences } from '@/lib/workspace/productImages';
import { getDailyQuotaUsage } from '@/lib/workspace/production/dailyQuota';
import { getProductImageAbsolutePath, listProductImageAssets } from '@/lib/workspace/productImages';
import { listAssets, readAssetFile } from '@/lib/workspace/assetStore';
import fs from 'node:fs';
import { firstReferenceImageName } from '@/lib/workspace/taskMetadata';
import { appendProductSummary, lookupProductSummary } from '@/lib/workspace/productSummary';
import * as productSummaryModule from '@/lib/workspace/productSummary';
import { enqueueProviderTask, SCHEDULER_RUNTIME_ID } from '@/lib/providers/concurrency';
import { cacheVideoTaskOutputsBeforeCompletion } from '@/lib/workspace/videoInventory';
import { canonicalTaskProgress } from '@/lib/providers/taskProgress';
import type { GPTPromptAttachment } from '@/lib/providers/payloads';
import { normalizeTaskName, parseTaskNameMode, validateTaskNaming } from '@/lib/workspace/taskNaming';
import { classifyTaskError } from '@/lib/providers/taskErrorInfo';
import { businessDate } from '@/lib/workspace/tasks';

type VideoProvider = 'grok-video' | 'yuanai-grok-video' | 'mgrouter-grok-video' | 'wan3-video' | 'minimax-h3' | 'miku-minimax' | 'pro666-video' | 'quality-v4' | 'oairegbox-omni';
const VIDEO_PROVIDERS: readonly VideoProvider[] = ['grok-video', 'yuanai-grok-video', 'mgrouter-grok-video', 'wan3-video', 'minimax-h3', 'miku-minimax', 'pro666-video', 'quality-v4', 'oairegbox-omni'];
const safeRecoveryRuns = new Map<string, Promise<{ recovered: number; skipped: number }>>();

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
    const run = (async () => {
      let recovered = 0;
      for (const task of safe) {
        if (enqueueRecoveredVideoTask(task)) recovered += 1;
        // Yield between asset publication and scheduler registration so a
        // large repair batch never monopolizes the event loop or delays page
        // navigation for operators.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      return { recovered, skipped: safe.length - recovered };
    })();
    safeRecoveryRuns.set(batchId, run);
    void run.finally(() => { safeRecoveryRuns.delete(batchId); });
    return NextResponse.json({ success: true, data: { batchId, started: safe.length, skipped } });
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
  const model = provider === 'minimax-h3' || provider === 'pro666-video' || provider === 'yuanai-grok-video'
    ? config.model
    : provider === 'grok-video' && requestedModel === 'grok'
      ? config.model
      : requestedModel ?? config.model;
  const isSdMini = provider === 'grok-video' && model.toLowerCase() === 'sd-mini';
  // sd-mini requires seconds explicitly; unlike legacy providers, do not
  // silently inject the provider's first duration when the field is omitted.
  const duration = rawDuration !== undefined ? Math.round(rawDuration) : (isSdMini ? undefined : getDefaultProductionDuration(config.supports.durations));
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
    // Share one prompt-generation request across all outputs in a batch. The
    // promise is reset after a rejection so scheduler retries can try again.
    let childPromptPromise: Promise<GeneratedChildPrompt> | null = null;
    const resolveChildPrompt = automaticPrompt
      ? () => {
        if (!childPromptPromise) {
          childPromptPromise = generateChildPrompt({ accountId: id, title: input.prompt, templateContent: promptTemplateContent, productSummary, promptModel: requestedPromptModel, referenceAssetIds: orderedReferenceAssetIds, productImageAssetIds: orderedProductImageAssetIds }).catch((error) => {
            childPromptPromise = null;
            throw error;
          });
        }
        return childPromptPromise;
      }
      : null;
    // Publish/validate reference media once per request. Previously this work
    // ran inside the count loop, duplicating filesystem copies and registry
    // writes for every output in a batch and making queue submission appear
    // to hang for tens of seconds.
    const live = isProviderLiveEnabled(provider);
    // Publish all account media in one registry transaction. Four separate
    // publishAssetReferences calls each read/copy/write registry.json and made
    // a submit wait noticeably longer (and could race on the registry file).
    const imageCount = orderedReferenceAssetIds.length;
    const videoCount = referenceVideoAssetIds.length;
    const mediaInputs = [
      ...orderedReferenceAssetIds.map((assetId) => ({ accountId: id, assetId, allowedKinds: ['image'] as const })),
      ...referenceVideoAssetIds.map((assetId) => ({ accountId: id, assetId, allowedKinds: ['inventory-video'] as const })),
      ...referenceAudioAssetIds.map((assetId) => ({ accountId: id, assetId, allowedKinds: ['audio'] as const })),
    ];
    const publishedMedia = live ? publishAssetReferences(mediaInputs) : [];
    const publishedImages = publishedMedia.slice(0, imageCount);
    const publishedVideos = publishedMedia.slice(imageCount, imageCount + videoCount);
    const publishedAudios = publishedMedia.slice(imageCount + videoCount);
    const publishedProductImages = live ? publishProductImageReferences(orderedProductImageAssetIds, id) : [];
    const publishedImageUrls = new Map<string, string>();
    orderedReferenceAssetIds.forEach((assetId, assetIndex) => { const item = publishedImages[assetIndex]; if (item) publishedImageUrls.set(assetId, item.url); });
    orderedProductImageAssetIds.forEach((assetId, assetIndex) => { const item = publishedProductImages[assetIndex]; if (item) publishedImageUrls.set(assetId, item.url); });
    const referenceImages = [...rawReferenceImages, ...orderedImageAssets.map((item) => publishedImageUrls.get(item.id)).filter((value): value is string => Boolean(value))];
    const referenceImageTokens = orderedImageAssets.map((item) => {
      if (item.kind === 'image') {
        const index = orderedReferenceAssetIds.indexOf(item.id);
        return publishedImages[index]?.token;
      }
      const index = orderedProductImageAssetIds.indexOf(item.id);
      return publishedProductImages[index]?.token;
    }).filter((value): value is string => Boolean(value));
    const referenceVideos = [...rawReferenceVideos, ...publishedVideos.map((item) => item.url)];
    const referenceAudios = [...rawReferenceAudios, ...publishedAudios.map((item) => item.url)];
    const referenceFiles = provider === 'oairegbox-omni'
      ? orderedImageAssets.map((item) => item.kind === 'image'
        ? (() => {
          const record = readAssetFile(id, item.id);
          if (!record) throw new Error('reference_asset_not_found');
          return { bytes: new Uint8Array(record.bytes), mimeType: record.asset.mimeType || 'application/octet-stream', fileName: record.asset.name };
        })()
        : (() => {
          const product = listProductImageAssets().find((candidate) => candidate.id === item.id);
          if (!product) throw new Error('reference_asset_not_found');
          return { bytes: new Uint8Array(fs.readFileSync(getProductImageAbsolutePath(item.id))), mimeType: product.mimeType, fileName: product.name };
        })())
      : undefined;
    if (provider === 'oairegbox-omni' && rawReferenceImages.length > 0 && !referenceFiles?.length) throw new Error('reference_files_required');
    const normalized = validateGenerationRequest({ provider, model, duration, aspectRatio, resolution, referenceImages, referenceVideos, referenceAudios });
    if (provider === 'wan3-video' || provider === 'grok-video' || provider === 'yuanai-grok-video' || provider === 'mgrouter-grok-video' || provider === 'minimax-h3' || provider === 'miku-minimax' || provider === 'pro666-video' || provider === 'quality-v4' || provider === 'oairegbox-omni') {
        const capability = getVideoCapability(provider, model);
        validateVideoCapability(capability, {
          duration: normalized.duration!,
          aspectRatio: normalized.aspectRatio!,
          resolution: provider === 'wan3-video' ? String(normalized.resolution).toUpperCase() : String(normalized.resolution),
          referenceCount: referenceImages.length,
          referenceVideoCount: referenceVideos.length,
          referenceAudioCount: referenceAudios.length,
        });
    }
    const taskStatus = automaticPrompt ? 'prompting' as const : 'queued' as const;
    const taskPrompt = manualVideoPrompt;
    const promptHint = automaticPrompt ? promptProviderHint(requestedPromptModel) : undefined;
    const promptModelHint = automaticPrompt ? promptModelHintFor(requestedPromptModel) : undefined;
    const tasks = createProviderTasks(Array.from({ length: count }, (_, index) => ({ accountId: id, mode: 'video' as const, provider, model, prompt: taskPrompt, status: taskStatus, progress: automaticPrompt ? 2 : 0, metadata: { ...(ownerId ? { ownerId } : {}), ...(referenceImageName ? { referenceImageName } : {}), ...(taskNameMode ? { taskNameMode } : {}), ...(taskNameMode === 'manual' && taskName ? { taskName } : {}), sequence: index + 1, execution: 'pending', schedulerState: 'waiting', schedulerOwnerId: ownerId ?? id, schedulerMode: 'video', schedulerModel: model, schedulerRuntimeId: SCHEDULER_RUNTIME_ID, modelId: typeof input.modelId === 'string' ? input.modelId : model, supplierId: typeof input.supplierId === 'string' ? input.supplierId : provider, promptMode: typeof input.promptMode === 'string' ? input.promptMode : 'manual', promptModel: requestedPromptModel, templateId: typeof input.templateId === 'string' ? input.templateId : undefined, childPrompt: typeof input.childPrompt === 'string' ? input.childPrompt : undefined, finalPrompt: manualVideoPrompt, originalPrompt: typeof input.originalPrompt === 'string' ? input.originalPrompt : input.prompt, suffixEnabled: input.suffixEnabled === true, count, aspectRatio: normalized.aspectRatio, resolution: normalized.resolution, duration: normalized.duration, assetIds, referenceAssetIds, referenceVideoAssetIds, referenceAudioAssetIds, productImageAssetIds, referenceAssetOrder: safeReferenceAssetOrder, referenceVideos, referenceTokens: referenceImageTokens, ...(automaticPrompt ? { promptGenerationPending: true, ...(promptHint ? { promptProvider: promptHint } : {}), ...(promptModelHint ? { promptModel: promptModelHint } : {}), promptTemplateContent } : {}), ...(productSummary ? { productSummary } : { productSummaryLookup: referenceImageName ? 'not_found' : 'no_reference_name' }), ...(rawReferenceImages.length ? { externalReferenceImages: [...rawReferenceImages] } : {}), ...(rawReferenceVideos.length ? { externalReferenceVideos: [...rawReferenceVideos] } : {}), ...(rawReferenceAudios.length ? { externalReferenceAudios: [...rawReferenceAudios] } : {}), ...(typeof input.pid === 'string' && input.pid.trim() ? { pid: input.pid.trim() } : {}) } })));
    for (const task of tasks) {
      enqueueProviderTask({ taskId: task.id, ownerId: ownerId ?? id, mode: 'video', model, run: async () => {
        let finalPrompt = manualVideoPrompt;
        if (resolveChildPrompt) {
          const current = getProviderTask(task.id);
          updateProviderTask(task.id, { status: 'prompting', progress: canonicalTaskProgress({ mode: 'video', status: 'prompting', progress: current?.progress ?? 0, promptGenerationPending: true }), metadata: { ...(current?.metadata ?? {}), promptGenerationPending: true } });
          try {
            const generated = await resolveChildPrompt();
            // Excel 标题和描述只在生成子提示词时作为输入，最终提交给视频的
            // prompt 就是子提示词模型生成的原文，不额外拼接 Excel 内容。
            finalPrompt = generated.text;
            const generatedTask = getProviderTask(task.id);
            updateProviderTask(task.id, { prompt: finalPrompt, status: 'submitting', progress: canonicalTaskProgress({ mode: 'video', status: 'submitting', progress: generatedTask?.progress ?? 0 }), metadata: { ...(generatedTask?.metadata ?? {}), childPrompt: finalPrompt, finalPrompt, promptGenerationPending: false, promptProvider: generated.provider, promptModel: generated.model, promptGenerationSource: generated.mode, ...(generated.fallbackFrom ? { promptFallbackFrom: generated.fallbackFrom } : {}), ...(generated.fallbackProviders?.length ? { promptFallbackProviders: generated.fallbackProviders } : {}), ...(generated.fallbackModels?.length ? { promptFallbackModels: generated.fallbackModels } : {}) } });
          } catch (error) {
            const failedTask = getProviderTask(task.id);
            const fallbackDetails = error && typeof error === 'object' ? error as { promptProvider?: unknown; promptModel?: unknown; promptFallbackFrom?: unknown; promptFallbackProviders?: unknown; promptFallbackModels?: unknown } : {};
            updateProviderTask(task.id, { status: 'failed', progress: 100, error: sanitizeProviderError(error instanceof Error ? error.message : 'prompt_provider_failed'), providerResponse: providerResponseSnapshot(error), metadata: { ...(failedTask?.metadata ?? {}), promptGenerationPending: false, promptGenerationFailed: true, ...(typeof fallbackDetails.promptProvider === 'string' ? { promptProvider: fallbackDetails.promptProvider } : {}), ...(typeof fallbackDetails.promptModel === 'string' ? { promptModel: fallbackDetails.promptModel } : {}), ...(typeof fallbackDetails.promptFallbackFrom === 'string' ? { promptFallbackFrom: fallbackDetails.promptFallbackFrom } : {}), ...(Array.isArray(fallbackDetails.promptFallbackProviders) ? { promptFallbackProviders: fallbackDetails.promptFallbackProviders.filter((value): value is string => typeof value === 'string') } : {}), ...(Array.isArray(fallbackDetails.promptFallbackModels) ? { promptFallbackModels: fallbackDetails.promptFallbackModels.filter((value): value is string => typeof value === 'string') } : {}) } });
            throw error;
          }
        }
        return submitVideoTask({ taskId: task.id, provider, model, prompt: finalPrompt, duration: normalized.duration!, aspectRatio: normalized.aspectRatio!, resolution: normalized.resolution!, referenceImages, referenceFiles, referenceAudios, referenceVideos });
      } });
    }
    const persistedTasks = tasks.map((task) => getProviderTask(task.id) ?? task);
    const first = persistedTasks[0];
    const queueFull = persistedTasks.some((task) => task.status === 'failed' && task.error === 'scheduler_queue_full');
    return NextResponse.json({ success: !queueFull, data: { taskId: first.id, taskIds: persistedTasks.map((task) => task.id), count: persistedTasks.length, accountId: id, status: first.status, provider: first.provider, execution: 'pending', model: first.model, providerTaskId: first.providerTaskId, progress: first.progress }, ...(queueFull ? { error: 'scheduler_queue_full' } : {}) }, { status: queueFull ? 503 : 202 });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : '';
    const known = ['provider_not_configured', 'provider_unauthorized', 'provider_model_unavailable', 'provider_upstream_failed', 'provider_invalid_request', 'reference_public_base_invalid', 'reference_asset_not_found', 'reference_asset_kind_invalid', 'reference_files_required', 'reference_images_must_be_https', 'reference_videos_must_be_https', 'reference_audios_must_be_https', 'too_many_reference_images', 'too_many_reference_videos', 'too_many_reference_audios', 'unsupported_duration', 'unsupported_aspect_ratio', 'unsupported_resolution', 'duration_required', 'yuanai_grok_reference_media_unsupported', 'yuanai_grok_prompt_required', 'yuanai_grok_invalid_duration', 'yuanai_grok_invalid_aspect_ratio', 'yuanai_grok_invalid_resolution', 'yuanai_grok_too_many_reference_images', 'yuanai_grok_reference_urls_must_be_https', 'sdmini_reference_media_unsupported', 'sdmini_model_invalid', 'sdmini_prompt_required', 'sdmini_invalid_seconds', 'sdmini_invalid_resolution', 'sdmini_720p_requires_10s', 'sdmini_invalid_aspect_ratio', 'sdmini_too_many_reference_images', 'sdmini_reference_images_must_be_http', 'minimax_prompt_required', 'minimax_invalid_duration', 'minimax_invalid_aspect_ratio', 'minimax_too_many_reference_images', 'minimax_too_many_reference_audios', 'minimax_reference_urls_must_be_https', 'miku_prompt_required', 'miku_invalid_duration', 'miku_invalid_aspect_ratio', 'miku_invalid_resolution', 'miku_too_many_reference_images', 'miku_too_many_reference_videos', 'miku_too_many_reference_audios', 'miku_reference_urls_must_be_https', 'pro666_reference_video_unsupported', 'pro666_prompt_required', 'pro666_too_many_reference_images', 'pro666_too_many_reference_audios', 'pro666_reference_urls_must_be_https', 'mgrouter_reference_audio_unsupported', 'qualityv4_prompt_required', 'qualityv4_invalid_duration', 'qualityv4_invalid_resolution', 'qualityv4_720p_requires_10s', 'qualityv4_invalid_size', 'qualityv4_too_many_reference_images', 'qualityv4_too_many_reference_videos', 'qualityv4_too_many_reference_audios'];
    const responseError = known.includes(message) ? message : 'provider_request_failed';
    const status = responseError === 'provider_not_configured' ? 503 : responseError.startsWith('provider_') ? 502 : 400;
    return NextResponse.json({ success: false, error: responseError }, { status });
  }
}

function metadataStrings(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function metadataText(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && Number.isFinite(Number(value)) ? Number(value) : undefined;
}

/**
 * Rebuild a scheduler callback from a persisted task after a process restart.
 * Only the safe-recovery API calls this function, and only for tasks that have
 * no upstream provider id. The original task id is retained so the queue does
 * not show a duplicate logical task.
 */
function enqueueRecoveredVideoTask(task: ProviderTask): boolean {
  if (task.mode !== 'video' || task.status !== 'failed' || task.providerTaskId) return false;
  if (!VIDEO_PROVIDERS.includes(task.provider as VideoProvider)) return false;
  const metadata = task.metadata ?? {};
  const ownerId = metadataText(metadata, 'ownerId') || task.accountId;
  const provider = task.provider as VideoProvider;
  const config = getProviderConfig(provider);
  const model = task.model || metadataText(metadata, 'modelId') || config.model;
  const referenceAssetIds = metadataStrings(metadata, 'referenceAssetIds').length ? metadataStrings(metadata, 'referenceAssetIds') : metadataStrings(metadata, 'assetIds');
  const referenceVideoAssetIds = metadataStrings(metadata, 'referenceVideoAssetIds');
  const referenceAudioAssetIds = metadataStrings(metadata, 'referenceAudioAssetIds');
  const productImageAssetIds = metadataStrings(metadata, 'productImageAssetIds');
  const referenceAssetOrder = parseAssetOrder(metadata.referenceAssetOrder);
  const orderedImages = (referenceAssetOrder.length
    ? referenceAssetOrder.filter((item) => item.kind === 'image' || item.kind === 'product-image')
    : [...referenceAssetIds.map((id) => ({ id, kind: 'image' as const })), ...productImageAssetIds.map((id) => ({ id, kind: 'product-image' as const }))])
    .filter((item) => referenceAssetIds.includes(item.id) || productImageAssetIds.includes(item.id));
  const orderedReferenceAssetIds = orderedImages.filter((item) => item.kind === 'image').map((item) => item.id);
  const orderedProductImageAssetIds = orderedImages.filter((item) => item.kind === 'product-image').map((item) => item.id);
  const externalImages = metadataStrings(metadata, 'externalReferenceImages');
  const externalVideos = metadataStrings(metadata, 'externalReferenceVideos');
  const externalAudios = metadataStrings(metadata, 'externalReferenceAudios');
  const live = isProviderLiveEnabled(provider);
  try {
    const publishedMedia = live ? publishAssetReferences([
      ...orderedReferenceAssetIds.map((assetId) => ({ accountId: task.accountId, assetId, allowedKinds: ['image'] as const })),
      ...referenceVideoAssetIds.map((assetId) => ({ accountId: task.accountId, assetId, allowedKinds: ['inventory-video'] as const })),
      ...referenceAudioAssetIds.map((assetId) => ({ accountId: task.accountId, assetId, allowedKinds: ['audio'] as const })),
    ]) : [];
    const publishedImages = publishedMedia.slice(0, orderedReferenceAssetIds.length);
    const publishedVideos = publishedMedia.slice(orderedReferenceAssetIds.length, orderedReferenceAssetIds.length + referenceVideoAssetIds.length);
    const publishedAudios = publishedMedia.slice(orderedReferenceAssetIds.length + referenceVideoAssetIds.length);
    const publishedProducts = live ? publishProductImageReferences(orderedProductImageAssetIds, task.accountId) : [];
    const imageById = new Map<string, string>();
    orderedReferenceAssetIds.forEach((id, index) => { if (publishedImages[index]) imageById.set(id, publishedImages[index].url); });
    orderedProductImageAssetIds.forEach((id, index) => { if (publishedProducts[index]) imageById.set(id, publishedProducts[index].url); });
    const referenceImages = [...externalImages, ...orderedImages.map((item) => imageById.get(item.id)).filter((value): value is string => Boolean(value))];
    const referenceVideos = [...externalVideos, ...publishedVideos.map((item) => item.url)];
    const referenceAudios = [...externalAudios, ...publishedAudios.map((item) => item.url)];
    const referenceFiles = provider === 'oairegbox-omni'
      ? orderedImages.map((item) => {
        if (item.kind === 'image') {
          const record = readAssetFile(task.accountId, item.id);
          if (!record) throw new Error('reference_asset_not_found');
          return { bytes: new Uint8Array(record.bytes), mimeType: record.asset.mimeType || 'application/octet-stream', fileName: record.asset.name };
        }
        const product = listProductImageAssets().find((candidate) => candidate.id === item.id);
        if (!product) throw new Error('reference_asset_not_found');
        return { bytes: new Uint8Array(fs.readFileSync(getProductImageAbsolutePath(item.id))), mimeType: product.mimeType, fileName: product.name };
      })
      : undefined;
    const duration = metadataNumber(metadata, 'duration') ?? getDefaultProductionDuration(config.supports.durations);
    const aspectRatio = metadataText(metadata, 'aspectRatio') ?? getDefaultProductionAspectRatio(config.supports.ratios);
    const resolution = metadataText(metadata, 'resolution') ?? getDefaultVideoResolution(config.supports.resolutions);
    const automaticPrompt = metadata.promptMode === 'asset-template-child-prompt' && (metadata.promptGenerationPending === true || !task.prompt);
    const originalPrompt = metadataText(metadata, 'originalPrompt') || task.prompt || '';
    const promptModel = metadataText(metadata, 'promptModel') || 'pomoai-gpt';
    const title = metadataText(metadata, 'referenceImageName') || originalPrompt;
    const templateContent = metadataText(metadata, 'promptTemplateContent') || '';
    const productSummary = lookupProductSummary(title);
    const run = async () => {
      let finalPrompt = task.prompt || metadataText(metadata, 'finalPrompt') || originalPrompt;
      if (automaticPrompt) {
        updateProviderTask(task.id, { status: 'prompting', progress: 2, metadata: { ...(getProviderTask(task.id)?.metadata ?? metadata), promptGenerationPending: true } });
        const generated = await generateChildPrompt({ accountId: task.accountId, title, templateContent, productSummary, promptModel, referenceAssetIds: orderedReferenceAssetIds, productImageAssetIds: orderedProductImageAssetIds });
        finalPrompt = generated.text;
        updateProviderTask(task.id, { prompt: finalPrompt, status: 'submitting', progress: 30, metadata: { ...(getProviderTask(task.id)?.metadata ?? metadata), promptGenerationPending: false, promptGenerationFailed: false, childPrompt: finalPrompt, finalPrompt, promptProvider: generated.provider, promptModel: generated.model, promptGenerationSource: generated.mode } });
      }
      await submitVideoTask({ taskId: task.id, provider, model, prompt: finalPrompt, duration, aspectRatio, resolution, referenceImages, referenceFiles, referenceAudios, referenceVideos });
    };
    updateProviderTask(task.id, { status: automaticPrompt ? 'prompting' : 'queued', progress: automaticPrompt ? 2 : 0, error: undefined, providerTaskId: undefined, outputUrls: [], outputBase64: [], metadata: { ...metadata, schedulerState: 'waiting', schedulerOwnerId: ownerId, schedulerMode: 'video', schedulerModel: model, schedulerRuntimeId: SCHEDULER_RUNTIME_ID, recoveryRequestedAt: new Date().toISOString(), recoveryAttempts: (metadataNumber(metadata, 'recoveryAttempts') ?? 0) + 1, promptGenerationPending: automaticPrompt } });
    return enqueueProviderTask({ taskId: task.id, ownerId, mode: 'video', model, run });
  } catch (error) {
    updateProviderTask(task.id, { error: sanitizeProviderError(error instanceof Error ? error.message : 'reference_asset_not_found'), providerResponse: providerResponseSnapshot(error), status: 'failed', progress: 100 });
    return false;
  }
}

async function submitVideoTask(input: { taskId: string; provider: VideoProvider; model: string; prompt: string; duration: number; aspectRatio: string; resolution: string; referenceImages: string[]; referenceFiles?: Array<{ bytes: Uint8Array; mimeType: string; fileName: string }>; referenceAudios: string[]; referenceVideos: string[] }): Promise<void> {
  let providerResponse: unknown;
  try {
    const previousProvider = getProviderTask(input.taskId)?.metadata?.lastProviderFailure;
    const skipProviders = typeof previousProvider === 'string' && VIDEO_PROVIDERS.includes(previousProvider as VideoProvider) ? [previousProvider as ProviderId] : undefined;
    const submitted = await submitVideoWithFallback({ provider: input.provider, model: input.model, prompt: input.prompt, duration: input.duration, aspectRatio: input.aspectRatio, resolution: input.resolution, referenceImages: input.referenceImages, referenceFiles: input.referenceFiles, referenceAudios: input.referenceAudios, referenceVideos: input.referenceVideos, media: [...input.referenceImages.map((url) => ({ type: 'reference_image' as const, url })), ...input.referenceVideos.map((url) => ({ type: 'reference_video' as const, url })), ...input.referenceAudios.map((url) => ({ type: 'audio' as const, url }))] }, skipProviders ? { skipProviders } : undefined);
    providerResponse = submitted.response;
    const status = normalizeProviderResponse(submitted.provider, submitted.response);
    const current = getProviderTask(input.taskId);
    // Only treat an unrecognised response as "waiting upstream" when there is a
    // provider task id to poll; otherwise nothing will ever advance it and the
    // task would sit in the queue indefinitely.
    const unresumable = status.status === 'unknown' && !status.providerTaskId && !status.outputUrls.length && !status.outputBase64.length;
    const normalizedStatus = unresumable ? 'failed' as const : status.status === 'unknown' ? 'queued' as const : status.status;
    const cacheTask = current ? { ...current, provider: submitted.provider, model: submitted.model, status: 'completed' as const, progress: 100, providerTaskId: status.providerTaskId ?? current.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64 } : null;
    const cache = normalizedStatus === 'completed' && cacheTask
      ? await cacheVideoTaskOutputsBeforeCompletion(cacheTask.accountId, cacheTask)
      : null;
    const noOutput = normalizedStatus === 'completed' && cache?.expected === 0;
    const cachePending = normalizedStatus === 'completed' && cache && cache.expected > 0 && !cache.ready;
    const finalStatus = noOutput ? 'failed' : cachePending ? 'processing' : normalizedStatus;
    const updated = updateProviderTask(input.taskId, { provider: submitted.provider, model: submitted.model, status: finalStatus, progress: canonicalTaskProgress({ mode: 'video', status: finalStatus, progress: status.progress, providerTaskId: status.providerTaskId, schedulerState: cachePending ? 'provider-active' : undefined, localOutputReady: cache?.ready === true, localOutputPending: cachePending === true }), providerTaskId: status.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64, error: noOutput ? 'provider_upstream_failed' : unresumable ? (status.error || 'provider_response_unrecognized') : status.error, providerResponse: status.status === 'failed' || noOutput || unresumable ? providerResponseSnapshot(new Error(status.error ?? 'provider_response_unrecognized'), { body: providerResponse, method: 'POST' }) : undefined, metadata: { ...(current?.metadata ?? {}), execution: submitted.mode, ...(submitted.fallbackFrom ? { fallbackFrom: submitted.fallbackFrom, fallbackProviders: submitted.fallbackProviders, fallbackParameters: submitted.fallbackParameters } : {}), ...(cache ? { localOutputCount: cache.cached, localOutputExpected: cache.expected, localOutputReady: cache.ready } : {}) } });
    if (updated && submitted.mode === 'mock') void processMockProviderTask(input.taskId);
  } catch (error) {
    updateProviderTask(input.taskId, { status: 'failed', progress: 100, error: sanitizeProviderError(error instanceof Error ? error.message : ''), providerResponse: providerResponseSnapshot(error, providerResponse === undefined ? undefined : { body: providerResponse, method: 'POST' }), metadata: { ...(getProviderTask(input.taskId)?.metadata ?? {}), execution: 'failed' } });
  }
}

function promptProviderHint(requested: string): ProviderId | undefined {
  const normalized = requested.trim().toLowerCase();
  if (normalized === 'pomoai-gpt' || normalized === 'pomoai-gpt-prompt' || normalized.startsWith('pomoai:')) return 'pomoai-gpt-prompt';
  if (normalized === 'oairegbox-gpt' || normalized === 'oairegbox-gpt-prompt') return 'oairegbox-gpt-prompt';
  if (normalized === 'bigsnake' || normalized.startsWith('bigsnake:')) return 'bigsnake-prompt';
  if (normalized === 'gpt-2999' || /^gpt[-_]/i.test(normalized)) return 'gpt-2999-prompt';
  if (/^gemini[-_]/i.test(normalized)) return 'yuanai-gemini-prompt';
  return undefined;
}

function promptModelHintFor(requested: string): string | undefined {
  const normalized = requested.trim();
  if (!normalized) return undefined;
  if (normalized === 'pomoai-gpt' || normalized === 'pomoai-gpt-prompt') return getProviderConfig('pomoai-gpt-prompt').model;
  if (normalized.startsWith('pomoai:')) return normalized.slice('pomoai:'.length).trim() || getProviderConfig('pomoai-gpt-prompt').model;
  if (normalized === 'oairegbox-gpt' || normalized === 'oairegbox-gpt-prompt') return getProviderConfig('oairegbox-gpt-prompt').model;
  if (normalized === 'bigsnake') return getProviderConfig('bigsnake-prompt').model;
  if (normalized.startsWith('bigsnake:')) return normalized.slice('bigsnake:'.length).trim() || getProviderConfig('bigsnake-prompt').model;
  if (normalized === 'gpt-2999') return getProviderConfig('gpt-2999-prompt').model;
  return normalized;
}

type GeneratedChildPrompt = { provider: ProviderId; model: string; mode: 'live' | 'mock'; text: string; response: unknown; fallbackFrom?: ProviderId; fallbackProviders?: ProviderId[]; fallbackModels?: string[] };

const MAX_PROMPT_REFERENCE_BYTES = 40 * 1024 * 1024;

/** Generate a child prompt inside the scheduler instead of blocking task creation. */
async function generateChildPrompt(input: {
  accountId: string;
  title: string;
  templateContent: string;
  productSummary: ReturnType<typeof lookupProductSummary>;
  promptModel: string;
  referenceAssetIds: readonly string[];
  productImageAssetIds: readonly string[];
}): Promise<GeneratedChildPrompt> {
  const references = readPromptReferences(input.accountId, input.referenceAssetIds, input.productImageAssetIds);
  const generationPrompt = appendProductSummary(
    `请为商品“${input.title.trim()}”生成适合 TikTok 带货视频的子提示词。${input.templateContent.trim()}`.trim(),
    input.productSummary,
  );
  const requested = input.promptModel.trim() || 'pomoai-gpt';
  const isPomoFallback = requested === 'pomoai-gpt' || requested === 'pomoai-gpt-prompt' || requested.startsWith('pomoai:');
  const isOAIRegbox = requested === 'oairegbox-gpt' || requested === 'oairegbox-gpt-prompt';
  const isBigSnake = requested === 'bigsnake' || requested.startsWith('bigsnake:');
  const isGpt = requested === 'gpt-2999' || /^gpt[-_]/i.test(requested);
  const isGemini = /^gemini[-_]/i.test(requested);
  if (!isPomoFallback && !isOAIRegbox && !isBigSnake && !isGpt && !isGemini) throw new Error('prompt_model_invalid');

  if (isPomoFallback) {
    const selectedPomoModel = requested.startsWith('pomoai:') ? requested.slice('pomoai:'.length).trim() : undefined;
    const result = await generatePromptWithFallback({ model: selectedPomoModel || undefined, prompt: generationPrompt, attachments: references });
    return { ...result, text: result.text.trim() || generationPrompt };
  }
  if (isOAIRegbox) {
    const result = await generateOAIRegboxGPTPrompt({ prompt: generationPrompt, attachments: references });
    return { ...result, text: result.text.trim() || generationPrompt };
  }

  if (isBigSnake) {
    const provider: ProviderId = 'bigsnake-prompt';
    const config = getProviderConfig(provider);
    const model = requested.startsWith('bigsnake:') ? requested.slice('bigsnake:'.length).trim() || config.model : config.model;
    const result = await generateBigSnakePrompt({ model, prompt: generationPrompt, attachments: references });
    return { provider, model, mode: result.mode, text: result.text.trim() || generationPrompt, response: result.response };
  }
  if (isGpt) {
    const provider: ProviderId = 'gpt-2999-prompt';
    const config = getProviderConfig(provider);
    const model = /^gpt[-_]/i.test(requested) && requested !== 'gpt-2999' ? requested : config.model;
    const result = await generateGPTPrompt({ model, messages: [{ role: 'user', content: generationPrompt }], attachments: references });
    return { provider, model, mode: result.mode, text: result.text.trim() || generationPrompt, response: result.response };
  }
  const provider: ProviderId = 'yuanai-gemini-prompt';
  const config = getProviderConfig(provider);
  const model = isGemini ? requested : config.model;
  const result = await generateGeminiPrompt({ model, prompt: generationPrompt, references });
  return { provider, model, mode: result.mode, text: result.text.trim() || generationPrompt, response: result.response };
}

function readPromptReferences(accountId: string, referenceAssetIds: readonly string[], productImageAssetIds: readonly string[]): GPTPromptAttachment[] {
  const references: GPTPromptAttachment[] = [];
  let totalBytes = 0;
  for (const assetId of referenceAssetIds) {
    const stored = readAssetFile(accountId, assetId);
    if (!stored || stored.asset.kind !== 'image') throw new Error('reference_asset_not_found');
    totalBytes += stored.bytes.byteLength;
    if (totalBytes > MAX_PROMPT_REFERENCE_BYTES) throw new Error('reference_images_too_large');
    references.push({ name: stored.asset.name, mimeType: stored.asset.mimeType || 'image/png', dataBase64: Buffer.from(stored.bytes).toString('base64') });
  }
  const products = listProductImageAssets();
  for (const assetId of productImageAssetIds) {
    const product = products.find((candidate) => candidate.id === assetId);
    if (!product) throw new Error('reference_asset_not_found');
    // Product-image assets are shared across operator workspaces.  The source
    // file is already validated under the workspace root by productImages.ts;
    // no per-account ownership check should be applied here.
    let bytes: Buffer;
    try { bytes = fs.readFileSync(getProductImageAbsolutePath(assetId)); } catch { throw new Error('reference_asset_not_found'); }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PROMPT_REFERENCE_BYTES) throw new Error('reference_images_too_large');
    references.push({ name: product.name, mimeType: product.mimeType || 'image/png', dataBase64: bytes.toString('base64') });
  }
  return references;
}

function parseAssetOrder(value: unknown): Array<{ id: string; kind: 'image' | 'product-image' | 'inventory-video' | 'audio' }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { id?: unknown; kind?: unknown } => Boolean(item && typeof item === 'object'))
    .map((item) => ({ id: typeof item.id === 'string' ? item.id.trim() : '', kind: item.kind }))
    .filter((item): item is { id: string; kind: 'image' | 'product-image' | 'inventory-video' | 'audio' } => Boolean(item.id) && ['image', 'product-image', 'inventory-video', 'audio'].includes(String(item.kind)))
    .map((item) => ({ id: item.id, kind: item.kind as 'image' | 'product-image' | 'inventory-video' | 'audio' }))
    .slice(0, 16);
}
