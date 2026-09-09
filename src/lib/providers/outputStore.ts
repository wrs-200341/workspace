import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWorkspacePath } from '@/lib/storagePaths';

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_OUTPUT_BYTES = 200 * 1024 * 1024;
const MAX_VIDEO_OUTPUT_BYTES = 200 * 1024 * 1024;

export type StoredImageOutput = {
  index: number;
  relativePath: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  size: number;
};

export type StoredVideoOutput = {
  index: number;
  relativePath: string;
  mimeType: string;
  size: number;
};

function detectImage(bytes: Buffer): StoredImageOutput['mimeType'] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function detectVideo(bytes: Buffer, declaredMime = 'video/mp4'): string | null {
  const normalized = declaredMime.toLowerCase().split(';', 1)[0].trim();
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return normalized.includes('webm') || normalized.includes('matroska') ? normalized : 'video/webm';
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'AVI ') return 'video/x-msvideo';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return normalized.startsWith('video/') ? normalized : 'video/mp4';
  return null;
}

function extension(mime: StoredImageOutput['mimeType']): string {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
}

function videoExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('webm') || normalized.includes('matroska')) return 'webm';
  if (normalized.includes('quicktime')) return 'mov';
  if (normalized.includes('avi')) return 'avi';
  return 'mp4';
}

function outputDirectory(accountId: string, taskId: string): string | null {
  if (!/^[-a-zA-Z0-9_]+$/.test(accountId) || !/^[-a-zA-Z0-9_]+$/.test(taskId)) return null;
  return getWorkspacePath('generated', accountId, taskId);
}

function isSafeOutputDirectory(directory: string): boolean {
  try {
    const root = path.resolve(getWorkspacePath());
    const expected = path.resolve(directory);
    const real = fs.realpathSync(directory);
    return real === expected && real.startsWith(`${root}${path.sep}`);
  } catch { return false; }
}

export function outputFilePath(accountId: string, taskId: string, index: number): string {
  if (!/^[-a-zA-Z0-9_]+$/.test(accountId) || !/^[-a-zA-Z0-9_]+$/.test(taskId) || !Number.isInteger(index) || index < 0 || index > 63) throw new Error('output_path_invalid');
  return getWorkspacePath('generated', accountId, taskId, `${index}.bin`);
}

export function storeImageBase64Outputs(accountId: string, taskId: string, values: readonly string[]): StoredImageOutput[] {
  const stored: StoredImageOutput[] = [];
  let totalBytes = 0;
  values.slice(0, 16).forEach((value, index) => {
    if (typeof value !== 'string') return;
    const raw = value.replace(/^data:[^;]+;base64,/i, '').trim();
    if (!raw || raw.length > Math.ceil(MAX_OUTPUT_BYTES * 4 / 3)) return;
    let bytes: Buffer;
    // Buffer.from(..., 'base64') is intentionally permissive (it silently
    // drops non-base64 characters). Reject malformed input before decoding so
    // provider responses cannot smuggle arbitrary text into the image store.
    const compact = raw.replace(/[\r\n\t ]+/g, '');
    if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || /=[^=]/.test(compact)) return;
    try {
      bytes = Buffer.from(compact, 'base64');
      if (bytes.toString('base64') !== compact) return;
    } catch { return; }
    if (bytes.length === 0 || bytes.length > MAX_OUTPUT_BYTES) return;
    if (totalBytes + bytes.length > MAX_TOTAL_OUTPUT_BYTES) return;
    const mimeType = detectImage(bytes);
    if (!mimeType) return;
    const target = outputFilePath(accountId, taskId, index);
    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true });
    if (!isSafeOutputDirectory(directory)) return;
    const finalPath = target.replace(/\.bin$/, `.${extension(mimeType)}`);
    const temporary = `${finalPath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600 });
      fs.renameSync(temporary, finalPath);
      // Remove stale alternate extensions only after the new file is safely
      // in place, keeping reads atomic if a write fails.
      for (const other of ['png', 'jpg', 'webp']) {
        if (other !== extension(mimeType)) fs.rmSync(path.join(path.dirname(finalPath), `${index}.${other}`), { force: true });
      }
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
    totalBytes += bytes.length;
    stored.push({ index, relativePath: path.relative(getWorkspacePath(), finalPath).replace(/\\/g, '/'), mimeType, size: bytes.length });
  });
  return stored;
}

/** Persist one validated remote image response in the task-local output store. */
export function storeImageOutput(accountId: string, taskId: string, index: number, bytes: Buffer, mimeType = 'image/png'): StoredImageOutput | null {
  if (!/^[-a-zA-Z0-9_]+$/.test(accountId) || !/^[-a-zA-Z0-9_]+$/.test(taskId) || !Number.isInteger(index) || index < 0 || index > 63) return null;
  if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES) return null;
  const detected = detectImage(bytes);
  if (!detected || (mimeType && !mimeType.toLowerCase().startsWith('image/'))) return null;
  const directory = outputDirectory(accountId, taskId);
  if (!directory) return null;
  fs.mkdirSync(directory, { recursive: true });
  if (!isSafeOutputDirectory(directory)) return null;
  const finalPath = path.join(directory, `${index}.${extension(detected)}`);
  const temporary = `${finalPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, finalPath);
    for (const other of ['png', 'jpg', 'webp']) if (other !== extension(detected)) fs.rmSync(path.join(directory, `${index}.${other}`), { force: true });
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return { index, relativePath: path.relative(getWorkspacePath(), finalPath).replace(/\\/g, '/'), mimeType: detected, size: bytes.length };
}

export function readStoredOutput(accountId: string, taskId: string, index: number): { bytes: Buffer; mimeType: StoredImageOutput['mimeType'] } | null {
  if (!/^[-a-zA-Z0-9_]+$/.test(accountId) || !/^[-a-zA-Z0-9_]+$/.test(taskId) || !Number.isInteger(index) || index < 0 || index > 63) return null;
  const directory = outputDirectory(accountId, taskId);
  if (!directory) return null;
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp'] as const) {
    const file = path.join(directory, `${index}.${extension(mimeType)}`);
    if (!fs.existsSync(file)) continue;
    try {
      const root = path.resolve(getWorkspacePath());
      const taskRoot = fs.realpathSync(directory);
      if (!taskRoot.startsWith(`${root}${path.sep}`)) return null;
      const resolved = fs.realpathSync(file);
      if (!resolved.startsWith(`${taskRoot}${path.sep}`)) return null;
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OUTPUT_BYTES) return null;
      const bytes = fs.readFileSync(resolved);
      const detected = detectImage(bytes);
      if (!detected || detected !== mimeType) return null;
      return { bytes, mimeType };
    } catch {
      return null;
    }
  }
  return null;
}

/** Persist one validated provider video under the task's local output store. */
export function storeVideoOutput(accountId: string, taskId: string, index: number, bytes: Buffer, mimeType = 'video/mp4'): StoredVideoOutput | null {
  if (!/^[-a-zA-Z0-9_]+$/.test(accountId) || !/^[-a-zA-Z0-9_]+$/.test(taskId) || !Number.isInteger(index) || index < 0 || index > 63) return null;
  if (!bytes.length || bytes.length > MAX_VIDEO_OUTPUT_BYTES) return null;
  const detected = detectVideo(bytes, mimeType);
  if (!detected) return null;
  const directory = outputDirectory(accountId, taskId);
  if (!directory) return null;
  fs.mkdirSync(directory, { recursive: true });
  if (!isSafeOutputDirectory(directory)) return null;
  const finalPath = path.join(directory, `${index}.${videoExtension(detected)}`);
  const temporary = `${finalPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, finalPath);
    for (const other of ['mp4', 'webm', 'mov', 'avi']) {
      if (other !== videoExtension(detected)) fs.rmSync(path.join(directory, `${index}.${other}`), { force: true });
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return { index, relativePath: path.relative(getWorkspacePath(), finalPath).replace(/\\/g, '/'), mimeType: detected, size: bytes.length };
}

/** Read a previously cached task video after validating its path and bytes. */
export function readStoredVideoOutput(accountId: string, taskId: string, index: number): StoredVideoOutput & { bytes: Buffer } | null {
  if (!/^[-a-zA-Z0-9_]+$/.test(accountId) || !/^[-a-zA-Z0-9_]+$/.test(taskId) || !Number.isInteger(index) || index < 0 || index > 63) return null;
  const directory = outputDirectory(accountId, taskId);
  if (!directory) return null;
  const root = path.resolve(getWorkspacePath());
  let taskRoot: string;
  try { taskRoot = fs.realpathSync(directory); } catch { return null; }
  if (!taskRoot.startsWith(`${root}${path.sep}`)) return null;
  for (const ext of ['mp4', 'webm', 'mov', 'avi']) {
    const file = path.join(directory, `${index}.${ext}`);
    if (!fs.existsSync(file)) continue;
    try {
      const resolved = fs.realpathSync(file);
      if (!resolved.startsWith(`${taskRoot}${path.sep}`)) return null;
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_VIDEO_OUTPUT_BYTES) return null;
      const bytes = fs.readFileSync(resolved);
      const mimeType = detectVideo(bytes, ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : ext === 'avi' ? 'video/x-msvideo' : 'video/mp4');
      if (!mimeType) return null;
      return { index, relativePath: path.relative(getWorkspacePath(), resolved).replace(/\\/g, '/'), mimeType, size: bytes.length, bytes };
    } catch {
      return null;
    }
  }
  return null;
}

/** Return metadata for a cached video without reading its body. */
export function getStoredVideoOutputFileInfo(accountId: string, taskId: string, index: number): StoredVideoOutput & { filePath: string } | null {
  if (!/^[-a-zA-Z0-9_]+$/.test(accountId) || !/^[-a-zA-Z0-9_]+$/.test(taskId) || !Number.isInteger(index) || index < 0 || index > 63) return null;
  const directory = outputDirectory(accountId, taskId);
  if (!directory) return null;
  const root = path.resolve(getWorkspacePath());
  let taskRoot: string;
  try { taskRoot = fs.realpathSync(directory); } catch { return null; }
  if (!taskRoot.startsWith(`${root}${path.sep}`)) return null;
  for (const ext of ['mp4', 'webm', 'mov', 'avi']) {
    const file = path.join(directory, `${index}.${ext}`);
    if (!fs.existsSync(file)) continue;
    try {
      const resolved = fs.realpathSync(file);
      if (!resolved.startsWith(`${taskRoot}${path.sep}`)) return null;
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_VIDEO_OUTPUT_BYTES) return null;
      const mimeType = ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : ext === 'avi' ? 'video/x-msvideo' : 'video/mp4';
      return { index, relativePath: path.relative(getWorkspacePath(), resolved).replace(/\\/g, '/'), mimeType, size: stat.size, filePath: resolved };
    } catch { return null; }
  }
  return null;
}
