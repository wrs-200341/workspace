import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireApiRole, mockCanAccessWorkspaceAccount, mockGetProviderTask, mockGetStoredVideoOutputFileInfo, mockCacheVideoTaskOutputLocally, mockIsVideoOutputIntentionallyDeleted, mockGetAssetFileInfo } = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockCanAccessWorkspaceAccount: vi.fn(),
  mockGetProviderTask: vi.fn(),
  mockGetStoredVideoOutputFileInfo: vi.fn(),
  mockCacheVideoTaskOutputLocally: vi.fn(),
  mockIsVideoOutputIntentionallyDeleted: vi.fn(),
  mockGetAssetFileInfo: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/access', () => ({ canAccessWorkspaceAccount: mockCanAccessWorkspaceAccount }));
vi.mock('@/lib/providers/taskStore', () => ({ getProviderTask: mockGetProviderTask }));
vi.mock('@/lib/providers/outputStore', () => ({ getStoredVideoOutputFileInfo: mockGetStoredVideoOutputFileInfo }));
vi.mock('@/lib/workspace/videoInventory', () => ({ cacheVideoTaskOutputLocally: mockCacheVideoTaskOutputLocally, isVideoOutputIntentionallyDeleted: mockIsVideoOutputIntentionallyDeleted }));
vi.mock('@/lib/workspace/assetStore', () => ({ getAssetFileInfo: mockGetAssetFileInfo }));

import { GET } from './route';

const task = {
  id: 'video-task-1', accountId: 'account-1', mode: 'video', provider: 'wan3-video', providerTaskId: 'wan-task-1',
  status: 'completed', progress: 100, outputUrls: ['https://media.manjuai.top/videos/a.mp4', 'https://media.manjuai.top/downloads/a.mp4'], outputBase64: [],
};
const params = { params: Promise.resolve({ id: 'account-1', taskId: 'video-task-1', index: '0' }) };
const testFilePath = `${process.env.TEMP || process.env.TMP || 'D:/workspace/data'}/workspace-video-route-${process.pid}.mp4`;
const cachedInfo = { index: 0, relativePath: 'generated/account-1/video-task-1/0.mp4', filePath: testFilePath, mimeType: 'video/mp4', size: 8 };

describe('video output proxy API', () => {
  afterAll(() => { fs.rmSync(testFilePath, { force: true }); });
  beforeEach(() => {
    mockRequireApiRole.mockReset().mockResolvedValue({ role: 'operator', username: 'operator' });
    mockCanAccessWorkspaceAccount.mockReset().mockReturnValue(true);
    mockGetProviderTask.mockReset().mockReturnValue({ ...task });
    fs.writeFileSync(testFilePath, Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]));
    mockGetStoredVideoOutputFileInfo.mockReset().mockReturnValue(cachedInfo);
    mockCacheVideoTaskOutputLocally.mockReset();
    mockIsVideoOutputIntentionallyDeleted.mockReset().mockReturnValue(false);
    mockGetAssetFileInfo.mockReset().mockReturnValue(null);
  });

  it('serves the cached local video and exposes an attachment filename', async () => {
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/video-tasks/video-task-1/outputs/0?download=1'), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(mockCacheVideoTaskOutputLocally).not.toHaveBeenCalled();
  });

  it('serves suffix byte ranges from the end of a cached video', async () => {
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/video-tasks/video-task-1/outputs/0', { headers: { range: 'bytes=-4' } }), params);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 4-7/8');
    expect(response.headers.get('content-length')).toBe('4');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x66, 0x74, 0x79, 0x70]));
  });

  it('caches a remote output before serving a browser request', async () => {
    mockGetStoredVideoOutputFileInfo.mockReturnValueOnce(null).mockReturnValue(cachedInfo);
    mockCacheVideoTaskOutputLocally.mockResolvedValue(1);
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/video-tasks/video-task-1/outputs/0'), params);
    expect(response.status).toBe(200);
    expect(mockCacheVideoTaskOutputLocally).toHaveBeenCalledWith('account-1', expect.objectContaining({ id: 'video-task-1' }), 0);
  });

  it('checks authorization before reading a task', async () => {
    mockRequireApiRole.mockResolvedValue(NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 }));
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/video-tasks/video-task-1/outputs/0'), params);
    expect(response.status).toBe(403);
    expect(mockGetProviderTask).not.toHaveBeenCalled();
  });

  it('serves an inventory video when the generated cache file is missing', async () => {
    mockGetStoredVideoOutputFileInfo.mockReturnValue(null);
    mockGetProviderTask.mockReturnValue({ ...task, outputUrls: ['/api/workspace/accounts/account-1/video-tasks/video-task-1/outputs/0'], metadata: { inventoryAssetIds: ['asset-video-1'] } });
    mockGetAssetFileInfo.mockReturnValue({ asset: { id: 'asset-video-1', accountId: 'account-1', kind: 'inventory-video', mimeType: 'video/mp4' }, filePath: testFilePath, size: 8 });
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/video-tasks/video-task-1/outputs/0'), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
  });

  it('does not recreate an inventory video that an operator permanently deleted', async () => {
    mockIsVideoOutputIntentionallyDeleted.mockReturnValue(true);
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/video-tasks/video-task-1/outputs/0'), params);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ success: false, error: 'output_deleted' });
    expect(mockGetStoredVideoOutputFileInfo).not.toHaveBeenCalled();
    expect(mockCacheVideoTaskOutputLocally).not.toHaveBeenCalled();
  });
});
