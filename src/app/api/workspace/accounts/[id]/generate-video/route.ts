import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount } from '@/lib/workspace/access';
import { normalizeProviderResponse, providerResponseSnapshot, sanitizeProviderError, submitVideo } from '@/lib/providers/client';
import { getProviderConfig, isProviderLiveEnabled, type ProviderId } from '@/lib/providers/config';
import { createProviderTask, getProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { validateGenerationRequest } from '@/lib/providers/validation';
import { publishAssetReference } from '@/lib/workspace/referenceBridge';
import { processMockProviderTask } from '@/lib/providers/taskProcessor';
import { getVideoCapability, validateVideoCapability } from '@/lib/workspace/production/video-capabilities';
import { getDefaultProductionAspectRatio, getDefaultVideoResolution } from '@/lib/workspace/production/defaults';
import { publishProductImageReference } from '@/lib/workspace/productImages';
import { getProductImageAbsolutePath, listProductImageAssets } from '@/lib/workspace/productImages';
import { readAssetFile } from '@/lib/workspace/assetStore';
import fs from 'node:fs';
import { firstReferenceImageName } from '@/lib/workspace/taskMetadata';
import { lookupProductSummary } from '@/lib/workspace/productSummary';
import { enqueueProviderTask } from '@/lib/providers/concurrency';
import { cacheVideoTaskOutputsLocally } from '@/lib/workspace/videoInventory';

type VideoProvider = 'grok-video' | 'mgrouter-grok-video' | 'wan3-video' | 'minimax-h3' | 'quality-v4' | 'oairegbox-omni';
const VIDEO_PROVIDERS: readonly VideoProvider[] = ['grok-video', 'mgrouter-grok-video', 'wan3-video', 'minimax-h3', 'quality-v4', 'oairegbox-omni'];

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
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
  const model = provider === 'grok-video' && requestedModel === 'grok' ? config.model : requestedModel ?? config.model;
  const isSdMini = provider === 'grok-video' && model.toLowerCase() === 'sd-mini';
  // sd-mini requires seconds explicitly; unlike legacy providers, do not
  // silently inject the provider's first duration when the field is omitted.
  const duration = rawDuration !== undefined ? Math.round(rawDuration) : (isSdMini ? undefined : config.supports.durations?.[0] ?? 10);
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
    const productSummary = lookupProductSummary(referenceImageName);
    const promptWithSummary = productSummary
      ? `${input.prompt.trim()}\n\n商品资料（来自 Excel）\n标题：${productSummary.title}\n描述：${productSummary.description}`.trim()
      : input.prompt.trim();
    const tasks = [];
    for (let index = 0; index < count; index += 1) {
      const publishedImages = isProviderLiveEnabled(provider) ? orderedReferenceAssetIds.map((assetId) => publishAssetReference({ accountId: id, assetId, allowedKinds: ['image'] })) : [];
      const publishedProductImages = isProviderLiveEnabled(provider) ? orderedProductImageAssetIds.map((assetId) => publishProductImageReference(assetId, id)) : [];
      const publishedVideos = isProviderLiveEnabled(provider) ? referenceVideoAssetIds.map((assetId) => publishAssetReference({ accountId: id, assetId, allowedKinds: ['inventory-video'] })) : [];
      const publishedAudios = isProviderLiveEnabled(provider) ? referenceAudioAssetIds.map((assetId) => publishAssetReference({ accountId: id, assetId, allowedKinds: ['audio'] })) : [];
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
      const task = createProviderTask({ accountId: id, mode: 'video', provider, model, prompt: promptWithSummary, status: 'queued', progress: 0, metadata: { ...(ownerId ? { ownerId } : {}), ...(referenceImageName ? { referenceImageName } : {}), sequence: index + 1, execution: 'pending', modelId: typeof input.modelId === 'string' ? input.modelId : model, supplierId: typeof input.supplierId === 'string' ? input.supplierId : provider, promptMode: typeof input.promptMode === 'string' ? input.promptMode : 'manual', promptModel: typeof input.promptModel === 'string' ? input.promptModel : undefined, templateId: typeof input.templateId === 'string' ? input.templateId : undefined, childPrompt: typeof input.childPrompt === 'string' ? input.childPrompt : undefined, finalPrompt: promptWithSummary, originalPrompt: typeof input.originalPrompt === 'string' ? input.originalPrompt : input.prompt, suffixEnabled: input.suffixEnabled === true, count, aspectRatio: normalized.aspectRatio, resolution: normalized.resolution, duration: normalized.duration, assetIds, referenceAssetIds, referenceVideoAssetIds, referenceAudioAssetIds, productImageAssetIds, referenceAssetOrder: safeReferenceAssetOrder, referenceVideos, referenceTokens: referenceImageTokens, ...(productSummary ? { productSummary } : { productSummaryLookup: referenceImageName ? 'not_found' : 'no_reference_name' }), ...(rawReferenceImages.length ? { externalReferenceImages: [...rawReferenceImages] } : {}), ...(rawReferenceVideos.length ? { externalReferenceVideos: [...rawReferenceVideos] } : {}), ...(rawReferenceAudios.length ? { externalReferenceAudios: [...rawReferenceAudios] } : {}), ...(typeof input.pid === 'string' && input.pid.trim() ? { pid: input.pid.trim() } : {}) } });
      tasks.push(task);
      enqueueProviderTask({ taskId: task.id, ownerId: ownerId ?? id, mode: 'video', model, run: () => submitVideoTask({ taskId: task.id, provider, model, prompt: promptWithSummary, duration: normalized.duration!, aspectRatio: normalized.aspectRatio!, resolution: normalized.resolution!, referenceImages, referenceFiles, referenceAudios, referenceVideos }) });
      continue;
    }
    const first = tasks[0];
    return NextResponse.json({ success: true, data: { taskId: first.id, taskIds: tasks.map((task) => task.id), count: tasks.length, accountId: id, status: first.status, provider: first.provider, execution: 'pending', model: first.model, providerTaskId: first.providerTaskId, progress: first.progress } }, { status: 202 });
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
    const updated = updateProviderTask(input.taskId, { status: status.status === 'unknown' ? 'queued' : status.status, progress: status.progress, providerTaskId: status.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64, error: status.error, providerResponse: status.status === 'failed' ? providerResponseSnapshot(new Error(status.error ?? 'provider_upstream_failed'), { body: providerResponse, method: 'POST' }) : undefined, metadata: { ...(current?.metadata ?? {}), execution: submitted.mode } });
    if (updated?.status === 'completed') void cacheVideoTaskOutputsLocally(updated.accountId, updated).catch(() => undefined);
    if (updated && submitted.mode === 'mock') void processMockProviderTask(input.taskId);
  } catch (error) {
    updateProviderTask(input.taskId, { status: 'failed', progress: 100, error: sanitizeProviderError(error instanceof Error ? error.message : ''), providerResponse: providerResponseSnapshot(error, providerResponse === undefined ? undefined : { body: providerResponse, method: 'POST' }), metadata: { ...(getProviderTask(input.taskId)?.metadata ?? {}), execution: 'failed' } });
  }
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
