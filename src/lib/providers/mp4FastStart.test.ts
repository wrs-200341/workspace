import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockSpawnSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: mockSpawnSync }));

import { mp4FileHasFastStart, mp4FileNeedsFastStart, mp4NeedsFastStart, remuxMp4FastStart } from './mp4FastStart';

const testRoot = path.join(process.env.TEMP || process.env.TMP || 'D:/workspace/data', `workspace-faststart-test-${process.pid}`);

function atom(type: string, body = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + body.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, body]);
}

const ftyp = atom('ftyp', Buffer.from('isom'));
const mdat = atom('mdat', Buffer.from([1, 2, 3, 4]));
const moov = atom('moov', Buffer.from([5, 6, 7, 8]));

afterEach(() => {
  mockSpawnSync.mockReset();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('MP4 fast-start normalization', () => {
  it('detects whether moov appears after the media payload', () => {
    expect(mp4NeedsFastStart(Buffer.concat([ftyp, mdat, moov]))).toBe(true);
    expect(mp4NeedsFastStart(Buffer.concat([ftyp, moov, mdat]))).toBe(false);
    fs.mkdirSync(testRoot, { recursive: true });
    const file = path.join(testRoot, 'needs-faststart.mp4');
    fs.writeFileSync(file, Buffer.concat([ftyp, mdat, moov]));
    expect(mp4FileNeedsFastStart(file)).toBe(true);
    expect(mp4FileHasFastStart(file)).toBe(false);
  });

  it('validates a remuxed file before reporting success', () => {
    fs.mkdirSync(testRoot, { recursive: true });
    const input = path.join(testRoot, 'input.mp4');
    const output = path.join(testRoot, 'output.mp4');
    fs.writeFileSync(input, Buffer.concat([ftyp, mdat, moov]));
    mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
      fs.writeFileSync(args.at(-1)!, Buffer.concat([ftyp, moov, mdat]));
      return { status: 0, error: undefined };
    });

    expect(remuxMp4FastStart(input, output)).toBe(true);
    expect(mp4FileHasFastStart(output)).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-c', 'copy', '-movflags', '+faststart']), expect.objectContaining({ windowsHide: true }));
  });

  it('rejects a successful process result whose output is not fast-start', () => {
    fs.mkdirSync(testRoot, { recursive: true });
    const input = path.join(testRoot, 'input.mp4');
    const output = path.join(testRoot, 'output.mp4');
    fs.writeFileSync(input, Buffer.concat([ftyp, mdat, moov]));
    mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
      fs.writeFileSync(args.at(-1)!, Buffer.concat([ftyp, mdat, moov]));
      return { status: 0, error: undefined };
    });

    expect(remuxMp4FastStart(input, output)).toBe(false);
  });
});
