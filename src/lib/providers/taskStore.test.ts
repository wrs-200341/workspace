import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkspacePath } from '../storagePaths';
import {
  createProviderTask,
  createProviderTasks,
  closeProviderTaskStore,
  deleteProviderTask,
  getProviderTask,
  listProviderTasks,
  listProviderTaskSummaries,
  findNextUnreviewedVideoTask,
  migrateProviderTaskStore,
  legacyProviderTasksPath,
  getProviderTaskStoreRevision,
  getProviderTaskCounterAggregates,
  getProviderTaskStatsAggregate,
  listInventorySavedVideoTaskSummariesSince,
  countCompletedProviderTasksForDailyQuota,
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
  closeProviderTaskStore();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

afterAll(() => {
  closeProviderTaskStore();
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

  it('finds the next unreviewed video in queue order and wraps within the account scope', () => {
    seed({ id: 'newest', accountId: 'account-1', status: 'completed', createdAt: '2026-09-14T04:00:00.000Z', outputUrls: ['https://cdn.example/newest.mp4'] });
    seed({ id: 'current', accountId: 'account-1', status: 'completed', createdAt: '2026-09-14T03:00:00.000Z', outputUrls: ['https://cdn.example/current.mp4'] });
    seed({ id: 'next-cross-account', accountId: 'account-2', status: 'completed', createdAt: '2026-09-14T02:00:00.000Z', outputUrls: ['https://cdn.example/next.mp4'] });
    seed({ id: 'saved', accountId: 'account-2', status: 'completed', createdAt: '2026-09-14T01:00:00.000Z', outputUrls: ['https://cdn.example/saved.mp4'], inventorySavedAt: '2026-09-14T05:00:00.000Z' });
    seed({ id: 'failed', accountId: 'account-2', status: 'failed', createdAt: '2026-09-14T00:30:00.000Z', outputUrls: ['https://cdn.example/failed.mp4'] });
    seed({ id: 'other-owner', accountId: 'account-3', status: 'completed', createdAt: '2026-09-14T02:30:00.000Z', outputUrls: ['https://cdn.example/other.mp4'] });

    expect(findNextUnreviewedVideoTask(['account-1', 'account-2'], { id: 'current', createdAt: '2026-09-14T03:00:00.000Z' })?.id).toBe('next-cross-account');
    expect(findNextUnreviewedVideoTask(['account-1', 'account-2'], { id: 'next-cross-account', createdAt: '2026-09-14T02:00:00.000Z' })?.id).toBe('newest');
    expect(findNextUnreviewedVideoTask([], { id: 'current', createdAt: '2026-09-14T03:00:00.000Z' })).toBeNull();
  });

  it('aggregates counters and daily quota inside SQLite without hydrating task details', () => {
    seed({
      id: 'saved-today',
      accountId: 'account-a',
      status: 'completed',
      createdAt: '2026-09-12T04:00:00.000Z',
      inventorySavedAt: '2026-09-14T04:00:00.000Z',
      outputUrls: ['https://cdn.example/saved.mp4'],
      metadata: { ownerId: 'owner-a', modelId: 'minimax-h3-max' },
      model: 'minimax-h3-max',
    });
    seed({
      id: 'unsaved-today',
      accountId: 'account-a',
      status: 'completed',
      createdAt: '2026-09-14T04:00:00.000Z',
      outputUrls: ['https://cdn.example/unsaved.mp4'],
      metadata: { ownerId: 'owner-a', modelId: 'minimax-h3-max' },
      model: 'minimax-h3-max',
    });
    seed({ id: 'running', accountId: 'account-a', status: 'running', createdAt: '2026-09-14T04:00:00.000Z', metadata: { ownerId: 'owner-a' } });
    seed({ id: 'failed', accountId: 'account-b', status: 'failed', createdAt: '2026-09-13T04:00:00.000Z', metadata: { ownerId: 'owner-b' } });

    expect(getProviderTaskCounterAggregates({}, '2026-09-14')).toEqual([
      {
        accountId: 'account-a',
        metadataOwnerId: 'owner-a',
        inventorySavedToday: 1,
        completedNotInInventory: 1,
        running: 1,
        queued: 0,
        failed: 0,
      },
      {
        accountId: 'account-b',
        metadataOwnerId: 'owner-b',
        inventorySavedToday: 0,
        completedNotInInventory: 0,
        running: 0,
        queued: 0,
        failed: 1,
      },
    ]);
    expect(getProviderTaskStatsAggregate('2026-09-14')).toMatchObject({
      total: 4,
      running: 1,
      completed: 2,
      failed: 1,
      successfulOutputs: 2,
      inventorySavedToday: 1,
      completedNotInInventory: 1,
      activeAccountsToday: 1,
    });
    expect(countCompletedProviderTasksForDailyQuota('owner-a', 'minimax-h3-max', '2026-09-14')).toBe(2);
    expect(countCompletedProviderTasksForDailyQuota('owner-b', 'minimax-h3-max', '2026-09-14')).toBe(0);
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

  it.each([false, true])('preserves complete PNG outputs through create, update and reopen (data URL: %s)', async (dataUrl) => {
    const pixels = randomBytes(128 * 128 * 3);
    const png = await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
    const base64 = png.toString('base64');
    const output = dataUrl ? `data:image/png;base64,${base64}` : base64;
    expect(base64.length).toBeGreaterThan(32_000);

    const created = seed({ mode: 'image', provider: 'yuanai-image', status: 'processing', outputBase64: [output] });
    expect(created.outputBase64).toEqual([output]);
    closeProviderTaskStore();
    expect(getProviderTask(created.id)?.outputBase64).toEqual([output]);

    const updated = updateProviderTask(created.id, { status: 'completed', progress: 100, outputBase64: [output] });
    expect(updated?.outputBase64).toEqual([output]);
    closeProviderTaskStore();
    const persisted = getProviderTask(created.id)!;
    expect(persisted.outputBase64).toEqual([output]);
    const decoded = Buffer.from(dataUrl ? persisted.outputBase64[0].split(',')[1] : persisted.outputBase64[0], 'base64');
    expect(decoded.equals(png)).toBe(true);
    expect((await sharp(decoded).raw().toBuffer()).equals(pixels)).toBe(true);
    expect(listProviderTaskSummaries({ ids: [created.id] })[0]).not.toHaveProperty('outputBase64');
  });

  it('rejects oversized binary outputs without partially creating or updating tasks', () => {
    const original = seed({ id: 'original', status: 'processing', progress: 90 });
    const revision = getProviderTaskStoreRevision();
    const oversized = 'A'.repeat(Math.ceil((50 * 1024 * 1024 + 1) / 3) * 4);
    expect(() => createProviderTasks([
      { id: 'batch-first', accountId: 'a', provider: 'yuanai-image', mode: 'image' },
      { id: 'too-large', accountId: 'a', provider: 'yuanai-image', mode: 'image', outputBase64: [oversized] },
    ])).toThrow('output_base64_too_large');
    expect(getProviderTask('batch-first')).toBeNull();
    expect(getProviderTask('too-large')).toBeNull();
    expect(() => updateProviderTask(original.id, {
      status: 'completed', progress: 100, outputBase64: [oversized],
    })).toThrow('output_base64_too_large');
    expect(getProviderTask(original.id)).toEqual(original);
    expect(getProviderTaskStoreRevision()).toBe(revision);
  });

  it('rejects excessive aggregate binary output size or count without replacing existing data', () => {
    const original = seed({ status: 'processing', outputBase64: ['aGVsbG8='] });
    const revision = getProviderTaskStoreRevision();
    const output = 'A'.repeat(4 * Math.ceil(41 * 1024 * 1024 / 3));
    expect(() => updateProviderTask(original.id, {
      status: 'completed', outputBase64: Array(5).fill(output),
    })).toThrow('output_base64_total_too_large');
    expect(() => updateProviderTask(original.id, {
      status: 'completed', outputBase64: Array(65).fill('aGVsbG8='),
    })).toThrow('output_base64_too_many_items');
    expect(getProviderTask(original.id)).toEqual(original);
    expect(getProviderTaskStoreRevision()).toBe(revision);
  });

  it('retains ordinary text and URL limits separately from binary outputs', () => {
    const task = seed({ prompt: 'x'.repeat(33_000), outputUrls: ['https://example.com/' + 'x'.repeat(33_000)] });
    expect(task.prompt).toHaveLength(32_000);
    expect(task.outputUrls[0]).toHaveLength(32_000);
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

  it('uses the inventory-date index to list only saved videos after an exact timestamp', () => {
    seed({ id: 'before', status: 'completed', inventorySavedAt: '2026-09-28T01:00:00.000Z', outputUrls: ['https://cdn.example/before.mp4'] });
    seed({ id: 'after', status: 'completed', inventorySavedAt: '2026-09-28T03:00:00.000Z', outputUrls: ['https://cdn.example/after.mp4'] });
    seed({ id: 'tomorrow', status: 'completed', inventorySavedAt: '2026-09-29T03:00:00.000Z', outputUrls: ['https://cdn.example/tomorrow.mp4'] });
    seed({ id: 'unsaved', status: 'completed', outputUrls: ['https://cdn.example/unsaved.mp4'] });
    seed({ id: 'image', mode: 'image', provider: 'yuanai-image', status: 'completed', inventorySavedAt: '2026-09-28T03:00:00.000Z', outputUrls: ['https://cdn.example/image.png'] });

    expect(listInventorySavedVideoTaskSummariesSince('2026-09-28T02:00:00.000Z').map((task) => task.id)).toEqual(['after', 'tomorrow']);
    expect(listInventorySavedVideoTaskSummariesSince('not-a-date')).toEqual([]);
  });

  it('adds current pipeline context to legacy error-info snapshots without loading task details', () => {
    const task = seed({
      id: 'legacy-dual-model-error',
      status: 'failed',
      error: 'video_prompt_too_long',
      metadata: {
        promptMode: 'asset-template-child-prompt',
        promptGenerationPending: false,
        promptGenerationFailed: false,
        promptProvider: 'pomoai-gpt-prompt',
        promptModel: 'claude-opus-4-8',
      },
    });
    closeProviderTaskStore();
    const db = new DatabaseSync(providerTasksPath());
    try {
      const row = db.prepare('SELECT summary FROM provider_tasks WHERE id=?').get(task.id) as { summary: string };
      const legacy = JSON.parse(row.summary) as Record<string, unknown>;
      legacy.errorInfo = { code: 'video_prompt_too_long', category: 'invalid_request', title: '提示词超长', message: '', action: '请缩短提示词后重新提交。', safeToRetry: false };
      db.prepare('UPDATE provider_tasks SET summary=? WHERE id=?').run(JSON.stringify(legacy), task.id);
    } finally { db.close(); }

    const summary = listProviderTaskSummaries({ ids: [task.id] })[0];
    expect(summary.errorInfo?.title).toBe('snumom 视频提交前校验失败：提示词超长');
    expect(summary.errorInfo?.message).toContain('子提示词模型 PomoAI · claude-opus-4-8 已成功生成');
    expect(summary.errorInfo?.message).toContain('错误环节：视频模型 snumom · grok-imagine-video-1.5的提交前校验环节');
    expect(summary.errorInfo?.action).toBe('');
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
