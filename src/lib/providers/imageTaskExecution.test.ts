import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { NextRequest } from 'next/server';
import type { ProviderTask } from './taskStore';

const state = vi.hoisted(() => ({ task: null as ProviderTask | null, events: [] as string[], generate: vi.fn(), flush: vi.fn(), cache: vi.fn(), enqueue: vi.fn(), publish: vi.fn(), assertAsset: vi.fn(), readProduct: vi.fn(), productPath: vi.fn() }));

vi.mock('./taskStore', () => ({
  getProviderTask: (id: string) => state.task?.id === id ? structuredClone(state.task) : null,
  updateProviderTask: (id: string, patch: Partial<ProviderTask>) => {
    if (state.task?.id !== id) return null;
    state.task = { ...state.task, ...patch };
    return structuredClone(state.task);
  },
  createProviderTasks: (inputs: Partial<ProviderTask>[]) => inputs.map((input, index) => {
    state.task = { id: `task-${index}`, accountId: 'account', mode: 'image', provider: 'yuanai-image', status: 'queued', progress: 0, outputUrls: [], outputBase64: [], createdAt: '', updatedAt: '', ...input };
    return structuredClone(state.task);
  }),
  flushProviderTaskStore: state.flush,
}));
vi.mock('./client', () => ({
  generateMGRouterImage: state.generate,
  generateSeedreamImage: state.generate,
  generateYuanAIImage: state.generate,
  generatePomoAIImage: state.generate,
  generateOpenAICompatibleImage: state.generate,
  generateGeminiNativeImage: state.generate,
  generateOriginNanoImage: state.generate,
  normalizeProviderResponse: (_provider: string, response: Record<string, unknown>) => ({ status: 'unknown', progress: 0, outputUrls: [], outputBase64: [], ...response }),
  providerErrorInfo: (error: Error & { status?: number }) => ({ code: error?.message ?? 'provider_request_failed', status: error?.status }),
  providerResponseSnapshot: (_error: unknown, fallback?: { body?: unknown }) => ({ body: fallback?.body }),
  sanitizeProviderError: (message: string) => message,
}));
vi.mock('./config', () => ({
  getProviderConfig: (provider: string) => ({ model: provider === 'seedream' ? 'dola-seedream-5-0-pro-260628' : 'image-model', supports: { referenceImages: 8, ratios: ['1:1'], resolutions: ['1k', '2k', '4k'] } }),
  isProviderLiveEnabled: () => false,
}));
vi.mock('./validation', () => ({ validateGenerationRequest: (input: { aspectRatio?: string; resolution?: string }) => ({ aspectRatio: input.aspectRatio ?? '1:1', resolution: input.resolution ?? '2k' }) }));
vi.mock('./taskProcessor', () => ({ processMockProviderTask: vi.fn() }));
vi.mock('./concurrency', () => ({ enqueueProviderTask: state.enqueue, SCHEDULER_RUNTIME_ID: 'test-runtime' }));
vi.mock('@/lib/workspace/referenceBridge', () => ({ assertAssetReference: state.assertAsset, publishAssetReferences: state.publish }));
vi.mock('@/lib/workspace/productImages', () => ({ readProductImageAsset: state.readProduct, publishProductImageReferences: state.publish, getProductImageAbsolutePath: state.productPath }));
vi.mock('@/lib/workspace/imageInventory', () => ({ cacheImageTaskOutputsBeforeCompletion: state.cache, localImageOutputUrls: () => ['/api/local-image'] }));
vi.mock('@/lib/auth/server', () => ({ requireApiRole: async () => ({ role: 'admin' }) }));
vi.mock('@/lib/workspace/access', () => ({ canAccessWorkspaceAccount: () => true, workspaceOwnerIdForAccount: () => 'owner' }));
vi.mock('@/lib/workspace/taskMetadata', () => ({ firstReferenceImageName: () => undefined }));

import { executePersistedImageTask } from './imageTaskExecution';
import { POST } from '@/app/api/workspace/accounts/[id]/generate-image/route';

function seed(patch: Partial<ProviderTask> = {}): ProviderTask {
  state.task = { id: 'task', accountId: 'account', mode: 'image', provider: 'yuanai-image', model: 'image-model', prompt: 'image prompt', status: 'queued', progress: 0, outputUrls: [], outputBase64: [], metadata: { aspectRatio: '1:1', resolution: '2k', assetIds: [], productImageAssetIds: [], referenceAssetOrder: [], externalReferenceImages: [] }, createdAt: '', updatedAt: '', ...patch };
  return state.task;
}

describe('persisted image execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.task = null;
    state.events = [];
    state.generate.mockReset().mockImplementation(async () => {
      state.events.push('submit');
      return { mode: 'live', response: { status: 'completed', outputBase64: ['image-bytes'] } };
    });
    state.flush.mockReset().mockImplementation(async () => { state.events.push(state.task?.metadata?.providerAcceptedAt ? 'flush-accepted' : 'flush-started'); });
    state.cache.mockReset().mockImplementation(async () => {
      state.events.push('cache');
      return { ready: true, cached: 1, expected: 1 };
    });
    state.enqueue.mockReturnValue(true);
    state.assertAsset.mockReturnValue({ id: 'asset', name: 'reference.png', relativePath: 'not-read.png', mimeType: 'image/png' });
    state.readProduct.mockReset().mockReturnValue(null);
    state.productPath.mockReset();
  });

  it('does not resubmit an existing upstream task ID', async () => {
    seed({ providerTaskId: 'upstream-id', status: 'processing' });
    await executePersistedImageTask('task');
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.task?.providerTaskId).toBe('upstream-id');
  });

  it('reads only selected product images and preserves their order with account references', async () => {
    const productId = 'product-image:other-account:2026-09-14:1731260011305600841:001_main.jpg';
    seed({ metadata: {
      productImageAssetIds: [productId], assetIds: ['asset'],
      referenceAssetOrder: [{ id: productId, kind: 'product-image' }, { id: 'asset', kind: 'image' }],
    } });
    state.readProduct.mockReturnValue({ id: productId, name: '001_main.jpg', mimeType: 'image/jpeg' });
    state.productPath.mockReturnValue('selected-product.jpg');
    const fileRead = vi.spyOn(fs, 'readFileSync').mockImplementation(() => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    try {
      await executePersistedImageTask('task');
      expect(state.readProduct).toHaveBeenCalledTimes(1);
      expect(state.readProduct).toHaveBeenCalledWith(productId);
      expect(state.productPath).toHaveBeenCalledTimes(1);
      expect(state.productPath).toHaveBeenCalledWith(productId);
      expect(state.generate).toHaveBeenCalledWith(expect.objectContaining({
        referenceFiles: [
          expect.objectContaining({ fileName: '001_main.jpg', mimeType: 'image/jpeg' }),
          expect.objectContaining({ fileName: 'reference.png', mimeType: 'image/png' }),
        ],
      }));
      expect(state.task?.status).toBe('completed');
    } finally {
      fileRead.mockRestore();
    }
  });

  it('does not submit without a selected product reference', async () => {
    const productId = 'product-image:other-account:2026-09-14:missing:001_main.jpg';
    seed({ metadata: { productImageAssetIds: [productId], assetIds: [] } });
    await executePersistedImageTask('task');
    expect(state.task).toMatchObject({ status: 'failed', error: 'reference_asset_not_found' });
    expect(state.generate).not.toHaveBeenCalled();
  });

  it('uses the current Seedream model when executing a saved legacy selection', async () => {
    seed({ provider: 'seedream', model: 'dola-seedream-5-0-pro-260628-ep' });
    await executePersistedImageTask('task');
    expect(state.generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'dola-seedream-5-0-pro-260628' }));
    expect(state.task?.model).toBe('dola-seedream-5-0-pro-260628');
  });

  it('keeps an already accepted Seedream request unchanged', async () => {
    seed({ provider: 'seedream', model: 'dola-seedream-5-0-pro-260628-ep', providerTaskId: 'accepted-seedream', status: 'processing' });
    await executePersistedImageTask('task');
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.task).toMatchObject({ model: 'dola-seedream-5-0-pro-260628-ep', providerTaskId: 'accepted-seedream' });
  });

  it('enqueues the current Seedream model from an unrefreshed page', async () => {
    const request = new NextRequest('http://localhost/api/workspace/accounts/account/generate-image', { method: 'POST', body: JSON.stringify({ prompt: 'portrait', provider: 'seedream', model: 'dola-seedream-5-0-pro-260628-ep' }) });
    const response = await POST(request, { params: Promise.resolve({ id: 'account' }) });
    expect(response.status).toBe(202);
    expect(state.task).toMatchObject({ model: 'dola-seedream-5-0-pro-260628', metadata: { modelId: 'dola-seedream-5-0-pro-260628', schedulerModel: 'dola-seedream-5-0-pro-260628' } });
    expect(state.generate).not.toHaveBeenCalled();
  });

  it('checkpoints a confirmed failed upstream ID without exhausting scheduler retries', async () => {
    seed();
    state.generate.mockResolvedValue({ mode: 'live', response: { status: 'failed', providerTaskId: 'confirmed-failed-id', error: 'provider_upstream_failed' } });
    await executePersistedImageTask('task');
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.cache).not.toHaveBeenCalled();
    expect(state.task).toMatchObject({ status: 'failed', progress: 100, providerTaskId: 'confirmed-failed-id', metadata: { lastProviderStatus: 'failed', schedulerRetryExhausted: false, providerAcceptedAt: expect.any(String) } });
  });

  it('does not resurrect a failed attempt snapshot after the scheduler has cleared its acceptance', async () => {
    seed({ status: 'retrying', providerResponse: { body: { status: 'failed', providerTaskId: 'previous-failed-id' } }, metadata: { schedulerRetryCount: 1, lastProviderStatus: 'failed' } });
    await executePersistedImageTask('task');
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.task?.providerTaskId).toBeUndefined();
    expect(state.task?.metadata?.lastProviderStatus).toBe('completed');
    expect(state.task?.status).toBe('completed');
  });

  it('leaves confirmed failures without an upstream ID eligible for scheduler retries', async () => {
    seed({ provider: 'mgrouter-grok-image' });
    state.generate.mockResolvedValue({ mode: 'live', response: { status: 'failed', error: 'provider_upstream_failed' } });
    await executePersistedImageTask('task');
    expect(state.task).toMatchObject({ status: 'failed', metadata: { lastProviderStatus: 'failed' } });
    expect(state.task?.metadata?.schedulerRetryExhausted).not.toBe(true);
    expect(state.task?.metadata?.providerSubmissionUncertain).not.toBe(true);
  });

  it('exhausts retries on a lost POST response without YuanAI fallback', async () => {
    seed();
    state.generate.mockRejectedValue(new Error('fetch failed'));
    await executePersistedImageTask('task');
    await executePersistedImageTask('task');
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.task).toMatchObject({ provider: 'yuanai-image', status: 'failed', error: 'provider_submission_uncertain', metadata: { providerSubmissionUncertain: true, schedulerRetryExhausted: true } });
  });

  it('does not resubmit a request interrupted after its submission checkpoint', async () => {
    seed({ metadata: { providerSubmissionStartedAt: '2026-09-14T00:00:00Z' } });
    await executePersistedImageTask('task');
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.task?.error).toBe('provider_submission_uncertain');
  });

  it('flushes the accepted synchronous output before waiting for the local cache', async () => {
    seed();
    let resolveCache!: (value: { ready: boolean; cached: number; expected: number }) => void;
    state.cache.mockImplementation(() => {
      state.events.push('cache');
      return new Promise((resolve) => { resolveCache = resolve; });
    });
    const execution = executePersistedImageTask('task');
    await vi.waitFor(() => expect(state.cache).toHaveBeenCalledTimes(1));
    expect(state.events).toEqual(['flush-started', 'submit', 'flush-accepted', 'cache']);
    expect(state.task).toMatchObject({ status: 'processing', outputBase64: ['image-bytes'], providerResponse: { body: { outputBase64: ['image-bytes'] } }, metadata: { providerAcceptedAt: expect.any(String) } });
    resolveCache({ ready: true, cached: 1, expected: 1 });
    await execution;
    expect(state.task).toMatchObject({ status: 'completed', outputUrls: ['/api/local-image'], outputBase64: [] });
  });

  it('recovers synchronous outputs without a provider task ID or another POST', async () => {
    seed({ status: 'processing', providerResponse: { body: { status: 'completed', outputBase64: ['stored-image'] } }, metadata: { providerAcceptedAt: '2026-09-14T00:00:00Z' } });
    await executePersistedImageTask('task');
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.cache).toHaveBeenCalledTimes(1);
    expect(state.task?.status).toBe('completed');
  });

  it('rechecks cancellation after the pre-submit flush', async () => {
    seed();
    state.flush.mockImplementationOnce(async () => { state.task!.status = 'cancelled'; });
    await executePersistedImageTask('task');
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.task?.status).toBe('cancelled');
    expect(state.task?.metadata?.providerSubmissionStartedAt).toBeUndefined();
  });

  it('does not POST or clear another worker checkpoint after the task claim changes', async () => {
    seed({ metadata: { schedulerWorkerId: 'original-worker' } });
    state.flush.mockImplementationOnce(async () => {
      state.task!.metadata = { schedulerWorkerId: 'replacement-worker', providerSubmissionStartedAt: 'replacement-checkpoint' };
    });
    await executePersistedImageTask('task');
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.task?.metadata).toMatchObject({ schedulerWorkerId: 'replacement-worker', providerSubmissionStartedAt: 'replacement-checkpoint' });
  });

  it('retains a provider ID returned after cancellation without overwriting cancellation', async () => {
    seed();
    state.generate.mockImplementation(async () => {
      state.task!.status = 'cancelled';
      return { mode: 'live', response: { status: 'processing', providerTaskId: 'accepted-after-cancel' } };
    });
    await executePersistedImageTask('task');
    expect(state.task).toMatchObject({ status: 'cancelled', providerTaskId: 'accepted-after-cancel', metadata: { providerAcceptedAt: expect.any(String) } });
    expect(state.cache).not.toHaveBeenCalled();
  });

  it('does not overwrite cancellation while the image cache is running', async () => {
    seed();
    state.cache.mockImplementation(async () => {
      state.task!.status = 'cancelled';
      return { ready: true, cached: 1, expected: 1 };
    });
    await executePersistedImageTask('task');
    expect(state.task?.status).toBe('cancelled');
  });

  it('persists request metadata and enqueues a descriptor without retaining a callback or reading bytes', async () => {
    const request = new NextRequest('http://localhost/api/workspace/accounts/account/generate-image', { method: 'POST', body: JSON.stringify({ prompt: ' prompt ', provider: 'yuanai-image', aspectRatio: '1:1', resolution: '2K', assetIds: ['asset'], referenceAssetOrder: [{ id: 'asset', kind: 'image' }], referenceImages: ['https://example.test/reference.png'] }) });
    const response = await POST(request, { params: Promise.resolve({ id: 'account' }) });
    expect(response.status).toBe(202);
    expect(state.enqueue).toHaveBeenCalledWith({ taskId: 'task-0', ownerId: 'owner', mode: 'image', model: 'image-model' });
    expect(state.task).toMatchObject({ prompt: 'prompt', metadata: { assetIds: ['asset'], referenceAssetOrder: [{ id: 'asset', kind: 'image' }], externalReferenceImages: ['https://example.test/reference.png'], aspectRatio: '1:1', resolution: '2k' } });
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
    expect(state.flush).toHaveBeenCalledTimes(1);
  });
});
