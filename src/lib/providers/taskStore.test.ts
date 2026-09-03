import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getWorkspacePath } from '../storagePaths';
import {
  createProviderTask,
  deleteProviderTask,
  getProviderTask,
  listProviderTasks,
  providerTasksPath,
  updateProviderTask,
  type ProviderTask,
} from './taskStore';

const testRoot = `D:\\all_projects\\workspace\\data\\provider-task-store-test-${process.pid}`;
const previousRoot = process.env.WORKSPACE_DATA_ROOT;

beforeEach(() => {
  process.env.WORKSPACE_DATA_ROOT = testRoot;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.WORKSPACE_DATA_ROOT;
  else process.env.WORKSPACE_DATA_ROOT = previousRoot;
});

function seed(overrides: Partial<Parameters<typeof createProviderTask>[0]> = {}): ProviderTask {
  return createProviderTask({
    accountId: 'account-1',
    mode: 'video',
    provider: 'grok-video',
    model: 'grok-imagine-video-1.5',
    prompt: 'A product demo',
    ...overrides,
  });
}

describe('JSON provider task store', () => {
  it('keeps the task file below the D-drive workspace data root', () => {
    expect(providerTasksPath()).toBe(getWorkspacePath('providers', 'tasks.json'));
    expect(providerTasksPath().toLowerCase()).toContain('d:\\all_projects\\workspace\\data');
  });

  it('creates and reads a task with generated identity and timestamps', () => {
    const task = seed();

    expect(task.id).toMatch(/^provider-task-/);
    expect(task.status).toBe('queued');
    expect(task.progress).toBe(0);
    expect(task.outputUrls).toEqual([]);
    expect(task.outputBase64).toEqual([]);
    expect(task.createdAt).toBe(task.updatedAt);
    expect(getProviderTask(task.id)).toEqual(task);
    expect(fs.existsSync(path.join(testRoot, 'providers', 'tasks.json'))).toBe(true);
  });

  it('lists immutable task copies and supports filters', () => {
    const first = seed({ accountId: 'account-1', status: 'running', progress: 35 });
    const second = seed({ accountId: 'account-2', mode: 'image', provider: 'yuanai-image', status: 'completed', progress: 100 });

    const listed = listProviderTasks();
    expect(listed).toHaveLength(2);
    expect(listProviderTasks({ accountId: 'account-2' })).toEqual([second]);
    expect(listProviderTasks({ status: 'running' })).toEqual([first]);
    expect(listProviderTasks({ mode: 'image', provider: 'yuanai-image' })).toEqual([second]);

    listed[0].outputUrls.push('https://mutated.example/out.mp4');
    expect(getProviderTask(first.id)?.outputUrls).toEqual([]);
  });

  it('updates a task atomically without allowing id or creation time changes', () => {
    const task = seed();
    const updated = updateProviderTask(task.id, {
      status: 'completed',
      progress: 100,
      providerTaskId: 'remote-123',
      outputUrls: ['https://cdn.example/video.mp4'],
      id: 'attacker-id',
      createdAt: '2000-01-01T00:00:00.000Z',
    } as never);

    expect(updated).toMatchObject({
      id: task.id,
      createdAt: task.createdAt,
      status: 'completed',
      progress: 100,
      providerTaskId: 'remote-123',
      outputUrls: ['https://cdn.example/video.mp4'],
    });
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(task.updatedAt).getTime());
    expect(getProviderTask(task.id)).toEqual(updated);
  });

  it('clears optional provider fields when a patch explicitly sets them to undefined', () => {
    const task = seed({ error: 'temporary failure', providerTaskId: 'remote-1' });
    const updated = updateProviderTask(task.id, { error: undefined, providerTaskId: undefined });
    expect(updated?.error).toBeUndefined();
    expect(updated?.providerTaskId).toBeUndefined();
  });

  it('returns null for missing tasks and rejects invalid create input', () => {
    expect(getProviderTask('missing')).toBeNull();
    expect(updateProviderTask('missing', { status: 'failed' })).toBeNull();
    expect(() => createProviderTask({ accountId: '', mode: 'video', provider: 'grok-video' })).toThrow('account_id_required');
    expect(() => createProviderTask({ accountId: 'a', mode: 'video', provider: 'not-a-provider' as never })).toThrow('provider_invalid');
  });

  it('deletes only the requested task and is idempotent for missing ids', () => {
    const first = seed({ id: 'delete-me' });
    const second = seed({ id: 'keep-me' });

    expect(deleteProviderTask(first.id)).toBe(true);
    expect(getProviderTask(first.id)).toBeNull();
    expect(getProviderTask(second.id)).toEqual(second);
    expect(deleteProviderTask(first.id)).toBe(false);
    expect(deleteProviderTask('')).toBe(false);
  });
});
