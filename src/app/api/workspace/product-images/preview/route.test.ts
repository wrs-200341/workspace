import fs from 'node:fs';
import sharp from 'sharp';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { requireApiRole, canAccessWorkspaceAccount } = vi.hoisted(() => ({ requireApiRole: vi.fn(), canAccessWorkspaceAccount: vi.fn() }));
vi.mock('@/lib/auth/server', () => ({ requireApiRole }));
vi.mock('@/lib/workspace/access', () => ({ canAccessWorkspaceAccount }));

import { GET } from './route';
import { getWorkspacePath } from '@/lib/storagePaths';
import { readProductImageAsset } from '@/lib/workspace/productImages';

const root = `D:\\all_projects\\workspace\\data\\product-image-preview-test-${process.pid}`;
const previousRoot = process.env.WORKSPACE_DATA_ROOT;
const assetId = 'product-image:account-1:2026-09-02:P1:source.png';
let sourcePath: string;

function request(params: Record<string, string> = {}, headers?: HeadersInit): NextRequest {
  return new NextRequest(`http://localhost/api/workspace/product-images/preview?${new URLSearchParams({ assetId, ...params })}`, { headers });
}

beforeEach(async () => {
  process.env.WORKSPACE_DATA_ROOT = root;
  fs.rmSync(root, { recursive: true, force: true });
  const folder = getWorkspacePath('product-images', 'account-1', '2026-09-02', 'P1');
  fs.mkdirSync(folder, { recursive: true });
  sourcePath = getWorkspacePath('product-images', 'account-1', '2026-09-02', 'P1', 'source.png');
  await sharp({ create: { width: 1200, height: 600, channels: 3, background: '#25753b' } }).png().toFile(sourcePath);
  requireApiRole.mockReset().mockResolvedValue({ id: 'user-1', role: 'operator' });
  canAccessWorkspaceAccount.mockReset().mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.WORKSPACE_DATA_ROOT; else process.env.WORKSPACE_DATA_ROOT = previousRoot;
});

describe('product image preview API', () => {
  it('streams exact original bytes by default without synchronous file reads', async () => {
    const expected = fs.readFileSync(sourcePath);
    readProductImageAsset(assetId);
    const read = vi.spyOn(fs, 'readFileSync');
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe(String(expected.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
    expect(read).not.toHaveBeenCalled();
  });

  it('returns bounded, uncropped thumbnails with versioned private caching', async () => {
    const asset = readProductImageAsset(assetId)!;
    const response = await GET(request({ thumbnail: '1', v: asset.version! }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(await sharp(Buffer.from(await response.arrayBuffer())).metadata()).toMatchObject({ width: 480, height: 240 });
    expect(await sharp(sourcePath).metadata()).toMatchObject({ width: 1200, height: 600 });
    const etag = response.headers.get('etag')!;
    const unchanged = await GET(request({ thumbnail: '1', v: asset.version! }, { 'if-none-match': etag }));
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
  });

  it('does not mark an obsolete version URL immutable', async () => {
    const response = await GET(request({ thumbnail: '1', v: 'old-version' }));
    expect(response.headers.get('cache-control')).not.toContain('immutable');
    await response.arrayBuffer();
  });

  it('streams browser-readable BMP originals when the resize decoder does not support them', async () => {
    const bmp = Buffer.alloc(58);
    bmp.write('BM');
    bmp.writeUInt32LE(58, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(1, 18);
    bmp.writeInt32LE(1, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    bmp.writeUInt32LE(4, 34);
    bmp[54] = 255;
    const bmpPath = getWorkspacePath('product-images', 'account-1', '2026-09-02', 'P1', 'source.bmp');
    fs.writeFileSync(bmpPath, bmp);
    const bmpId = 'product-image:account-1:2026-09-02:P1:source.bmp';
    const asset = readProductImageAsset(bmpId)!;
    const response = await GET(request({ assetId: bmpId, thumbnail: '1', v: asset.version! }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/bmp');
    expect(response.headers.get('content-length')).toBe(String(bmp.length));
    expect(response.headers.get('etag')).toContain('original-');
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bmp);
    expect(fs.readFileSync(bmpPath)).toEqual(bmp);
  });

  it('keeps authentication and account authorization ahead of cached responses', async () => {
    const cached = await GET(request({ thumbnail: '1' }));
    await cached.arrayBuffer();
    canAccessWorkspaceAccount.mockReturnValue(false);
    const forbidden = await GET(request({ thumbnail: '1' }, { 'if-none-match': cached.headers.get('etag')! }));
    expect(forbidden.status).toBe(403);
    requireApiRole.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await GET(request({ thumbnail: '1' }))).status).toBe(401);
  });

  it('rejects unknown IDs and missing originals even when a derivative exists', async () => {
    expect((await GET(request({ assetId: '../outside.png' }))).status).toBe(404);
    expect((await GET(request({ assetId: '' }))).status).toBe(400);
    const cached = await GET(request({ thumbnail: '1' }));
    await cached.arrayBuffer();
    fs.unlinkSync(sourcePath);
    expect((await GET(request({ thumbnail: '1' }))).status).toBe(404);
  });
});
