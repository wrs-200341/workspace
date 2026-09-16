import fs from 'node:fs';
import { generateMGRouterImage, generateSeedreamImage, generateYuanAIImage, generatePomoAIImage, generateOpenAICompatibleImage, generateGeminiNativeImage, generateOriginNanoImage, normalizeProviderResponse, providerErrorInfo, providerResponseSnapshot, sanitizeProviderError } from './client';
import { getProviderConfig, isProviderLiveEnabled, type ProviderId } from './config';
import { flushProviderTaskStore, getProviderTask, updateProviderTask, type ProviderTask } from './taskStore';
import { validateGenerationRequest } from './validation';
import { processMockProviderTask } from './taskProcessor';
import { assertAssetReference, publishAssetReferences } from '@/lib/workspace/referenceBridge';
import { getWorkspacePath } from '@/lib/storagePaths';
import { cacheImageTaskOutputsBeforeCompletion, localImageOutputUrls } from '@/lib/workspace/imageInventory';
import { getProductImageAbsolutePath, readProductImageAsset, publishProductImageReferences } from '@/lib/workspace/productImages';

type ImageAsset = { id: string; kind: 'image' | 'product-image' };
type ReferenceFile = { bytes: Uint8Array; mimeType: string; fileName: string };
type ImageSubmissionInput = {
  accountId: string;
  taskId: string;
  schedulerWorkerId?: string;
  provider: ProviderId;
  model: string;
  prompt: string;
  normalized: { aspectRatio?: string; resolution?: string };
  images: string[];
  referenceAssetOrder: ImageAsset[];
  yuanReferenceFiles?: ReferenceFile[];
  originReferenceFiles?: ReferenceFile[];
  pomoReferences: Array<{ mimeType: string; dataBase64: string }>;
};

/** Rebuild all request inputs from the durable record, never from a route closure. */
export async function executePersistedImageTask(taskId: string): Promise<void> {
  let task = getProviderTask(taskId);
  if (!task || task.mode !== 'image' || ['completed', 'cancelled', 'paused'].includes(task.status)) return;
  if (!task.outputUrls.length && !task.outputBase64.length && task.providerResponse && typeof task.providerResponse === 'object') {
    const body = (task.providerResponse as { body?: unknown }).body;
    const response = body === undefined ? undefined : normalizeProviderResponse(task.provider, body);
    const previousFailedAttempt = response?.status === 'failed' && !task.providerTaskId && !task.metadata?.providerAcceptedAt;
    if (response && !previousFailedAttempt && (response.outputUrls.length || response.outputBase64.length || response.providerTaskId)) {
      task = updateProviderTask(taskId, {
        providerTaskId: task.providerTaskId ?? response.providerTaskId,
        outputUrls: response.outputUrls, outputBase64: response.outputBase64,
        metadata: { ...(task.metadata ?? {}), providerAcceptedAt: task.metadata?.providerAcceptedAt ?? new Date().toISOString(), lastProviderStatus: response.status, schedulerRetryExhausted: response.status === 'failed' ? false : task.metadata?.schedulerRetryExhausted === true },
      }) ?? task;
      await flushProviderTaskStore();
    }
  }
  if (task.outputUrls.length || task.outputBase64.length) {
    await recoverImageOutputs(task);
    return;
  }
  if (task.providerTaskId) return;
  if (task.metadata?.providerAcceptedAt || task.metadata?.providerSubmissionStartedAt || task.metadata?.providerSubmissionUncertain) {
    await markSubmissionUncertain(taskId);
    return;
  }
  let input: ImageSubmissionInput;
  try {
    input = rebuildImageSubmission(task);
  } catch (error) {
    const latest = getProviderTask(taskId);
    updateProviderTask(taskId, { status: 'failed', progress: 100, error: sanitizeProviderError(error instanceof Error ? error.message : ''), metadata: { ...(latest?.metadata ?? {}), execution: 'failed', schedulerRetryExhausted: true } });
    await flushProviderTaskStore();
    return;
  }
  await submitImageTask(input);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function imageAssetOrder(task: ProviderTask): ImageAsset[] {
  const metadata = task.metadata ?? {};
  const assetIds = strings(metadata.assetIds);
  const productIds = strings(metadata.productImageAssetIds);
  if (!Array.isArray(metadata.referenceAssetOrder)) return [...assetIds.map((id) => ({ id, kind: 'image' as const })), ...productIds.map((id) => ({ id, kind: 'product-image' as const }))];
  return metadata.referenceAssetOrder.filter((item): item is ImageAsset => {
    if (!item || typeof item !== 'object') return false;
    const asset = item as Partial<ImageAsset>;
    return typeof asset.id === 'string' && (asset.kind === 'image' ? assetIds.includes(asset.id) : asset.kind === 'product-image' && productIds.includes(asset.id));
  });
}

function publishReferences(accountId: string, assets: ImageAsset[]): { urls: string[]; tokens: string[] } {
  const images = publishAssetReferences(assets.filter((asset) => asset.kind === 'image').map((asset) => ({ accountId, assetId: asset.id, allowedKinds: ['image'] as const })));
  const products = publishProductImageReferences(assets.filter((asset) => asset.kind === 'product-image').map((asset) => asset.id), accountId);
  const imageMap = new Map(images.map((asset) => [asset.assetId, asset]));
  const productMap = new Map(products.map((asset) => [asset.assetId, asset]));
  const ordered = assets.map((asset) => (asset.kind === 'image' ? imageMap : productMap).get(asset.id)).filter((asset): asset is typeof images[number] => Boolean(asset));
  return { urls: ordered.map((asset) => asset.url), tokens: ordered.map((asset) => asset.token) };
}

function rebuildImageSubmission(task: ProviderTask): ImageSubmissionInput {
  const provider = task.provider;
  const config = getProviderConfig(provider);
  const metadata = task.metadata ?? {};
  const model = provider === 'seedream' ? config.model : task.model || config.model;
  const assets = imageAssetOrder(task);
  const rawImages = strings(metadata.externalReferenceImages);
  if (rawImages.length + assets.length > config.supports.referenceImages) throw new Error('too_many_reference_images');
  const published = isProviderLiveEnabled(provider) && ['mgrouter-grok-image', 'origin-grok-image', 'seedream'].includes(provider)
    ? publishReferences(task.accountId, assets) : { urls: [], tokens: [] };
  if (published.tokens.length) updateProviderTask(task.id, { metadata: { ...metadata, referenceTokens: published.tokens } });
  const images = [...rawImages, ...published.urls];
  const normalized = validateGenerationRequest({ provider, model, aspectRatio: typeof metadata.aspectRatio === 'string' ? metadata.aspectRatio : undefined, resolution: typeof metadata.resolution === 'string' ? metadata.resolution : undefined, referenceImages: images, referenceAudios: [] });
  const needsFiles = ['yuanai-image', 'aicloud-gpt-image', 'pomoai-gemini-image', 'junze-gemini-image', 'origin-gpt-image', 'origin-nano-image'].includes(provider);
  const files = needsFiles && assets.length ? assets.map((asset): ReferenceFile => {
    if (asset.kind === 'image') {
      const reference = assertAssetReference(task.accountId, asset.id, ['image']);
      if (!reference.relativePath) throw new Error('reference_asset_not_found');
      return { bytes: new Uint8Array(fs.readFileSync(getWorkspacePath(reference.relativePath))), mimeType: reference.mimeType || 'image/png', fileName: reference.name || `${reference.id}.png` };
    }
    const product = readProductImageAsset(asset.id);
    if (!product) throw new Error('reference_asset_not_found');
    return { bytes: new Uint8Array(fs.readFileSync(getProductImageAbsolutePath(asset.id))), mimeType: product.mimeType, fileName: product.name };
  }) : undefined;
  if (files?.some((file) => !isImageBytes(file.bytes))) throw new Error('reference_image_invalid');
  if (files && provider === 'origin-gpt-image' && (files.some((file) => file.bytes.byteLength > 25 * 1024 * 1024) || files.reduce((total, file) => total + file.bytes.byteLength, 0) > 150 * 1024 * 1024)) throw new Error('origin_reference_payload_too_large');
  return {
    accountId: task.accountId, taskId: task.id, schedulerWorkerId: typeof metadata.schedulerWorkerId === 'string' ? metadata.schedulerWorkerId : undefined,
    provider, model, prompt: task.prompt?.trim() || '', normalized, images, referenceAssetOrder: assets,
    yuanReferenceFiles: provider === 'yuanai-image' ? files : undefined,
    originReferenceFiles: provider === 'origin-gpt-image' || provider === 'aicloud-gpt-image' ? files : undefined,
    pomoReferences: ['pomoai-gemini-image', 'junze-gemini-image', 'origin-nano-image'].includes(provider) && files ? files.map((file) => ({ mimeType: file.mimeType, dataBase64: Buffer.from(file.bytes).toString('base64') })) : [],
  };
}

async function markSubmissionUncertain(taskId: string, error?: unknown): Promise<void> {
  const current = getProviderTask(taskId);
  if (!current) return;
  updateProviderTask(taskId, {
    status: current.status === 'cancelled' || current.status === 'paused' ? current.status : 'failed',
    progress: current.status === 'cancelled' || current.status === 'paused' ? current.progress : 100, error: 'provider_submission_uncertain',
    ...(error ? { providerResponse: providerResponseSnapshot(error) } : {}),
    metadata: { ...(current.metadata ?? {}), execution: 'failed', providerSubmissionUncertain: true, schedulerRetryExhausted: true },
  });
  await flushProviderTaskStore();
}

function isExplicitRejection(error: unknown, response: unknown, provider: ProviderId): boolean {
  if (response !== undefined && normalizeProviderResponse(provider, response).status === 'failed') return true;
  const info = providerErrorInfo(error);
  if (info.status !== undefined) return info.status >= 400 && info.status < 500 && info.status !== 408;
  // These failures happen before any request can be accepted.
  return /^(provider_not_configured|unsupported_|reference_|too_many_|origin_|yuanai_reference_)/.test(info.code);
}

async function submitImageTask(input: ImageSubmissionInput): Promise<void> {
  const maxAttempts = input.provider === 'yuanai-image' ? 3 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: unknown;
    const current = getProviderTask(input.taskId);
    if (!current || current.metadata?.schedulerWorkerId !== input.schedulerWorkerId || current.providerTaskId || current.metadata?.providerAcceptedAt || ['cancelled', 'paused'].includes(current.status)) return;
    updateProviderTask(input.taskId, { status: 'submitting', progress: 8, metadata: { ...(current.metadata ?? {}), providerSubmissionStartedAt: new Date().toISOString(), providerSubmissionRejectedAt: undefined, lastProviderStatus: undefined, attempts: attempt + 1 } });
    await flushProviderTaskStore();
    const beforeSubmission = getProviderTask(input.taskId);
    if (beforeSubmission?.metadata?.schedulerWorkerId !== input.schedulerWorkerId) return;
    if (!beforeSubmission || beforeSubmission.providerTaskId || beforeSubmission.metadata?.providerAcceptedAt || ['completed', 'cancelled', 'paused'].includes(beforeSubmission.status)) {
      if (beforeSubmission && !beforeSubmission.providerTaskId && !beforeSubmission.metadata?.providerAcceptedAt) {
        updateProviderTask(input.taskId, { metadata: { ...(beforeSubmission.metadata ?? {}), providerSubmissionStartedAt: undefined } });
        await flushProviderTaskStore();
      }
      return;
    }
    try {
      const result = await submitImageProvider(input);
      response = result.response;
      const status = normalizeProviderResponse(input.provider, response);
      if (status.status === 'failed' && !status.providerTaskId) throw new Error(status.error ?? 'provider_upstream_failed');
      await completeImageTask(input, result, attempt + 1);
      return;
    } catch (error) {
      const latest = getProviderTask(input.taskId);
      // A cache/persistence error after acceptance must never become a new POST.
      if (latest?.providerTaskId || latest?.metadata?.providerAcceptedAt || latest?.outputUrls.length || latest?.outputBase64.length) {
        updateProviderTask(input.taskId, { metadata: { ...(latest.metadata ?? {}), schedulerRetryExhausted: true, localCacheError: sanitizeProviderError(error instanceof Error ? error.message : '') } });
        await flushProviderTaskStore();
        return;
      }
      if (!isExplicitRejection(error, response, input.provider)) {
        await markSubmissionUncertain(input.taskId, error);
        return;
      }
      const retry = attempt + 1 < maxAttempts;
      const stopped = latest?.status === 'cancelled' || latest?.status === 'paused';
      updateProviderTask(input.taskId, {
        status: stopped ? latest.status : retry ? 'retrying' : 'failed', progress: stopped ? latest.progress : retry ? 8 : 100,
        error: retry ? undefined : sanitizeProviderError(error instanceof Error ? error.message : ''),
        providerResponse: providerResponseSnapshot(error, response === undefined ? undefined : { body: response, method: 'POST' }),
        metadata: { ...(latest?.metadata ?? {}), providerSubmissionStartedAt: undefined, providerSubmissionRejectedAt: new Date().toISOString(), ...(response === undefined ? {} : { lastProviderStatus: normalizeProviderResponse(input.provider, response).status }), retryCount: attempt + 1, lastAttemptProvider: input.provider, lastAttemptError: sanitizeProviderError(error instanceof Error ? error.message : ''), execution: retry ? 'pending' : 'failed' },
      });
      await flushProviderTaskStore();
      if (stopped) return;
    }
  }
  if (input.provider !== 'yuanai-image') return;
  const current = getProviderTask(input.taskId);
  if (!current || current.metadata?.schedulerWorkerId !== input.schedulerWorkerId || current.providerTaskId || current.metadata?.providerAcceptedAt || current.metadata?.providerSubmissionUncertain) return;
  const fallbackProvider: ProviderId = 'mgrouter-grok-image';
  const fallback = getProviderConfig(fallbackProvider);
  const resolution = input.normalized.resolution === '4k' ? '2k' : input.normalized.resolution;
  updateProviderTask(input.taskId, { provider: fallbackProvider, model: fallback.model, status: 'submitting', error: undefined, metadata: { ...(current.metadata ?? {}), supplierId: fallbackProvider, modelId: fallback.model, resolution, fallback: true, fallbackFrom: 'yuanai-image', fallbackProvider, fallbackResolution: resolution, fallbackAfterRetries: maxAttempts } });
  await flushProviderTaskStore();
  const fallbackTask = getProviderTask(input.taskId);
  if (fallbackTask && fallbackTask.metadata?.schedulerWorkerId === input.schedulerWorkerId) await executePersistedImageTask(fallbackTask.id);
}

async function submitImageProvider(input: ImageSubmissionInput) {
  const { provider, model, prompt, normalized, images, yuanReferenceFiles, originReferenceFiles, pomoReferences } = input;
  if (provider === 'seedream') return generateSeedreamImage({ model, prompt, aspectRatio: normalized.aspectRatio, resolution: normalized.resolution, referenceImages: images });
  if (provider === 'yuanai-image') return generateYuanAIImage({ model, prompt, aspectRatio: normalized.aspectRatio!, resolution: normalized.resolution as '1k' | '2k' | '4k', referenceImages: yuanReferenceFiles?.length ? [] : images, referenceFiles: yuanReferenceFiles });
  if (provider === 'pomoai-gemini-image') return generatePomoAIImage({ model, prompt, references: pomoReferences, aspectRatio: normalized.aspectRatio, resolution: normalized.resolution });
  if (provider === 'origin-gpt-image' || provider === 'origin-grok-image' || provider === 'junze-gpt-image' || provider === 'aicloud-gpt-image') return generateOpenAICompatibleImage(provider, { model, prompt, aspectRatio: normalized.aspectRatio, resolution: normalized.resolution, referenceImages: images, referenceFiles: originReferenceFiles });
  if (provider === 'origin-nano-image') return generateOriginNanoImage({ model, prompt, aspectRatio: normalized.aspectRatio, resolution: normalized.resolution, references: pomoReferences, referenceImages: images });
  if (provider === 'junze-gemini-image') return generateGeminiNativeImage(provider, { model, prompt, aspectRatio: normalized.aspectRatio, resolution: normalized.resolution, references: pomoReferences });
  return generateMGRouterImage({ model, prompt, aspectRatio: normalized.aspectRatio!, resolution: normalized.resolution as '1k' | '2k', referenceImages: images });
}

async function completeImageTask(input: ImageSubmissionInput, result: Awaited<ReturnType<typeof generateMGRouterImage>>, attempts: number): Promise<void> {
  const status = normalizeProviderResponse(input.provider, result.response);
  const current = getProviderTask(input.taskId);
  if (!current) return;
  const hasOutputs = status.outputUrls.length + status.outputBase64.length > 0;
  const confirmedFailure = status.status === 'failed';
  const unresumable = !confirmedFailure && !status.providerTaskId && !hasOutputs && result.mode !== 'mock';
  const stopped = current.status === 'cancelled' || current.status === 'paused';
  const checkpoint = updateProviderTask(input.taskId, {
    provider: input.provider, model: input.model,
    status: stopped ? current.status : confirmedFailure ? 'failed' : hasOutputs ? 'processing' : unresumable ? 'failed' : status.status === 'unknown' ? 'submitted' : status.status,
    progress: stopped ? current.progress : confirmedFailure || unresumable ? 100 : hasOutputs ? 99 : status.progress,
    providerTaskId: status.providerTaskId ?? current.providerTaskId,
    outputUrls: status.outputUrls, outputBase64: status.outputBase64,
    error: unresumable ? 'provider_submission_uncertain' : status.error,
    providerResponse: providerResponseSnapshot(undefined, { body: result.response, method: 'POST' }),
    metadata: {
      ...(current.metadata ?? {}), execution: result.mode, attempts,
      providerAcceptedAt: new Date().toISOString(), lastProviderStatus: status.status,
      schedulerRetryExhausted: confirmedFailure ? false : unresumable || current.metadata?.schedulerRetryExhausted === true,
      ...(unresumable ? { providerSubmissionUncertain: true } : {}),
      ...(hasOutputs ? { localOutputReady: false, localOutputCount: 0, localOutputExpected: status.outputUrls.length + status.outputBase64.length, localCacheCheckpointAt: new Date().toISOString() } : {}),
    },
  });
  // This acceptance checkpoint must reach durable storage before downloading or caching output.
  await flushProviderTaskStore();
  if (stopped || confirmedFailure) return;
  if (checkpoint && hasOutputs) await recoverImageOutputs(checkpoint);
  else if (result.mode === 'mock') await processMockProviderTask(input.taskId);
}

async function recoverImageOutputs(task: ProviderTask): Promise<void> {
  const cache = await cacheImageTaskOutputsBeforeCompletion(task.accountId, { ...task, status: 'completed', progress: 100 });
  const current = getProviderTask(task.id);
  if (!current) return;
  const stopped = current.status === 'cancelled' || current.status === 'paused';
  updateProviderTask(task.id, {
    status: stopped ? current.status : cache.ready ? 'completed' : 'processing', progress: stopped ? current.progress : cache.ready ? 100 : 99,
    outputUrls: cache.ready && cache.expected > 0 ? localImageOutputUrls(task.accountId, task) : task.outputUrls,
    outputBase64: cache.ready && cache.expected > 0 ? [] : task.outputBase64,
    error: undefined,
    metadata: { ...(current.metadata ?? {}), localOutputCount: cache.cached, localOutputExpected: cache.expected, localOutputReady: cache.ready, schedulerRetryExhausted: true },
  });
  await flushProviderTaskStore();
}

function isImageBytes(bytes: Uint8Array): boolean {
  if (bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
}
