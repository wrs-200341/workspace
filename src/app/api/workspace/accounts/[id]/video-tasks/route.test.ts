import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireApiRole, mockCanAccessWorkspaceAccount, mockGetServerWorkspaceTasks, mockWorkspaceOwnerIdForUser, mockWorkspaceOwnerIdForAccount } = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockCanAccessWorkspaceAccount: vi.fn(),
  mockGetServerWorkspaceTasks: vi.fn(),
  mockWorkspaceOwnerIdForUser: vi.fn(),
  mockWorkspaceOwnerIdForAccount: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/access', () => ({
  canAccessWorkspaceAccount: mockCanAccessWorkspaceAccount,
  workspaceOwnerIdForUser: mockWorkspaceOwnerIdForUser,
  workspaceOwnerIdForAccount: mockWorkspaceOwnerIdForAccount,
}));
vi.mock('@/lib/workspace/serverTasks', () => ({ getServerWorkspaceTasks: mockGetServerWorkspaceTasks }));
vi.mock('@/lib/workspace/tasks', () => ({
  businessDate: (value: string | Date | number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(value)),
}));
vi.mock('@/lib/providers/taskStore', () => ({ createProviderTask: vi.fn() }));
vi.mock('@/lib/providers/config', () => ({ getProviderConfig: vi.fn(), }));
vi.mock('@/lib/providers/client', () => ({ normalizeProviderResponse: vi.fn(), submitVideo: vi.fn() }));
vi.mock('@/lib/providers/validation', () => ({ validateGenerationRequest: vi.fn() }));

import { GET } from './route';

describe('video task list API', () => {
  beforeEach(() => {
    mockRequireApiRole.mockResolvedValue({ role: 'admin', username: 'admin' });
    mockCanAccessWorkspaceAccount.mockReturnValue(true);
    mockGetServerWorkspaceTasks.mockReset();
    mockWorkspaceOwnerIdForUser.mockReset().mockReturnValue(undefined);
    mockWorkspaceOwnerIdForAccount.mockReset().mockReturnValue('operator-emily');
  });

  it('filters tasks by Shanghai business date and returns compatibility envelopes', async () => {
    mockGetServerWorkspaceTasks.mockReturnValue([
      { id: 'today', accountId: 'account-1', mode: 'video', createdAt: '2026-09-01T16:30:00.000Z' },
      { id: 'yesterday', accountId: 'account-1', mode: 'video', createdAt: '2026-09-01T15:59:59.000Z' },
    ]);

    const response = await GET(
      new NextRequest('http://localhost/api/workspace/accounts/account-1/video-tasks?date=2026-09-02'),
      { params: Promise.resolve({ id: 'account-1' }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.map((task: { id: string }) => task.id)).toEqual(['today']);
    expect(body.tasks).toEqual(body.data);
    expect(mockGetServerWorkspaceTasks).toHaveBeenCalledWith({ accountId: 'account-1', mode: 'video' });
  });

  it('rejects an account outside the current user scope', async () => {
    mockCanAccessWorkspaceAccount.mockReturnValue(false);
    const response = await GET(
      new NextRequest('http://localhost/api/workspace/accounts/other/video-tasks'),
      { params: Promise.resolve({ id: 'other' }) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'forbidden_account_scope' });
    expect(mockGetServerWorkspaceTasks).not.toHaveBeenCalled();
  });

  it('allows an operator to read their production queue', async () => {
    mockRequireApiRole.mockResolvedValue({ role: 'operator', username: 'emily' });
    mockGetServerWorkspaceTasks.mockReturnValue([]);
    const response = await GET(
      new NextRequest('http://localhost/api/workspace/accounts/account-1/video-tasks'),
      { params: Promise.resolve({ id: 'account-1' }) },
    );
    expect(response.status).toBe(200);
  });

  it('supports an owner-scoped queue containing all accounts for the operator, without cross-owner tasks', async () => {
    mockRequireApiRole.mockResolvedValue({ role: 'operator', username: 'emily', displayName: 'Emily' });
    mockWorkspaceOwnerIdForUser.mockReturnValue('operator-emily');
    mockGetServerWorkspaceTasks.mockImplementation((filters: { ownerId?: string; accountId?: string; mode?: string }) => {
      expect(filters).toEqual({ ownerId: 'operator-emily', mode: 'video' });
      return [
        { id: 'emily-a', accountId: 'workspace-account-emily-a', owner: 'operator-emily', mode: 'video', createdAt: '2026-09-03T01:00:00.000Z' },
        { id: 'emily-b', accountId: 'workspace-account-emily-b', owner: 'operator-emily', mode: 'video', createdAt: '2026-09-03T02:00:00.000Z' },
      ];
    });

    const response = await GET(
      new NextRequest('http://localhost/api/workspace/accounts/workspace-account-emily-a/video-tasks?scope=owner&date=2026-09-03'),
      { params: Promise.resolve({ id: 'workspace-account-emily-a' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map((task: { id: string }) => task.id)).toEqual(['emily-a', 'emily-b']);
    expect(body.data.every((task: { owner: string }) => task.owner === 'operator-emily')).toBe(true);
  });
});
