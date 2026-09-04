import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getWorkspacePath } from '@/lib/storagePaths';
import { storeImageBase64Outputs, readStoredOutput, readStoredVideoOutput, storeVideoOutput } from './outputStore';

const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64');
const mp4 = Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70,0,0,0,0]).toString('base64');
const testRoot = `D:\\all_projects\\workspace\\data\\output-store-test-${process.pid}`;
const previousDataRoot = process.env.WORKSPACE_DATA_ROOT;

describe('provider output store', () => {
  beforeEach(() => {
    // Never point test cleanup at the real production data root.  These tests
    // run in the same workspace process as the app and used to delete every
    // generated image under data/generated before each case.
    process.env.WORKSPACE_DATA_ROOT = testRoot;
    // Use the already fixed testRoot directly for cleanup. Do not resolve the
    // deletion target through mutable process.env state, otherwise another
    // parallel test could theoretically redirect it to production data.
    fs.rmSync(path.join(testRoot, 'generated'), { recursive: true, force: true });
  });

  it('keeps test cleanup inside the process-specific test root', () => {
    expect(path.resolve(getWorkspacePath('generated'))).toBe(path.resolve(testRoot, 'generated'));
  });

  afterAll(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    if (previousDataRoot === undefined) delete process.env.WORKSPACE_DATA_ROOT;
    else process.env.WORKSPACE_DATA_ROOT = previousDataRoot;
  });

  it('stores validated base64 images under D-drive workspace data', () => {
    const stored = storeImageBase64Outputs('account-1', 'task-1', [png]);
    expect(stored).toHaveLength(1);
    expect(stored[0].relativePath).toContain('generated/account-1/task-1/0.png');
    const output = readStoredOutput('account-1', 'task-1', 0);
    expect(output?.mimeType).toBe('image/png');
    expect(output?.bytes.subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
  });

  it('rejects invalid or oversized image data without writing a file', () => {
    expect(storeImageBase64Outputs('account-1', 'task-2', ['not-an-image-data'])).toEqual([]);
    expect(readStoredOutput('account-1', 'task-2', 0)).toBeNull();
  });

  it('rejects malformed base64 instead of Buffer.from permissive decoding', () => {
    // These values contain invalid characters and incorrect padding but would
    // otherwise be silently truncated by Node's base64 decoder.
    expect(storeImageBase64Outputs('account-1', 'task-3', ['iVBORw0KGgo!!!', 'iVBORw0KGgo'])).toEqual([]);
    expect(readStoredOutput('account-1', 'task-3', 0)).toBeNull();
  });

  it('stores and reads validated local video outputs', () => {
    const stored = storeVideoOutput('account-1', 'task-video', 0, Buffer.from(mp4, 'base64'), 'video/mp4');
    expect(stored?.relativePath).toContain('generated/account-1/task-video/0.mp4');
    expect(readStoredVideoOutput('account-1', 'task-video', 0)?.mimeType).toBe('video/mp4');
  });
});
