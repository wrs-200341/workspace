import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProviderTask, getProviderTask, updateProviderTask } from './taskStore';
import { enqueueProviderTask, expireStaleProviderActiveTasks, recoverOrphanedSchedulerTasks, resetSchedulerForTests } from './concurrency';

const testRoot = `D:\\all_projects\\workspace\\data\\concurrency-test-${process.pid}`;
const previousRoot = process.env.WORKSPACE_DATA_ROOT;

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function seed(id: string, mode: 'image' | 'video', model: string, ownerId = 'operator-a') {
  return createProviderTask({ id, accountId: `${ownerId}-account`, mode, provider: mode === 'image' ? 'mgrouter-grok-image' : 'grok-video', model, status: 'queued', metadata: { ownerId, schedulerState: 'waiting' } });
}

describe('production concurrency scheduler', () => {
  beforeEach(() => {
    process.env.WORKSPACE_DATA_ROOT = testRoot;
    process.env.WORKSPACE_IMAGE_MODEL_CONCURRENCY = '5';
    process.env.WORKSPACE_VIDEO_MODEL_CONCURRENCY = '20';
    process.env.WORKSPACE_IMAGE_CONCURRENCY = '20';
    process.env.WORKSPACE_VIDEO_CONCURRENCY = '50';
    fs.rmSync(testRoot, { recursive: true, force: true });
    resetSchedulerForTests();
  });

  afterEach(() => {
    resetSchedulerForTests();
    fs.rmSync(testRoot, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.WORKSPACE_DATA_ROOT;
    else process.env.WORKSPACE_DATA_ROOT = previousRoot;
  });

  it('runs at most twenty same-video-model jobs while allowing an unlimited waiting queue', async () => {
    const ids = Array.from({ length: 21 }, (_, index) => `video-${index}`).map((id) => seed(id, 'video', 'grok-model'));
    let started = 0;
    let maxStarted = 0;
    const finishers: Array<() => void> = [];
    ids.forEach((task) => enqueueProviderTask({ taskId: task.id, ownerId: 'operator-a', mode: 'video', model: 'grok-model', run: () => {
      started += 1;
      maxStarted = Math.max(maxStarted, started);
      return new Promise<void>((resolve) => finishers.push(() => { updateProviderTask(task.id, { status: 'completed', progress: 100 }); started -= 1; resolve(); }));
    } }));
    await tick();
    expect(started).toBe(20);
    expect(maxStarted).toBe(20);
    expect(getProviderTask(ids[20].id)?.status).toBe('queued');
    finishers.splice(0, 5).forEach((finish) => finish());
    await tick();
    expect(started).toBe(16);
    finishers.splice(0).forEach((finish) => finish());
    await tick();
    expect(started).toBe(0);
    expect(ids.every((task) => getProviderTask(task.id)?.status === 'completed')).toBe(true);
  });

  it('preserves prompting while an automatic child prompt job is dispatched', async () => {
    const task = createProviderTask({
      id: 'prompting-dispatch',
      accountId: 'operator-a-account',
      mode: 'video',
      provider: 'grok-video',
      model: 'grok-model',
      status: 'prompting',
      progress: 2,
      metadata: { ownerId: 'operator-a', schedulerState: 'waiting', promptGenerationPending: true },
    });
    let finish!: () => void;
    enqueueProviderTask({
      taskId: task.id,
      ownerId: 'operator-a',
      mode: 'video',
      model: 'grok-model',
      run: () => new Promise<void>((resolve) => {
        finish = () => {
          updateProviderTask(task.id, { status: 'completed', progress: 100 });
          resolve();
        };
      }),
    });
    await tick();
    expect(getProviderTask(task.id)).toMatchObject({ status: 'prompting', progress: 10, metadata: { schedulerState: 'dispatching' } });
    finish();
    await tick();
    expect(getProviderTask(task.id)?.status).toBe('completed');
  });

  it('allocates model slots independently for each operator', async () => {
    const operatorA = Array.from({ length: 5 }, (_, index) => seed(`operator-a-omni-${index}`, 'video', 'omni-fast-no-water', 'operator-a'));
    const operatorB = Array.from({ length: 5 }, (_, index) => seed(`operator-b-omni-${index}`, 'video', 'omni-fast-no-water', 'operator-b'));
    const finishers: Array<() => void> = [];
    let startedA = 0;
    let startedB = 0;
    for (const task of operatorA) enqueueProviderTask({ taskId: task.id, ownerId: 'operator-a', mode: 'video', model: 'omni-fast-no-water', run: () => { startedA += 1; return new Promise<void>((resolve) => finishers.push(() => { startedA -= 1; updateProviderTask(task.id, { status: 'completed', progress: 100 }); resolve(); })); } });
    for (const task of operatorB) enqueueProviderTask({ taskId: task.id, ownerId: 'operator-b', mode: 'video', model: 'omni-fast-no-water', run: () => { startedB += 1; return new Promise<void>((resolve) => finishers.push(() => { startedB -= 1; updateProviderTask(task.id, { status: 'completed', progress: 100 }); resolve(); })); } });
    await tick();
    expect(startedA).toBe(5);
    expect(startedB).toBe(5);
    expect(finishers).toHaveLength(10);
    finishers.splice(0).forEach((finish) => finish());
    await tick();
    expect(startedA).toBe(0);
    expect(startedB).toBe(0);
  });

  it('expires stale provider-active tasks so they do not block a model lane forever', async () => {
    const staleUpdatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const stale = createProviderTask({
      id: 'stale-provider-active',
      accountId: 'operator-a-account',
      mode: 'video',
      provider: 'grok-video',
      model: 'omni-fast-no-water',
      status: 'queued',
      providerTaskId: 'upstream-stale',
      progress: 35,
      createdAt: staleUpdatedAt,
      metadata: { ownerId: 'operator-a', schedulerState: 'provider-active' },
    });
    const waiting = seed('waiting-after-stale', 'video', 'omni-fast-no-water');
    let started = 0;
    enqueueProviderTask({
      taskId: waiting.id,
      ownerId: 'operator-a',
      mode: 'video',
      model: 'omni-fast-no-water',
      run: async () => {
        started += 1;
        updateProviderTask(waiting.id, { status: 'completed', progress: 100 });
      },
    });
    await tick();
    expect(started).toBe(1);
    expect(getProviderTask(stale.id)).toMatchObject({ status: 'failed', error: 'provider_task_stale', progress: 100 });
  });

  it('can explicitly expire stale provider-active rows during recovery scans', () => {
    const staleUpdatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const stale = createProviderTask({
      id: 'stale-provider-scan',
      accountId: 'operator-a-account',
      mode: 'video',
      provider: 'grok-video',
      model: 'grok-model',
      status: 'running',
      providerTaskId: 'upstream-stale-scan',
      progress: 75,
      createdAt: staleUpdatedAt,
      metadata: { ownerId: 'operator-a', schedulerState: 'provider-active' },
    });
    const expired = expireStaleProviderActiveTasks(Date.now(), { pump: false });
    expect(expired.map((task) => task.id)).toContain(stale.id);
    expect(getProviderTask(stale.id)).toMatchObject({ status: 'failed', error: 'provider_task_stale' });
  });

  it('marks never-submitted jobs from a previous runtime as interrupted', () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const task = createProviderTask({ id: 'orphaned-task', accountId: 'operator-a-account', mode: 'video', provider: 'grok-video', model: 'grok-model', status: 'submitting', createdAt: old, metadata: { ownerId: 'operator-a', schedulerState: 'dispatching', execution: 'pending' } });
    const recovered = recoverOrphanedSchedulerTasks(Date.now(), { force: true });
    expect(recovered.map((item) => item.id)).toContain(task.id);
    expect(getProviderTask(task.id)).toMatchObject({ status: 'failed', error: 'scheduler_interrupted', progress: 100 });
  });

  it('recovers queued tasks the scheduler already marked terminal', () => {
    // A supplier response with no task id used to leave the job queued while
    // the scheduler recorded it as finished, so it showed as 本地排队中 forever.
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const task = createProviderTask({
      id: 'stranded-terminal-task',
      accountId: 'operator-a-account',
      mode: 'image',
      provider: 'mgrouter-grok-image',
      model: 'grok-image',
      status: 'queued',
      createdAt: old,
      metadata: { ownerId: 'operator-a', schedulerState: 'terminal', schedulerFinishedAt: old },
    });
    // The age guard is measured from updatedAt, which creation just set to now.
    const recovered = recoverOrphanedSchedulerTasks(Date.now() + 10 * 60 * 1000, { force: true });
    expect(recovered.map((item) => item.id)).toContain(task.id);
    expect(getProviderTask(task.id)).toMatchObject({ status: 'failed', error: 'provider_response_unrecognized', progress: 100 });
  });

  it('marks orphaned prompting child-prompt jobs as failed so they do not stall forever', () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const task = createProviderTask({
      id: 'orphaned-prompting-task',
      accountId: 'operator-a-account',
      mode: 'video',
      provider: 'grok-video',
      model: 'grok-model',
      status: 'prompting',
      createdAt: old,
      metadata: { ownerId: 'operator-a', schedulerState: 'waiting', promptGenerationPending: true, schedulerRuntimeId: 'previous-runtime' },
    });
    const recovered = recoverOrphanedSchedulerTasks(Date.now(), { force: true });
    expect(recovered.map((item) => item.id)).toContain(task.id);
    expect(getProviderTask(task.id)).toMatchObject({ status: 'failed', error: 'scheduler_prompt_interrupted', progress: 100 });
  });

  it('marks orphaned retrying jobs as safely recoverable after a restart', () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const task = createProviderTask({
      id: 'orphaned-retrying-task',
      accountId: 'operator-a-account',
      mode: 'video',
      provider: 'grok-video',
      model: 'grok-model',
      status: 'retrying',
      createdAt: old,
      metadata: { ownerId: 'operator-a', schedulerState: 'waiting', schedulerRuntimeId: 'previous-runtime', schedulerRetryCount: 1, maxRetries: 2 },
    });
    const recovered = recoverOrphanedSchedulerTasks(Date.now(), { force: true });
    expect(recovered.map((item) => item.id)).toContain(task.id);
    expect(getProviderTask(task.id)).toMatchObject({ status: 'failed', error: 'scheduler_retry_interrupted', progress: 100 });
  });

  it('caps image and video modes separately for one operator', async () => {
    const imageTasks = Array.from({ length: 25 }, (_, index) => seed(`image-${index}`, 'image', `image-model-${index}`));
    const videoTasks = Array.from({ length: 20 }, (_, index) => seed(`video-${index}`, 'video', `video-model-${index}`));
    let imageStarted = 0;
    let videoStarted = 0;
    const finishers: Array<() => void> = [];
    imageTasks.forEach((task) => enqueueProviderTask({ taskId: task.id, ownerId: 'operator-a', mode: 'image', model: task.model!, run: () => { imageStarted += 1; return new Promise<void>((resolve) => finishers.push(() => { imageStarted -= 1; updateProviderTask(task.id, { status: 'completed', progress: 100 }); resolve(); })); } }));
    videoTasks.forEach((task) => enqueueProviderTask({ taskId: task.id, ownerId: 'operator-a', mode: 'video', model: task.model!, run: () => { videoStarted += 1; return new Promise<void>((resolve) => finishers.push(() => { videoStarted -= 1; updateProviderTask(task.id, { status: 'completed', progress: 100 }); resolve(); })); } }));
    await tick();
    expect(imageStarted).toBe(20);
    expect(videoStarted).toBe(20);
    expect(finishers.length).toBe(40);
    while (finishers.length) {
      finishers.splice(0).forEach((finish) => finish());
      await tick();
    }
    expect(imageStarted).toBe(0);
    expect(videoStarted).toBe(0);
  });

  it('caps video jobs at fifty per operator when models differ', async () => {
    const tasks = Array.from({ length: 51 }, (_, index) => seed(`video-cap-${index}`, 'video', `unique-model-${index}`, 'operator-a'));
    let started = 0;
    const finishers: Array<() => void> = [];
    tasks.forEach((task) => enqueueProviderTask({ taskId: task.id, ownerId: 'operator-a', mode: 'video', model: task.model!, run: () => {
      started += 1;
      return new Promise<void>((resolve) => finishers.push(() => { started -= 1; updateProviderTask(task.id, { status: 'completed', progress: 100 }); resolve(); }));
    } }));
    await tick();
    expect(finishers).toHaveLength(50);
    expect(getProviderTask(tasks[50].id)?.status).toBe('queued');
    finishers.splice(0).forEach((finish) => finish());
    await tick();
    expect(started).toBe(1);
    finishers.splice(0).forEach((finish) => finish());
    await tick();
    expect(started).toBe(0);
  });

  it('automatically retries failed jobs twice and exposes retrying state', async () => {
    const task = seed('auto-retry', 'video', 'retry-model');
    let attempts = 0;
    enqueueProviderTask({
      taskId: task.id,
      ownerId: 'operator-a',
      mode: 'video',
      model: 'retry-model',
      run: async () => {
        attempts += 1;
        if (attempts < 3) {
          updateProviderTask(task.id, { status: 'failed', progress: 100, error: `failure-${attempts}` });
          return;
        }
        updateProviderTask(task.id, { status: 'completed', progress: 100 });
      },
    });
    await tick();
    expect(getProviderTask(task.id)?.status).toBe('retrying');
    expect(getProviderTask(task.id)?.metadata?.schedulerRetryCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await tick();
    expect(getProviderTask(task.id)?.status).toBe('retrying');
    expect(getProviderTask(task.id)?.metadata?.schedulerRetryCount).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await tick();
    expect(attempts).toBe(3);
    expect(getProviderTask(task.id)?.status).toBe('completed');
  });

  it('marks a task failed after the two automatic retries are exhausted', async () => {
    const task = seed('auto-retry-failed', 'image', 'retry-model');
    let attempts = 0;
    enqueueProviderTask({
      taskId: task.id,
      ownerId: 'operator-a',
      mode: 'image',
      model: 'retry-model',
      run: async () => {
        attempts += 1;
        updateProviderTask(task.id, { status: 'failed', progress: 100, error: 'persistent_failure' });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(attempts).toBe(3);
    expect(getProviderTask(task.id)?.status).toBe('failed');
    expect(getProviderTask(task.id)?.metadata?.schedulerRetryCount).toBe(2);
  });

  it('does not dispatch or clear accepted provider handles without a confirmed terminal failure', async () => {
    const task = createProviderTask({
      id: 'auto-retry-clears-provider',
      accountId: 'operator-a-account',
      mode: 'video',
      provider: 'grok-video',
      model: 'retry-model',
      status: 'queued',
      providerTaskId: 'stale-upstream-id',
      outputUrls: ['https://cdn.example/video.mp4'],
      metadata: { ownerId: 'operator-a', schedulerState: 'waiting' },
    });
    let attempts = 0;
    enqueueProviderTask({
      taskId: task.id,
      ownerId: 'operator-a',
      mode: 'video',
      model: 'retry-model',
      run: async () => {
        attempts += 1;
        updateProviderTask(task.id, { status: 'failed', progress: 100, error: 'failed' });
      },
    });
    await tick();
    const retrying = getProviderTask(task.id);
    expect(retrying?.status).toBe('queued');
    expect(retrying?.providerTaskId).toBe('stale-upstream-id');
    expect(retrying?.outputUrls).toEqual(['https://cdn.example/video.mp4']);
    expect(attempts).toBe(0);
  });
});
