import fs from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUploadedAsset, listAssets } from './assetStore';
import { cacheImageTaskOutputsBeforeCompletion, saveImageTaskOutputsToAssets } from './imageInventory';
import type { ProviderTask } from '@/lib/providers/taskStore';

const root = `D:\\all_projects\\workspace\\data\\image-inventory-test-${process.pid}`;
const previous = process.env.WORKSPACE_DATA_ROOT;
const accountId = 'image-inventory-account';
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

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

  it('blocks private image output targets before fetching', async () => {
    const fetcher = vi.fn();
    await expect(saveImageTaskOutputsToAssets(accountId, task({ outputUrls: ['https://127.0.0.1/private.png'] }), { fetcher, lookup: publicLookup })).rejects.toThrow('image_url_target_blocked');
    expect(fetcher).not.toHaveBeenCalled();
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
});
