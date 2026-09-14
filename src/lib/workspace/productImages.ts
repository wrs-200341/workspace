import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { getWorkspacePath } from '../storagePaths';
import { productImageFileVersion, productImageThumbnailUrl } from './productImageThumbnails';
import { publishFileReference, publishFileReferences, type PublishedAssetReference } from './referenceBridge';

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
  version?: string;
  thumbnailUrl?: string;
};

export type ProductImageFolder = ProductImageRecord & {
  coverAssetId?: string;
  coverUrl?: string;
  imageCount: number;
  images?: ProductImageAsset[];
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
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp']);

let sourceToken: string | null = null;
let sourceTokenBase = '';
type ProductImageDirectoryCache = {
  root: string;
  mtimeMs: number;
  records: ProductImageRecord[];
  assetSources: Map<string, { record: ProductImageRecord; file: string }>;
  assets: Map<string, ProductImageAsset>;
  folders: Map<string, ProductImageFolder[]>;
};
let directoryCache: ProductImageDirectoryCache | null = null;

function sourceTimeoutMs(): number {
  const configured = Number(process.env.WORKSPACE_8765_TIMEOUT_MS || 30_000);
  return Number.isFinite(configured) ? Math.max(1_000, Math.min(120_000, Math.round(configured))) : 30_000;
}

/**
 * Archive downloads bundle every image of every requested PID, so they are far
 * slower than the metadata calls the default timeout is sized for. A folder
 * that has to come from the remote NAS costs roughly a second per file.
 */
function archiveTimeoutMs(): number {
  const configured = Number(process.env.WORKSPACE_8765_ARCHIVE_TIMEOUT_MS || 300_000);
  const fallback = Math.max(sourceTimeoutMs(), 300_000);
  return Number.isFinite(configured) ? Math.max(30_000, Math.min(900_000, Math.round(configured))) : fallback;
}

async function fetchSource(fetcher: typeof fetch, input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = sourceTimeoutMs()): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: init.signal ?? controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('product_source_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const MAX_SOURCE_ERROR_DETAIL = 400;

/**
 * 8765 reports a failed read as an HTTP error whose JSON body names the real
 * cause — for example `极空间代理请求失败: ConnectionError` when the ZSpace
 * desktop client, and with it the local proxy 8765 depends on, is not running.
 * Keep the stable `product_source_http_<status>` code that callers switch on,
 * but carry that upstream text on the error so operators are told what actually
 * broke instead of only seeing a bare status code.
 */
async function productSourceHttpError(response: Response): Promise<Error> {
  const error = new Error(`product_source_http_${response.status}`) as Error & { detail?: string };
  const raw = await response.text().catch(() => '');
  let detail = raw.trim();
  if (detail) {
    try {
      const payload = JSON.parse(detail) as Record<string, unknown>;
      const named = [payload.error, payload.msg, payload.message].find((value) => typeof value === 'string' && value.trim());
      if (typeof named === 'string') detail = named.trim();
    } catch { /* a non-JSON body is reported as-is */ }
    if (detail) error.detail = detail.slice(0, MAX_SOURCE_ERROR_DETAIL);
  }
  return error;
}

/** Read the upstream 8765 explanation attached by `productSourceHttpError`. */
export function productSourceErrorDetail(error: unknown): string | undefined {
  const detail = error && typeof error === 'object' ? (error as { detail?: unknown }).detail : undefined;
  return typeof detail === 'string' && detail.trim() ? detail.trim() : undefined;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function productImagesRoot(): string { return getWorkspacePath('product-images'); }

function rootMtimeMs(root: string): number {
  try {
    return fs.statSync(root).mtimeMs;
  } catch {
    return 0;
  }
}

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
  const root = baseUrl();
  const url = new URL(`${root}/api/v1/gallery/search`);
  if (params.query?.trim()) url.searchParams.set('q', params.query.trim().slice(0, 200));
  if (params.membership?.trim()) url.searchParams.set('membership', params.membership.trim().slice(0, 80));
  if (params.category?.trim()) url.searchParams.set('category', params.category.trim().slice(0, 80));
  if (params.limit !== undefined) url.searchParams.set('limit', String(Math.max(1, Math.min(100, Math.round(params.limit)))));
  if (params.offset !== undefined) url.searchParams.set('offset', String(Math.max(0, Math.min(1_000_000, Math.round(params.offset)))));
  // Prefer the current search endpoint to avoid an extra failed round trip on
  // every PID. Fall back to the legacy route for older 8765 deployments.
  const legacy = new URL(`${root}/api/v1/gallery`);
  if (params.query?.trim()) legacy.searchParams.set('query', params.query.trim().slice(0, 200));
  if (params.membership?.trim()) legacy.searchParams.set('membership', params.membership.trim().slice(0, 80));
  if (params.category?.trim()) legacy.searchParams.set('category', params.category.trim().slice(0, 80));
  if (params.limit !== undefined) legacy.searchParams.set('limit', String(Math.max(1, Math.min(100, Math.round(params.limit)))));
  if (params.offset !== undefined) legacy.searchParams.set('offset', String(Math.max(0, Math.min(1_000_000, Math.round(params.offset)))));
  let response = await fetchSource(fetcher, url, { headers: { accept: 'application/json' } });
  if (response.status === 403 || response.status === 404 || response.status === 405) response = await fetchSource(fetcher, legacy, { headers: { accept: 'application/json' } });
  if (!response.ok) throw await productSourceHttpError(response);
  const payload = await response.json() as unknown;
  const items = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? ((payload as { items?: unknown; data?: unknown; results?: unknown }).items
        ?? (payload as { data?: unknown }).data
        ?? (payload as { results?: unknown }).results)
      : undefined;
  if (Array.isArray(items)) return items.filter(isGalleryItem).map((item) => normalizeGalleryItem(item, root));
  throw new Error('product_gallery_response_invalid');
}

function isGalleryItem(value: unknown): value is GalleryItem {
  return Boolean(value && typeof value === 'object' && typeof (value as { pid?: unknown }).pid === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test((value as { pid: string }).pid));
}

function normalizeGalleryItem(item: GalleryItem, root: string): GalleryItem {
  const raw = item as GalleryItem & { cover?: unknown; image_count?: unknown; cover_available?: unknown };
  const coverUrl = typeof raw.coverUrl === 'string' && raw.coverUrl.trim()
    ? raw.coverUrl.trim()
    : raw.cover || raw.cover_available
      ? `${root}/api/v1/gallery/cover/${encodeURIComponent(item.pid)}`
      : undefined;
  return clone({ ...item, ...(coverUrl ? { coverUrl } : {}), ...(typeof raw.image_count === 'number' ? { imageCount: raw.image_count } : {}) });
}

async function sourceAuthHeaders(fetcher: typeof fetch): Promise<Record<string, string>> {
  const root = baseUrl();
  if (sourceToken && sourceTokenBase === root) return { 'X-Clone-Token': sourceToken };
  const response = await fetchSource(fetcher, `${root}/api/v1/session`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw await productSourceHttpError(response);
  const payload = await response.json() as { token?: unknown };
  if (typeof payload.token !== 'string' || !payload.token.trim()) throw new Error('product_source_session_invalid');
  sourceToken = payload.token.trim();
  sourceTokenBase = root;
  return { 'X-Clone-Token': sourceToken };
}

async function authenticatedPost(fetcher: typeof fetch, path: string, body: Record<string, unknown>, accept: string, timeoutMs?: number): Promise<Response> {
  const send = async (headers: Record<string, string>) => fetchSource(fetcher, `${baseUrl()}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept }, body: JSON.stringify(body) }, timeoutMs ?? sourceTimeoutMs());
  let response = await send(await sourceAuthHeaders(fetcher));
  // 8765 regenerates its local session token on process restart. Refresh it
  // once on an authorization failure so imports recover without a manual
  // server restart or page reload.
  if (response.status === 401 || response.status === 403) {
    sourceToken = null;
    sourceTokenBase = '';
    response = await send(await sourceAuthHeaders(fetcher));
  }
  return response;
}

/** Fetch the first image for a remote 8765 PID without exposing its local
 * service address to the browser. The response is proxied by our API route. */
export async function fetchProductGalleryCover(pidInput: string, fetcher: typeof fetch = fetch): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const pid = safeSegment(pidInput, 'product_pid_invalid');
  const endpoint = `${baseUrl()}/api/v1/gallery/cover/${encodeURIComponent(pid)}`;
  let response = await fetchSource(fetcher, endpoint, { headers: { accept: 'image/*' } });
  if (response.status === 401 || response.status === 403) response = await fetchSource(fetcher, endpoint, { headers: { ...(await sourceAuthHeaders(fetcher)), accept: 'image/*' } });
  if (!response.ok) throw await productSourceHttpError(response);
  const mimeType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || 'image/jpeg';
  if (!mimeType.startsWith('image/')) throw new Error('product_cover_content_type_invalid');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.byteLength > MAX_ENTRY_BYTES) throw new Error('product_cover_invalid');
  return { bytes, mimeType };
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
  // Legacy 8765 builds accepted /check-pids without a session header. Try it
  // first so existing deployments and test doubles remain compatible; the
  // current clone falls back to authenticated /check.
  let check = await fetchSource(fetcher, `${root}/api/v1/gallery/check-pids`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ pids }) });
  if (check.status === 403 || check.status === 404) check = await authenticatedPost(fetcher, '/api/v1/gallery/check', { pids }, 'application/json');
  if (!check.ok) throw await productSourceHttpError(check);
  const checkPayload = await check.json() as unknown;
  const valid = extractPidList(checkPayload, pids);
  const requested = new Set(pids);
  if (valid.length !== requested.size || new Set(valid).size !== requested.size || valid.some((pid) => !requested.has(pid))) throw new Error('product_pid_unavailable');
  let response = await fetchSource(fetcher, `${root}/api/v1/gallery/download-folder`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/zip, application/octet-stream' }, body: JSON.stringify({ pids }) }, archiveTimeoutMs());
  if (response.status === 403 || response.status === 404) response = await authenticatedPost(fetcher, '/api/v1/gallery/download', { pids }, 'application/zip, application/octet-stream', archiveTimeoutMs());
  if (!response.ok) throw await productSourceHttpError(response);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType && !['application/zip', 'application/octet-stream', 'application/x-zip-compressed'].includes(contentType)) throw new Error('product_archive_content_type_invalid');
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_ARCHIVE_BYTES) throw new Error('product_archive_too_large');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length <= 0 || bytes.length > MAX_ARCHIVE_BYTES) throw new Error('product_archive_too_large');
  const date = dateInShanghai(importedAt);
  const imported: ProductImageRecord[] = [];
  // Partial imports also change the index, including when extraction later fails.
  directoryCache = null;
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
  directoryCache = null;
  return imported.map(clone);
}

function extractPidList(payload: unknown, requested: readonly string[] = []): string[] {
  if (Array.isArray(payload)) return payload.filter((value): value is string => typeof value === 'string');
  if (payload && typeof payload === 'object') {
    const value = payload as { valid?: unknown; pids?: unknown; data?: unknown; existing?: unknown; missing?: unknown };
    for (const candidate of [value.valid, value.pids, value.existing, value.data]) if (Array.isArray(candidate)) return candidate.filter((item): item is string => typeof item === 'string');
    // 8765's /gallery/check returns existing/missing instead of a `valid`
    // list. Treat every requested PID that is not missing as available.
    if (Array.isArray(value.missing)) {
      const missing = new Set(value.missing.filter((item): item is string => typeof item === 'string'));
      return requested.filter((pid) => !missing.has(pid));
    }
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
  let extractedBytes = 0;
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
    // A multi-PID archive is processed once per requested PID. Only entries
    // rooted below the current PID may be written; entries for other requested
    // PIDs are skipped and unscoped top-level files are rejected.
    if (parts[0] !== pid) {
      if (allowedPids.has(parts[0])) continue;
      throw new Error('product_archive_pid_mismatch');
    }
    const relative = parts.slice(1).join('/');
    if (!relative || !IMAGE_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
    if (compressedSize > MAX_ENTRY_BYTES || uncompressedSize > MAX_ENTRY_BYTES) throw new Error('product_archive_entry_too_large');
    extractedBytes += uncompressedSize;
    if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('product_archive_too_large');
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

function productImageAssetId(record: ProductImageRecord, file: string): string {
  return `product-image:${record.accountId}:${record.importDate}:${record.pid}:${file.replace(/\\/g, '/')}`;
}

function buildProductImageAssets(record: ProductImageRecord): ProductImageAsset[] {
  return record.files.map((file) => buildProductImageAsset(record, file)).filter((item): item is ProductImageAsset => Boolean(item));
}

function buildProductImageAsset(record: ProductImageRecord, file: string): ProductImageAsset | null {
  const id = productImageAssetId(record, file);
  const cached = directoryCache?.assets.get(id);
  if (cached) return cached;
  const relativePath = path.posix.join(record.relativePath.replace(/\\/g, '/'), file.replace(/\\/g, '/'));
  const absolutePath = path.resolve(getWorkspacePath(relativePath));
  let stat: fs.Stats;
  try { stat = fs.statSync(absolutePath); } catch { return null; }
  if (!stat.isFile() || !stat.size) return null;
  const version = productImageFileVersion(stat);
  const asset: ProductImageAsset = {
    id,
    pid: record.pid,
    importDate: record.importDate,
    name: `${record.pid} · ${path.basename(file)}`,
    relativePath,
    mimeType: mimeTypeForPath(file),
    size: stat.size,
    version,
    thumbnailUrl: productImageThumbnailUrl(id, version),
  };
  directoryCache?.assets.set(id, asset);
  return asset;
}

function buildProductImageFolder(record: ProductImageRecord, includeImages: boolean): ProductImageFolder {
  const images = includeImages ? buildProductImageAssets(record) : [];
  const cover = images[0] ?? (record.files[0] ? buildProductImageAsset(record, record.files[0]) : null);
  const fallbackCoverFile = record.files[0];
  const fallbackCoverAssetId = fallbackCoverFile
    ? `product-image:${record.accountId}:${record.importDate}:${record.pid}:${fallbackCoverFile.replace(/\\/g, '/')}`
    : undefined;
  const fallbackCoverUrl = fallbackCoverAssetId ? productImageThumbnailUrl(fallbackCoverAssetId) : undefined;
  return {
    ...record,
    files: [...record.files],
    imageCount: record.files.length,
    ...(cover ? {
      coverAssetId: cover.id,
      coverUrl: cover.thumbnailUrl,
      ...(includeImages ? { images } : {}),
    } : {
      ...(fallbackCoverAssetId ? { coverAssetId: fallbackCoverAssetId } : {}),
      ...(fallbackCoverUrl ? { coverUrl: fallbackCoverUrl } : {}),
      ...(includeImages ? { images } : {}),
    }),
  };
}

function getProductImageDirectoryCache(): ProductImageDirectoryCache {
  const root = productImagesRoot();
  const cached = directoryCache;
  const rootStat = rootMtimeMs(root);
  if (cached && cached.root === root && cached.mtimeMs === rootStat) return cached;
  const records: ProductImageRecord[] = [];
  const accounts = readDirectories(root);
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
  directoryCache = {
    root,
    mtimeMs: rootStat,
    records,
    assetSources: new Map(records.flatMap((record) => record.files.map((file) => [productImageAssetId(record, file), { record, file }] as const))),
    assets: new Map(),
    folders: new Map(),
  };
  return directoryCache;
}

export function listProductImages(accountIdInput?: string): ProductImageRecord[] {
  return getProductImageDirectoryCache().records.filter((record) => !accountIdInput || record.accountId === accountIdInput).map(clone);
}

/** Lists individual shared product-image files across every operator account. */
export function listProductImageAssets(accountIdInput?: string): ProductImageAsset[] {
  return getProductImageDirectoryCache().records.filter((record) => !accountIdInput || record.accountId === accountIdInput)
    .flatMap((record) => buildProductImageAssets(record)).map(clone);
}

/** Return imported PID folders. Images are loaded lazily on demand. */
export function listProductImageFolders(accountIdInput?: string, options: { includeImages?: boolean } = {}): ProductImageFolder[] {
  const cache = getProductImageDirectoryCache();
  const scope = accountIdInput ?? '';
  const cachedFolders = cache.folders.get(scope);
  if (cachedFolders && !options.includeImages) return cachedFolders.map(clone);
  const records = listProductImages(accountIdInput);
  const grouped = new Map<string, ProductImageRecord[]>();
  for (const record of records) grouped.set(record.pid, [...(grouped.get(record.pid) ?? []), record]);
  const folders = [...grouped.values()].map((recordGroup) => buildProductImageFolder([...recordGroup].sort((left, right) => right.importedAt.localeCompare(left.importedAt))[0], Boolean(options.includeImages))).map(clone);
  if (!options.includeImages) cache.folders.set(scope, folders.map(clone));
  return folders;
}

export function readProductImageFolder(accountIdInput: string | undefined, pidInput: string): ProductImageFolder | null {
  const pid = safeSegment(pidInput, 'product_pid_invalid');
  const record = listProductImages(accountIdInput).filter((item) => item.pid === pid).sort((left, right) => right.importedAt.localeCompare(left.importedAt))[0];
  if (!record) return null;
  return clone(buildProductImageFolder(record, true));
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
  const asset = readProductImageAsset(assetId);
  if (!asset) throw new Error('reference_asset_not_found');
  // Shared gallery assets are available to every workspace account.
  return publishFileReference({ accountId, assetId, relativePath: asset.relativePath, mimeType: asset.mimeType });
}

/** Batch variant used by production submissions to avoid one registry rewrite per image. */
export function publishProductImageReferences(assetIds: readonly string[], accountId: string): PublishedAssetReference[] {
  if (!assetIds.length) return [];
  const inputs = assetIds.map((assetId) => {
    const asset = readProductImageAsset(assetId);
    if (!asset) throw new Error('reference_asset_not_found');
    return { accountId, assetId, relativePath: asset.relativePath, mimeType: asset.mimeType };
  });
  return publishFileReferences(inputs);
}

export function readProductImageAsset(assetId: string): ProductImageAsset | null {
  const cache = getProductImageDirectoryCache();
  const source = cache.assetSources.get(assetId);
  if (!source) return null;
  const asset = buildProductImageAsset(source.record, source.file);
  return asset ? clone(asset) : null;
}

function readDirectories(directory: string): string[] { try { return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((left, right) => left.localeCompare(right, undefined, { numeric: true })); } catch { return []; } }
function listImageFiles(directory: string): string[] { try { return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true })).flatMap((entry) => entry.isDirectory() ? listImageFiles(path.join(directory, entry.name)).map((child) => `${entry.name}/${child}`) : IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ? [entry.name] : []); } catch { return []; } }

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
  directoryCache = null;
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
