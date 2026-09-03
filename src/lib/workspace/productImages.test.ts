import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkspacePath } from '../storagePaths';
import {
  cleanupExpiredProductImages,
  getNextShanghaiMidnight,
  importProductImages,
  listProductImageAssets,
  listProductImages,
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
  fs.rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.WORKSPACE_DATA_ROOT; else process.env.WORKSPACE_DATA_ROOT = previousRoot;
  if (previousBase === undefined) delete process.env.WORKSPACE_8765_BASE_URL; else process.env.WORKSPACE_8765_BASE_URL = previousBase;
});

describe('8765 product image adapter', () => {
  it('queries gallery using validated query parameters', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe('/api/v1/gallery');
      expect(parsed.searchParams.get('query')).toBe('shoe blue');
      expect(parsed.searchParams.get('limit')).toBe('20');
      expect(parsed.searchParams.get('offset')).toBe('2');
      return new Response(JSON.stringify({ items: [{ pid: 'P1', title: 'Shoe' }] }), { status: 200 });
    });
    await expect(queryProductGallery({ query: 'shoe blue', limit: 20, offset: 2 }, fetcher)).resolves.toEqual([{ pid: 'P1', title: 'Shoe' }]);
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
});

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
