import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkspacePath } from '../storagePaths';
import {
  cleanupExpiredProductImages,
  getNextShanghaiMidnight,
  importProductImages,
  listProductImageAssets,
  listProductImageFolders,
  listProductImages,
  readProductImageAsset,
  readProductImageFolder,
  productSourceErrorDetail,
  queryProductGallery,
} from './productImages';

const root = `D:\\all_projects\\workspace\\data\\product-images-test-${process.pid}`;
const previousRoot = process.env.WORKSPACE_DATA_ROOT;
const previousBase = process.env.WORKSPACE_8765_BASE_URL;

beforeEach(() => {
  process.env.WORKSPACE_DATA_ROOT = root;
  process.env.WORKSPACE_8765_BASE_URL = 'http://127.0.0.1:8765';
  fs.rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.WORKSPACE_DATA_ROOT; else process.env.WORKSPACE_DATA_ROOT = previousRoot;
  if (previousBase === undefined) delete process.env.WORKSPACE_8765_BASE_URL; else process.env.WORKSPACE_8765_BASE_URL = previousBase;
});

describe('8765 product image adapter', () => {
  it('queries gallery using validated query parameters', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe('/api/v1/gallery/search');
      expect(parsed.searchParams.get('q')).toBe('shoe blue');
      expect(parsed.searchParams.get('limit')).toBe('20');
      expect(parsed.searchParams.get('offset')).toBe('2');
      return new Response(JSON.stringify({ items: [{ pid: 'P1', title: 'Shoe' }] }), { status: 200 });
    });
    await expect(queryProductGallery({ query: 'shoe blue', limit: 20, offset: 2 }, fetcher)).resolves.toEqual([{ pid: 'P1', title: 'Shoe' }]);
  });

  it('uses the current 8765 search endpoint when the legacy route is unavailable', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const parsed = new URL(String(input));
      if (parsed.pathname === '/api/v1/gallery') return new Response('{}', { status: 404 });
      expect(parsed.pathname).toBe('/api/v1/gallery/search');
      expect(parsed.searchParams.get('q')).toBe('1731106');
      return new Response(JSON.stringify({ items: [{ pid: '1731106368253625737', cover_available: true }] }), { status: 200 });
    });
    await expect(queryProductGallery({ query: '1731106' }, fetcher)).resolves.toEqual([expect.objectContaining({ pid: '1731106368253625737', coverUrl: 'http://127.0.0.1:8765/api/v1/gallery/cover/1731106368253625737' })]);
  });

  it('keeps the upstream 8765 explanation on a failed gallery read', async () => {
    // 8765 answers with HTTP 502 and names the real cause when the ZSpace
    // desktop client (and with it the local proxy 8765 depends on) is down.
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: '极空间代理请求失败: ConnectionError' }), { status: 502 }));
    const caught = await queryProductGallery({ query: '1734504276888552805' }, fetcher).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('product_source_http_502');
    expect(productSourceErrorDetail(caught)).toBe('极空间代理请求失败: ConnectionError');
  });

  it('reports a failed import without an upstream body as a bare status code', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 502 }));
    const caught = await importProductImages('account-1', ['P1'], fetcher).catch((error: unknown) => error);
    expect((caught as Error).message).toBe('product_source_http_502');
    expect(productSourceErrorDetail(caught)).toBeUndefined();
  });

  it('downloads a zip, extracts files below the D-drive PID directory and records metadata', async () => {
    const zip = createStoredZip([{ name: 'P1/001.jpg', bytes: Buffer.from('image') }]);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/check-pids')) return new Response(JSON.stringify({ valid: ['P1'] }), { status: 200 });
      expect(url).toBe('http://127.0.0.1:8765/api/v1/gallery/download-folder');
      expect(init?.method).toBe('POST');
      return new Response(zip as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/zip' } });
    });
    const imported = await importProductImages('account-1', ['P1'], fetcher, new Date('2026-09-02T08:00:00.000Z'));
    expect(imported).toHaveLength(1);
    expect(imported[0].pid).toBe('P1');
    expect(fs.readFileSync(getWorkspacePath('product-images', 'account-1', '2026-09-02', 'P1', '001.jpg'), 'utf8')).toBe('image');
    expect(listProductImages('account-1')).toHaveLength(1);
    expect(listProductImageAssets()).toEqual([expect.objectContaining({ pid: 'P1', name: 'P1 · 001.jpg', mimeType: 'image/jpeg' })]);
  });

  it('falls back to the authenticated current 8765 check/download endpoints', async () => {
    const zip = createStoredZip([{ name: 'P2/001.png', bytes: Buffer.from('image') }]);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/check-pids')) return new Response('{}', { status: 404 });
      if (url.endsWith('/session')) return new Response(JSON.stringify({ token: 'test-token' }), { status: 200 });
      if (url.endsWith('/check')) return new Response(JSON.stringify({ existing: ['P2'], missing: [] }), { status: 200 });
      if (url.endsWith('/download-folder')) return new Response('{}', { status: 404 });
      expect(url).toBe('http://127.0.0.1:8765/api/v1/gallery/download');
      expect((init?.headers as Record<string, string>)['X-Clone-Token']).toBe('test-token');
      return new Response(zip as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/zip' } });
    });
    const imported = await importProductImages('account-1', ['P2'], fetcher, new Date('2026-09-02T08:00:00.000Z'));
    expect(imported[0].files).toEqual(['001.png']);
  });

  it('rejects zip path traversal', async () => {
    const zip = createStoredZip([{ name: '../escape.txt', bytes: Buffer.from('bad') }]);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/check-pids')) return new Response(JSON.stringify({ valid: ['P1'] }), { status: 200 });
      return new Response(zip as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/zip' } });
    });
    await expect(importProductImages('account-1', ['P1'], fetcher)).rejects.toThrow('product_archive_path_invalid');
  });

  it('deletes product images on or before three days ago regardless of references', () => {
    const oldDir = getWorkspacePath('product-images', 'account-1', '2026-08-30', 'P1');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(`${oldDir}\\001.jpg`, 'old');
    fs.mkdirSync(getWorkspacePath('product-images', 'account-1', '2026-09-01', 'P2'), { recursive: true });
    expect(cleanupExpiredProductImages(new Date('2026-09-02T00:00:00+08:00'))).toMatchObject({ deletedDirectories: 1 });
    expect(fs.existsSync(oldDir)).toBe(false);
  });

  it('does not fail when an expired date directory disappears during cleanup', () => {
    const dateDir = getWorkspacePath('product-images', 'account-1', '2026-08-30');
    const oldDir = path.join(dateDir, 'P1');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, '001.jpg'), 'old');
    const originalReadDirectory = fs.readdirSync.bind(fs);
    let removed = false;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((directory: fs.PathLike, options?: unknown) => {
      const entries = originalReadDirectory(directory, options as never);
      if (!removed && path.resolve(String(directory)) === path.resolve(dateDir)) {
        removed = true;
        fs.rmSync(dateDir, { recursive: true, force: true });
      }
      return entries;
    }) as typeof fs.readdirSync);

    expect(() => cleanupExpiredProductImages(new Date('2026-09-02T00:00:00+08:00'))).not.toThrow();
    expect(removed).toBe(true);
  });

  it('supports dry-run without deleting expired product images', () => {
    const oldDir = getWorkspacePath('product-images', 'account-1', '2026-08-30', 'P1');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(`${oldDir}\\001.jpg`, 'old');
    const result = cleanupExpiredProductImages(new Date('2026-09-02T00:00:00+08:00'), { dryRun: true });
    expect(result).toMatchObject({ deletedDirectories: 1, deletedFiles: 1, dryRun: true });
    expect(fs.existsSync(oldDir)).toBe(true);
  });

  it('supports a dry-run without deleting expired directories', () => {
    const oldDir = getWorkspacePath('product-images', 'account-1', '2026-08-30', 'P1');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(`${oldDir}\\001.jpg`, 'old');
    const result = cleanupExpiredProductImages(new Date('2026-09-02T00:00:00+08:00'), { dryRun: true });
    expect(result.deletedDirectories).toBe(1);
    expect(fs.existsSync(oldDir)).toBe(true);
  });

  it('calculates next midnight in Asia/Shanghai', () => {
    const next = getNextShanghaiMidnight(new Date('2026-09-02T01:00:00+08:00'));
    expect(next.toISOString()).toBe('2026-09-02T16:00:00.000Z');
  });

  it('indexes requested assets without statting or rebuilding every image for each preview', () => {
    const directory = getWorkspacePath('product-images', 'shared', '2026-09-02', 'P1');
    fs.mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 100; index += 1) fs.writeFileSync(`${directory}\\${index}.png`, 'image');
    const stat = vi.spyOn(fs, 'statSync');
    const assetId = 'product-image:shared:2026-09-02:P1:50.png';
    expect(readProductImageAsset(assetId)).toMatchObject({ id: assetId, thumbnailUrl: expect.stringContaining('thumbnail=1&v=') });
    expect(stat.mock.calls.filter(([target]) => String(target).endsWith('50.png'))).toHaveLength(1);
    const readDirectory = vi.spyOn(fs, 'readdirSync');
    expect(readProductImageAsset(assetId)?.id).toBe(assetId);
    expect(readProductImageAsset('product-image:shared:2026-09-02:P1:missing.png')).toBeNull();
    expect(readDirectory).not.toHaveBeenCalled();
    expect(stat.mock.calls.filter(([target]) => String(target).endsWith('50.png'))).toHaveLength(1);
  });

  it('keeps account caches isolated and folder summaries free of image details', () => {
    for (const [account, pid] of [['account-1', 'P1'], ['account-2', 'P2']]) {
      const directory = getWorkspacePath('product-images', account, '2026-09-02', pid);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(`${directory}\\001.jpg`, 'image');
    }
    expect(listProductImages('account-1').map((record) => record.pid)).toEqual(['P1']);
    expect(listProductImageAssets('account-1').map((asset) => asset.pid)).toEqual(['P1']);
    expect(listProductImageAssets().map((asset) => asset.pid)).toEqual(['P1', 'P2']);
    const summaries = listProductImageFolders('account-1');
    expect(summaries.map((folder) => folder.pid)).toEqual(['P1']);
    expect(summaries[0].images).toBeUndefined();
    expect(summaries[0].coverUrl).toContain('thumbnail=1&v=');
    expect(listProductImageFolders().map((folder) => folder.pid)).toEqual(['P1', 'P2']);
    expect(listProductImageFolders('account-2').map((folder) => folder.pid)).toEqual(['P2']);
    expect(readProductImageFolder(undefined, 'P2')?.images).toHaveLength(1);
    expect(listProductImageFolders('account-1', { includeImages: true })[0].images).toHaveLength(1);
    expect(listProductImageFolders('account-1')[0].images).toBeUndefined();
  });

  it('invalidates the asset index for imports, cleanup, and data-root changes', async () => {
    const directory = getWorkspacePath('product-images', 'account-1', '2026-09-02', 'P1');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(`${directory}\\001.jpg`, 'old');
    const assetId = 'product-image:account-1:2026-09-02:P1:001.jpg';
    const old = readProductImageAsset(assetId);
    const zip = createStoredZip([{ name: 'P1/001.jpg', bytes: Buffer.from('new image') }]);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/check-pids')
      ? new Response(JSON.stringify({ valid: ['P1'] }), { status: 200 })
      : new Response(zip as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/zip' } }));
    await importProductImages('account-1', ['P1'], fetcher, new Date('2026-09-02T08:00:00.000Z'));
    expect(readProductImageAsset(assetId)?.size).toBe(9);
    expect(readProductImageAsset(assetId)?.version).not.toBe(old?.version);
    process.env.WORKSPACE_DATA_ROOT = `${root}\\alternate`;
    expect(readProductImageAsset(assetId)).toBeNull();
    process.env.WORKSPACE_DATA_ROOT = root;
    expect(readProductImageAsset(assetId)).not.toBeNull();
    cleanupExpiredProductImages(new Date('2026-09-06T00:00:00+08:00'));
    expect(readProductImageAsset(assetId)).toBeNull();
  });

  it('refreshes a separate worker cache after an import inside an existing account and date', async () => {
    vi.resetModules();
    const web = await import('./productImages');
    const importedAt = new Date('2026-09-02T08:00:00.000Z');
    await web.importProductImages('account-1', ['P1'], archiveFetcher([{ name: 'P1/001.jpg', bytes: Buffer.from('old') }]), importedAt);
    const imageRoot = getWorkspacePath('product-images');
    const fixedMtime = new Date('2026-09-02T00:00:00.000Z');
    fs.utimesSync(imageRoot, fixedMtime, fixedMtime);
    expect(listProductImageFolders().map((folder) => folder.pid)).toEqual(['P1']);
    expect(readProductImageAsset('product-image:account-1:2026-09-02:P2:001.jpg')).toBeNull();

    await web.importProductImages('account-1', ['P2'], archiveFetcher([{ name: 'P2/001.jpg', bytes: Buffer.from('new') }]), importedAt);
    fs.utimesSync(imageRoot, fixedMtime, fixedMtime);

    expect(listProductImageFolders().map((folder) => folder.pid)).toEqual(['P1', 'P2']);
    expect(readProductImageFolder(undefined, 'P2')?.images).toHaveLength(1);
    expect(readProductImageAsset('product-image:account-1:2026-09-02:P2:001.jpg')).toMatchObject({ size: 3 });
    const readDirectory = vi.spyOn(fs, 'readdirSync');
    expect(readProductImageAsset('product-image:account-1:2026-09-02:P2:001.jpg')).not.toBeNull();
    expect(listProductImageFolders()).toHaveLength(2);
    expect(readDirectory).not.toHaveBeenCalled();
  });

  it('refreshes a separate worker cache after cleanup without invalidating it on a dry run', async () => {
    vi.resetModules();
    const web = await import('./productImages');
    await web.importProductImages('account-1', ['P1'], archiveFetcher([{ name: 'P1/001.jpg', bytes: Buffer.from('expired') }]), new Date('2026-08-30T08:00:00.000Z'));
    await web.importProductImages('account-1', ['P2'], archiveFetcher([{ name: 'P2/001.jpg', bytes: Buffer.from('current') }]), new Date('2026-09-02T08:00:00.000Z'));
    const imageRoot = getWorkspacePath('product-images');
    const fixedMtime = new Date('2026-09-02T00:00:00.000Z');
    fs.utimesSync(imageRoot, fixedMtime, fixedMtime);
    expect(listProductImageFolders()).toHaveLength(2);
    const expiredAssetId = 'product-image:account-1:2026-08-30:P1:001.jpg';
    expect(readProductImageAsset(expiredAssetId)).not.toBeNull();
    const revision = fs.readFileSync(`${imageRoot}\\.revision`, 'utf8');

    web.cleanupExpiredProductImages(new Date('2026-09-02T00:00:00+08:00'), { dryRun: true });
    expect(fs.readFileSync(`${imageRoot}\\.revision`, 'utf8')).toBe(revision);
    expect(readProductImageAsset(expiredAssetId)).not.toBeNull();
    web.cleanupExpiredProductImages(new Date('2026-09-02T00:00:00+08:00'));
    fs.utimesSync(imageRoot, fixedMtime, fixedMtime);

    expect(readProductImageAsset(expiredAssetId)).toBeNull();
    expect(readProductImageFolder(undefined, 'P1')).toBeNull();
    expect(listProductImageFolders().map((folder) => folder.pid)).toEqual(['P2']);
  });

  it('publishes partial import changes and failed-folder cleanup to a separate worker cache', async () => {
    vi.resetModules();
    const web = await import('./productImages');
    const importedAt = new Date('2026-09-02T08:00:00.000Z');
    await web.importProductImages('account-1', ['P1'], archiveFetcher([{ name: 'P1/001.jpg', bytes: Buffer.from('old') }]), importedAt);
    const imageRoot = getWorkspacePath('product-images');
    const fixedMtime = new Date('2026-09-02T00:00:00.000Z');
    fs.utimesSync(imageRoot, fixedMtime, fixedMtime);
    const oldAssetId = 'product-image:account-1:2026-09-02:P1:001.jpg';
    expect(readProductImageAsset(oldAssetId)).not.toBeNull();
    expect(listProductImageFolders().map((folder) => folder.pid)).toEqual(['P1']);

    await expect(web.importProductImages('account-1', ['P2', 'P1'], archiveFetcher([{ name: 'P2/001.jpg', bytes: Buffer.from('new') }]), importedAt)).rejects.toThrow('product_archive_no_images');
    fs.utimesSync(imageRoot, fixedMtime, fixedMtime);

    expect(readProductImageAsset(oldAssetId)).toBeNull();
    expect(readProductImageAsset('product-image:account-1:2026-09-02:P2:001.jpg')).not.toBeNull();
    expect(listProductImageFolders().map((folder) => folder.pid)).toEqual(['P2']);
  });
});

function archiveFetcher(entries: Array<{ name: string; bytes: Buffer }>): typeof fetch {
  const zip = createStoredZip(entries);
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/check-pids')
    ? new Response(JSON.stringify({ valid: JSON.parse(String(init?.body)).pids }), { status: 200 })
    : new Response(zip as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/zip' } }));
}

function createStoredZip(entries: Array<{ name: string; bytes: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14); local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    chunks.push(local, entry.bytes);
    const c = Buffer.alloc(46 + name.length); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt32LE(0, 20); c.writeUInt32LE(entry.bytes.length, 20); c.writeUInt32LE(entry.bytes.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42); name.copy(c, 46); central.push(c); offset += local.length + entry.bytes.length;
  }
  const cd = Buffer.concat(central); const body = Buffer.concat(chunks); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(body.length, 16); return Buffer.concat([body, cd, e]);
}
