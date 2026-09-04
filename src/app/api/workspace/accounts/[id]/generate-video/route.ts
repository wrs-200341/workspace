import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount } from '@/lib/workspace/access';
import { generateBigSnakePrompt, generateGeminiPrompt, generateGPTPrompt, normalizeProviderResponse, providerResponseSnapshot, sanitizeProviderError, submitVideo } from '@/lib/providers/client';
import { getProviderConfig, isProviderLiveEnabled, type ProviderId } from '@/lib/providers/config';
import { createProviderTasks, getProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { validateGenerationRequest } from '@/lib/providers/validation';
import { publishAssetReferences } from '@/lib/workspace/referenceBridge';
import { processMockProviderTask } from '@/lib/providers/taskProcessor';
import { getVideoCapability, validateVideoCapability } from '@/lib/workspace/production/video-capabilities';
import { getDefaultProductionAspectRatio, getDefaultProductionDuration, getDefaultVideoResolution } from '@/lib/workspace/production/defaults';
import { publishProductImageReferences } from '@/lib/workspace/productImages';
import { getProductImageAbsolutePath, listProductImageAssets } from '@/lib/workspace/productImages';
import { listAssets, readAssetFile } from '@/lib/workspace/assetStore';
import fs from 'node:fs';
import { firstReferenceImageName } from '@/lib/workspace/taskMetadata';
import { appendProductSummary, lookupProductSummary } from '@/lib/workspace/productSummary';
import * as productSummaryModule from '@/lib/workspace/productSummary';
import { enqueueProviderTask, SCHEDULER_RUNTIME_ID } from '@/lib/providers/concurrency';
import { cacheVideoTaskOutputsBeforeCompletion } from '@/lib/workspace/videoInventory';
import type { GPTPromptAttachment } from '@/lib/providers/payloads';

type VideoProvider = 'grok-video' | 'mgrouter-grok-video' | 'wan3-video' | 'minimax-h3' | 'quality-v4' | 'oairegbox-omni';
const VIDEO_PROVIDERS: readonly VideoProvider[] = ['grok-video', 'mgrouter-grok-video', 'wan3-video', 'minimax-h3', 'quality-v4', 'oairegbox-omni'];

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  if (!body || typeof body !== 'object' || typeof (body as { prompt?: unknown }).prompt !== 'string' || !(body as { prompt: string }).prompt.trim()) {
    return NextResponse.json({ success: false, error: 'prompt_required' }, { status: 400 });
  }
  const input = body as { prompt: string; provider?: unknown; model?: unknown; modelId?: unknown; supplierId?: unknown; promptMode?: unknown; promptModel?: unknown; templateId?: unknown; childPrompt?: unknown; finalPrompt?: unknown; originalPrompt?: unknown; suffixEnabled?: unknown; suffix?: unknown; count?: unknown; duration?: unknown; seconds?: unknown; aspectRatio?: unknown; resolution?: unknown; referenceImages?: unknown; referenceVideos?: unknown; referenceAudios?: unknown; assetIds?: unknown; referenceAssetIds?: unknown; referenceVideoAssetIds?: unknown; referenceAudioAssetIds?: unknown; productImageAssetIds?: unknown; referenceAssetOrder?: unknown; pid?: unknown };
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
  const model = provider === 'minimax-h3'
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
    const referenceImageName = firstReferenceImageName({ accountId: id, referenceAssetIds: orderedReferenceAssetIds, assetIds, productImageAssetIds: orderedProductImageAssetIds, rawReferenceImages });
    const accountLookup = (productSummaryModule as typeof productSummaryModule & { lookupProductSummaryForAccount?: typeof lookupProductSummary }).lookupProductSummaryForAccount;
    const productSummary = typeof accountLookup === 'function' ? accountLookup(id, referenceImageName) : lookupProductSummary(referenceImageName);
    const promptWithSummary = appendProductSummary(input.prompt, productSummary);
    const automaticPrompt = input.promptMode === 'asset-template-child-prompt';
    const requestedPromptModel = typeof input.promptModel === 'string' && input.promptModel.trim() ? input.promptModel.trim() : 'gemini-2.5-flash';
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
    if (provider === 'wan3-video' || provider === 'grok-video' || provider === 'mgrouter-grok-video' || provider === 'minimax-h3' || provider === 'quality-v4' || provider === 'oairegbox-omni') {
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
    const taskPrompt = automaticPrompt ? input.prompt.trim() : promptWithSummary;
    const tasks = createProviderTasks(Array.from({ length: count }, (_, index) => ({ accountId: id, mode: 'video' as const, provider, model, prompt: taskPrompt, status: taskStatus, progress: automaticPrompt ? 2 : 0, metadata: { ...(ownerId ? { ownerId } : {}), ...(referenceImageName ? { referenceImageName } : {}), sequence: index + 1, execution: 'pending', schedulerState: 'waiting', schedulerOwnerId: ownerId ?? id, schedulerMode: 'video', schedulerModel: model, schedulerRuntimeId: SCHEDULER_RUNTIME_ID, modelId: typeof input.modelId === 'string' ? input.modelId : model, supplierId: typeof input.supplierId === 'string' ? input.supplierId : provider, promptMode: typeof input.promptMode === 'string' ? input.promptMode : 'manual', promptModel: requestedPromptModel, templateId: typeof input.templateId === 'string' ? input.templateId : undefined, childPrompt: typeof input.childPrompt === 'string' ? input.childPrompt : undefined, finalPrompt: automaticPrompt ? undefined : promptWithSummary, originalPrompt: typeof input.originalPrompt === 'string' ? input.originalPrompt : input.prompt, suffixEnabled: input.suffixEnabled === true, count, aspectRatio: normalized.aspectRatio, resolution: normalized.resolution, duration: normalized.duration, assetIds, referenceAssetIds, referenceVideoAssetIds, referenceAudioAssetIds, productImageAssetIds, referenceAssetOrder: safeReferenceAssetOrder, referenceVideos, referenceTokens: referenceImageTokens, ...(automaticPrompt ? { promptGenerationPending: true, promptTemplateContent } : {}), ...(productSummary ? { productSummary } : { productSummaryLookup: referenceImageName ? 'not_found' : 'no_reference_name' }), ...(rawReferenceImages.length ? { externalReferenceImages: [...rawReferenceImages] } : {}), ...(rawReferenceVideos.length ? { externalReferenceVideos: [...rawReferenceVideos] } : {}), ...(rawReferenceAudios.length ? { externalReferenceAudios: [...rawReferenceAudios] } : {}), ...(typeof input.pid === 'string' && input.pid.trim() ? { pid: input.pid.trim() } : {}) } })));
    for (const task of tasks) {
      enqueueProviderTask({ taskId: task.id, ownerId: ownerId ?? id, mode: 'video', model, run: async () => {
        let finalPrompt = promptWithSummary;
        if (resolveChildPrompt) {
          const current = getProviderTask(task.id);
          updateProviderTask(task.id, { status: 'prompting', progress: Math.max(2, current?.progress ?? 0), metadata: { ...(current?.metadata ?? {}), promptGenerationPending: true } });
          try {
            const generated = await resolveChildPrompt();
            finalPrompt = generated.text;
            const generatedTask = getProviderTask(task.id);
            updateProviderTask(task.id, { prompt: finalPrompt, status: 'submitting', progress: Math.max(5, generatedTask?.progress ?? 0), metadata: { ...(generatedTask?.metadata ?? {}), childPrompt: finalPrompt, finalPrompt, promptGenerationPending: false, promptProvider: generated.provider, promptModel: generated.model, promptGenerationSource: generated.mode } });
          } catch (error) {
            const failedTask = getProviderTask(task.id);
            updateProviderTask(task.id, { status: 'failed', progress: 100, error: sanitizeProviderError(error instanceof Error ? error.message : 'prompt_provider_failed'), providerResponse: providerResponseSnapshot(error), metadata: { ...(failedTask?.metadata ?? {}), promptGenerationPending: false, promptGenerationFailed: true } });
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
      const known = ['provider_not_configured', 'provider_unauthorized', 'provider_model_unavailable', 'provider_upstream_failed', 'provider_invalid_request', 'reference_public_base_invalid', 'reference_asset_not_found', 'reference_asset_kind_invalid', 'reference_files_required', 'reference_images_must_be_https', 'reference_videos_must_be_https', 'reference_audios_must_be_https', 'too_many_reference_images', 'too_many_reference_videos', 'too_many_reference_audios', 'unsupported_duration', 'unsupported_aspect_ratio', 'unsupported_resolution', 'duration_required', 'sdmini_reference_media_unsupported', 'sdmini_model_invalid', 'sdmini_prompt_required', 'sdmini_invalid_seconds', 'sdmini_invalid_resolution', 'sdmini_720p_requires_10s', 'sdmini_invalid_aspect_ratio', 'sdmini_too_many_reference_images', 'sdmini_reference_images_must_be_http', 'minimax_prompt_required', 'minimax_invalid_duration', 'minimax_invalid_aspect_ratio', 'minimax_too_many_reference_images', 'minimax_too_many_reference_audios', 'minimax_reference_urls_must_be_https', 'mgrouter_reference_audio_unsupported', 'qualityv4_prompt_required', 'qualityv4_invalid_duration', 'qualityv4_invalid_resolution', 'qualityv4_720p_requires_10s', 'qualityv4_invalid_size', 'qualityv4_too_many_reference_images', 'qualityv4_too_many_reference_videos', 'qualityv4_too_many_reference_audios'];
    const responseError = known.includes(message) ? message : 'provider_request_failed';
    const status = responseError === 'provider_not_configured' ? 503 : responseError.startsWith('provider_') ? 502 : 400;
    return NextResponse.json({ success: false, error: responseError }, { status });
  }
}

async function submitVideoTask(input: { taskId: string; provider: VideoProvider; model: string; prompt: string; duration: number; aspectRatio: string; resolution: string; referenceImages: string[]; referenceFiles?: Array<{ bytes: Uint8Array; mimeType: string; fileName: string }>; referenceAudios: string[]; referenceVideos: string[] }): Promise<void> {
  let providerResponse: unknown;
  try {
    const submitted = await submitVideo({ provider: input.provider, model: input.model, prompt: input.prompt, duration: input.duration, aspectRatio: input.aspectRatio, resolution: input.resolution, referenceImages: input.referenceImages, referenceFiles: input.referenceFiles, referenceAudios: input.referenceAudios, referenceVideos: input.referenceVideos, media: [...input.referenceImages.map((url) => ({ type: 'reference_image' as const, url })), ...input.referenceVideos.map((url) => ({ type: 'reference_video' as const, url })), ...input.referenceAudios.map((url) => ({ type: 'audio' as const, url }))] });
    providerResponse = submitted.response;
    const status = normalizeProviderResponse(input.provider, submitted.response);
    const current = getProviderTask(input.taskId);
    const normalizedStatus = status.status === 'unknown' ? 'queued' : status.status;
    const cacheTask = current ? { ...current, status: 'completed' as const, progress: 100, providerTaskId: status.providerTaskId ?? current.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64 } : null;
    const cache = normalizedStatus === 'completed' && cacheTask
      ? await cacheVideoTaskOutputsBeforeCompletion(cacheTask.accountId, cacheTask)
      : null;
    const noOutput = normalizedStatus === 'completed' && cache?.expected === 0;
    const cachePending = normalizedStatus === 'completed' && cache && cache.expected > 0 && !cache.ready;
    const updated = updateProviderTask(input.taskId, { status: noOutput ? 'failed' : cachePending ? 'processing' : normalizedStatus, progress: noOutput ? 100 : cachePending ? 99 : status.progress, providerTaskId: status.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64, error: noOutput ? 'provider_upstream_failed' : status.error, providerResponse: status.status === 'failed' || noOutput ? providerResponseSnapshot(new Error(status.error ?? 'provider_upstream_failed'), { body: providerResponse, method: 'POST' }) : undefined, metadata: { ...(current?.metadata ?? {}), execution: submitted.mode, ...(cache ? { localOutputCount: cache.cached, localOutputExpected: cache.expected, localOutputReady: cache.ready } : {}) } });
    if (updated && submitted.mode === 'mock') void processMockProviderTask(input.taskId);
  } catch (error) {
    updateProviderTask(input.taskId, { status: 'failed', progress: 100, error: sanitizeProviderError(error instanceof Error ? error.message : ''), providerResponse: providerResponseSnapshot(error, providerResponse === undefined ? undefined : { body: providerResponse, method: 'POST' }), metadata: { ...(getProviderTask(input.taskId)?.metadata ?? {}), execution: 'failed' } });
  }
}

type GeneratedChildPrompt = { provider: ProviderId; model: string; mode: 'live' | 'mock'; text: string; response: unknown };

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
  const requested = input.promptModel.trim() || 'gemini-2.5-flash';
  const isBigSnake = requested === 'bigsnake' || requested.startsWith('bigsnake:');
  const isGpt = requested === 'gpt-2999' || /^gpt[-_]/i.test(requested);
  const isGemini = /^gemini[-_]/i.test(requested);
  if (!isBigSnake && !isGpt && !isGemini) throw new Error('prompt_model_invalid');

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
