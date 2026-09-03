import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkspacePath } from '../storagePaths';
import { listAssets } from './assetStore';
import { importExternalImageAsset, normalizeExternalImageUrl } from './externalImageImport';

const root = `D:\\all_projects\\workspace\\data\\external-image-import-test-${process.pid}`;
const previous = process.env.WORKSPACE_DATA_ROOT;

beforeEach(() => {
  process.env.WORKSPACE_DATA_ROOT = root;
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  if (previous === undefined) delete process.env.WORKSPACE_DATA_ROOT;
  else process.env.WORKSPACE_DATA_ROOT = previous;
});

const publicLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

describe('external image import', () => {
  it('normalizes duplicate leading question marks without dropping WeChat query parameters', () => {
    const source = 'https://szfilehelper.weixin.qq.com/cgi-bin/mmwebwx-bin/webwxgetmsgimg??&MsgID=123&skey=secret&type=slave&mmweb_appid=wx_webfilehelper';
    const normalized = normalizeExternalImageUrl(source);
    expect(normalized).toBe('https://szfilehelper.weixin.qq.com/cgi-bin/mmwebwx-bin/webwxgetmsgimg?&MsgID=123&skey=secret&type=slave&mmweb_appid=wx_webfilehelper');
    expect(new URL(normalized).searchParams.get('MsgID')).toBe('123');
    expect(new URL(normalized).searchParams.get('skey')).toBe('secret');
  });

  it('downloads and stores a validated image below the D-drive data root', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('MsgID=123');
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) } });
    });
    const asset = await importExternalImageAsset('account-1', 'https://szfilehelper.weixin.qq.com/cgi-bin/mmwebwx-bin/webwxgetmsgimg??&MsgID=123&skey=secret', { fetcher, lookup: publicLookup });
    expect(asset.kind).toBe('image');
    expect(asset.mimeType).toBe('image/png');
    expect(asset.name).toMatch(/\.png$/);
    expect(asset.relativePath?.startsWith('uploads/account-1/')).toBe(true);
    expect(fs.existsSync(getWorkspacePath(asset.relativePath!))).toBe(true);
    expect(listAssets('account-1', 'image')).toEqual([asset]);
  });

  it('follows only validated public redirects', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn.example/image.jpg' } }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const asset = await importExternalImageAsset('account-1', 'https://source.example/image', { fetcher, lookup: publicLookup });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(asset.mimeType).toBe('image/jpeg');
  });

  it('rejects private targets, HTML responses, and over-large payload declarations', async () => {
    await expect(importExternalImageAsset('account-1', 'https://127.0.0.1/image.png', { fetcher: vi.fn(), lookup: publicLookup })).rejects.toThrow('image_url_target_blocked');
    await expect(importExternalImageAsset('account-1', 'https://example.com/login', { fetcher: vi.fn(async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } })), lookup: publicLookup })).rejects.toThrow('external_asset_auth_required');
    await expect(importExternalImageAsset('account-1', 'https://example.com/large', { fetcher: vi.fn(async () => new Response(null, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(101 * 1024 * 1024) } })), lookup: publicLookup })).rejects.toThrow('image_file_too_large');
  });
});
