import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeProviderTaskStore, createProviderTask, getProviderTask, listProviderTaskSummaries, updateProviderTask } from './taskStore';
import { enqueueProviderTask, requeueProviderTask, retryProviderTaskOnFailure } from './concurrency';
import { DurableProviderWorker, isDurableWaitingTask } from './durableWorker';

const mocks = vi.hoisted(() => ({ image: vi.fn(), video: vi.fn(), recovery: vi.fn(async () => []) }));
vi.mock('./imageTaskExecution', () => ({ executePersistedImageTask: mocks.image }));
vi.mock('./videoTaskExecution', () => ({ executePersistedVideoTask: mocks.video }));
vi.mock('./providerTaskRecovery', () => ({ runProviderTaskRecoveryPass: mocks.recovery }));
vi.mock('@/lib/workspace/imageInventory', () => ({ recoverPendingImageTaskOutputCache: vi.fn(async () => null) }));
vi.mock('@/lib/workspace/videoInventory', () => ({ recoverPendingVideoTaskOutputCache: vi.fn(async () => null) }));
vi.mock('./taskProcessor', () => ({ processMockProviderTask: vi.fn(async () => undefined) }));
vi.mock('@/lib/workspace/access', () => ({ workspaceOwnerIdForAccount: () => undefined }));

let root = '';
let workers: DurableProviderWorker[] = [];
const priorRoot = process.env.WORKSPACE_DATA_ROOT;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), 'data', 'durable-worker-test-'));
  process.env.WORKSPACE_DATA_ROOT = root;
  mocks.image.mockReset();
  mocks.video.mockReset();
  mocks.recovery.mockClear();
  workers = [];
});

afterEach(async () => {
  for (const worker of workers) await worker.drain();
  closeProviderTaskStore();
  fs.rmSync(root, { recursive: true, force: true });
  if (priorRoot === undefined) delete process.env.WORKSPACE_DATA_ROOT;
  else process.env.WORKSPACE_DATA_ROOT = priorRoot;
  vi.unstubAllEnvs();
});

function worker(): DurableProviderWorker {
  const value = new DurableProviderWorker();
  workers.push(value);
  value.start();
  return value;
}

function seed(id: string, extra: Partial<Parameters<typeof createProviderTask>[0]> = {}) {
  return createProviderTask({ id, accountId: 'account-a', mode: 'image', provider: 'mgrouter-grok-image', model: 'image-model', status: 'queued', metadata: { ownerId: 'owner-a', schedulerState: 'waiting' }, ...extra });
}

describe('durable provider worker', () => {
  it('acknowledges persisted IDs without starting callbacks in the web process', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const task = seed('web-only');
    const callback = vi.fn(async () => undefined);
    expect(enqueueProviderTask({ taskId: task.id, ownerId: 'owner-a', mode: 'image', model: 'image-model', run: callback })).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    expect(getProviderTask(task.id)?.metadata?.schedulerState).toBe('waiting');
  });

  it('executes a waiting task from storage and never resubmits an accepted provider ID after restart', async () => {
    seed('waiting');
    seed('accepted', { status: 'running', providerTaskId: 'upstream-preserved', metadata: { ownerId: 'owner-a', schedulerState: 'provider-active' } });
    mocks.image.mockImplementation(async (id: string) => { updateProviderTask(id, { status: 'completed', progress: 100 }); });
    const first = worker();
    await first.tick();
    await first.drain();
    expect(mocks.image.mock.calls).toEqual([['waiting']]);
    expect(getProviderTask('accepted')?.providerTaskId).toBe('upstream-preserved');
    expect(requeueProviderTask('accepted')).toBe(false);
    const second = worker();
    await second.tick();
    await second.drain();
    expect(mocks.image.mock.calls).toEqual([['waiting']]);
  });

  it('fails interrupted submitting jobs without clearing metadata or issuing a new request', async () => {
    seed('uncertain', { status: 'submitting', metadata: { schedulerState: 'dispatching', providerSubmissionStartedAt: '2026-09-14T01:00:00Z', promptTemplateContent: 'retained template' } });
    const active = worker();
    await active.tick();
    expect(mocks.image).not.toHaveBeenCalled();
    expect(getProviderTask('uncertain')).toMatchObject({ status: 'failed', error: 'provider_submission_uncertain', metadata: { providerSubmissionUncertain: true, schedulerRetryExhausted: true, promptTemplateContent: 'retained template' } });
    expect(requeueProviderTask('uncertain')).toBe(false);
  });

  it('allows only one independently leased worker', () => {
    worker();
    expect(() => worker()).toThrow('provider_worker_already_running');
  });

  it('resumes a safely claimed job when the prior worker stopped before its POST checkpoint', async () => {
    seed('before-post', { status: 'submitting', metadata: { schedulerState: 'dispatching', schedulerWorkerId: 'dead-worker' } });
    mocks.image.mockImplementation(async (id: string) => { updateProviderTask(id, { status: 'completed', progress: 100 }); });
    const active = worker();
    await active.tick();
    await active.drain();
    expect(mocks.image).toHaveBeenCalledWith('before-post');
    expect(getProviderTask('before-post')?.status).toBe('completed');
  });

  it('retries confirmed supplier failures while archiving the original accepted attempt', () => {
    seed('confirmed-failed', { status: 'failed', providerTaskId: 'confirmed-old-id', metadata: { schedulerState: 'terminal', providerAcceptedAt: '2026-09-14T01:00:00Z', lastProviderStatus: 'failed' } });
    expect(retryProviderTaskOnFailure('confirmed-failed')).toBe(true);
    expect(getProviderTask('confirmed-failed')).toMatchObject({ status: 'retrying', metadata: { schedulerRetryCount: 1, providerAttemptHistory: [{ providerTaskId: 'confirmed-old-id', status: 'failed' }] } });
    expect(getProviderTask('confirmed-failed')?.providerTaskId).toBeUndefined();
    expect(getProviderTask('confirmed-failed')?.metadata?.providerAcceptedAt).toBeUndefined();
  });

  it('never turns a polling timeout with an accepted ID into a new paid attempt', () => {
    seed('poll-timeout', { status: 'failed', providerTaskId: 'still-upstream', error: 'provider_request_failed', metadata: { schedulerState: 'terminal', providerAcceptedAt: '2026-09-14T01:00:00Z', lastProviderStatus: 'running' } });
    expect(retryProviderTaskOnFailure('poll-timeout')).toBe(false);
    expect(getProviderTask('poll-timeout')?.providerTaskId).toBe('still-upstream');
  });

  it('runs the real isolated supervisor and child to completion without Next or live providers', () => {
    closeProviderTaskStore();
    const result = spawnSync(process.execPath, ['scripts/provider-worker-supervisor.mjs', '--once'], { cwd: process.cwd(), env: { ...process.env, WORKSPACE_DATA_ROOT: root, NODE_ENV: 'test', WORKSPACE_ENABLE_LIVE_PROVIDERS: 'false' }, encoding: 'utf8', timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Provider worker stopped.');
  });

  it('honors persisted retry delays and excludes accepted or uncertain jobs', () => {
    seed('delayed', { status: 'retrying', metadata: { schedulerState: 'waiting', schedulerRetryNotBefore: '2099-01-01T00:00:00Z' } });
    seed('accepted', { providerTaskId: 'upstream-id' });
    seed('uncertain', { metadata: { schedulerState: 'waiting', providerSubmissionStartedAt: '2026-09-14T01:00:00Z' } });
    expect(listProviderTaskSummaries().filter((task) => isDurableWaitingTask(task))).toEqual([]);
  });
});
