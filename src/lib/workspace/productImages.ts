import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { getWorkspacePath } from '../storagePaths';
import { publishFileReference, type PublishedAssetReference } from './referenceBridge';

/** Product/PID records imported from the 8765 gallery service. */
export type ProductImageRecord = {
  accountId: string;
  pid: string;
  importedAt: string;
  importDate: string;
  relativePath: string;
  files: string[];
};

export type ProductImageAsset = {
  id: string;
  pid: string;
  importDate: string;
  name: string;
  relativePath: string;
  mimeType: string;
  size: number;
};

export type GalleryItem = { pid: string; title?: string; description?: string; coverUrl?: string; [key: string]: unknown };
export type ProductImageCleanupResult = {
  cutoffDate: string;
  dryRun: boolean;
  scannedDateDirectories: number;
  deletedDirectories: number;
  deletedFiles: number;
  deletedIndexes: number;
  failures: number;
};

const DEFAULT_8765_BASE = 'http://127.0.0.1:8765';
const MAX_PID_COUNT = 100;
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp']);

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function productImagesRoot(): string { return getWorkspacePath('product-images'); }

function safeSegment(value: string, errorCode: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/\0]/.test(normalized) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) throw new Error(errorCode);
  return normalized;
}

function normalizePidList(pids: readonly string[]): string[] {
  if (!Array.isArray(pids) || pids.length === 0 || pids.length > MAX_PID_COUNT) throw new Error('product_pid_required');
  return [...new Set(pids.map((pid) => safeSegment(pid, 'product_pid_invalid')))];
}

function baseUrl(): string {
  const configured = process.env.WORKSPACE_8765_BASE_URL?.trim() || DEFAULT_8765_BASE;
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error('product_source_url_invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' && url.pathname !== '') throw new Error('product_source_url_invalid');
  const local = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (!local && process.env.WORKSPACE_8765_ALLOW_REMOTE !== 'true') throw new Error('product_source_host_not_allowed');
  return url.origin;
}

function dateInShanghai(value: Date | number = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function subtractDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

export function getNextShanghaiMidnight(now: Date | number = new Date()): Date {
  const current = new Date(now);
  const currentDate = dateInShanghai(current);
  const nextDate = subtractDays(currentDate, -1);
  const [year, month, day] = nextDate.split('-').map(Number);
  // Shanghai is UTC+08:00 and does not observe DST.
  return new Date(Date.UTC(year, month - 1, day, -8, 0, 0, 0));
}

export async function queryProductGallery(
  params: { query?: string; membership?: string; category?: string; limit?: number; offset?: number } = {},
  fetcher: typeof fetch = fetch,
): Promise<GalleryItem[]> {
  const url = new URL(`${baseUrl()}/api/v1/gallery`);
  if (params.query?.trim()) url.searchParams.set('query', params.query.trim().slice(0, 200));
  if (params.membership?.trim()) url.searchParams.set('membership', params.membership.trim().slice(0, 80));
  if (params.category?.trim()) url.searchParams.set('category', params.category.trim().slice(0, 80));
  if (params.limit !== undefined) url.searchParams.set('limit', String(Math.max(1, Math.min(100, Math.round(params.limit)))));
  if (params.offset !== undefined) url.searchParams.set('offset', String(Math.max(0, Math.min(1_000_000, Math.round(params.offset)))));
  const response = await fetcher(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`product_source_http_${response.status}`);
  const payload = await response.json() as unknown;
  if (Array.isArray(payload)) return payload.filter(isGalleryItem).map(clone);
  if (payload && typeof payload === 'object') {
    const candidate = payload as { items?: unknown; data?: unknown; results?: unknown };
    for (const value of [candidate.items, candidate.data, candidate.results]) if (Array.isArray(value)) return value.filter(isGalleryItem).map(clone);
  }
  throw new Error('product_gallery_response_invalid');
}

function isGalleryItem(value: unknown): value is GalleryItem {
  return Boolean(value && typeof value === 'object' && typeof (value as { pid?: unknown }).pid === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test((value as { pid: string }).pid));
}

export async function importProductImages(
  accountIdInput: string,
  pidsInput: readonly string[],
  fetcher: typeof fetch = fetch,
  importedAt: Date | number = new Date(),
): Promise<ProductImageRecord[]> {
  const accountId = safeSegment(accountIdInput, 'account_id_invalid');
  const pids = normalizePidList(pidsInput);
  const root = baseUrl();
  const check = await fetcher(`${root}/api/v1/gallery/check-pids`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ pids }) });
  if (!check.ok) throw new Error(`product_source_http_${check.status}`);
  const checkPayload = await check.json() as unknown;
  const valid = extractPidList(checkPayload);
  const requested = new Set(pids);
  if (valid.length !== requested.size || new Set(valid).size !== requested.size || valid.some((pid) => !requested.has(pid))) throw new Error('product_pid_unavailable');
  const response = await fetcher(`${root}/api/v1/gallery/download-folder`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/zip, application/octet-stream' }, body: JSON.stringify({ pids }) });
  if (!response.ok) throw new Error(`product_source_http_${response.status}`);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType && !['application/zip', 'application/octet-stream', 'application/x-zip-compressed'].includes(contentType)) throw new Error('product_archive_content_type_invalid');
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_ARCHIVE_BYTES) throw new Error('product_archive_too_large');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length <= 0 || bytes.length > MAX_ARCHIVE_BYTES) throw new Error('product_archive_too_large');
  const date = dateInShanghai(importedAt);
  const imported: ProductImageRecord[] = [];
  for (const pid of pids) {
    const destination = getWorkspacePath('product-images', accountId, date, pid);
    fs.mkdirSync(destination, { recursive: true });
    try {
      const files = extractZipForPid(bytes, pid, destination, new Set(pids));
      if (!files.length) throw new Error('product_archive_no_images');
      const now = new Date(importedAt).toISOString();
      const manifest = { accountId, pid, importedAt: now, importDate: date, files };
      fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
      imported.push({ ...manifest, relativePath: path.relative(getWorkspacePath(), destination).replace(/\\/g, '/') });
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  }
  return imported.map(clone);
}

function extractPidList(payload: unknown): string[] {
  if (Array.isArray(payload)) return payload.filter((value): value is string => typeof value === 'string');
  if (payload && typeof payload === 'object') {
    const value = payload as { valid?: unknown; pids?: unknown; data?: unknown };
    for (const candidate of [value.valid, value.pids, value.data]) if (Array.isArray(candidate)) return candidate.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function extractZipForPid(archive: Buffer, pid: string, destination: string, allowedPids: ReadonlySet<string> = new Set([pid])): string[] {
  const eocd = findSignature(archive, 0x06054b50);
  if (eocd < 0) throw new Error('product_archive_invalid');
  const count = archive.readUInt16LE(eocd + 10);
  const size = archive.readUInt32LE(eocd + 12);
  const offset = archive.readUInt32LE(eocd + 16);
  if (offset + size > archive.length) throw new Error('product_archive_invalid');
  const files: string[] = [];
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('product_archive_invalid');
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!name || name.endsWith('/')) continue;
    const normalized = name.replace(/\\/g, '/');
    if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..') || normalized.includes('\0')) throw new Error('product_archive_path_invalid');
    const parts = normalized.split('/');
    const relative = parts[0] === pid ? parts.slice(1).join('/') : normalized;
    if (parts[0] !== pid && parts.length > 1) {
      if (allowedPids.has(parts[0])) continue;
      throw new Error('product_archive_pid_mismatch');
    }
    if (!relative || !IMAGE_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
    if (compressedSize > MAX_ENTRY_BYTES || uncompressedSize > MAX_ENTRY_BYTES) throw new Error('product_archive_entry_too_large');
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('product_archive_invalid');
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) throw new Error('product_archive_invalid');
    let data: Buffer;
    try { data = method === 0 ? archive.subarray(dataStart, dataEnd) : method === 8 ? zlib.inflateRawSync(archive.subarray(dataStart, dataEnd)) : (() => { throw new Error('product_archive_compression_unsupported'); })(); } catch (error) { if (error instanceof Error && error.message.startsWith('product_archive_')) throw error; throw new Error('product_archive_invalid'); }
    if (data.length !== uncompressedSize) throw new Error('product_archive_invalid');
    const target = path.resolve(destination, ...relative.split('/'));
    const destinationRoot = path.resolve(destination);
    if (!target.startsWith(`${destinationRoot}${path.sep}`)) throw new Error('product_archive_path_invalid');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode: 0o600 });
    files.push(path.relative(destination, target).replace(/\\/g, '/'));
  }
  return files;
}

function findSignature(buffer: Buffer, signature: number): number {
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index -= 1) if (buffer.readUInt32LE(index) === signature) return index;
  return -1;
}

export function listProductImages(accountIdInput?: string): ProductImageRecord[] {
  const root = productImagesRoot();
  const accountFilter = accountIdInput ? safeSegment(accountIdInput, 'account_id_invalid') : undefined;
  const accounts = accountFilter ? [accountFilter] : readDirectories(root);
  const records: ProductImageRecord[] = [];
  for (const accountId of accounts) {
    const accountDir = path.join(root, accountId);
    for (const date of readDirectories(accountDir).filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item))) {
      for (const pid of readDirectories(path.join(accountDir, date))) {
        const pidDir = path.join(accountDir, date, pid);
        const files = listImageFiles(pidDir);
        if (!files.length) continue;
        let importedAt = new Date(`${date}T00:00:00.000Z`).toISOString();
        try { const manifest = JSON.parse(fs.readFileSync(path.join(pidDir, 'manifest.json'), 'utf8')) as { importedAt?: string }; if (typeof manifest.importedAt === 'string') importedAt = manifest.importedAt; } catch { /* manifest is optional */ }
        records.push({ accountId, pid, importedAt, importDate: date, relativePath: path.relative(getWorkspacePath(), pidDir).replace(/\\/g, '/'), files });
      }
    }
  }
  return records.map(clone);
}

/** Lists individual shared product-image files across every operator account. */
export function listProductImageAssets(): ProductImageAsset[] {
  return listProductImages().flatMap((record) => record.files.map((file) => {
    const relativePath = path.posix.join(record.relativePath.replace(/\\/g, '/'), file.replace(/\\/g, '/'));
    const absolutePath = path.resolve(getWorkspacePath(relativePath));
    let size = 0;
    try { size = fs.statSync(absolutePath).size; } catch { /* stale files are omitted below */ }
    if (!size) return null;
    return {
      id: `product-image:${record.accountId}:${record.importDate}:${record.pid}:${file.replace(/\\/g, '/')}`,
      pid: record.pid,
      importDate: record.importDate,
      name: `${record.pid} · ${path.basename(file)}`,
      relativePath,
      mimeType: mimeTypeForPath(file),
      size,
    } satisfies ProductImageAsset;
  }).filter((item): item is ProductImageAsset => Boolean(item)));
}

export function getProductImageAbsolutePath(assetId: string): string {
  const asset = readProductImageAsset(assetId);
  if (!asset) throw new Error('reference_asset_not_found');
  const root = path.resolve(getWorkspacePath());
  const resolved = path.resolve(getWorkspacePath(asset.relativePath));
  if (!resolved.startsWith(`${root}${path.sep}`) || !fs.existsSync(resolved)) throw new Error('reference_asset_not_found');
  const real = fs.realpathSync(resolved);
  if (!real.startsWith(`${root}${path.sep}`)) throw new Error('reference_asset_not_found');
  return real;
}

function mimeTypeForPath(file: string): string {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.avif') return 'image/avif';
  if (extension === '.bmp') return 'image/bmp';
  return 'image/png';
}

/** Publishes a shared product image through the same short-lived reference bridge as account assets. */
export function publishProductImageReference(assetId: string, accountId: string): PublishedAssetReference {
  const asset = listProductImageAssets().find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error('reference_asset_not_found');
  // Shared gallery assets are intentionally available to every workspace;
  // legacy account-scoped imports remain restricted to their owner.
  if (asset.id.split(':')[1] !== 'shared' && asset.id.split(':')[1] !== accountId) throw new Error('reference_asset_not_found');
  return publishFileReference({ accountId, assetId, relativePath: asset.relativePath, mimeType: asset.mimeType });
}

export function readProductImageAsset(assetId: string): ProductImageAsset | null {
  return listProductImageAssets().find((candidate) => candidate.id === assetId) ?? null;
}

function readDirectories(directory: string): string[] { try { return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; } }
function listImageFiles(directory: string): string[] { try { return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? listImageFiles(path.join(directory, entry.name)).map((child) => `${entry.name}/${child}`) : IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ? [entry.name] : []); } catch { return []; } }

export function cleanupExpiredProductImages(now: Date | number = new Date(), options: { dryRun?: boolean } = {}): ProductImageCleanupResult {
  const cutoffDate = subtractDays(dateInShanghai(now), 3);
  const result: ProductImageCleanupResult = { cutoffDate, dryRun: options.dryRun === true, scannedDateDirectories: 0, deletedDirectories: 0, deletedFiles: 0, deletedIndexes: 0, failures: 0 };
  const root = productImagesRoot();
  for (const accountId of readDirectories(root)) {
    const accountDir = path.join(root, accountId);
    for (const date of readDirectories(accountDir)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > cutoffDate) continue;
      result.scannedDateDirectories += 1;
      const dateDir = path.join(accountDir, date);
      for (const pid of readDirectories(dateDir)) {
        const target = path.join(dateDir, pid);
        try { result.deletedFiles += countFiles(target); if (!options.dryRun) fs.rmSync(target, { recursive: true, force: true }); result.deletedDirectories += 1; } catch { result.failures += 1; }
      }
      for (const entry of fs.existsSync(dateDir) ? fs.readdirSync(dateDir, { withFileTypes: true }) : []) {
        const target = path.join(dateDir, entry.name);
        try { if (entry.isFile()) { result.deletedFiles += 1; if (/(pid|hash|thumb|import|manifest|index)/i.test(entry.name)) result.deletedIndexes += 1; if (!options.dryRun) fs.rmSync(target, { force: true }); } else if (entry.isDirectory() && !options.dryRun) fs.rmSync(target, { recursive: true, force: true }); } catch { result.failures += 1; }
      }
      if (!options.dryRun) { try { fs.rmSync(dateDir, { recursive: true, force: true }); } catch { result.failures += 1; } }
    }
  }
  return result;
}

function countFiles(directory: string): number { try { return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => total + (entry.isDirectory() ? countFiles(path.join(directory, entry.name)) : 1), 0); } catch { return 0; } }

let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
export function scheduleProductImageCleanup(): () => void {
  if (cleanupTimer) return () => { if (cleanupTimer) clearTimeout(cleanupTimer); cleanupTimer = undefined; };
  cleanupExpiredProductImages();
  const scheduleNext = () => { const delay = Math.max(1_000, getNextShanghaiMidnight().getTime() - Date.now()); cleanupTimer = setTimeout(() => { cleanupTimer = undefined; cleanupExpiredProductImages(); scheduleNext(); }, delay); cleanupTimer.unref?.(); };
  scheduleNext();
  return () => { if (cleanupTimer) clearTimeout(cleanupTimer); cleanupTimer = undefined; };
}
