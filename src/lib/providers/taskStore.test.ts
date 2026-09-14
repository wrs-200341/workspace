import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkspacePath } from '../storagePaths';
import {
  createProviderTask,
  deleteProviderTask,
  getProviderTask,
  listProviderTasks,
  listProviderTaskSummaries,
  migrateProviderTaskStore,
  legacyProviderTasksPath,
  getProviderTaskStoreRevision,
  acquireProviderWorkerLease,
  releaseProviderWorkerLease,
  claimProviderTask,
  providerTasksPath,
  updateProviderTask,
  type ProviderTask,
} from './taskStore';

const testRoot = `D:\\all_projects\\workspace\\data\\provider-task-store-test-${process.pid}`;
const previousRoot = process.env.WORKSPACE_DATA_ROOT;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

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

describe('indexed provider task store', () => {
  it('keeps the task file below the D-drive workspace data root', () => {
    expect(providerTasksPath()).toBe(getWorkspacePath('providers', 'tasks.sqlite'));
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
    expect(fs.existsSync(path.join(testRoot, 'providers', 'tasks.sqlite'))).toBe(true);
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

  it('requires explicit migration and preserves every legacy field and source byte', () => {
    const record = { id: 'legacy', accountId: 'a', mode: 'video', provider: 'grok-video', status: 'running', progress: 70,
      prompt: 'complete prompt', providerTaskId: 'accepted-123', outputUrls: [], outputBase64: [],
      metadata: { originalPrompt: 'original'.repeat(10000), promptTemplateContent: 'template'.repeat(8000), inventoryAssetIds: ['asset-1'], nested: { values: [1, 2] } },
      inventorySavedAt: '2026-09-12T02:00:00.000Z', providerResponse: { request_id: 'request-1' },
      createdAt: '2026-09-11T23:00:00.000Z', updatedAt: '2026-09-12T02:00:00.000Z' };
    const original = JSON.stringify([record], null, 2);
    fs.mkdirSync(path.dirname(legacyProviderTasksPath()), { recursive: true });
    fs.writeFileSync(legacyProviderTasksPath(), original);
    expect(() => listProviderTasks()).toThrow('provider_tasks_migration_required');
    expect(migrateProviderTaskStore()).toMatchObject({ count: 1, alreadyImported: false });
    expect(getProviderTask('legacy')).toEqual(record);
    expect(fs.readFileSync(legacyProviderTasksPath(), 'utf8')).toBe(original);
    expect(migrateProviderTaskStore()).toMatchObject({ count: 1, alreadyImported: true });
  });

  it('rolls back an invalid migration instead of leaving a partial task table', () => {
    fs.mkdirSync(path.dirname(legacyProviderTasksPath()), { recursive: true });
    fs.writeFileSync(legacyProviderTasksPath(), JSON.stringify([{ id: 'bad' }]));
    expect(() => migrateProviderTaskStore()).toThrow();
    const db = new DatabaseSync(providerTasksPath());
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM provider_tasks').get()?.count).toBe(0); }
    finally { db.close(); }
  });

  it('rolls back rows and provenance when the legacy source changes during import', () => {
    const source = legacyProviderTasksPath();
    const record = { id: 'before', accountId: 'a', mode: 'video', provider: 'grok-video', status: 'queued', progress: 0,
      outputUrls: [], outputBase64: [], createdAt: '2026-09-14T01:00:00Z', updatedAt: '2026-09-14T01:00:00Z' };
    const changed = JSON.stringify([record, { ...record, id: 'arrived-during-import' }]);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, JSON.stringify([record]));
    const originalRead = fs.readFileSync;
    let changedSource = false;
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
      const content = originalRead(file, options);
      if (file === source && !changedSource) {
        changedSource = true;
        fs.writeFileSync(source, changed);
      }
      return content;
    }) as typeof fs.readFileSync);
    try { expect(() => migrateProviderTaskStore()).toThrow('legacy_task_store_changed_during_migration'); }
    finally { read.mockRestore(); }
    const db = new DatabaseSync(providerTasksPath());
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM provider_tasks').get()?.count).toBe(0);
      expect(db.prepare("SELECT value FROM task_store_meta WHERE key='imported'").get()).toBeUndefined();
      expect(db.prepare("SELECT value FROM task_store_meta WHERE key='imported_source_sha256'").get()).toBeUndefined();
    } finally { db.close(); }
    expect(migrateProviderTaskStore()).toMatchObject({ count: 2, alreadyImported: false, sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(getProviderTask('arrived-during-import')).not.toBeNull();
  });

  it('refuses a changed legacy source on retry without altering already imported tasks', () => {
    const source = legacyProviderTasksPath();
    const record = { id: 'original', accountId: 'a', mode: 'video', provider: 'grok-video', status: 'queued', progress: 0,
      outputUrls: [], outputBase64: [], createdAt: '2026-09-14T01:00:00Z', updatedAt: '2026-09-14T01:00:00Z' };
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, JSON.stringify([record]));
    const first = migrateProviderTaskStore();
    expect(migrateProviderTaskStore()).toMatchObject({ alreadyImported: true, sourceSha256: first.sourceSha256 });
    fs.writeFileSync(source, JSON.stringify([record, { ...record, id: 'later' }]));
    expect(() => migrateProviderTaskStore()).toThrow('provider_tasks_legacy_source_changed_since_import');
    expect(getProviderTask('original')).toEqual(record);
    expect(getProviderTask('later')).toBeNull();
  });

  it('adds missing provenance only for an exact old migration and preserves newer SQLite data', () => {
    const source = legacyProviderTasksPath();
    const record = { id: 'original', accountId: 'a', mode: 'video', provider: 'grok-video', status: 'queued', progress: 0,
      outputUrls: [], outputBase64: [], createdAt: '2026-09-14T01:00:00Z', updatedAt: '2026-09-14T01:00:00Z' };
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, JSON.stringify([record]));
    const imported = migrateProviderTaskStore();
    const removeDigest = () => {
      const db = new DatabaseSync(providerTasksPath());
      try { db.exec("DELETE FROM task_store_meta WHERE key='imported_source_sha256'"); }
      finally { db.close(); }
    };
    removeDigest();
    const revision = getProviderTaskStoreRevision();
    expect(migrateProviderTaskStore()).toMatchObject({ count: 1, alreadyImported: true, sourceSha256: imported.sourceSha256 });
    expect(getProviderTaskStoreRevision()).toBe(revision);
    removeDigest();
    const updated = updateProviderTask('original', { progress: 75 });
    expect(() => migrateProviderTaskStore()).toThrow('provider_tasks_migration_provenance_missing');
    expect(getProviderTask('original')).toEqual(updated);
    const db = new DatabaseSync(providerTasksPath());
    try { expect(db.prepare("SELECT value FROM task_store_meta WHERE key='imported_source_sha256'").get()).toBeUndefined(); }
    finally { db.close(); }
  });

  it('filters dates in Shanghai, pages rows, and never exposes long details in summaries', () => {
    seed({ id: 'old', createdAt: '2026-09-10T01:00:00Z' });
    const first = seed({ id: 'first', createdAt: '2026-09-13T16:00:00Z', metadata: { originalPrompt: 'x'.repeat(20000), providerTaskAcceptedAt: '2026-09-14T01:00:00Z' } });
    seed({ id: 'second', createdAt: '2026-09-14T02:00:00Z' });
    const summaries = listProviderTaskSummaries({ accountIds: ['account-1'], createdBusinessDate: '2026-09-14', limit: 1 });
    expect(summaries.map((task) => task.id)).toEqual([first.id]);
    expect(summaries[0].metadata).not.toHaveProperty('originalPrompt');
    expect(summaries[0].metadata?.providerTaskAcceptedAt).toBe('2026-09-14T01:00:00Z');
    expect(listProviderTaskSummaries({ accountIds: [] })).toEqual([]);
    expect(listProviderTaskSummaries({ ids: ['second'] }).map((task) => task.id)).toEqual(['second']);
  });

  it('updates progress without rewriting prompt details and increments revision on deletion', () => {
    const task = seed({ metadata: { originalPrompt: 'keep'.repeat(10000), promptTemplateContent: 'snapshot'.repeat(5000) } });
    const db = new DatabaseSync(providerTasksPath());
    try { db.exec("CREATE TRIGGER forbid_detail_update BEFORE UPDATE ON provider_task_details BEGIN SELECT RAISE(ABORT, 'unexpected_detail_write'); END;"); }
    finally { db.close(); }
    const revision = getProviderTaskStoreRevision();
    expect(updateProviderTask(task.id, { progress: 71 })?.progress).toBe(71);
    expect(getProviderTask(task.id)?.metadata).toEqual(task.metadata);
    expect(getProviderTaskStoreRevision()).toBe(revision + 1);
    deleteProviderTask(task.id);
    expect(getProviderTaskStoreRevision()).toBe(revision + 2);
  });

  it('claims a waiting task once and never claims an accepted or uncertain submission', () => {
    const waiting = seed({ metadata: { schedulerState: 'waiting' } });
    const accepted = seed({ providerTaskId: 'remote-id', metadata: { schedulerState: 'waiting' } });
    const uncertain = seed({ metadata: { schedulerState: 'waiting', providerSubmissionUncertain: true } });
    expect(acquireProviderWorkerLease('worker-1', 60000)).toBe(true);
    expect(acquireProviderWorkerLease('worker-2', 60000)).toBe(false);
    expect(claimProviderTask(waiting.id, 'worker-2')).toBeNull();
    expect(claimProviderTask(waiting.id, 'worker-1')?.metadata?.schedulerState).toBe('dispatching');
    expect(claimProviderTask(waiting.id, 'worker-1')).toBeNull();
    expect(claimProviderTask(accepted.id, 'worker-1')).toBeNull();
    expect(claimProviderTask(uncertain.id, 'worker-1')).toBeNull();
    releaseProviderWorkerLease('worker-1');
    expect(acquireProviderWorkerLease('worker-2', 60000)).toBe(true);
  });

  it('rejects a stale asynchronous write instead of overwriting a newer user action', () => {
    const original = seed();
    const paused = updateProviderTask(original.id, { status: 'paused', metadata: { inventoryAssetIds: ['keep'] } });
    expect(updateProviderTask(original.id, { status: 'completed', metadata: {} }, original.updatedAt)).toBeNull();
    expect(getProviderTask(original.id)).toEqual(paused);
  });
});
