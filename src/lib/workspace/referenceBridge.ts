import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAsset, type AssetKind, type WorkspaceAsset } from './assetStore';
import { getWorkspacePath } from '../storagePaths';

/**
 * Short-lived, read-only references for providers that cannot access local
 * filesystem paths. Files are copied into the D-drive data root and are
 * addressed by an unguessable token. No provider credentials are ever stored
 * in this registry.
 */
export type PublishedAssetReference = {
  token: string;
  url: string;
  accountId: string;
  assetId: string;
  mimeType: string;
  expiresAt: number;
};

type RegistryEntry = PublishedAssetReference & { cacheFile: string; createdAt: number };

const CACHE_DIRECTORY = 'reference-bridge/cache';
const REGISTRY_FILE = 'reference-bridge/registry.json';
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BATCH_REFERENCES = 64;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BINARY_KINDS: readonly AssetKind[] = ['image', 'inventory-video', 'audio'];

export function referenceBridgeCachePath(): string {
  return getWorkspacePath(...CACHE_DIRECTORY.split('/'));
}

export function referenceBridgeRegistryPath(): string {
  return getWorkspacePath(...REGISTRY_FILE.split('/'));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ensureDirectories(): void {
  fs.mkdirSync(referenceBridgeCachePath(), { recursive: true });
  fs.mkdirSync(path.dirname(referenceBridgeRegistryPath()), { recursive: true });
}

function readRegistry(): RegistryEntry[] {
  ensureDirectories();
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(referenceBridgeRegistryPath(), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRegistryEntry).map(clone);
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT') return [];
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

function writeRegistry(entries: readonly RegistryEntry[]): void {
  ensureDirectories();
  const file = referenceBridgeRegistryPath();
  const temporary = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<RegistryEntry>;
  return typeof candidate.token === 'string' && TOKEN_PATTERN.test(candidate.token)
    && typeof candidate.url === 'string' && typeof candidate.accountId === 'string'
    && typeof candidate.assetId === 'string' && typeof candidate.mimeType === 'string'
    && typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt)
    && typeof candidate.cacheFile === 'string' && typeof candidate.createdAt === 'number';
}

function publicBaseUrl(): string {
  const configured = process.env.WORKSPACE_PUBLIC_BASE_URL?.trim();
  if (!configured) throw new Error('reference_public_base_invalid');
  let parsed: URL;
  try { parsed = new URL(configured); } catch { throw new Error('reference_public_base_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('reference_public_base_invalid');
  }
  return parsed.origin;
}

function safeCachePath(fileName: string): string {
  const root = path.resolve(referenceBridgeCachePath());
  const resolved = path.resolve(root, fileName);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('reference_cache_path_invalid');
  return resolved;
}

function extensionFor(asset: WorkspaceAsset): string {
  const original = asset.relativePath ? path.extname(asset.relativePath).toLowerCase() : '';
  if (/^\.[a-z0-9]{1,8}$/.test(original)) return original;
  if (asset.mimeType === 'image/png') return '.png';
  if (asset.mimeType === 'image/jpeg') return '.jpg';
  if (asset.mimeType === 'image/webp') return '.webp';
  if (asset.mimeType === 'video/mp4') return '.mp4';
  if (asset.mimeType === 'audio/wav') return '.wav';
  return '.bin';
}

function validateAssetFile(asset: WorkspaceAsset, accountId: string, allowedKinds: readonly AssetKind[]): string {
  if (asset.accountId !== accountId) throw new Error('reference_asset_not_found');
  if (!BINARY_KINDS.includes(asset.kind) || !allowedKinds.includes(asset.kind)) throw new Error('reference_asset_kind_invalid');
  if (!asset.relativePath || path.isAbsolute(asset.relativePath)) throw new Error('reference_asset_path_invalid');
  const root = fs.realpathSync(path.resolve(getWorkspacePath()));
  const lexicalFile = path.resolve(getWorkspacePath(asset.relativePath));
  if (!lexicalFile.startsWith(`${root}${path.sep}`) || !fs.existsSync(lexicalFile)) throw new Error('reference_asset_not_found');
  let file: string;
  try { file = fs.realpathSync(lexicalFile); } catch { throw new Error('reference_asset_not_found'); }
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('reference_asset_not_found');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 100 * 1024 * 1024) throw new Error('reference_asset_file_invalid');
  return file;
}

/** Validate ownership and on-disk presence without publishing a public URL. */
export function assertAssetReference(accountId: string, assetId: string, allowedKinds: readonly AssetKind[] = BINARY_KINDS): WorkspaceAsset {
  const normalizedAccount = accountId.trim();
  const normalizedAsset = assetId.trim();
  const asset = normalizedAccount && normalizedAsset ? getAsset(normalizedAccount, normalizedAsset) : null;
  if (!asset) throw new Error('reference_asset_not_found');
  validateAssetFile(asset, normalizedAccount, allowedKinds);
  return asset;
}

export function publishAssetReference(input: {
  accountId: string;
  assetId: string;
  ttlMs?: number;
  allowedKinds?: readonly AssetKind[];
}): PublishedAssetReference {
  const accountId = input.accountId.trim();
  const assetId = input.assetId.trim();
  if (!accountId || !assetId) throw new Error('reference_asset_not_found');
  const asset = assertAssetReference(accountId, assetId, input.allowedKinds ?? BINARY_KINDS);
  const base = publicBaseUrl();
  const allowedKinds = input.allowedKinds ?? BINARY_KINDS;
  const source = validateAssetFile(asset, accountId, allowedKinds);
  const ttl = typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs) ? Math.max(1, Math.min(MAX_TTL_MS, Math.round(input.ttlMs))) : DEFAULT_TTL_MS;
  const token = crypto.randomBytes(32).toString('base64url');
  const extension = extensionFor(asset);
  const cacheFile = `${token}${extension}`;
  const destination = safeCachePath(cacheFile);
  ensureDirectories();
  // copyFile (rather than copy2) gives this publication a fresh mtime for TTL
  // based cleanup and avoids inheriting stale timestamps from old uploads.
  fs.copyFileSync(source, destination);
  const now = Date.now();
  const entry: RegistryEntry = {
    token,
    url: `${base}/api/workspace/references/${token}`,
    accountId,
    assetId,
    mimeType: asset.mimeType || 'application/octet-stream',
    expiresAt: now + ttl,
    cacheFile,
    createdAt: now,
  };
  const entries = readRegistry().filter((candidate) => candidate.expiresAt > now && candidate.token !== token);
  writeRegistry([...entries, entry]);
  return clone(entry);
}

/** Publish several account assets in one registry transaction. The previous
 * per-item API rewrote registry.json for every image/audio/video, which made
 * a batch production submission needlessly slow on large workspaces. */
export function publishAssetReferences(inputs: ReadonlyArray<{
  accountId: string;
  assetId: string;
  ttlMs?: number;
  allowedKinds?: readonly AssetKind[];
}>): PublishedAssetReference[] {
  if (inputs.length === 0) return [];
  if (inputs.length > MAX_BATCH_REFERENCES) throw new Error('reference_batch_too_large');
  const now = Date.now();
  const base = publicBaseUrl();
  ensureDirectories();
  const active = readRegistry().filter((candidate) => candidate.expiresAt > now);
  const published: RegistryEntry[] = [];
  try {
    for (const input of inputs) {
      const accountId = input.accountId.trim();
      const assetId = input.assetId.trim();
      if (!accountId || !assetId) throw new Error('reference_asset_not_found');
      const asset = assertAssetReference(accountId, assetId, input.allowedKinds ?? BINARY_KINDS);
      const source = validateAssetFile(asset, accountId, input.allowedKinds ?? BINARY_KINDS);
      const ttl = typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs) ? Math.max(1, Math.min(MAX_TTL_MS, Math.round(input.ttlMs))) : DEFAULT_TTL_MS;
      const token = crypto.randomBytes(32).toString('base64url');
      const cacheFile = `${token}${extensionFor(asset)}`;
      const destination = safeCachePath(cacheFile);
      fs.copyFileSync(source, destination);
      published.push({ token, url: `${base}/api/workspace/references/${token}`, accountId, assetId, mimeType: asset.mimeType || 'application/octet-stream', expiresAt: now + ttl, cacheFile, createdAt: now });
    }
  } catch (error) {
    for (const entry of published) {
      try { fs.rmSync(safeCachePath(entry.cacheFile), { force: true }); } catch { /* best effort rollback */ }
    }
    throw error;
  }
  writeRegistry([...active, ...published]);
  return published.map(clone);
}

/** Publishes a validated file already stored under the workspace data root. */
export function publishFileReference(input: { accountId: string; assetId: string; relativePath: string; mimeType: string; ttlMs?: number }): PublishedAssetReference {
  const accountId = input.accountId.trim();
  const assetId = input.assetId.trim();
  if (!accountId || !assetId || !input.relativePath || path.isAbsolute(input.relativePath)) throw new Error('reference_asset_not_found');
  const root = fs.realpathSync(path.resolve(getWorkspacePath()));
  const lexicalFile = path.resolve(getWorkspacePath(input.relativePath));
  if (!lexicalFile.startsWith(`${root}${path.sep}`) || !fs.existsSync(lexicalFile)) throw new Error('reference_asset_not_found');
  let source: string;
  try { source = fs.realpathSync(lexicalFile); } catch { throw new Error('reference_asset_not_found'); }
  if (!source.startsWith(`${root}${path.sep}`)) throw new Error('reference_asset_not_found');
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 100 * 1024 * 1024) throw new Error('reference_asset_file_invalid');
  const base = publicBaseUrl();
  const ttl = typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs) ? Math.max(1, Math.min(MAX_TTL_MS, Math.round(input.ttlMs))) : DEFAULT_TTL_MS;
  const token = crypto.randomBytes(32).toString('base64url');
  const extension = path.extname(input.relativePath).toLowerCase().match(/^\.[a-z0-9]{1,8}$/)?.[0] || '.bin';
  const cacheFile = `${token}${extension}`;
  const destination = safeCachePath(cacheFile);
  ensureDirectories();
  fs.copyFileSync(source, destination);
  const now = Date.now();
  const entry: RegistryEntry = { token, url: `${base}/api/workspace/references/${token}`, accountId, assetId, mimeType: input.mimeType || 'application/octet-stream', expiresAt: now + ttl, cacheFile, createdAt: now };
  const entries = readRegistry().filter((candidate) => candidate.expiresAt > now && candidate.token !== token);
  writeRegistry([...entries, entry]);
  return clone(entry);
}

export function readPublicReference(token: string): { accountId: string; assetId: string; mimeType: string; bytes: Buffer; expiresAt: number } | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  cleanupExpiredReferenceAssets();
  const entry = readRegistry().find((candidate) => candidate.token === token && candidate.expiresAt > Date.now());
  if (!entry) return null;
  let file: string;
  try { file = safeCachePath(entry.cacheFile); } catch { return null; }
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024) return null;
    return { accountId: entry.accountId, assetId: entry.assetId, mimeType: entry.mimeType, bytes: fs.readFileSync(file), expiresAt: entry.expiresAt };
  } catch { return null; }
}

export function cleanupExpiredReferenceAssets(now = Date.now()): number {
  const entries = readRegistry();
  if (!entries.length) return 0;
  let removed = 0;
  const active: RegistryEntry[] = [];
  for (const entry of entries) {
    if (entry.expiresAt > now) {
      active.push(entry);
      continue;
    }
    removed += 1;
    try { fs.rmSync(safeCachePath(entry.cacheFile), { force: true }); } catch { /* stale registry entries are harmless */ }
  }
  if (active.length !== entries.length) writeRegistry(active);
  return removed;
}

export function revokeAssetReference(token: string): boolean {
  if (!TOKEN_PATTERN.test(token)) return false;
  const entries = readRegistry();
  const target = entries.find((entry) => entry.token === token);
  if (!target) return false;
  try { fs.rmSync(safeCachePath(target.cacheFile), { force: true }); } catch { /* best effort */ }
  writeRegistry(entries.filter((entry) => entry.token !== token));
  return true;
}

/** Historical-friendly aliases used by provider adapters. */
export function publishPublicReferenceImage(accountId: string, assetId: string, ttlMs?: number): PublishedAssetReference {
  return publishAssetReference({ accountId, assetId, ttlMs, allowedKinds: ['image'] });
}

export function publishPublicReferenceVideo(accountId: string, assetId: string, ttlMs?: number): PublishedAssetReference {
  return publishAssetReference({ accountId, assetId, ttlMs, allowedKinds: ['inventory-video'] });
}

export function publishPublicReferenceAudio(accountId: string, assetId: string, ttlMs?: number): PublishedAssetReference {
  return publishAssetReference({ accountId, assetId, ttlMs, allowedKinds: ['audio'] });
}
