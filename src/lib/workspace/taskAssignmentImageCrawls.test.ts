import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listTaskAssignmentImageCrawls,
  processTaskAssignmentImageCrawlsNow,
  queueTaskAssignmentImageCrawls,
  refreshTaskAssignmentImageCrawlsNow,
} from './taskAssignmentImageCrawls';

const originalRoot = process.env.WORKSPACE_DATA_ROOT;
const testRoot = path.join(process.cwd(), 'data', `task-assignment-crawl-test-${process.pid}`);

describe('task assignment image crawl scheduling', () => {
  beforeEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    process.env.WORKSPACE_DATA_ROOT = testRoot;
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    if (originalRoot === undefined) delete process.env.WORKSPACE_DATA_ROOT;
    else process.env.WORKSPACE_DATA_ROOT = originalRoot;
  });

  it('submits only missing PIDs and never resubmits completed or active PIDs', async () => {
    const existingPid = '1736087723181180428';
    const missingPid = '1733599561145419031';
    const check = vi.fn().mockResolvedValue({ existing: [existingPid], missing: [missingPid] });
    const createBatch = vi.fn().mockResolvedValue({ batchId: 'batch-1', existing: [], submitted: [missingPid] });
    const runBatch = vi.fn().mockResolvedValue(undefined);

    expect(queueTaskAssignmentImageCrawls([existingPid, missingPid], 'non_clothing', { start: false })).toMatchObject({ queued: 2 });
    await processTaskAssignmentImageCrawlsNow({ check, createBatch, runBatch });

    expect(check).toHaveBeenCalledWith([existingPid, missingPid]);
    expect(createBatch).toHaveBeenCalledWith([missingPid], 'non_clothing', expect.stringContaining('workspace-'));
    expect(runBatch).toHaveBeenCalledWith('batch-1');
    expect(listTaskAssignmentImageCrawls([existingPid, missingPid])).toEqual(expect.arrayContaining([
      expect.objectContaining({ pid: existingPid, status: 'completed' }),
      expect.objectContaining({ pid: missingPid, status: 'running', batchId: 'batch-1' }),
    ]));

    expect(queueTaskAssignmentImageCrawls([existingPid, missingPid], 'clothing', { start: false })).toMatchObject({ queued: 0, completed: 1, active: 1 });
  });

  it('marks a running PID completed after it appears in the gallery', async () => {
    const pid = '1736087723181180428';
    queueTaskAssignmentImageCrawls([pid], 'clothing', { start: false });
    await processTaskAssignmentImageCrawlsNow({
      check: vi.fn().mockResolvedValue({ existing: [], missing: [pid] }),
      createBatch: vi.fn().mockResolvedValue({ batchId: 'batch-2', existing: [], submitted: [pid] }),
      runBatch: vi.fn().mockResolvedValue(undefined),
    });

    await refreshTaskAssignmentImageCrawlsNow({ check: vi.fn().mockResolvedValue({ existing: [pid], missing: [] }) });

    expect(listTaskAssignmentImageCrawls([pid])[0]).toMatchObject({ pid, status: 'completed' });
  });

  it('records an actionable failure without throwing back into task creation', async () => {
    const pid = '1736087723181180428';
    queueTaskAssignmentImageCrawls([pid], 'clothing', { start: false });

    await expect(processTaskAssignmentImageCrawlsNow({
      check: vi.fn().mockRejectedValue(new Error('product_source_timeout')),
      createBatch: vi.fn(),
      runBatch: vi.fn(),
    })).resolves.toBeUndefined();

    expect(listTaskAssignmentImageCrawls([pid])[0]).toMatchObject({
      status: 'failed',
      error: '8765 图库服务连接超时',
    });
  });

  it('turns an accepted batch into a visible failure when 8765 later fails it', async () => {
    const pid = '1736087723181180428';
    queueTaskAssignmentImageCrawls([pid], 'clothing', { start: false });
    await processTaskAssignmentImageCrawlsNow({
      check: vi.fn().mockResolvedValue({ existing: [], missing: [pid] }),
      createBatch: vi.fn().mockResolvedValue({ batchId: 'batch-failed', existing: [], submitted: [pid] }),
      runBatch: vi.fn().mockResolvedValue(undefined),
    });

    await refreshTaskAssignmentImageCrawlsNow({
      check: vi.fn().mockResolvedValue({ existing: [], missing: [pid] }),
      getBatchStatus: vi.fn().mockResolvedValue({ status: 'failed', syncStage: 'scraping' }),
    });

    expect(listTaskAssignmentImageCrawls([pid])[0]).toMatchObject({
      status: 'failed',
      error: '8765 爬图批次执行失败',
    });
  });
});
