import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireApiRole, mockCanAccessWorkspaceAccount, mockGetProviderTask, mockUpdateProviderTask } = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockCanAccessWorkspaceAccount: vi.fn(),
  mockGetProviderTask: vi.fn(),
  mockUpdateProviderTask: vi.fn(),
}));
vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/access', () => ({ canAccessWorkspaceAccount: mockCanAccessWorkspaceAccount }));
vi.mock('@/lib/providers/taskStore', () => ({ getProviderTask: mockGetProviderTask, updateProviderTask: mockUpdateProviderTask }));
vi.mock('@/lib/workspace/taskActions', () => ({ applyTaskAction: vi.fn((task, action) => action === 'retry' ? { ...task, status: 'queued', progress: 0 } : task) }));
import { GET, POST } from './route';

const params = { params: Promise.resolve({ id: 'account-1', taskId: 'prompt-1' }) };
const request = new NextRequest('http://localhost/api/workspace/accounts/account-1/prompt-tasks/prompt-1');

describe('prompt task detail API', () => {
  beforeEach(() => {
    mockRequireApiRole.mockResolvedValue({ role: 'admin', username: 'admin' });
    mockCanAccessWorkspaceAccount.mockReturnValue(true);
    mockGetProviderTask.mockReset();
    mockUpdateProviderTask.mockReset();
    mockGetProviderTask.mockReturnValue({ id: 'prompt-1', accountId: 'account-1', mode: 'prompt', provider: 'yuanai-gemini-prompt', status: 'completed', progress: 100, outputUrls: [], outputBase64: [], prompt: '商品标题', metadata: { childPrompt: 'child', finalPrompt: 'final' } });
    mockUpdateProviderTask.mockReturnValue({ id: 'prompt-1', status: 'queued', progress: 0 });
  });
  it('returns prompt details for the owning account', async () => {
    const response = await GET(request, params);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.metadata.finalPrompt).toBe('final');
  });
  it('enforces auth before reading task', async () => {
    mockRequireApiRole.mockResolvedValue(NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 }));
    const response = await GET(request, params);
    expect(response.status).toBe(403);
    expect(mockGetProviderTask).not.toHaveBeenCalled();
  });
  it('supports retry action', async () => {
    const response = await POST(new NextRequest(request, { method: 'POST', body: JSON.stringify({ action: 'retry' }), headers: { 'content-type': 'application/json' } }), params);
    expect(response.status).toBe(200);
    expect(mockUpdateProviderTask).toHaveBeenCalledWith('prompt-1', expect.objectContaining({ status: 'queued', progress: 0 }));
  });
});
