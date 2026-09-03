import fs from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createProviderTask, getProviderTask } from './taskStore';
import { processMockProviderTasks, processMockProviderTask } from './taskProcessor';

const root = `D:\\all_projects\\workspace\\data\\task-processor-test-${process.pid}`;
const previous = process.env.WORKSPACE_DATA_ROOT;

beforeEach(() => {
  process.env.WORKSPACE_DATA_ROOT = root;
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.WORKSPACE_DATA_ROOT;
  else process.env.WORKSPACE_DATA_ROOT = previous;
});

describe('mock provider task processor', () => {
  it('advances a mock queued task through terminal completion without a network call', async () => {
    const task = createProviderTask({ accountId: 'account-1', mode: 'video', provider: 'grok-video', status: 'queued', metadata: { execution: 'mock' } });
    const completed = await processMockProviderTask(task.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.progress).toBe(100);
    expect(completed?.metadata).toMatchObject({ execution: 'mock', processedBy: 'workspace-mock-worker' });
    expect(getProviderTask(task.id)?.status).toBe('completed');
  });

  it('processes only mock tasks and leaves live/paused tasks untouched', async () => {
    const mockTask = createProviderTask({ accountId: 'account-1', mode: 'image', provider: 'yuanai-image', status: 'queued', metadata: { execution: 'mock' } });
    const liveTask = createProviderTask({ accountId: 'account-1', mode: 'video', provider: 'grok-video', status: 'queued', metadata: { execution: 'live' } });
    const pausedTask = createProviderTask({ accountId: 'account-1', mode: 'video', provider: 'grok-video', status: 'paused', metadata: { execution: 'mock' } });
    const processed = await processMockProviderTasks();
    expect(processed.map((item) => item.id)).toEqual([mockTask.id]);
    expect(getProviderTask(liveTask.id)?.status).toBe('queued');
    expect(getProviderTask(pausedTask.id)?.status).toBe('paused');
  });

  it('returns null for unknown ids and does not process non-queued tasks', async () => {
    expect(await processMockProviderTask('missing')).toBeNull();
    const task = createProviderTask({ accountId: 'account-1', mode: 'prompt', provider: 'yuanai-gemini-prompt', status: 'completed', progress: 100, metadata: { execution: 'mock' } });
    expect(await processMockProviderTask(task.id)).toEqual(task);
  });
});
