import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireApiRole,
  mockCanAccessWorkspaceAccount,
  mockGetAsset,
  mockGetAssetFileInfo,
  mockRenameAsset,
  mockDeleteAsset,
  mockReadAssetFile,
} = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockCanAccessWorkspaceAccount: vi.fn(),
  mockGetAsset: vi.fn(),
  mockGetAssetFileInfo: vi.fn(),
  mockRenameAsset: vi.fn(),
  mockDeleteAsset: vi.fn(),
  mockReadAssetFile: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/access', () => ({ canAccessWorkspaceAccount: mockCanAccessWorkspaceAccount }));
vi.mock('@/lib/workspace/assetStore', () => ({
  getAsset: mockGetAsset,
  getAssetFileInfo: mockGetAssetFileInfo,
  renameAsset: mockRenameAsset,
  deleteAsset: mockDeleteAsset,
  readAssetFile: mockReadAssetFile,
}));

import { DELETE, GET, PATCH } from './route';

const params = { params: Promise.resolve({ id: 'account-1', assetId: 'asset-123' }) };
const testFilePath = `${process.env.TEMP || process.env.TMP || 'D:/workspace/data'}/workspace-asset-route-${process.pid}.bin`;
const imageAsset = {
  id: 'asset-123',
  accountId: 'account-1',
  kind: 'image' as const,
  name: 'hero.png',
  relativePath: 'uploads/account-1/asset-123-hero.png',
  mimeType: 'image/png',
  size: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('workspace asset item API', () => {
  afterAll(() => { fs.rmSync(testFilePath, { force: true }); });
  beforeEach(() => {
    mockRequireApiRole.mockReset().mockResolvedValue({ id: 'user-emily', role: 'operator', username: 'emily' });
    mockCanAccessWorkspaceAccount.mockReset().mockReturnValue(true);
    mockGetAsset.mockReset().mockReturnValue(imageAsset);
    mockRenameAsset.mockReset().mockReturnValue({ ...imageAsset, name: 'renamed.png' });
    mockDeleteAsset.mockReset().mockReturnValue(imageAsset);
    mockReadAssetFile.mockReset().mockReturnValue({ asset: imageAsset, filePath: 'D:/workspace/data/uploads/account-1/asset-123-hero.png', bytes: Buffer.from([1, 2, 3]) });
    fs.writeFileSync(testFilePath, Buffer.from([1, 2, 3]));
    mockGetAssetFileInfo.mockReset().mockReturnValue({ asset: imageAsset, filePath: testFilePath, size: 3 });
  });

  it('serves a binary asset inline by default and as an attachment when requested', async () => {
    const inline = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/files/asset-123'), params);
    expect(inline.status).toBe(200);
    expect(inline.headers.get('content-type')).toBe('image/png');
    expect(inline.headers.get('content-disposition')).toContain('inline');
    expect(new Uint8Array(await inline.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const download = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/files/asset-123?download=1'), params);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('attachment');
  });

  it('serves byte ranges for media previews and seeking', async () => {
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/files/asset-123', { headers: { range: 'bytes=0-1' } }), params);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-1/3');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  it('returns prompt content as JSON instead of trying to read a file', async () => {
    const prompt = { ...imageAsset, kind: 'prompt' as const, content: 'Write a concise hook.' };
    mockGetAsset.mockReturnValue(prompt);
    mockReadAssetFile.mockReturnValue(null);
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/files/asset-123'), params);

    expect(response.status).toBe(200);
    expect((await response.json()).data.asset).toEqual(prompt);
    expect(mockReadAssetFile).not.toHaveBeenCalled();
  });

  it('renames an asset after validating the account scope and name', async () => {
    const response = await PATCH(new NextRequest('http://localhost/api/workspace/accounts/account-1/files/asset-123', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed.png' }),
    }), params);

    expect(response.status).toBe(200);
    expect(mockRequireApiRole).toHaveBeenCalledWith(expect.arrayContaining(['operator']));
    expect(mockRenameAsset).toHaveBeenCalledWith('account-1', 'asset-123', 'renamed.png');
    expect((await response.json()).data.name).toBe('renamed.png');
  });

  it('deletes an asset and reports a missing asset as 404', async () => {
    const response = await DELETE(new NextRequest('http://localhost/api/workspace/accounts/account-1/files/asset-123', { method: 'DELETE' }), params);
    expect(response.status).toBe(200);
    expect(mockRequireApiRole).toHaveBeenCalledWith(expect.arrayContaining(['operator']));
    expect(mockDeleteAsset).toHaveBeenCalledWith('account-1', 'asset-123');

    mockDeleteAsset.mockReturnValue(null);
    const missing = await DELETE(new NextRequest('http://localhost/api/workspace/accounts/account-1/files/asset-123', { method: 'DELETE' }), params);
    expect(missing.status).toBe(404);
  });

  it('stops before reading or mutating assets when the account is forbidden', async () => {
    mockCanAccessWorkspaceAccount.mockReturnValue(false);
    const forbidden = await PATCH(new NextRequest('http://localhost/api/workspace/accounts/account-1/files/asset-123', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    }), params);

    expect(forbidden.status).toBe(403);
    expect(mockRenameAsset).not.toHaveBeenCalled();
    expect(mockReadAssetFile).not.toHaveBeenCalled();
  });

  it('propagates an unauthorised response before checking account access', async () => {
    mockRequireApiRole.mockResolvedValue(NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 }));
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/files/asset-123'), params);

    expect(response.status).toBe(403);
    expect(mockCanAccessWorkspaceAccount).not.toHaveBeenCalled();
    expect(mockReadAssetFile).not.toHaveBeenCalled();
  });

  it('maps malformed asset identifiers to a client error instead of throwing', async () => {
    mockGetAsset.mockImplementation((_accountId: string, assetId: string) => {
      if (assetId.includes('..')) throw new Error('asset_id_invalid');
      return imageAsset;
    });
    const malformedParams = { params: Promise.resolve({ id: 'account-1', assetId: '../escape' }) };
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/files/%2E%2E%2Fescape'), malformedParams);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'asset_id_invalid' });
    expect(mockReadAssetFile).not.toHaveBeenCalled();
  });
});
