import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireApiRole, mockCanAccessWorkspaceAccount, mockGetProviderTask, mockReadStoredOutput } = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockCanAccessWorkspaceAccount: vi.fn(),
  mockGetProviderTask: vi.fn(),
  mockReadStoredOutput: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/access', () => ({ canAccessWorkspaceAccount: mockCanAccessWorkspaceAccount }));
vi.mock('@/lib/providers/taskStore', () => ({ getProviderTask: mockGetProviderTask }));
vi.mock('@/lib/providers/outputStore', () => ({ readStoredOutput: mockReadStoredOutput, storeImageOutput: vi.fn() }));

import { GET } from './route';

const task = {
  id: 'image-task-1', accountId: 'account-1', mode: 'image', provider: 'mgrouter-grok-image',
  model: 'grok-image', prompt: 'product', status: 'completed', progress: 100,
  outputUrls: ['https://93.184.216.34/output.png'], outputBase64: [], metadata: {},
  createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
};
const params = { params: Promise.resolve({ id: 'account-1', taskId: 'image-task-1', index: '0' }) };

describe('image output proxy API', () => {
  beforeEach(() => {
    mockRequireApiRole.mockReset().mockResolvedValue({ role: 'operator', username: 'operator' });
    mockCanAccessWorkspaceAccount.mockReset().mockReturnValue(true);
    mockGetProviderTask.mockReset().mockReturnValue({ ...task });
    mockReadStoredOutput.mockReset().mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn());
  });

  it('serves a locally stored image without contacting the remote URL', async () => {
    mockReadStoredOutput.mockReturnValue({ bytes: Buffer.from('png-bytes'), mimeType: 'image/png' });
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/image-tasks/image-task-1/outputs/0'), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(await response.arrayBuffer()).toEqual(Uint8Array.from(Buffer.from('png-bytes')).buffer);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('marks an image as an attachment when the download query is present', async () => {
    mockReadStoredOutput.mockReturnValue({ bytes: Buffer.from('png-bytes'), mimeType: 'image/png' });
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/image-tasks/image-task-1/outputs/0?download=1'), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
  });

  it('proxies a remote image URL through the same-origin route', async () => {
    const remote = vi.mocked(fetch);
    const pngHeader = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    remote.mockResolvedValue(new Response(pngHeader, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(pngHeader.byteLength) },
    }));
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/image-tasks/image-task-1/outputs/0'), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toContain('inline');
    expect(await response.arrayBuffer()).toEqual(pngHeader.buffer);
    expect(remote).toHaveBeenCalledWith('https://93.184.216.34/output.png', expect.objectContaining({ redirect: 'error' }));
  });

  it('rejects a remote response that is not an image', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('not image', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/image-tasks/image-task-1/outputs/0'), params);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ success: false, error: 'image_output_invalid' });
  });

  it('rejects a declared image MIME that does not match the file bytes', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/image-tasks/image-task-1/outputs/0'), params);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ success: false, error: 'image_output_invalid' });
  });

  it('reports a missing local proxy file without treating it as a remote URL error', async () => {
    mockGetProviderTask.mockReturnValue({ ...task, outputUrls: ['/api/workspace/accounts/account-1/image-tasks/image-task-1/outputs/0'] });
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/image-tasks/image-task-1/outputs/0'), params);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: 'output_unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks private and loopback image targets before fetching', async () => {
    mockGetProviderTask.mockReturnValue({ ...task, outputUrls: ['https://127.0.0.1/private.png'] });
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/image-tasks/image-task-1/outputs/0'), params);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ success: false, error: 'image_output_target_blocked' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks authorization before resolving task output', async () => {
    mockRequireApiRole.mockResolvedValue(NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 }));
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts/account-1/image-tasks/image-task-1/outputs/0'), params);
    expect(response.status).toBe(403);
    expect(mockGetProviderTask).not.toHaveBeenCalled();
  });
});
