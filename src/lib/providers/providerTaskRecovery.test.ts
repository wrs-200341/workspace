import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderTask } from './taskStore';

const mocks = vi.hoisted(() => ({ tasks: new Map<string, unknown>(), sync: vi.fn(), imageCache: vi.fn(), videoCache: vi.fn() }));
vi.mock('./config', () => ({ isProviderLiveEnabled: () => true }));
vi.mock('./client', () => ({ syncProviderTask: mocks.sync, providerResponseSnapshot: (error: Error) => ({ code: error.message }) }));
vi.mock('./taskStore', () => ({
  getProviderTask: (id: string) => mocks.tasks.get(id) ?? null,
  listProviderTaskSummaries: () => [...mocks.tasks.values()],
  updateProviderTask: (id: string, patch: Partial<ProviderTask>) => {
    const current = mocks.tasks.get(id) as ProviderTask | undefined;
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    mocks.tasks.set(id, next);
    return next;
  },
}));
vi.mock('@/lib/workspace/access', () => ({ workspaceOwnerIdForAccount: () => undefined }));
vi.mock('@/lib/workspace/imageInventory', () => ({ cacheImageTaskOutputsBeforeCompletion: mocks.imageCache, localImageOutputUrls: () => ['/local/image'] }));
vi.mock('@/lib/workspace/videoInventory', () => ({ cacheVideoTaskOutputsBeforeCompletion: mocks.videoCache, localVideoOutputUrls: () => ['/local/video'] }));

import { syncMediaProviderTask } from './providerTaskRecovery';

function seed(mode: 'image' | 'video'): ProviderTask {
  const task: ProviderTask = { id: mode, accountId: 'account', mode, provider: mode === 'image' ? 'mgrouter-grok-image' : 'grok-video', status: 'running', progress: 50, providerTaskId: `upstream-${mode}`, outputUrls: [], outputBase64: [], createdAt: '2026-09-14T01:00:00Z', updatedAt: '2026-09-14T01:01:00Z', metadata: { schedulerState: 'provider-active', retained: 'original' } };
  mocks.tasks.set(task.id, task);
  return task;
}

beforeEach(() => {
  mocks.tasks.clear();
  mocks.sync.mockReset();
  mocks.imageCache.mockReset().mockResolvedValue({ expected: 1, cached: 1, ready: true });
  mocks.videoCache.mockReset().mockResolvedValue({ expected: 1, cached: 1, ready: true });
});

describe('worker media status recovery', () => {
  it.each(['image', 'video'] as const)('polls and caches accepted %s tasks with matching recovery behavior', async (mode) => {
    const task = seed(mode);
    mocks.sync.mockResolvedValue({ status: 'completed', progress: 100, outputUrls: [`https://cdn.example/${mode}`], outputBase64: [], response: {} });
    const result = await syncMediaProviderTask(task.id, { force: true });
    expect(mocks.sync).toHaveBeenCalledWith(task.provider, task.providerTaskId);
    expect(result).toMatchObject({ status: 'completed', providerTaskId: task.providerTaskId, outputUrls: [`/local/${mode}`], metadata: { retained: 'original', localOutputReady: true, lastProviderStatus: 'completed' } });
    expect(mode === 'image' ? mocks.imageCache : mocks.videoCache).toHaveBeenCalledTimes(1);
  });

  it('keeps accepted jobs pollable after a transport failure', async () => {
    const task = seed('video');
    mocks.sync.mockRejectedValue(new Error('provider_timeout'));
    expect(await syncMediaProviderTask(task.id, { force: true })).toMatchObject({ status: 'running', providerTaskId: task.providerTaskId });
  });

  it('records explicit supplier failure proof without losing the accepted attempt ID', async () => {
    const task = seed('image');
    mocks.sync.mockResolvedValue({ status: 'failed', progress: 100, outputUrls: [], outputBase64: [], error: 'provider_upstream_failed', response: {} });
    expect(await syncMediaProviderTask(task.id, { force: true })).toMatchObject({ status: 'failed', providerTaskId: task.providerTaskId, metadata: { lastProviderStatus: 'failed' } });
  });

  it('does not resurrect a cancellation that arrives during output caching', async () => {
    const task = seed('video');
    mocks.sync.mockResolvedValue({ status: 'completed', progress: 100, outputUrls: ['https://cdn.example/video'], outputBase64: [], response: {} });
    mocks.videoCache.mockImplementation(async () => {
      const latest = mocks.tasks.get(task.id) as ProviderTask;
      mocks.tasks.set(task.id, { ...latest, status: 'cancelled' });
      return { expected: 1, cached: 1, ready: true };
    });
    expect(await syncMediaProviderTask(task.id, { force: true })).toMatchObject({ status: 'cancelled', providerTaskId: task.providerTaskId });
  });
});
