import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireApiRole, mockCanAccessWorkspaceAccount, mockGetProviderTask, mockReadStoredVideoOutput, mockCacheVideoTaskOutputLocally } = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockCanAccessWorkspaceAccount: vi.fn(),
  mockGetProviderTask: vi.fn(),
  mockReadStoredVideoOutput: vi.fn(),
  mockCacheVideoTaskOutputLocally: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/access', () => ({ canAccessWorkspaceAccount: mockCanAccessWorkspaceAccount }));
vi.mock('@/lib/providers/taskStore', () => ({ getProviderTask: mockGetProviderTask }));
vi.mock('@/lib/providers/outputStore', () => ({ readStoredVideoOutput: mockReadStoredVideoOutput }));
vi.mock('@/lib/workspace/videoInventory', () => ({ cacheVideoTaskOutputLocally: mockCacheVideoTaskOutputLocally }));

import { GET } from './route';

const task = {
  id: 'video-task-1', accountId: 'account-1', mode: 'video', provider: 'wan3-video', providerTaskId: 'wan-task-1',
  status: 'completed', progress: 100, outputUrls: ['https://media.manjuai.top/videos/a.mp4', 'https://media.manjuai.top/downloads/a.mp4'], outputBase64: [],
};
const params = { params: Promise.resolve({ id: 'account-1', taskId: 'video-task-1', index: '0' }) };

describe('video output proxy API', () => {
  beforeEach(() => {
    mockRequireApiRole.mockReset().mockResolvedValue({ role: 'operator', username: 'operator' });
    mockCanAccessWorkspaceAccount.mockReset().mockReturnValue(true);
    mockGetProviderTask.mockReset().mockReturnValue({ ...task });
    mockReadStoredVideoOutput.mockReset().mockReturnValue({ bytes: Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), mimeType: 'video/mp4' });
    mockCacheVideoTaskOutputLocally.mockReset();
  });

  it('serves the cached local video and exposes an attachment filename', async () => {
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/video-tasks/video-task-1/outputs/0?download=1'), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(mockCacheVideoTaskOutputLocally).not.toHaveBeenCalled();
  });

  it('caches a remote output before serving a browser request', async () => {
    const cached = { bytes: Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), mimeType: 'video/mp4' };
    mockReadStoredVideoOutput.mockReturnValueOnce(null).mockReturnValue(cached);
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
});
