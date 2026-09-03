import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount } from '@/lib/workspace/access';
import { generateMGRouterImage, generateYuanAIImage, generatePomoAIImage, normalizeProviderResponse, sanitizeProviderError } from '@/lib/providers/client';
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

const IMAGE_PROVIDERS: readonly ProviderId[] = ['mgrouter-grok-image', 'yuanai-image', 'pomoai-gemini-image'];

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { prompt?: unknown; model?: unknown; provider?: unknown; aspectRatio?: unknown; resolution?: unknown; referenceImages?: unknown; assetIds?: unknown; productImageAssetIds?: unknown; pid?: unknown; count?: unknown };
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return NextResponse.json({ success: false, error: 'prompt_required' }, { status: 400 });
  const provider: ProviderId = IMAGE_PROVIDERS.includes(body.provider as ProviderId) ? body.provider as ProviderId : 'mgrouter-grok-image';
  const config = getProviderConfig(provider);
  const rawImages = Array.isArray(body.referenceImages) && body.referenceImages.every((value) => typeof value === 'string') ? body.referenceImages as string[] : [];
  const assetIds = Array.isArray(body.assetIds) && body.assetIds.every((value) => typeof value === 'string') ? body.assetIds as string[] : [];
  const productImageAssetIds = Array.isArray(body.productImageAssetIds) && body.productImageAssetIds.every((value) => typeof value === 'string') ? body.productImageAssetIds as string[] : [];
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
    const referenceImageName = firstReferenceImageName({ accountId: id, assetIds, productImageAssetIds, rawReferenceImages: rawImages });
    const publishedReferences = isProviderLiveEnabled(provider) && provider !== 'yuanai-image' && provider !== 'pomoai-gemini-image'
      ? assetIds.map((assetId) => publishAssetReference({ accountId: id, assetId, allowedKinds: ['image'] }))
      : [];
    const publishedProductReferences = isProviderLiveEnabled(provider) && provider !== 'yuanai-image' && provider !== 'pomoai-gemini-image'
      ? productImageAssetIds.map((assetId) => publishProductImageReference(assetId, id))
      : [];
    const images = [...rawImages, ...publishedReferences.map((item) => item.url), ...publishedProductReferences.map((item) => item.url)];
    const normalized = validateGenerationRequest({ provider, aspectRatio, resolution, referenceImages: images, referenceAudios: [] });
    const localImageAssets = (provider === 'yuanai-image' || provider === 'pomoai-gemini-image') && (assetIds.length > 0 || productImageAssetIds.length > 0)
      ? [...assetIds.map((assetId) => {
        const asset = assertAssetReference(id, assetId, ['image']);
        if (!asset.relativePath) throw new Error('reference_asset_not_found');
        const bytes = new Uint8Array(fs.readFileSync(getWorkspacePath(asset.relativePath)));
        return { bytes, mimeType: asset.mimeType || 'image/png', fileName: asset.name || `${asset.id}.png` };
      }), ...productImageAssetIds.map((assetId) => {
        const product = listProductImageAssets().find((candidate) => candidate.id === assetId);
        if (!product) throw new Error('reference_asset_not_found');
        return { bytes: new Uint8Array(fs.readFileSync(getProductImageAbsolutePath(assetId))), mimeType: product.mimeType, fileName: product.name };
      })]
      : undefined;
    if (localImageAssets && localImageAssets.length > config.supports.referenceImages) throw new Error('too_many_reference_images');
    if (localImageAssets && localImageAssets.some((asset) => !isImageBytes(asset.bytes))) throw new Error('reference_image_invalid');
    const yuanReferenceFiles = provider === 'yuanai-image' ? localImageAssets : undefined;
    const pomoReferences = provider === 'pomoai-gemini-image' && localImageAssets
      ? localImageAssets.map((reference) => ({ mimeType: reference.mimeType, dataBase64: Buffer.from(reference.bytes).toString('base64') }))
      : [];
    const baseMetadata = { ...(ownerId ? { ownerId } : {}), ...(referenceImageName ? { referenceImageName } : {}), execution: 'pending', modelId: model, supplierId: provider, aspectRatio: normalized.aspectRatio, resolution: normalized.resolution, count, ...(assetIds.length || productImageAssetIds.length ? { assetIds, productImageAssetIds, referenceTokens: [...publishedReferences, ...publishedProductReferences].map((item) => item.token) } : {}), ...(rawImages.length ? { externalReferenceImages: [...rawImages] } : {}), ...(typeof body.pid === 'string' && body.pid.trim() ? { pid: body.pid.trim() } : {}) };
    const promptText = body.prompt.trim();
    const tasks = Array.from({ length: count }, (_, index) => createProviderTask({ accountId: id, mode: 'image', provider, model, prompt: promptText, status: 'submitting', progress: 5, metadata: { ...baseMetadata, sequence: index + 1 } }));
    void tasks.reduce((chain, task) => chain.then(() => submitImageTask({ accountId: id, taskId: task.id, provider, model, prompt: promptText, normalized, images, yuanReferenceFiles, pomoReferences })), Promise.resolve());
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

async function submitImageTask(input: { accountId: string; taskId: string; provider: ProviderId; model: string; prompt: string; normalized: { aspectRatio?: string; resolution?: string }; images: string[]; yuanReferenceFiles?: Array<{ bytes: Uint8Array; mimeType: string; fileName: string }>; pomoReferences: Array<{ mimeType: string; dataBase64: string }> }): Promise<void> {
  try {
    const result = input.provider === 'yuanai-image'
      ? await generateYuanAIImage({ model: input.model, prompt: input.prompt, aspectRatio: input.normalized.aspectRatio!, resolution: input.normalized.resolution as '1k' | '2k' | '4k', referenceImages: input.yuanReferenceFiles?.length ? [] : input.images, referenceFiles: input.yuanReferenceFiles })
      : input.provider === 'pomoai-gemini-image'
        ? await generatePomoAIImage({ model: input.model, prompt: input.prompt, references: input.pomoReferences })
        : await generateMGRouterImage({ model: input.model, prompt: input.prompt, aspectRatio: input.normalized.aspectRatio!, resolution: input.normalized.resolution as '1k' | '2k', referenceImages: input.images });
    const status = normalizeProviderResponse(input.provider, result.response);
    const current = getProviderTask(input.taskId);
    const task = updateProviderTask(input.taskId, { status: status.status === 'unknown' ? 'queued' : status.status, progress: status.progress, providerTaskId: status.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64, error: status.error, metadata: { ...(current?.metadata ?? {}), execution: result.mode } });
    if (!task) return;
    if (result.mode === 'live' && status.outputBase64.length > 0) {
      const stored = storeImageBase64Outputs(input.accountId, input.taskId, status.outputBase64);
      if (stored.length > 0) updateProviderTask(input.taskId, { outputBase64: [], outputUrls: stored.map((item) => `/api/workspace/accounts/${encodeURIComponent(input.accountId)}/image-tasks/${encodeURIComponent(input.taskId)}/outputs/${item.index}`), metadata: { ...(task.metadata ?? {}), execution: result.mode, generatedOutputs: stored }, status: 'completed', progress: 100 });
    } else if (result.mode === 'mock') {
      void processMockProviderTask(input.taskId);
    }
  } catch (error) {
    const current = getProviderTask(input.taskId);
    updateProviderTask(input.taskId, { status: 'failed', progress: 100, error: sanitizeProviderError(error instanceof Error ? error.message : ''), metadata: { ...(current?.metadata ?? {}), execution: 'failed' } });
  }
}

function isImageBytes(bytes: Uint8Array): boolean {
  if (bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
}
