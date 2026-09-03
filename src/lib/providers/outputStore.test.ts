import fs from 'node:fs';
import { describe, expect, it, beforeEach } from 'vitest';
import { getWorkspacePath } from '@/lib/storagePaths';
import { storeImageBase64Outputs, readStoredOutput } from './outputStore';

const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64');

describe('provider output store', () => {
  beforeEach(() => {
    fs.rmSync(getWorkspacePath('generated'), { recursive: true, force: true });
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
});
