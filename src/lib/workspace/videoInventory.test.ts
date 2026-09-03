import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveVideoTaskOutputsToAssets } from './videoInventory';
import type { ProviderTask } from '@/lib/providers/taskStore';

const root = `D:\\all_projects\\workspace\\data\\video-inventory-test-${process.pid}`;
process.env.WORKSPACE_DATA_ROOT = root;

function task(overrides: Partial<ProviderTask> = {}): ProviderTask {
  return { id: 'video-task-1', accountId: 'video-account', mode: 'video', provider: 'oairegbox-omni', model: 'omni-fast-no-water', prompt: 'demo', status: 'completed', progress: 100, providerTaskId: undefined, outputUrls: [], outputBase64: ['data:video/mp4;base64,AAAA'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
}

describe('video task inventory persistence', () => {
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('persists a completed base64 video as an inventory-video asset', async () => {
    const assets = await saveVideoTaskOutputsToAssets('video-account', task());
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe('inventory-video');
    expect(fs.existsSync(`${root}/uploads/video-account`)).toBe(true);
  });

  it('does not duplicate an already inventoried task', async () => {
    const assets = await saveVideoTaskOutputsToAssets('video-account', task({ metadata: { inventoryAssetIds: ['asset-existing'] } }));
    expect(assets).toEqual([]);
  });
});
