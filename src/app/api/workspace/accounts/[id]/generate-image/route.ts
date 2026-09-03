import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount } from '@/lib/workspace/access';
import { generateMGRouterImage, generateYuanAIImage, generatePomoAIImage, normalizeProviderResponse, providerResponseSnapshot, sanitizeProviderError } from '@/lib/providers/client';
import { getProviderConfig, isProviderLiveEnabled, type ProviderId } from '@/lib/providers/config';
import { createProviderTask, getProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { validateGenerationRequest } from '@/lib/providers/validation';
import { publishAssetReference, assertAssetReference } from '@/lib/workspace/referenceBridge';
import { getWorkspacePath } from '@/lib/storagePaths';
import fs from 'node:fs';
import { processMockProviderTask } from '@/lib/providers/taskProcessor';
import { storeImageBase64Outputs } from '@/lib/providers/outputStore';
import { getProductImageAbsolutePath, listProductImageAssets, publishProductImageReference } from '@/lib/workspace/productImages';
import { getDefaultImageResolution, getDefaultProductionAspectRatio } from '@/lib/workspace/production/defaults';
import { firstReferenceImageName } from '@/lib/workspace/taskMetadata';
import { enqueueProviderTask } from '@/lib/providers/concurrency';

const IMAGE_PROVIDERS: readonly ProviderId[] = ['mgrouter-grok-image', 'yuanai-image', 'pomoai-gemini-image'];

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { prompt?: unknown; model?: unknown; provider?: unknown; aspectRatio?: unknown; resolution?: unknown; referenceImages?: unknown; assetIds?: unknown; productImageAssetIds?: unknown; referenceAssetOrder?: unknown; pid?: unknown; count?: unknown };
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return NextResponse.json({ success: false, error: 'prompt_required' }, { status: 400 });
  const provider: ProviderId = IMAGE_PROVIDERS.includes(body.provider as ProviderId) ? body.provider as ProviderId : 'mgrouter-grok-image';
  const config = getProviderConfig(provider);
  const rawImages = Array.isArray(body.referenceImages) && body.referenceImages.every((value) => typeof value === 'string') ? body.referenceImages as string[] : [];
  const assetIds = Array.isArray(body.assetIds) && body.assetIds.every((value) => typeof value === 'string') ? body.assetIds as string[] : [];
  const productImageAssetIds = Array.isArray(body.productImageAssetIds) && body.productImageAssetIds.every((value) => typeof value === 'string') ? body.productImageAssetIds as string[] : [];
  const referenceAssetOrder = parseAssetOrder(body.referenceAssetOrder);
  const orderedImageAssets: Array<{ id: string; kind: 'image' | 'product-image' }> = (referenceAssetOrder.length
    ? referenceAssetOrder.filter((item) => item.kind === 'image' || item.kind === 'product-image')
    : [...assetIds.map((id) => ({ id, kind: 'image' as const })), ...productImageAssetIds.map((id) => ({ id, kind: 'product-image' as const }))])
    .filter((item): item is { id: string; kind: 'image' | 'product-image' } => (item.kind === 'image' || item.kind === 'product-image') && (assetIds.includes(item.id) || productImageAssetIds.includes(item.id)));
  const aspectRatio = typeof body.aspectRatio === 'string' && body.aspectRatio.trim()
    ? body.aspectRatio.trim()
    : getDefaultProductionAspectRatio(config.supports.ratios);
  const resolution = typeof body.resolution === 'string' && body.resolution.trim()
    ? body.resolution.trim().toLowerCase()
    : getDefaultImageResolution(config.supports.resolutions);
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : config.model;
  const count = typeof body.count === 'number' && Number.isFinite(body.count) ? Math.min(4, Math.max(1, Math.round(body.count))) : 1;
  try {
    const ownerId = workspaceOwnerIdForAccount(id);
    const referenceImageName = firstReferenceImageName({ accountId: id, assetIds: orderedImageAssets.filter((item) => item.kind === 'image').map((item) => item.id), productImageAssetIds: orderedImageAssets.filter((item) => item.kind === 'product-image').map((item) => item.id), rawReferenceImages: rawImages });
    const publishedReferences = isProviderLiveEnabled(provider) && provider !== 'yuanai-image' && provider !== 'pomoai-gemini-image'
      ? orderedImageAssets.filter((item) => item.kind === 'image').map((item) => publishAssetReference({ accountId: id, assetId: item.id, allowedKinds: ['image'] }))
      : [];
    const publishedProductReferences = isProviderLiveEnabled(provider) && provider !== 'yuanai-image' && provider !== 'pomoai-gemini-image'
      ? orderedImageAssets.filter((item) => item.kind === 'product-image').map((item) => publishProductImageReference(item.id, id))
      : [];
    const publishedByAssetId = new Map<string, string>();
    orderedImageAssets.filter((item) => item.kind === 'image').forEach((item, index) => {
      const published = publishedReferences[index];
      if (published) publishedByAssetId.set(item.id, published.url);
    });
    orderedImageAssets.filter((item) => item.kind === 'product-image').forEach((item, index) => {
      const published = publishedProductReferences[index];
      if (published) publishedByAssetId.set(item.id, published.url);
    });
    const publishedTokensByAssetId = new Map<string, string>();
    orderedImageAssets.filter((item) => item.kind === 'image').forEach((item, index) => {
      const published = publishedReferences[index];
      if (published) publishedTokensByAssetId.set(item.id, published.token);
    });
    orderedImageAssets.filter((item) => item.kind === 'product-image').forEach((item, index) => {
      const published = publishedProductReferences[index];
      if (published) publishedTokensByAssetId.set(item.id, published.token);
    });
    const referenceTokens = orderedImageAssets.map((item) => publishedTokensByAssetId.get(item.id)).filter((value): value is string => Boolean(value));
    const images = [...rawImages, ...orderedImageAssets.map((item) => publishedByAssetId.get(item.id)).filter((value): value is string => Boolean(value))];
    const normalized = validateGenerationRequest({ provider, aspectRatio, resolution, referenceImages: images, referenceAudios: [] });
    const localImageAssets = (provider === 'yuanai-image' || provider === 'pomoai-gemini-image') && orderedImageAssets.length > 0
      ? orderedImageAssets.map((item) => item.kind === 'image'
        ? (() => {
          const asset = assertAssetReference(id, item.id, ['image']);
          if (!asset.relativePath) throw new Error('reference_asset_not_found');
          const bytes = new Uint8Array(fs.readFileSync(getWorkspacePath(asset.relativePath)));
          return { bytes, mimeType: asset.mimeType || 'image/png', fileName: asset.name || `${asset.id}.png` };
        })()
        : (() => {
          const product = listProductImageAssets().find((candidate) => candidate.id === item.id);
          if (!product) throw new Error('reference_asset_not_found');
          return { bytes: new Uint8Array(fs.readFileSync(getProductImageAbsolutePath(item.id))), mimeType: product.mimeType, fileName: product.name };
        })())
      : undefined;
    if (localImageAssets && localImageAssets.length > config.supports.referenceImages) throw new Error('too_many_reference_images');
    if (localImageAssets && localImageAssets.some((asset) => !isImageBytes(asset.bytes))) throw new Error('reference_image_invalid');
    const yuanReferenceFiles = provider === 'yuanai-image' ? localImageAssets : undefined;
    const pomoReferences = provider === 'pomoai-gemini-image' && localImageAssets
      ? localImageAssets.map((reference) => ({ mimeType: reference.mimeType, dataBase64: Buffer.from(reference.bytes).toString('base64') }))
      : [];
    const baseMetadata = { ...(ownerId ? { ownerId } : {}), ...(referenceImageName ? { referenceImageName } : {}), execution: 'pending', modelId: model, supplierId: provider, aspectRatio: normalized.aspectRatio, resolution: normalized.resolution, count, ...(assetIds.length || productImageAssetIds.length ? { assetIds, productImageAssetIds, referenceAssetOrder: orderedImageAssets, referenceTokens } : {}), ...(rawImages.length ? { externalReferenceImages: [...rawImages] } : {}), ...(typeof body.pid === 'string' && body.pid.trim() ? { pid: body.pid.trim() } : {}) };
    const promptText = body.prompt.trim();
    const tasks = Array.from({ length: count }, (_, index) => createProviderTask({ accountId: id, mode: 'image', provider, model, prompt: promptText, status: 'queued', progress: 0, metadata: { ...baseMetadata, sequence: index + 1 } }));
    tasks.forEach((task) => enqueueProviderTask({ taskId: task.id, ownerId: ownerId ?? id, mode: 'image', model, run: () => submitImageTask({ accountId: id, taskId: task.id, provider, model, prompt: promptText, normalized, images, assetIds, productImageAssetIds, referenceAssetOrder: orderedImageAssets, yuanReferenceFiles, pomoReferences }) }));
    const first = tasks[0];
    return NextResponse.json({ success: true, data: { accountId: id, taskId: first.id, taskIds: tasks.map((task) => task.id), count: tasks.length, status: first.status, provider: first.provider, execution: 'pending', model: first.model, progress: first.progress } }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const known = ['provider_not_configured', 'provider_unauthorized', 'provider_model_unavailable', 'provider_upstream_failed', 'provider_invalid_request', 'reference_public_base_invalid', 'reference_asset_not_found', 'reference_asset_kind_invalid', 'reference_images_must_be_https', 'too_many_reference_images', 'reference_image_invalid', 'unsupported_aspect_ratio', 'unsupported_resolution'];
    const responseError = known.includes(message) ? message : 'image_provider_failed';
    const status = responseError === 'provider_not_configured' ? 503 : responseError.startsWith('provider_') ? 502 : 400;
    return NextResponse.json({ success: false, error: responseError }, { status });
  }
}

type ImageSubmissionInput = {
  accountId: string;
  taskId: string;
  provider: ProviderId;
  model: string;
  prompt: string;
  normalized: { aspectRatio?: string; resolution?: string };
  images: string[];
  assetIds: string[];
  productImageAssetIds: string[];
  referenceAssetOrder: Array<{ id: string; kind: 'image' | 'product-image' }>;
  yuanReferenceFiles?: Array<{ bytes: Uint8Array; mimeType: string; fileName: string }>;
  pomoReferences: Array<{ mimeType: string; dataBase64: string }>;
};

async function submitImageTask(input: ImageSubmissionInput): Promise<void> {
  let lastError: unknown;
  let providerResponse: unknown;
  const maxYuanAttempts = input.provider === 'yuanai-image' ? 3 : 1;
  for (let attempt = 0; attempt < maxYuanAttempts; attempt += 1) {
    try {
      if (attempt > 0) await delay(300 * attempt);
      const result = await submitImageProvider(input.provider, input.model, input.prompt, input.normalized, input.images, input.yuanReferenceFiles, input.pomoReferences);
      providerResponse = result.response;
      const providerStatus = normalizeProviderResponse(input.provider, result.response);
      if (providerStatus.status === 'failed') throw new Error(providerStatus.error ?? 'provider_upstream_failed');
      await completeImageTask(input, input.provider, input.model, result, { attempts: attempt + 1 });
      return;
    } catch (error) {
      lastError = error;
      const current = getProviderTask(input.taskId);
      updateProviderTask(input.taskId, {
        status: attempt + 1 < maxYuanAttempts ? 'submitting' : 'failed',
        progress: attempt + 1 < maxYuanAttempts ? 8 : 100,
        error: attempt + 1 < maxYuanAttempts ? undefined : sanitizeProviderError(error instanceof Error ? error.message : ''),
        providerResponse: providerResponseSnapshot(error, providerResponse === undefined ? undefined : { body: providerResponse, method: 'POST' }),
        metadata: { ...(current?.metadata ?? {}), retryCount: attempt + 1, lastAttemptProvider: input.provider, lastAttemptError: sanitizeProviderError(error instanceof Error ? error.message : '') },
      });
      // YuanAI is retried twice for every upstream failure, including HTTP
      // 400 content-review responses. A persistent failure then falls back to
      // MGRouter with its compatible resolution/reference limits.
      if (input.provider !== 'yuanai-image') break;
    }
  }

  if (input.provider === 'yuanai-image') {
    const fallbackProvider: ProviderId = 'mgrouter-grok-image';
    const fallbackConfig = getProviderConfig(fallbackProvider);
    const fallbackResolution = input.normalized.resolution === '4k' ? '2k' : input.normalized.resolution as '1k' | '2k';
    try {
      const fallbackReferences = [...input.images];
      if (isProviderLiveEnabled(fallbackProvider)) {
        for (const asset of input.referenceAssetOrder) {
          fallbackReferences.push(asset.kind === 'image'
            ? publishAssetReference({ accountId: input.accountId, assetId: asset.id, allowedKinds: ['image'] }).url
            : publishProductImageReference(asset.id, input.accountId).url);
        }
      }
      const uniqueReferences = [...new Set(fallbackReferences)];
      if (uniqueReferences.length > fallbackConfig.supports.referenceImages) throw new Error('fallback_reference_limit');
      const current = getProviderTask(input.taskId);
      updateProviderTask(input.taskId, {
        provider: fallbackProvider,
        model: fallbackConfig.model,
        status: 'submitting',
        progress: 8,
        error: undefined,
        metadata: { ...(current?.metadata ?? {}), supplierId: fallbackProvider, modelId: fallbackConfig.model, resolution: fallbackResolution, fallbackFrom: 'yuanai-image', fallbackProvider, fallbackResolution, fallbackAfterRetries: maxYuanAttempts },
      });
      const result = await generateMGRouterImage({ model: fallbackConfig.model, prompt: input.prompt, aspectRatio: input.normalized.aspectRatio!, resolution: fallbackResolution, referenceImages: uniqueReferences });
      providerResponse = result.response;
      const fallbackStatus = normalizeProviderResponse(fallbackProvider, result.response);
      if (fallbackStatus.status === 'failed') throw new Error(fallbackStatus.error ?? 'provider_upstream_failed');
      await completeImageTask({ ...input, provider: fallbackProvider, model: fallbackConfig.model }, fallbackProvider, fallbackConfig.model, result, { attempts: maxYuanAttempts + 1, fallback: true });
      return;
    } catch (error) {
      lastError = error;
      const current = getProviderTask(input.taskId);
      updateProviderTask(input.taskId, { status: 'failed', progress: 100, error: sanitizeProviderError(error instanceof Error ? error.message : ''), providerResponse: providerResponseSnapshot(error, providerResponse === undefined ? undefined : { body: providerResponse, method: 'POST' }), metadata: { ...(current?.metadata ?? {}), execution: 'failed', fallbackError: sanitizeProviderError(error instanceof Error ? error.message : '') } });
      return;
    }
  }

  const current = getProviderTask(input.taskId);
  updateProviderTask(input.taskId, { status: 'failed', progress: 100, error: sanitizeProviderError(lastError instanceof Error ? lastError.message : ''), providerResponse: providerResponseSnapshot(lastError, providerResponse === undefined ? undefined : { body: providerResponse, method: 'POST' }), metadata: { ...(current?.metadata ?? {}), execution: 'failed' } });
}

async function submitImageProvider(provider: ProviderId, model: string, prompt: string, normalized: { aspectRatio?: string; resolution?: string }, images: string[], yuanReferenceFiles: ImageSubmissionInput['yuanReferenceFiles'], pomoReferences: ImageSubmissionInput['pomoReferences']) {
  if (provider === 'yuanai-image') return generateYuanAIImage({ model, prompt, aspectRatio: normalized.aspectRatio!, resolution: normalized.resolution as '1k' | '2k' | '4k', referenceImages: yuanReferenceFiles?.length ? [] : images, referenceFiles: yuanReferenceFiles });
  if (provider === 'pomoai-gemini-image') return generatePomoAIImage({ model, prompt, references: pomoReferences });
  return generateMGRouterImage({ model, prompt, aspectRatio: normalized.aspectRatio!, resolution: normalized.resolution as '1k' | '2k', referenceImages: images });
}

async function completeImageTask(input: ImageSubmissionInput, provider: ProviderId, model: string, result: Awaited<ReturnType<typeof generateMGRouterImage>>, details: { attempts: number; fallback?: boolean }): Promise<void> {
  const status = normalizeProviderResponse(provider, result.response);
  const current = getProviderTask(input.taskId);
  const task = updateProviderTask(input.taskId, { provider, model, status: status.status === 'unknown' ? 'queued' : status.status, progress: status.progress, providerTaskId: status.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64, error: status.error, providerResponse: undefined, metadata: { ...(current?.metadata ?? {}), execution: result.mode, attempts: details.attempts, ...(details.fallback ? { fallback: true } : {}) } });
  if (!task) return;
  if (result.mode === 'live' && status.outputBase64.length > 0) {
    const stored = storeImageBase64Outputs(input.accountId, input.taskId, status.outputBase64);
    if (stored.length > 0) updateProviderTask(input.taskId, { outputBase64: [], outputUrls: stored.map((item) => `/api/workspace/accounts/${encodeURIComponent(input.accountId)}/image-tasks/${encodeURIComponent(input.taskId)}/outputs/${item.index}`), metadata: { ...(task.metadata ?? {}), execution: result.mode, generatedOutputs: stored }, status: 'completed', progress: 100 });
  } else if (result.mode === 'mock') {
    void processMockProviderTask(input.taskId);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function isImageBytes(bytes: Uint8Array): boolean {
  if (bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
}
