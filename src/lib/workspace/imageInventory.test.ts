import fs from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAssets } from './assetStore';
import { saveImageTaskOutputsToAssets } from './imageInventory';
import type { ProviderTask } from '@/lib/providers/taskStore';

const root = `D:\\all_projects\\workspace\\data\\image-inventory-test-${process.pid}`;
const previous = process.env.WORKSPACE_DATA_ROOT;
const accountId = 'image-inventory-account';

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
  it('writes completed base64 output as a current account image asset', async () => {
    const assets = await saveImageTaskOutputsToAssets(accountId, task({ outputBase64: ['data:image/png;base64,aGVsbG8='] }));
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe('image');
    expect(assets[0].name).toBe('product.png');
    expect(listAssets(accountId, 'image')).toHaveLength(1);
  });

  it('downloads a remote image URL before writing it to the D-drive asset store', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(Buffer.from([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } })));
    const assets = await saveImageTaskOutputsToAssets(accountId, task({ outputUrls: ['https://cdn.example.test/image.png'] }));
    expect(assets).toHaveLength(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('https://cdn.example.test/image.png', { redirect: 'error' });
  });

  it('does not save failed, non-image, or already-recorded tasks', async () => {
    expect(await saveImageTaskOutputsToAssets(accountId, task({ status: 'failed', outputBase64: ['data:image/png;base64,aGVsbG8='] }))).toEqual([]);
    expect(await saveImageTaskOutputsToAssets(accountId, task({ metadata: { inventoryAssetIds: ['asset-existing'] }, outputBase64: ['data:image/png;base64,aGVsbG8='] }))).toEqual([]);
  });
});
