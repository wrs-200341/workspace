import fs from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUploadedAsset, listAssets } from './assetStore';
import { cacheImageTaskOutputsBeforeCompletion, recoverPendingImageTaskOutputCache, repairSavedImageTaskInventory, saveImageTaskOutputsToAssets } from './imageInventory';
import { storeImageOutput } from '@/lib/providers/outputStore';
import { createProviderTask, getProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import type { ProviderTask } from '@/lib/providers/taskStore';

const root = `D:\\all_projects\\workspace\\data\\image-inventory-test-${process.pid}`;
const previous = process.env.WORKSPACE_DATA_ROOT;
const accountId = 'image-inventory-account';
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const providerBenchmarkLookup = async () => [{ address: '198.18.0.191', family: 4 }];

beforeEach(() => {
  process.env.WORKSPACE_DATA_ROOT = root;
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.WORKSPACE_DATA_ROOT;
  else process.env.WORKSPACE_DATA_ROOT = previous;
});

function task(overrides: Partial<ProviderTask> = {}): ProviderTask {
  return {
    id: 'image-task-1', accountId, mode: 'image', provider: 'mgrouter-grok-image', model: 'grok-image',
    prompt: 'product', status: 'completed', progress: 100, outputUrls: [], outputBase64: [],
    createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z', ...overrides,
  };
}

describe('image task inventory persistence', () => {
  it('does not overwrite cancellation while an output download is in flight', async () => {
    const pending = createProviderTask({ accountId, mode: 'image', provider: 'mgrouter-grok-image', status: 'processing', outputUrls: ['https://cdn.example.test/cancel.png'] });
    const fetcher = vi.fn(async () => {
      updateProviderTask(pending.id, { status: 'cancelled', metadata: { operatorCancelled: true } });
      return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]), { headers: { 'content-type': 'image/png' } });
    });
    await recoverPendingImageTaskOutputCache(pending.id, { fetcher, lookup: publicLookup });
    expect(getProviderTask(pending.id)).toMatchObject({ status: 'cancelled', metadata: { operatorCancelled: true } });
  });

  it('caches mixed Base64 and URL outputs in distinct local slots', async () => {
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const fetcher = vi.fn().mockResolvedValue(new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } }));
    const result = await cacheImageTaskOutputsBeforeCompletion(accountId, task({ outputBase64: [`data:image/png;base64,${pngBytes.toString('base64')}`], outputUrls: ['https://cdn.example.test/remote.png'] }), { fetcher, lookup: publicLookup });
    expect(result).toEqual({ cached: 2, expected: 2, ready: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('writes completed base64 output as a current account image asset', async () => {
    const assets = await saveImageTaskOutputsToAssets(accountId, task({ outputBase64: ['data:image/png;base64,aGVsbG8='] }));
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe('image');
    expect(assets[0].name).toBe('product.png');
    expect(listAssets(accountId, 'image')).toHaveLength(1);
  });

  it('downloads a remote image URL before writing it to the D-drive asset store', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(Buffer.from([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } })));
    const assets = await saveImageTaskOutputsToAssets(accountId, task({ outputUrls: ['https://cdn.example.test/image.png'] }), { lookup: publicLookup });
    expect(assets).toHaveLength(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('https://cdn.example.test/image.png', expect.objectContaining({ redirect: 'error', cache: 'no-store' }));
  });

  it('allows trusted provider image hosts resolved through the LAN benchmark range', async () => {
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const fetcher = vi.fn().mockResolvedValue(new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } }));
    const result = await cacheImageTaskOutputsBeforeCompletion(accountId, task({
      provider: 'mgrouter-grok-image',
      outputUrls: ['https://imgen.x.ai/xai-imgen/result.png'],
    }), { fetcher, lookup: providerBenchmarkLookup });
    expect(result).toEqual({ cached: 1, expected: 1, ready: true });
    expect(fetcher).toHaveBeenCalledWith('https://imgen.x.ai/xai-imgen/result.png', expect.objectContaining({ redirect: 'error', cache: 'no-store' }));
  });

  it('blocks private image output targets before fetching', async () => {
    const fetcher = vi.fn();
    await expect(saveImageTaskOutputsToAssets(accountId, task({ outputUrls: ['https://127.0.0.1/private.png'] }), { fetcher, lookup: publicLookup })).rejects.toThrow('image_url_target_blocked');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recovers a task left at 99% when a later cache attempt succeeds', async () => {
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const fetcher = vi.fn().mockResolvedValue(new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } }));
    const pending = createProviderTask(task({ status: 'processing', progress: 99, outputUrls: ['https://cdn.example.test/retry.png'], metadata: { localOutputReady: false } }));
    const recovered = await recoverPendingImageTaskOutputCache(pending.id, { fetcher, lookup: publicLookup });
    expect(recovered?.status).toBe('completed');
    expect(recovered?.metadata?.localOutputReady).toBe(true);
    expect(recovered?.outputUrls[0]).toContain(`/image-tasks/${pending.id}/outputs/0`);
    expect(recovered?.outputBase64).toEqual([]);
  });

  it('repairs a terminal cache failure when the output was persisted before the status race', async () => {
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const failed = createProviderTask(task({
      id: 'image-task-raced-cache',
      status: 'failed',
      progress: 100,
      error: 'image_output_cache_failed',
      outputUrls: ['https://imgen.x.ai/xai-imgen/raced.png'],
      metadata: { localOutputReady: false, localCacheAttempts: 5 },
    }));
    expect(storeImageOutput(accountId, failed.id, 0, pngBytes, 'image/png')).not.toBeNull();
    const recovered = await recoverPendingImageTaskOutputCache(failed.id, { lookup: providerBenchmarkLookup });
    expect(recovered?.status).toBe('completed');
    expect(recovered?.error).toBeUndefined();
    expect(recovered?.metadata?.localOutputReady).toBe(true);
  });

  it('does not save failed, non-image, or already-recorded tasks', async () => {
    expect(await saveImageTaskOutputsToAssets(accountId, task({ status: 'failed', outputBase64: ['data:image/png;base64,aGVsbG8='] }))).toEqual([]);
    const existing = createUploadedAsset(accountId, 'image', { name: 'existing.png', type: 'image/png', size: 5, arrayBuffer: Uint8Array.from([1, 2, 3, 4, 5]).buffer });
    expect(await saveImageTaskOutputsToAssets(accountId, task({ metadata: { inventoryAssetIds: [existing.id] }, outputBase64: ['data:image/png;base64,aGVsbG8='] }))).toEqual([]);
  });

  it('does not recreate outputs whose readable asset is already linked', async () => {
    const existing = createUploadedAsset(accountId, 'image', { name: 'product.png', type: 'image/png', size: 5, arrayBuffer: Uint8Array.from([1, 2, 3, 4, 5]).buffer });
    const assets = await saveImageTaskOutputsToAssets(accountId, task({ metadata: { inventoryAssetIds: ['asset-missing', existing.id] }, outputBase64: ['data:image/png;base64,aGVsbG8='] }));
    expect(assets).toEqual([]);
    expect(listAssets(accountId, 'image')).toHaveLength(1);
  });

  it('repairs a saved image task whose asset record is missing', async () => {
    const persisted = createProviderTask(task({
      id: undefined,
      inventorySavedAt: '2026-09-03T01:00:00.000Z',
      outputBase64: ['data:image/png;base64,aGVsbG8='],
      metadata: { inventoryAssetIds: ['asset-missing'] },
    }));

    expect(await repairSavedImageTaskInventory()).toBe(1);
    const repaired = getProviderTask(persisted.id);
    expect(repaired?.inventorySavedAt).toBe(persisted.inventorySavedAt);
    expect(Array.isArray(repaired?.metadata?.inventoryAssetIds)).toBe(true);
    expect(listAssets(accountId, 'image')).toHaveLength(1);
    expect(await repairSavedImageTaskInventory()).toBe(0);
  });
});
