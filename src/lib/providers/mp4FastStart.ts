import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

type AtomOffsets = { moov: number; mdat: number };

function readAtomOffsets(size: number, readHeader: (offset: number) => Buffer): AtomOffsets | null {
  let offset = 0;
  let moov = -1;
  let mdat = -1;
  while (offset + 8 <= size) {
    const header = readHeader(offset);
    if (header.length < 8) return null;
    let atomSize = header.readUInt32BE(0);
    const type = header.subarray(4, 8).toString('ascii');
    let headerSize = 8;
    if (atomSize === 1) {
      if (header.length < 16) return null;
      atomSize = Number(header.readBigUInt64BE(8));
      headerSize = 16;
    } else if (atomSize === 0) {
      atomSize = size - offset;
    }
    if (!Number.isSafeInteger(atomSize) || atomSize < headerSize || offset + atomSize > size) return null;
    if (type === 'moov') moov = offset;
    if (type === 'mdat') mdat = offset;
    if (moov >= 0 && mdat >= 0) return { moov, mdat };
    offset += atomSize;
  }
  return null;
}

function inspectBuffer(bytes: Buffer): AtomOffsets | null {
  return readAtomOffsets(bytes.length, (offset) => bytes.subarray(offset, Math.min(bytes.length, offset + 16)));
}

function inspectFile(filePath: string): AtomOffsets | null {
  let descriptor: number | undefined;
  try {
    const size = fs.statSync(filePath).size;
    descriptor = fs.openSync(filePath, 'r');
    return readAtomOffsets(size, (offset) => {
      const header = Buffer.alloc(16);
      const read = fs.readSync(descriptor!, header, 0, header.length, offset);
      return header.subarray(0, read);
    });
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function mp4NeedsFastStart(bytes: Buffer): boolean {
  const atoms = inspectBuffer(bytes);
  return Boolean(atoms && atoms.moov > atoms.mdat);
}

export function mp4FileHasFastStart(filePath: string): boolean {
  const atoms = inspectFile(filePath);
  return Boolean(atoms && atoms.moov < atoms.mdat);
}

export function mp4FileNeedsFastStart(filePath: string): boolean {
  const atoms = inspectFile(filePath);
  return Boolean(atoms && atoms.moov > atoms.mdat);
}

/** Remux an MP4 without re-encoding and validate that FFmpeg moved moov first. */
export function remuxMp4FastStart(inputPath: string, outputPath: string): boolean {
  const executable = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  const result = spawnSync(executable, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
    '-map', '0', '-c', 'copy', '-movflags', '+faststart', outputPath,
  ], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  return !result.error && result.status === 0 && mp4FileHasFastStart(outputPath);
}
