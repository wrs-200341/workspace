import { describe, expect, it } from 'vitest';
import { aggregateProductionTaskStats } from './dashboardStats';
import type { WorkspaceTask } from './tasks';

function task(overrides: Partial<WorkspaceTask> = {}): WorkspaceTask {
  return {
    id: 'task-1', accountId: 'account-1', pid: 'pending', title: 'task', owner: 'operator-1', mode: 'video', model: 'grok',
    status: 'queued', progress: 0, createdAt: '2026-09-03T01:00:00.000Z', outputUrls: [], outputBase64: [], ...overrides,
  };
}

describe('dashboard production statistics', () => {
  it('counts real task states and only completed outputs as successful', () => {
    const stats = aggregateProductionTaskStats([
      task({ id: 'queued', status: 'queued' }),
      task({ id: 'running', status: 'processing' }),
      task({ id: 'failed', status: 'failed', progress: 100, outputUrls: ['https://example.test/failed.mp4'] }),
      task({ id: 'completed', status: 'completed', progress: 100, outputUrls: ['https://example.test/a.mp4'], outputBase64: ['data:video/mp4;base64,abc'] }),
      task({ id: 'saved', status: 'completed', progress: 100, inventorySavedAt: '2026-09-03T02:00:00.000Z', outputUrls: ['https://example.test/saved-a.mp4', 'https://example.test/saved-b.mp4'], outputCount: 2 }),
      task({ id: 'paused', status: 'paused' }),
    ], '2026-09-03T03:00:00.000Z');

    expect(stats).toEqual({
      total: 6,
      queued: 1,
      running: 1,
      completed: 2,
      failed: 1,
      paused: 1,
      successfulOutputs: 4,
      inventorySavedToday: 1,
      completedNotInInventory: 1,
      activeAccountsToday: 1,
    });
  });

  it('does not count completed tasks that have no output', () => {
    const stats = aggregateProductionTaskStats([task({ status: 'completed', progress: 100 })], '2026-09-03T03:00:00.000Z');
    expect(stats.successfulOutputs).toBe(0);
    expect(stats.completedNotInInventory).toBe(0);
  });
});
