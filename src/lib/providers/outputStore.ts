import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWorkspacePath } from '@/lib/storagePaths';

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_OUTPUT_BYTES = 200 * 1024 * 1024;

export type StoredImageOutput = {
  index: number;
  relativePath: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  size: number;
};

function detectImage(bytes: Buffer): StoredImageOutput['mimeType'] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function extension(mime: StoredImageOutput['mimeType']): string {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
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
    fs.mkdirSync(path.dirname(target), { recursive: true });
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

export function readStoredOutput(accountId: string, taskId: string, index: number): { bytes: Buffer; mimeType: StoredImageOutput['mimeType'] } | null {
  if (!/^[-a-zA-Z0-9_]+$/.test(accountId) || !/^[-a-zA-Z0-9_]+$/.test(taskId) || !Number.isInteger(index) || index < 0 || index > 63) return null;
  const directory = getWorkspacePath('generated', accountId, taskId);
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp'] as const) {
    const file = path.join(directory, `${index}.${extension(mimeType)}`);
    if (!fs.existsSync(file)) continue;
    try {
      const root = path.resolve(getWorkspacePath());
      const resolved = fs.realpathSync(file);
      if (!resolved.startsWith(`${root}${path.sep}`)) return null;
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
