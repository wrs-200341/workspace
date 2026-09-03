import fs from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getWorkspacePath } from '../storagePaths';
import { createPromptAsset, createUploadedAsset } from './assetStore';
import { createProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { getLiveAccountStats, withLiveAccountStats } from './accountStats';
import type { WorkspaceAccount } from './data';

const root = `D:\\all_projects\\workspace\\data\\account-stats-test-${process.pid}`;
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

const accountId = 'account-stats-1';

function account(overrides: Partial<WorkspaceAccount> = {}): WorkspaceAccount {
  return {
    id: accountId,
    ownerId: 'operator-1',
    ownerName: 'Operator',
    name: 'Stats account',
    category: 'featured',
    strategy: '',
    // Deliberately non-zero to prove historical counters are ignored.
    promptCount: 12,
    fileCount: 28,
    videoCount: 16,
    publishedCount: 11,
    updatedAt: '2026-09-02 00:00',
    planStatus: 'draft',
    ...overrides,
  };
}

describe('live account statistics', () => {
  it('starts at zero and ignores historical account counters', () => {
    expect(getLiveAccountStats(accountId)).toEqual({
      promptCount: 0,
      fileCount: 0,
      videoCount: 0,
      publishedCount: 0,
      assetCounts: { prompt: 0, image: 0, 'inventory-video': 0, audio: 0 },
      successfulVideoTaskCount: 0,
      successfulVideoOutputCount: 0,
    });
    expect(withLiveAccountStats(account())).toMatchObject({
      promptCount: 0,
      fileCount: 0,
      videoCount: 0,
      publishedCount: 0,
    });
  });

  it('counts prompt and binary assets by their current records', () => {
    createPromptAsset(accountId, { name: 'template 1', content: 'prompt' });
    createPromptAsset(accountId, { name: 'template 2', content: 'prompt' });
    const stats = getLiveAccountStats(accountId);
    expect(stats.promptCount).toBe(2);
    expect(stats.fileCount).toBe(0);
    expect(stats.assetCounts.prompt).toBe(2);
  });

  it('keeps inventory-video assets separate from transient provider outputs', () => {
    createProviderTask({ accountId, provider: 'grok-video', mode: 'video', status: 'failed', outputUrls: ['https://failed.invalid/video.mp4'] });
    createProviderTask({ accountId, provider: 'grok-video', mode: 'video', status: 'queued', outputUrls: ['https://queued.invalid/video.mp4'] });
    const noOutput = createProviderTask({ accountId, provider: 'grok-video', mode: 'video', status: 'completed' });
    const completed = createProviderTask({ accountId, provider: 'grok-video', mode: 'video', status: 'queued' });
    updateProviderTask(completed.id, {
      status: 'completed',
      outputUrls: ['https://example.com/one.mp4', 'https://example.com/two.mp4'],
    });
    expect(noOutput.id).toBeTruthy();
    expect(getLiveAccountStats(accountId)).toMatchObject({
      successfulVideoTaskCount: 1,
      successfulVideoOutputCount: 2,
      videoCount: 0,
      publishedCount: 0,
    });
  });

  it('counts inventory-video assets as the account card video statistic', () => {
    createUploadedAsset(accountId, 'inventory-video', {
      name: 'inventory.mp4', type: 'video/mp4', size: 4,
      arrayBuffer: Uint8Array.from([0, 1, 2, 3]).buffer,
    });
    expect(getLiveAccountStats(accountId)).toMatchObject({ videoCount: 1, fileCount: 0, publishedCount: 0 });
  });

  it('counts material images separately from inventory videos and audio', () => {
    createUploadedAsset(accountId, 'image', {
      name: 'material.png', type: 'image/png', size: 4,
      arrayBuffer: Uint8Array.from([137, 80, 78, 71]).buffer,
    });
    expect(getLiveAccountStats(accountId)).toMatchObject({ fileCount: 1, videoCount: 0 });
  });

  it('does not treat provider inventory flags as published content', () => {
    const task = createProviderTask({
      accountId,
      provider: 'grok-video',
      mode: 'video',
      status: 'completed',
      outputUrls: ['https://example.com/one.mp4'],
      inventorySavedAt: '2026-09-03T00:00:00.000Z',
    });
    expect(task.outputUrls).toHaveLength(1);
    expect(getLiveAccountStats(accountId)).toMatchObject({ videoCount: 0, publishedCount: 0, successfulVideoOutputCount: 1 });
  });
});
