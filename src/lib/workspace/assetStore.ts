import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWorkspacePath } from '../storagePaths';

export type AssetKind = 'prompt' | 'image' | 'inventory-video' | 'audio';
export type PromptAssetCategory = 'image' | 'video';
export type WorkspaceAsset = { id: string; accountId: string; kind: AssetKind; name: string; relativePath?: string; mimeType?: string; size?: number; content?: string; category?: PromptAssetCategory; createdAt: string; updatedAt: string };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ASSET_NAME_MAX_LENGTH = 120;
const CONTENT_MAX_LENGTH = 30_000;
const BINARY_KINDS: readonly Exclude<AssetKind, 'prompt'>[] = ['image', 'inventory-video', 'audio'];
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'tif', 'tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'webm']);

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function isAllowedUploadType(kind: Exclude<AssetKind, 'prompt'>, name: string, mimeType: string): boolean {
  const extension = name.split('.').pop()?.toLowerCase() || '';
  const normalizedMime = mimeType.trim().toLowerCase();
  if (kind === 'image') {
    // SVG is intentionally excluded: assets are served inline and SVG can
    // carry executable markup in otherwise trusted workspaces.
    return IMAGE_EXTENSIONS.has(extension) && normalizedMime !== 'image/svg+xml' && (normalizedMime === '' || normalizedMime.startsWith('image/'));
  }
  if (kind === 'inventory-video') return VIDEO_EXTENSIONS.has(extension) && (normalizedMime === '' || normalizedMime.startsWith('video/'));
  return AUDIO_EXTENSIONS.has(extension) && (normalizedMime === '' || normalizedMime.startsWith('audio/'));
}


/** Validate identifiers before they are interpolated into a workspace path. */
export function assertAssetAccountId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('account_id_invalid');
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized)) throw new Error('account_id_invalid');
  return normalized;
}

export function assertAssetId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('asset_id_invalid');
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized)) throw new Error('asset_id_invalid');
  return normalized;
}

function filePath(accountId: string): string {
  return getWorkspacePath('assets', `${assertAssetAccountId(accountId)}.json`);
}

function uploadDir(accountId: string): string {
  return getWorkspacePath('uploads', assertAssetAccountId(accountId));
}

function read(accountId: string): WorkspaceAsset[] {
  const file = filePath(accountId);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.map(normalizeStoredAsset) : [];
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code !== 'ENOENT') {
      // Preserve the historical tolerant behaviour for malformed stores while
      // allowing path/identifier validation errors to surface before this point.
      return [];
    }
    return [];
  }
}

/**
 * Normalize records written before prompt categories existed. Legacy prompt
 * templates are treated as video templates to preserve the historical
 * production flow; non-prompt assets never receive a category.
 */
function normalizeStoredAsset(value: unknown): WorkspaceAsset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('asset_store_invalid');
  const asset = value as WorkspaceAsset;
  if (asset.kind === 'prompt') {
    const category = asset.category === 'image' || asset.category === 'video' ? asset.category : 'video';
    return { ...asset, category };
  }
  const { category: _category, ...withoutCategory } = asset;
  return withoutCategory;
}

function write(accountId: string, assets: readonly WorkspaceAsset[]): void {
  const file = filePath(accountId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(assets, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

function safeAssetFilePath(accountId: string, relativePath: string, allowMissing = false): string | null {
  const normalizedAccount = assertAssetAccountId(accountId);
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) throw new Error('asset_path_invalid');
  const root = path.resolve(getWorkspacePath());
  // Resolve untrusted relativePath against the already-validated data root;
  // do not pass it back through getWorkspacePath(), which intentionally throws
  // before we can normalize a tampered legacy record into a safe null result.
  const lexical = path.resolve(root, relativePath);
  const accountRoot = path.resolve(uploadDir(normalizedAccount));
  if (!lexical.startsWith(`${root}${path.sep}`) || !lexical.startsWith(`${accountRoot}${path.sep}`)) throw new Error('asset_path_invalid');
  if (!fs.existsSync(lexical)) {
    if (allowMissing) return null;
    throw new Error('asset_file_not_found');
  }
  let real: string;
  try { real = fs.realpathSync(lexical); } catch { throw new Error('asset_path_invalid'); }
  let realRoot: string;
  try { realRoot = fs.realpathSync(accountRoot); } catch { throw new Error('asset_path_invalid'); }
  if (!realRoot.startsWith(`${root}${path.sep}`) || !real.startsWith(`${realRoot}${path.sep}`)) throw new Error('asset_path_invalid');
  let stat: fs.Stats;
  try { stat = fs.statSync(real); } catch { throw new Error('asset_file_not_found'); }
  if (!stat.isFile()) throw new Error('asset_file_invalid');
  return real;
}

export function listAssets(accountId: string, kind?: AssetKind): WorkspaceAsset[] {
  const normalizedAccount = assertAssetAccountId(accountId);
  return read(normalizedAccount).filter((asset) => !kind || asset.kind === kind).map(clone);
}

export function getAsset(accountId: string, id: string): WorkspaceAsset | null {
  const normalizedAccount = assertAssetAccountId(accountId);
  const normalizedAsset = assertAssetId(id);
  const asset = read(normalizedAccount).find((item) => item.id === normalizedAsset);
  return asset ? clone(asset) : null;
}

export function createPromptAsset(accountId: string, input: { name: string; content: string; category?: PromptAssetCategory }): WorkspaceAsset {
  const normalizedAccount = assertAssetAccountId(accountId);
  if (!input.name.trim() || !input.content.trim()) throw new Error('asset_content_required');
  const now = new Date().toISOString();
  const category = input.category === 'image' ? 'image' : 'video';
  const asset: WorkspaceAsset = { id: `asset-${crypto.randomUUID()}`, accountId: normalizedAccount, kind: 'prompt', category, name: input.name.trim().slice(0, ASSET_NAME_MAX_LENGTH), content: input.content.slice(0, CONTENT_MAX_LENGTH), createdAt: now, updatedAt: now };
  write(normalizedAccount, [...read(normalizedAccount), asset]);
  return clone(asset);
}

export function createUploadedAsset(accountId: string, kind: Exclude<AssetKind, 'prompt'>, file: { name: string; type: string; size: number; arrayBuffer: ArrayBuffer }): WorkspaceAsset {
  const normalizedAccount = assertAssetAccountId(accountId);
  if (!BINARY_KINDS.includes(kind) || !file.name || file.size <= 0 || file.size > 100 * 1024 * 1024) throw new Error('asset_file_invalid');
  if (!isAllowedUploadType(kind, file.name, file.type)) throw new Error('asset_file_type_invalid');
  const bytes = Buffer.from(file.arrayBuffer);
  if (kind === 'image') {
    const probe = bytes.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
    if (probe.startsWith('<svg') || probe.startsWith('<!doctype html') || probe.startsWith('<html') || probe.startsWith('<script')) {
      throw new Error('asset_file_type_invalid');
    }
  }
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, ASSET_NAME_MAX_LENGTH);
  const id = `asset-${crypto.randomUUID()}`;
  const directory = uploadDir(normalizedAccount);
  fs.mkdirSync(directory, { recursive: true });
  const relativePath = path.join('uploads', normalizedAccount, `${id}-${safeName}`).replace(/\\/g, '/');
  const destination = getWorkspacePath(relativePath);
  fs.writeFileSync(destination, bytes);
  const now = new Date().toISOString();
  const asset: WorkspaceAsset = { id, accountId: normalizedAccount, kind, name: file.name.slice(0, ASSET_NAME_MAX_LENGTH), relativePath, mimeType: file.type.slice(0, ASSET_NAME_MAX_LENGTH), size: file.size, createdAt: now, updatedAt: now };
  write(normalizedAccount, [...read(normalizedAccount), asset]);
  return clone(asset);
}

/** Rename an asset's display name without moving its physical file. */
export function renameAsset(accountId: string, id: string, name: string): WorkspaceAsset | null {
  const normalizedAccount = assertAssetAccountId(accountId);
  const normalizedAsset = assertAssetId(id);
  if (typeof name !== 'string' || !name.trim()) throw new Error('asset_name_required');
  const safeDisplayName = name.replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').trim().slice(0, ASSET_NAME_MAX_LENGTH);
  if (!safeDisplayName) throw new Error('asset_name_required');
  const current = read(normalizedAccount);
  const index = current.findIndex((asset) => asset.id === normalizedAsset);
  if (index < 0) return null;
  const next: WorkspaceAsset = { ...current[index], name: safeDisplayName, updatedAt: new Date().toISOString() };
  write(normalizedAccount, current.map((asset, itemIndex) => itemIndex === index ? next : asset));
  return clone(next);
}

/** Update a saved prompt template without changing its asset identity. */
export function updatePromptAsset(accountId: string, id: string, input: { name: string; content: string; category?: PromptAssetCategory }): WorkspaceAsset | null {
  const normalizedAccount = assertAssetAccountId(accountId);
  const normalizedAsset = assertAssetId(id);
  if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('asset_name_required');
  if (typeof input.content !== 'string' || !input.content.trim()) throw new Error('asset_content_required');
  const current = read(normalizedAccount);
  const index = current.findIndex((asset) => asset.id === normalizedAsset);
  if (index < 0) return null;
  if (current[index].kind !== 'prompt') throw new Error('asset_kind_invalid');
  const next: WorkspaceAsset = { ...current[index], category: input.category === 'image' ? 'image' : input.category === 'video' ? 'video' : current[index].category === 'image' ? 'image' : 'video', name: input.name.trim().slice(0, ASSET_NAME_MAX_LENGTH), content: input.content.slice(0, CONTENT_MAX_LENGTH), updatedAt: new Date().toISOString() };
  write(normalizedAccount, current.map((asset, itemIndex) => itemIndex === index ? next : asset));
  return clone(next);
}

/** Delete metadata and, for binary assets, the account-scoped physical file. */
export function deleteAsset(accountId: string, id: string): WorkspaceAsset | null {
  const normalizedAccount = assertAssetAccountId(accountId);
  const normalizedAsset = assertAssetId(id);
  const current = read(normalizedAccount);
  const asset = current.find((item) => item.id === normalizedAsset);
  if (!asset) return null;
  // Resolve and validate before changing metadata. This prevents a malformed
  // legacy relativePath from causing partial deletion or an arbitrary unlink.
  if (asset.relativePath) {
    const physical = safeAssetFilePath(normalizedAccount, asset.relativePath, true);
    if (physical) fs.rmSync(physical, { force: true });
  }
  write(normalizedAccount, current.filter((item) => item.id !== normalizedAsset));
  return clone(asset);
}

/** Return a validated physical file path for a binary asset and its bytes. */
export function readAssetFile(accountId: string, id: string): { asset: WorkspaceAsset; filePath: string; bytes: Buffer } | null {
  const normalizedAccount = assertAssetAccountId(accountId);
  const normalizedAsset = assertAssetId(id);
  const asset = read(normalizedAccount).find((item) => item.id === normalizedAsset);
  if (!asset || asset.kind === 'prompt' || !asset.relativePath) return null;
  let physical: string | null;
  try { physical = safeAssetFilePath(normalizedAccount, asset.relativePath); } catch (error) {
    // A stale or tampered legacy record is treated as unavailable by callers;
    // never expose the underlying path-validation detail through file reads.
    if (error instanceof Error && ['asset_path_invalid', 'asset_file_not_found', 'asset_file_invalid'].includes(error.message)) return null;
    throw error;
  }
  if (!physical) return null;
  return { asset: clone(asset), filePath: physical, bytes: fs.readFileSync(physical) };
}
