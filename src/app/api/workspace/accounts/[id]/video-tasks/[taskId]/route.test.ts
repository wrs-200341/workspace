import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireApiRole, mockCanAccessWorkspaceAccount, mockWorkspaceOwnerIdForAccount,
  mockGetProviderTask, mockDeleteProviderTask, mockUpdateProviderTask,
  mockFindNextUnreviewedVideoTask, mockDeleteStoredTaskOutputs,
  mockSaveVideoTaskOutputsToAssets, mockListVideoTaskInventoryAssets, mockListStoredAccounts,
} = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockCanAccessWorkspaceAccount: vi.fn(),
  mockWorkspaceOwnerIdForAccount: vi.fn(),
  mockGetProviderTask: vi.fn(),
  mockDeleteProviderTask: vi.fn(),
  mockUpdateProviderTask: vi.fn(),
  mockFindNextUnreviewedVideoTask: vi.fn(),
  mockDeleteStoredTaskOutputs: vi.fn(),
  mockSaveVideoTaskOutputsToAssets: vi.fn(),
  mockListVideoTaskInventoryAssets: vi.fn(),
  mockListStoredAccounts: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/access', () => ({ canAccessWorkspaceAccount: mockCanAccessWorkspaceAccount, workspaceOwnerIdForAccount: mockWorkspaceOwnerIdForAccount }));
vi.mock('@/lib/providers/taskStore', () => ({
  getProviderTask: mockGetProviderTask,
  deleteProviderTask: mockDeleteProviderTask,
  updateProviderTask: mockUpdateProviderTask,
  findNextUnreviewedVideoTask: mockFindNextUnreviewedVideoTask,
}));
vi.mock('@/lib/workspace/accountStore', () => ({ listStoredAccounts: mockListStoredAccounts }));
vi.mock('@/lib/providers/config', () => ({ isProviderLiveEnabled: () => false }));
vi.mock('@/lib/providers/client', () => ({ syncProviderTask: vi.fn() }));
vi.mock('@/lib/providers/outputStore', () => ({ deleteStoredTaskOutputs: mockDeleteStoredTaskOutputs }));
vi.mock('@/lib/workspace/serverTasks', () => ({ getServerWorkspaceTasks: vi.fn(() => []) }));
vi.mock('@/lib/workspace/taskActions', () => ({ applyTaskAction: vi.fn(), }));
vi.mock('@/lib/workspace/videoInventory', () => ({
  recoverPendingVideoTaskOutputCache: vi.fn(),
  saveVideoTaskOutputsToAssets: mockSaveVideoTaskOutputsToAssets,
  listVideoTaskInventoryAssets: mockListVideoTaskInventoryAssets,
}));

import { DELETE, POST } from './route';

const request = new NextRequest('http://localhost/api/workspace/accounts/account-1/video-tasks/task-1');
const params = { params: Promise.resolve({ id: 'account-1', taskId: 'task-1' }) };

describe('video task deletion API', () => {
  beforeEach(() => {
    mockRequireApiRole.mockResolvedValue({ role: 'admin', username: 'admin' });
    mockCanAccessWorkspaceAccount.mockReturnValue(true);
    mockGetProviderTask.mockReset();
    mockDeleteProviderTask.mockReset();
    mockUpdateProviderTask.mockReset();
    mockFindNextUnreviewedVideoTask.mockReset();
    mockDeleteStoredTaskOutputs.mockReset().mockReturnValue({ deletedFiles: 1, deletedBytes: 100 });
    mockWorkspaceOwnerIdForAccount.mockReset().mockReturnValue('owner-a');
    mockListStoredAccounts.mockReset().mockReturnValue([
      { id: 'account-1', ownerId: 'owner-a' },
      { id: 'account-2', ownerId: 'owner-a' },
    ]);
    mockSaveVideoTaskOutputsToAssets.mockReset().mockResolvedValue([{ id: 'asset-1' }]);
    mockListVideoTaskInventoryAssets.mockReset().mockReturnValue([]);
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
    expect(mockDeleteStoredTaskOutputs).toHaveBeenCalledWith('account-1', 'task-1');
    expect(mockDeleteProviderTask).toHaveBeenCalledWith('task-1');
    expect(mockDeleteStoredTaskOutputs.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteProviderTask.mock.invocationCallOrder[0]);
  });

  it('marks deletion as a restore when configuration recovery requested it', async () => {
    mockGetProviderTask.mockReturnValue({ id: 'task-1', accountId: 'account-1', mode: 'video', status: 'completed' });
    mockDeleteProviderTask.mockReturnValue(true);
    const restoreRequest = new NextRequest('http://localhost/api/workspace/accounts/account-1/video-tasks/task-1?reason=restore-config');
    const response = await DELETE(restoreRequest, params);
    expect(response.status).toBe(200);
    expect(mockDeleteProviderTask).toHaveBeenCalledWith('task-1', { restoreReason: 'restore-config' });
  });

  it('keeps the task record when output cleanup fails', async () => {
    mockGetProviderTask.mockReturnValue({ id: 'task-1', accountId: 'account-1', mode: 'video', status: 'completed' });
    mockDeleteStoredTaskOutputs.mockImplementation(() => { throw new Error('output_directory_invalid'); });
    const response = await DELETE(request, params);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: 'task_output_cleanup_failed' });
    expect(mockDeleteProviderTask).not.toHaveBeenCalled();
  });

  it('rejects deletion of active tasks', async () => {
    mockGetProviderTask.mockReturnValue({ id: 'task-1', accountId: 'account-1', mode: 'video', status: 'running' });
    const response = await DELETE(request, params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: 'active_task_cannot_delete' });
    expect(mockDeleteStoredTaskOutputs).not.toHaveBeenCalled();
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

  it('returns the next unreviewed video after saving inventory', async () => {
    const persisted = {
      id: 'task-1', accountId: 'account-1', mode: 'video', provider: 'grok-video',
      status: 'completed', progress: 100, outputUrls: ['https://cdn.example/video.mp4'], outputBase64: [],
      createdAt: '2026-09-14T03:00:00.000Z', updatedAt: '2026-09-14T04:00:00.000Z', metadata: { ownerId: 'owner-a' },
    };
    const updated = { ...persisted, inventorySavedAt: '2026-09-14T05:00:00.000Z' };
    mockGetProviderTask.mockReturnValue(persisted);
    mockUpdateProviderTask.mockReturnValue(updated);
    mockFindNextUnreviewedVideoTask.mockReturnValue({
      id: 'task-2', accountId: 'account-2', mode: 'video', provider: 'grok-video', status: 'completed', progress: 100,
      createdAt: '2026-09-14T02:00:00.000Z', updatedAt: '2026-09-14T03:00:00.000Z', outputCount: 1,
    });

    const response = await POST(new NextRequest(request.url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save-inventory' }),
    }), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: updated,
      nextReviewTask: { id: 'task-2', accountId: 'account-2', createdAt: '2026-09-14T02:00:00.000Z' },
    });
    expect(mockListStoredAccounts).toHaveBeenCalledWith({ ownerId: 'owner-a' });
    expect(mockFindNextUnreviewedVideoTask).toHaveBeenCalledWith(['account-1', 'account-2'], persisted);
  });
});
