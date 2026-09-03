import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listAssets } from './assetStore';
import { createProviderTask, getProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { repairSavedVideoTaskInventory, saveVideoTaskOutputsToAssets } from './videoInventory';
import type { ProviderTask } from '@/lib/providers/taskStore';

const root = `D:\\all_projects\\workspace\\data\\video-inventory-test-${process.pid}`;
process.env.WORKSPACE_DATA_ROOT = root;

function task(overrides: Partial<ProviderTask> = {}): ProviderTask {
  return { id: 'video-task-1', accountId: 'video-account', mode: 'video', provider: 'oairegbox-omni', model: 'omni-fast-no-water', prompt: 'demo', status: 'completed', progress: 100, providerTaskId: undefined, outputUrls: [], outputBase64: ['data:video/mp4;base64,AAAA'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const mp4Bytes = Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]);

describe('video task inventory persistence', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('persists a completed base64 video as an inventory-video asset', async () => {
    const assets = await saveVideoTaskOutputsToAssets('video-account', task());
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe('inventory-video');
    expect(assets[0].name).toBe('demo.mp4');
    expect(fs.existsSync(`${root}/uploads/video-account`)).toBe(true);
  });

  it('does not duplicate an already inventoried task', async () => {
    const first = await saveVideoTaskOutputsToAssets('video-account', task());
    const assets = await saveVideoTaskOutputsToAssets('video-account', task({ metadata: { inventoryAssetIds: [first[0].id] } }));
    expect(assets).toEqual([]);
  });

  it('repairs stale inventory ids by creating the missing asset', async () => {
    const assets = await saveVideoTaskOutputsToAssets('video-account', task({ metadata: { inventoryAssetIds: ['asset-missing'] } }));
    expect(assets).toHaveLength(1);
    expect(listAssets('video-account', 'inventory-video')).toHaveLength(1);
  });

  it('rejects remote non-video responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>error</html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    const assets = await saveVideoTaskOutputsToAssets('video-account', task({ outputBase64: [], outputUrls: ['https://cdn.example.test/video.mp4'] }), { lookup: publicLookup });
    expect(assets).toEqual([]);
    expect(listAssets('video-account', 'inventory-video')).toHaveLength(0);
  });

  it('deduplicates repeated output URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(mp4Bytes, { status: 200, headers: { 'content-type': 'video/mp4' } })));
    const assets = await saveVideoTaskOutputsToAssets('video-account', task({ outputBase64: [], outputUrls: ['https://cdn.example.test/video.mp4', 'https://cdn.example.test/video.mp4'] }), { lookup: publicLookup });
    expect(assets).toHaveLength(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('repairs saved historical tasks and persists their asset ids', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(mp4Bytes, { status: 200, headers: { 'content-type': 'video/mp4' } })));
    const persisted = createProviderTask(task({ id: undefined, outputBase64: [], outputUrls: ['https://cdn.example.test/history.mp4'], inventorySavedAt: '2026-09-03T01:00:00.000Z', metadata: undefined }));
    expect(await repairSavedVideoTaskInventory(undefined, { lookup: publicLookup })).toBe(1);
    const repaired = getProviderTask(persisted.id);
    expect(repaired?.inventorySavedAt).toBe(persisted.inventorySavedAt);
    const ids = repaired?.metadata?.inventoryAssetIds;
    expect(Array.isArray(ids)).toBe(true);
    expect(listAssets('video-account', 'inventory-video')).toHaveLength(1);
    expect(await repairSavedVideoTaskInventory(undefined, { lookup: publicLookup })).toBe(0);
  });

  it('does not write a task into a different account', async () => {
    const assets = await saveVideoTaskOutputsToAssets('other-account', task());
    expect(assets).toEqual([]);
    expect(listAssets('other-account', 'inventory-video')).toHaveLength(0);
  });

  it('repairs inventory ids that were accidentally shared by multiple tasks', async () => {
    const firstTask = createProviderTask(task({ id: undefined, outputBase64: ['data:video/mp4;base64,AAAA'], inventorySavedAt: '2026-09-03T01:00:00.000Z' }));
    const firstAsset = (await saveVideoTaskOutputsToAssets('video-account', firstTask))[0];
    updateProviderTask(firstTask.id, { metadata: { inventoryAssetIds: [firstAsset.id] } });
    const secondTask = createProviderTask(task({ id: undefined, outputBase64: ['data:video/mp4;base64,AAAA'], inventorySavedAt: '2026-09-03T01:00:00.000Z' }));
    updateProviderTask(secondTask.id, { metadata: { inventoryAssetIds: [firstAsset.id] } });

    await repairSavedVideoTaskInventory(undefined);
    const repaired = getProviderTask(secondTask.id);
    const ids = repaired?.metadata?.inventoryAssetIds;
    expect(Array.isArray(ids)).toBe(true);
    expect(ids).toHaveLength(1);
    expect(Array.isArray(ids) ? ids[0] : undefined).not.toBe(firstAsset.id);
    expect(listAssets('video-account', 'inventory-video')).toHaveLength(2);
  });
});
