import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount } from '@/lib/workspace/access';
import { getProviderConfig, type ProviderId } from '@/lib/providers/config';
import { createProviderTasks, flushProviderTaskStore, getProviderTask } from '@/lib/providers/taskStore';
import { validateGenerationRequest } from '@/lib/providers/validation';
import { assertAssetReference } from '@/lib/workspace/referenceBridge';
import { listProductImageAssets } from '@/lib/workspace/productImages';
import { getDefaultImageResolution, getDefaultProductionAspectRatio } from '@/lib/workspace/production/defaults';
import { firstReferenceImageName } from '@/lib/workspace/taskMetadata';
import { enqueueProviderTask, SCHEDULER_RUNTIME_ID } from '@/lib/providers/concurrency';
import { normalizeTaskName, parseTaskNameMode, validateTaskNaming } from '@/lib/workspace/taskNaming';

const IMAGE_PROVIDERS: readonly ProviderId[] = ['mgrouter-grok-image', 'yuanai-image', 'aicloud-gpt-image', 'pomoai-gemini-image', 'origin-gpt-image', 'origin-grok-image', 'origin-nano-image', 'junze-gpt-image', 'junze-gemini-image', 'seedream'];

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { prompt?: unknown; model?: unknown; provider?: unknown; aspectRatio?: unknown; resolution?: unknown; referenceImages?: unknown; assetIds?: unknown; productImageAssetIds?: unknown; referenceAssetOrder?: unknown; pid?: unknown; count?: unknown; taskNameMode?: unknown; taskName?: unknown };
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return NextResponse.json({ success: false, error: 'prompt_required' }, { status: 400 });
  const provider: ProviderId = IMAGE_PROVIDERS.includes(body.provider as ProviderId) ? body.provider as ProviderId : 'mgrouter-grok-image';
  const config = getProviderConfig(provider);
  const rawImages = Array.isArray(body.referenceImages) && body.referenceImages.every((value) => typeof value === 'string') ? body.referenceImages as string[] : [];
  const assetIds = Array.isArray(body.assetIds) && body.assetIds.every((value) => typeof value === 'string') ? body.assetIds as string[] : [];
  const productImageAssetIds = Array.isArray(body.productImageAssetIds) && body.productImageAssetIds.every((value) => typeof value === 'string') ? body.productImageAssetIds as string[] : [];
  const referenceAssetOrder = parseAssetOrder(body.referenceAssetOrder);
  const orderedImageAssets = (referenceAssetOrder.length ? referenceAssetOrder : [...assetIds.map((assetId) => ({ id: assetId, kind: 'image' as const })), ...productImageAssetIds.map((assetId) => ({ id: assetId, kind: 'product-image' as const }))])
    .filter((item) => item.kind === 'image' ? assetIds.includes(item.id) : productImageAssetIds.includes(item.id));
  const taskNameMode = parseTaskNameMode(body.taskNameMode);
  if (body.taskNameMode !== undefined && !taskNameMode) return NextResponse.json({ success: false, error: 'task_name_mode_invalid' }, { status: 400 });
  const taskName = normalizeTaskName(body.taskName);
  const taskNameError = validateTaskNaming(taskNameMode, taskName, rawImages.length + orderedImageAssets.length);
  if (taskNameError) return NextResponse.json({ success: false, error: taskNameError }, { status: 400 });
  const aspectRatio = typeof body.aspectRatio === 'string' && body.aspectRatio.trim() ? body.aspectRatio.trim() : getDefaultProductionAspectRatio(config.supports.ratios);
  const model = provider === 'seedream' ? config.model : typeof body.model === 'string' && body.model.trim() ? body.model.trim() : config.model;
  const resolution = typeof body.resolution === 'string' && body.resolution.trim() ? body.resolution.trim().toLowerCase() : getDefaultImageResolution(config.modelResolutions?.[model] ?? config.supports.resolutions);
  const count = typeof body.count === 'number' && Number.isFinite(body.count) ? Math.min(4, Math.max(1, Math.round(body.count))) : 1;
  try {
    const ownerId = workspaceOwnerIdForAccount(id);
    const normalized = validateGenerationRequest({ provider, model, aspectRatio, resolution, referenceImages: rawImages, referenceAudios: [] });
    if (rawImages.length + orderedImageAssets.length > config.supports.referenceImages) throw new Error('too_many_reference_images');
    // Only validate identifiers here. Publishing references and reading image bytes belong to the worker.
    const products = orderedImageAssets.some((item) => item.kind === 'product-image') ? listProductImageAssets() : [];
    for (const asset of orderedImageAssets) {
      if (asset.kind === 'image') assertAssetReference(id, asset.id, ['image']);
      else if (!products.some((product) => product.id === asset.id)) throw new Error('reference_asset_not_found');
    }
    const referenceImageName = firstReferenceImageName({ accountId: id, assetIds: orderedImageAssets.filter((item) => item.kind === 'image').map((item) => item.id), productImageAssetIds: orderedImageAssets.filter((item) => item.kind === 'product-image').map((item) => item.id), referenceAssetOrder: orderedImageAssets, rawReferenceImages: rawImages });
    const baseMetadata = {
      ...(ownerId ? { ownerId } : {}), ...(referenceImageName ? { referenceImageName } : {}), ...(taskNameMode ? { taskNameMode } : {}), ...(taskNameMode === 'manual' && taskName ? { taskName } : {}),
      execution: 'pending', modelId: model, supplierId: provider, aspectRatio: normalized.aspectRatio, resolution: normalized.resolution, count,
      schedulerState: 'waiting', schedulerOwnerId: ownerId ?? id, schedulerMode: 'image', schedulerModel: model, schedulerRuntimeId: SCHEDULER_RUNTIME_ID,
      assetIds, productImageAssetIds, referenceAssetOrder: orderedImageAssets, externalReferenceImages: rawImages,
      ...(typeof body.pid === 'string' && body.pid.trim() ? { pid: body.pid.trim() } : {}),
    };
    const prompt = body.prompt.trim();
    const tasks = createProviderTasks(Array.from({ length: count }, (_, index) => ({ accountId: id, mode: 'image' as const, provider, model, prompt, status: 'queued' as const, progress: 0, metadata: { ...baseMetadata, maxRetries: 2, sequence: index + 1 } })));
    const accepted = tasks.map((task) => enqueueProviderTask({ taskId: task.id, ownerId: ownerId ?? id, mode: 'image', model }));
    await flushProviderTaskStore();
    const persistedTasks = tasks.map((task) => getProviderTask(task.id) ?? task);
    const first = persistedTasks[0];
    const queueFull = accepted.some((value) => !value);
    return NextResponse.json({ success: !queueFull, data: { accountId: id, taskId: first.id, taskIds: persistedTasks.map((task) => task.id), count: persistedTasks.length, status: first.status, provider: first.provider, execution: 'pending', model: first.model, progress: first.progress }, ...(queueFull ? { error: 'scheduler_queue_full' } : {}) }, { status: queueFull ? 503 : 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const known = ['provider_not_configured', 'provider_unauthorized', 'provider_model_unavailable', 'provider_upstream_failed', 'provider_invalid_request', 'reference_public_base_invalid', 'reference_asset_not_found', 'reference_asset_kind_invalid', 'reference_images_must_be_https', 'too_many_reference_images', 'reference_image_invalid', 'origin_reference_payload_too_large', 'origin_4k_reference_requires_multipart', 'origin_grok_reference_requires_json', 'origin_nano_external_reference_unsupported', 'reference_images_unsupported', 'unsupported_aspect_ratio', 'unsupported_resolution', 'unsupported_model'];
    const responseError = known.includes(message) ? message : 'image_provider_failed';
    const status = responseError === 'provider_not_configured' ? 503 : responseError.startsWith('provider_') ? 502 : 400;
    return NextResponse.json({ success: false, error: responseError }, { status });
  }
}

function parseAssetOrder(value: unknown): Array<{ id: string; kind: 'image' | 'product-image' }> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { id?: unknown; kind?: unknown } => Boolean(item && typeof item === 'object'))
    .map((item) => ({ id: typeof item.id === 'string' ? item.id.trim() : '', kind: item.kind }))
    .filter((item): item is { id: string; kind: 'image' | 'product-image' } => Boolean(item.id) && (item.kind === 'image' || item.kind === 'product-image')).slice(0, 16);
}
