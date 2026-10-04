import fs from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeProviderTaskStore, createProviderTask, deleteProviderTask, updateProviderTask } from './taskStore';
import { listProviderGenerationDailyStats, listProviderGenerationStats } from './providerGenerationStats';

const testRoot = `D:\\all_projects\\workspace\\data\\provider-generation-stats-test-${process.pid}`;
const previousRoot = process.env.WORKSPACE_DATA_ROOT;

beforeEach(() => {
  process.env.WORKSPACE_DATA_ROOT = testRoot;
  closeProviderTaskStore();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

afterAll(() => {
  closeProviderTaskStore();
  fs.rmSync(testRoot, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.WORKSPACE_DATA_ROOT;
  else process.env.WORKSPACE_DATA_ROOT = previousRoot;
});

describe('provider generation statistics', () => {
  it('counts image and video lifecycle events once and excludes prompt tasks', () => {
    const image = createProviderTask({ id: 'image-1', accountId: 'account-1', mode: 'image', provider: 'yuanai-image' });
    const video = createProviderTask({ id: 'video-1', accountId: 'account-1', mode: 'video', provider: 'grok-video' });
    createProviderTask({ id: 'prompt-1', accountId: 'account-1', mode: 'prompt', provider: 'bigsnake-prompt' });

    updateProviderTask(image.id, { status: 'completed', progress: 100 });
    updateProviderTask(image.id, { status: 'completed', progress: 100 });
    updateProviderTask(image.id, { inventorySavedAt: '2026-09-29T03:00:00.000Z' });
    updateProviderTask(image.id, { inventorySavedAt: '2026-09-29T03:00:00.000Z' });

    const stats = listProviderGenerationStats();
    expect(stats.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'yuanai-image', mode: 'image', calls: 1, successes: 1, restores: 0, successfulRestores: 0, failedRestores: 0, inventories: 1 }),
      expect.objectContaining({ provider: 'grok-video', mode: 'video', calls: 1, successes: 0, restores: 0, successfulRestores: 0, failedRestores: 0, inventories: 0 }),
    ]));
    expect(stats.rows.some((row) => row.provider === 'bigsnake-prompt')).toBe(false);
    expect(stats.totals).toMatchObject({ calls: 2, successes: 1, restores: 0, successfulRestores: 0, failedRestores: 0, inventories: 1 });
    expect(video.status).toBe('queued');
  });

  it('keeps restore statistics after the original task is deleted', () => {
    const task = createProviderTask({ id: 'restore-1', accountId: 'account-1', mode: 'video', provider: 'grok-video', status: 'completed' });
    expect(deleteProviderTask(task.id, { restoreReason: 'restore-config' })).toBe(true);

    const row = listProviderGenerationStats().rows.find((candidate) => candidate.provider === 'grok-video');
    expect(row).toMatchObject({ calls: 1, successes: 1, restores: 1, successfulRestores: 1, failedRestores: 0 });
  });

  it('separates failed task recovery and filters daily task events by Shanghai date', () => {
    const failed = createProviderTask({ id: 'failed-restore', accountId: 'account-1', mode: 'video', provider: 'grok-video', status: 'failed' });
    expect(deleteProviderTask(failed.id, { restoreReason: 'restore-config' })).toBe(true);
    createProviderTask({ id: 'old', accountId: 'account-1', mode: 'video', provider: 'grok-video', status: 'completed', createdAt: '2026-09-28T15:59:59.000Z' });
    createProviderTask({ id: 'today', accountId: 'account-1', mode: 'video', provider: 'grok-video', status: 'completed', createdAt: '2026-09-28T16:00:00.000Z' });

    const stats = listProviderGenerationStats({ from: '2026-09-29', to: '2026-09-29' });
    expect(stats.totals).toMatchObject({ calls: 2, successes: 1, restores: 1, successfulRestores: 0, failedRestores: 1 });
    const daily = listProviderGenerationDailyStats();
    expect(daily.rows.map((row) => [row.businessDate, row.calls, row.successes, row.successfulRestores, row.failedRestores])).toEqual([
      ['2026-09-29', 2, 1, 0, 1],
      ['2026-09-28', 1, 1, 0, 0],
    ]);
  });
});
