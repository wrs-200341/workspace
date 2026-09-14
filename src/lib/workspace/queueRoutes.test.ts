import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), owner: vi.fn(), queue: vi.fn(), delta: vi.fn(), full: vi.fn(), recover: vi.fn(), pump: vi.fn(), sync: vi.fn() }));
vi.mock('@/lib/auth/server', () => ({ requireApiRole: mocks.auth }));
vi.mock('@/lib/workspace/access', () => ({ canAccessWorkspaceAccount: mocks.access, workspaceOwnerIdForUser: mocks.owner, workspaceOwnerIdForAccount: vi.fn(() => 'owner-a') }));
vi.mock('@/lib/workspace/serverTasks', () => ({ getServerWorkspaceQueueTasks: mocks.queue, getServerWorkspaceQueueDelta: mocks.delta, getServerWorkspaceTasks: mocks.full }));
vi.mock('@/lib/providers/taskStore', () => ({ createProviderTask: vi.fn(), getProviderTask: vi.fn(), updateProviderTask: vi.fn(), listProviderTasks: vi.fn(() => []), flushProviderTaskStore: vi.fn() }));
vi.mock('@/lib/providers/concurrency', () => ({ recoverOrphanedSchedulerTasks: mocks.recover, pumpProviderTasks: mocks.pump, enqueueProviderTask: vi.fn(), retryProviderTaskOnFailure: vi.fn(), SCHEDULER_RUNTIME_ID: 'test' }));
vi.mock('@/lib/providers/client', () => ({ syncProviderTask: mocks.sync, normalizeProviderResponse: vi.fn(), providerResponseSnapshot: vi.fn(), sanitizeProviderError: vi.fn(), submitVideoWithFallback: vi.fn() }));

import { GET as imageGET } from '@/app/api/workspace/accounts/[id]/image-tasks/route';
import { GET as videoGET } from '@/app/api/workspace/accounts/[id]/video-tasks/route';
import { GET as promptGET } from '@/app/api/workspace/accounts/[id]/prompt-tasks/route';

describe.each([['image', imageGET], ['video', videoGET], ['prompt', promptGET]] as const)('%s queue GET', (mode, get) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ role: 'workspace', username: 'operator-a' });
    mocks.access.mockReturnValue(true);
    mocks.owner.mockReturnValue('owner-a');
    mocks.queue.mockReturnValue([{ id: 'task-a', mode, accountId: 'account-a', status: 'processing', createdAt: '2026-09-14T01:00:00.000Z' }]);
    mocks.delta.mockReturnValue({ tasks: [], deletedTaskIds: ['deleted'], reset: false, token: 'next', counts: { all: 10 }, page: 1, totalPages: 2, pageSize: 50 });
  });

  function request(query: string) {
    return get(new NextRequest(`http://localhost/api/workspace/accounts/account-a/${mode}-tasks?${query}`), { params: Promise.resolve({ id: 'account-a' }) });
  }

  it('keeps the default full compatibility envelope without provider side effects', async () => {
    const response = await request('date=2026-09-14&scope=owner&sync=1');
    const payload = await response.json();
    expect(payload.data).toEqual(payload.tasks);
    expect(payload.tasks).toHaveLength(1);
    expect(mocks.queue).toHaveBeenCalledWith({ ownerId: 'owner-a', mode, date: '2026-09-14' });
    expect(mocks.delta).not.toHaveBeenCalled();
    expect(mocks.full).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.pump).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('opts in to a private scoped delta after authorization', async () => {
    const response = await request('queue=delta&date=2026-09-14&scope=owner&ownerId=someone-else&since=previous&page=1');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Server-Timing')).toMatch(/^queue;dur=/);
    expect(await response.json()).toMatchObject({ success: true, data: { token: 'next', deletedTaskIds: ['deleted'], reset: false } });
    expect(mocks.delta).toHaveBeenCalledWith({ ownerId: 'owner-a', mode, date: '2026-09-14' }, expect.objectContaining({ viewer: 'workspace:operator-a:account-a', searchParams: expect.any(URLSearchParams) }));
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.full).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it('does not consult cached deltas after account permission is denied', async () => {
    mocks.access.mockReturnValue(false);
    const response = await request('queue=delta&since=known-token');
    expect(response.status).toBe(403);
    expect(mocks.delta).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
  });
});
