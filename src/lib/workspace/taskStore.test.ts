import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceTask, getWorkspaceTaskById, resetWorkspaceTaskStore, updateWorkspaceTask } from './taskStore';

const testRoot = 'D:\\all_projects\\workspace\\data\\test-task-store';

beforeEach(() => {
  process.env.WORKSPACE_DATA_ROOT = testRoot;
  fs.rmSync(testRoot, { force: true, recursive: true });
});

afterEach(() => {
  resetWorkspaceTaskStore();
  fs.rmSync(testRoot, { force: true, recursive: true });
  delete process.env.WORKSPACE_DATA_ROOT;
});

describe('workspace task persistence', () => {
  it('persists a provider-backed task and reads it by id', () => {
    const created = createWorkspaceTask({
      id: 'persist-test-1', accountId: 'account-a', pid: 'pid-1', title: 'test', owner: 'operator',
      mode: 'video', model: 'grok-video', status: 'queued', progress: 0,
      createdAt: '2026-09-02T01:00:00.000Z', provider: 'grok-video', providerTaskId: 'upstream-1',
    });
    expect(created.providerTaskId).toBe('upstream-1');
    expect(getWorkspaceTaskById('persist-test-1')?.providerTaskId).toBe('upstream-1');
  });

  it('updates status and output metadata immutably', () => {
    createWorkspaceTask({ id: 'persist-test-2', accountId: 'account-a', pid: 'pid-2', title: 'test', owner: 'operator', mode: 'image', model: 'grok', status: 'queued', progress: 0, createdAt: new Date().toISOString() });
    const updated = updateWorkspaceTask('persist-test-2', { status: 'completed', progress: 100, outputUrls: ['https://cdn.example/image.png'] });
    expect(updated).toMatchObject({ status: 'completed', progress: 100, outputUrls: ['https://cdn.example/image.png'] });
    expect(updateWorkspaceTask('missing', { status: 'failed' })).toBeNull();
  });
});
