import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  ownerId: vi.fn(),
  list: vi.fn(),
  listWithProgress: vi.fn(),
  createOne: vi.fn(),
  createMany: vi.fn(),
  createForPids: vi.fn(),
  listCrawls: vi.fn(),
  queueCrawls: vi.fn(),
  refreshCrawls: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mocks.auth }));
vi.mock('@/lib/workspace/access', () => ({ workspaceOwnerIdForUser: mocks.ownerId }));
vi.mock('@/lib/workspace/taskAssignments', () => ({
  createTaskAssignment: mocks.createOne,
  createTaskAssignments: mocks.createMany,
  createTaskAssignmentsForPids: mocks.createForPids,
  listTaskAssignments: mocks.list,
  listTaskAssignmentsWithProgress: mocks.listWithProgress,
}));
vi.mock('@/lib/workspace/taskAssignmentImageCrawls', () => ({
  listTaskAssignmentImageCrawls: mocks.listCrawls,
  queueTaskAssignmentImageCrawls: mocks.queueCrawls,
  scheduleTaskAssignmentImageCrawlRefresh: mocks.refreshCrawls,
}));

import { GET, POST } from './route';

describe('task assignment route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ownerId.mockReturnValue('operator-wufengyan');
    mocks.list.mockReturnValue([]);
    mocks.listWithProgress.mockReturnValue([]);
    mocks.createOne.mockReturnValue({ id: 'assignment-one' });
    mocks.createMany.mockReturnValue([]);
    mocks.createForPids.mockReturnValue({ created: [], createdPids: [], skippedPids: [] });
    mocks.listCrawls.mockReturnValue([]);
    mocks.queueCrawls.mockReturnValue({ requested: 0, queued: 0, completed: 0, active: 0 });
  });

  it('scopes an operator progress request to their own assignments', async () => {
    mocks.auth.mockResolvedValue({ id: 'user-1', username: 'wufengyan', displayName: '吴凤燕', role: 'operator', active: true });

    const response = await GET(new NextRequest('http://localhost/api/workspace/task-assignments?includeProgress=1'));

    expect(response.status).toBe(200);
    expect(mocks.ownerId).toHaveBeenCalledWith(expect.objectContaining({ username: 'wufengyan' }));
    expect(mocks.listWithProgress).toHaveBeenCalledWith('operator-wufengyan');
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('keeps the administrator task list global', async () => {
    mocks.auth.mockResolvedValue({ id: 'admin-1', username: 'admin', displayName: '管理员', role: 'admin', active: true });

    const response = await GET(new NextRequest('http://localhost/api/workspace/task-assignments'));

    expect(response.status).toBe(200);
    expect(mocks.ownerId).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledWith(undefined);
    expect(mocks.listWithProgress).not.toHaveBeenCalled();
  });

  it('creates multiple new PID assignments through the batch endpoint', async () => {
    mocks.auth.mockResolvedValue({ id: 'admin-1', username: 'admin', displayName: '管理员', role: 'admin', active: true });
    mocks.createForPids.mockReturnValue({
      created: [{ id: 'assignment-new' }],
      createdPids: ['1732'],
      skippedPids: ['1731'],
    });
    const response = await POST(new NextRequest('http://localhost/api/workspace/task-assignments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pids: ['1731', '1732'],
        source: 'cap',
        crawlType: 'non_clothing',
        urgent: true,
        assignments: [{ operatorId: 'operator-chenxi', quantity: 4 }],
      }),
    }));

    expect(response.status).toBe(201);
    expect(mocks.createForPids).toHaveBeenCalledWith(
      ['1731', '1732'],
      'cap',
      [{ operatorId: 'operator-chenxi', quantity: 4 }],
      true,
    );
    expect(mocks.queueCrawls).toHaveBeenCalledWith(['1731', '1732'], 'non_clothing');
    expect((await response.json()).data).toMatchObject({ createdPids: ['1732'], skippedPids: ['1731'] });
  });
});
