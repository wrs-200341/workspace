import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProviderTask, getProviderTask, updateProviderTask } from './taskStore';
import { enqueueProviderTask, resetSchedulerForTests } from './concurrency';

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
    process.env.WORKSPACE_MODEL_CONCURRENCY = '5';
    process.env.WORKSPACE_IMAGE_CONCURRENCY = '20';
    process.env.WORKSPACE_VIDEO_CONCURRENCY = '20';
    fs.rmSync(testRoot, { recursive: true, force: true });
    resetSchedulerForTests();
  });

  afterEach(() => {
    resetSchedulerForTests();
    fs.rmSync(testRoot, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.WORKSPACE_DATA_ROOT;
    else process.env.WORKSPACE_DATA_ROOT = previousRoot;
  });

  it('runs at most five same-model jobs while allowing an unlimited waiting queue', async () => {
    const ids = Array.from({ length: 7 }, (_, index) => `video-${index}`).map((id) => seed(id, 'video', 'grok-model'));
    let started = 0;
    let maxStarted = 0;
    const finishers: Array<() => void> = [];
    ids.forEach((task) => enqueueProviderTask({ taskId: task.id, ownerId: 'operator-a', mode: 'video', model: 'grok-model', run: () => {
      started += 1;
      maxStarted = Math.max(maxStarted, started);
      return new Promise<void>((resolve) => finishers.push(() => { updateProviderTask(task.id, { status: 'completed', progress: 100 }); started -= 1; resolve(); }));
    } }));
    await tick();
    expect(started).toBe(5);
    expect(maxStarted).toBe(5);
    expect(getProviderTask(ids[5].id)?.status).toBe('queued');
    expect(getProviderTask(ids[6].id)?.status).toBe('queued');
    finishers.splice(0, 2).forEach((finish) => finish());
    await tick();
    expect(started).toBe(5);
    finishers.splice(0).forEach((finish) => finish());
    await tick();
    expect(started).toBe(0);
    expect(ids.every((task) => getProviderTask(task.id)?.status === 'completed')).toBe(true);
  });

  it('caps all media modes at twenty jobs for one operator', async () => {
    const imageTasks = Array.from({ length: 20 }, (_, index) => seed(`image-${index}`, 'image', 'image-model'));
    const videoTasks = Array.from({ length: 20 }, (_, index) => seed(`video-${index}`, 'video', 'video-model'));
    let imageStarted = 0;
    let videoStarted = 0;
    const finishers: Array<() => void> = [];
    imageTasks.forEach((task) => enqueueProviderTask({ taskId: task.id, ownerId: 'operator-a', mode: 'image', model: 'image-model', run: () => { imageStarted += 1; return new Promise<void>((resolve) => finishers.push(() => { imageStarted -= 1; updateProviderTask(task.id, { status: 'completed', progress: 100 }); resolve(); })); } }));
    videoTasks.forEach((task) => enqueueProviderTask({ taskId: task.id, ownerId: 'operator-a', mode: 'video', model: 'video-model', run: () => { videoStarted += 1; return new Promise<void>((resolve) => finishers.push(() => { videoStarted -= 1; updateProviderTask(task.id, { status: 'completed', progress: 100 }); resolve(); })); } }));
    await tick();
    expect(imageStarted).toBe(5);
    expect(videoStarted).toBe(5);
    expect(finishers.length).toBe(10);
    while (finishers.length) {
      finishers.splice(0).forEach((finish) => finish());
      await tick();
    }
    expect(imageStarted).toBe(0);
    expect(videoStarted).toBe(0);
  });

  it('keeps queued jobs waiting until an operator-wide slot is free', async () => {
    const tasks = Array.from({ length: 25 }, (_, index) => seed(`mixed-${index}`, (index % 2 ? 'video' : 'image') as 'image' | 'video', `unique-model-${index}`, 'operator-a'));
    let started = 0;
    const finishers: Array<() => void> = [];
    tasks.forEach((task) => enqueueProviderTask({ taskId: task.id, ownerId: 'operator-a', mode: task.mode as 'image' | 'video', model: task.model!, run: () => {
      started += 1;
      return new Promise<void>((resolve) => finishers.push(() => { started -= 1; updateProviderTask(task.id, { status: 'completed', progress: 100 }); resolve(); }));
    } }));
    await tick();
    expect(finishers).toHaveLength(20);
    expect(getProviderTask(tasks[20].id)?.status).toBe('queued');
    finishers.splice(0).forEach((finish) => finish());
    await tick();
    expect(finishers).toHaveLength(5);
    finishers.splice(0).forEach((finish) => finish());
    await tick();
    expect(started).toBe(0);
  });

  it('wakes the other media mode when a shared slot is released', async () => {
    const videoTasks = Array.from({ length: 20 }, (_, index) => seed(`video-full-${index}`, 'video', `video-model-${index}`));
    const imageTask = seed('image-waiting', 'image', 'image-model');
    const finishers: Array<() => void> = [];
    videoTasks.forEach((task) => enqueueProviderTask({
      taskId: task.id,
      ownerId: 'operator-a',
      mode: 'video',
      model: task.model!,
      run: () => new Promise<void>((resolve) => finishers.push(() => {
        updateProviderTask(task.id, { status: 'completed', progress: 100 });
        resolve();
      })),
    }));
    enqueueProviderTask({
      taskId: imageTask.id,
      ownerId: 'operator-a',
      mode: 'image',
      model: imageTask.model!,
      run: () => new Promise<void>((resolve) => {
        updateProviderTask(imageTask.id, { status: 'completed', progress: 100 });
        resolve();
      }),
    });
    await tick();
    expect(finishers).toHaveLength(20);
    expect(getProviderTask(imageTask.id)?.status).toBe('queued');
    finishers[0]();
    await tick();
    expect(getProviderTask(imageTask.id)?.status).toBe('completed');
  });
});
