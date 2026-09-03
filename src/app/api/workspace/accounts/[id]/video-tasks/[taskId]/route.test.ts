import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireApiRole, mockCanAccessWorkspaceAccount, mockGetProviderTask, mockDeleteProviderTask } = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockCanAccessWorkspaceAccount: vi.fn(),
  mockGetProviderTask: vi.fn(),
  mockDeleteProviderTask: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/access', () => ({ canAccessWorkspaceAccount: mockCanAccessWorkspaceAccount }));
vi.mock('@/lib/providers/taskStore', () => ({
  getProviderTask: mockGetProviderTask,
  deleteProviderTask: mockDeleteProviderTask,
  updateProviderTask: vi.fn(),
}));
vi.mock('@/lib/providers/config', () => ({ isProviderLiveEnabled: () => false }));
vi.mock('@/lib/providers/client', () => ({ syncProviderTask: vi.fn() }));
vi.mock('@/lib/workspace/serverTasks', () => ({ getServerWorkspaceTasks: vi.fn(() => []) }));
vi.mock('@/lib/workspace/taskActions', () => ({ applyTaskAction: vi.fn(), }));

import { DELETE } from './route';

const request = new NextRequest('http://localhost/api/workspace/accounts/account-1/video-tasks/task-1');
const params = { params: Promise.resolve({ id: 'account-1', taskId: 'task-1' }) };

describe('video task deletion API', () => {
  beforeEach(() => {
    mockRequireApiRole.mockResolvedValue({ role: 'admin', username: 'admin' });
    mockCanAccessWorkspaceAccount.mockReturnValue(true);
    mockGetProviderTask.mockReset();
    mockDeleteProviderTask.mockReset();
  });

  it('enforces role authorization before touching task storage', async () => {
    mockRequireApiRole.mockResolvedValue(NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 }));
    const response = await DELETE(request, params);
    expect(response.status).toBe(403);
    expect(mockGetProviderTask).not.toHaveBeenCalled();
  });

  it('deletes a completed task owned by the account', async () => {
    mockGetProviderTask.mockReturnValue({ id: 'task-1', accountId: 'account-1', mode: 'video', status: 'completed' });
    mockDeleteProviderTask.mockReturnValue(true);
    const response = await DELETE(request, params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { taskId: 'task-1', deleted: true } });
    expect(mockDeleteProviderTask).toHaveBeenCalledWith('task-1');
  });

  it('rejects deletion of active tasks', async () => {
    mockGetProviderTask.mockReturnValue({ id: 'task-1', accountId: 'account-1', mode: 'video', status: 'running' });
    const response = await DELETE(request, params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: 'active_task_cannot_delete' });
    expect(mockDeleteProviderTask).not.toHaveBeenCalled();
  });

  it('does not delete a task belonging to another account', async () => {
    mockGetProviderTask.mockReturnValue({ id: 'task-1', accountId: 'other-account', mode: 'video', status: 'completed' });
    const response = await DELETE(request, params);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: 'task_not_found' });
    expect(mockDeleteProviderTask).not.toHaveBeenCalled();
  });

  it('does not delete an image task through the video endpoint', async () => {
    mockGetProviderTask.mockReturnValue({ id: 'task-1', accountId: 'account-1', mode: 'image', status: 'completed' });
    const response = await DELETE(request, params);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: 'task_not_found' });
    expect(mockDeleteProviderTask).not.toHaveBeenCalled();
  });
});
