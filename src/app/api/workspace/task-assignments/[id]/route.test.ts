import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireApiRole,
  mockWorkspaceOwnerIdForUser,
  mockUpdateTaskAssignment,
  mockUpdateTaskAssignmentFeedback,
} = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockWorkspaceOwnerIdForUser: vi.fn(),
  mockUpdateTaskAssignment: vi.fn(),
  mockUpdateTaskAssignmentFeedback: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/access', () => ({ workspaceOwnerIdForUser: mockWorkspaceOwnerIdForUser }));
vi.mock('@/lib/workspace/taskAssignments', () => ({
  deleteTaskAssignment: vi.fn(),
  updateTaskAssignment: mockUpdateTaskAssignment,
  updateTaskAssignmentFeedback: mockUpdateTaskAssignmentFeedback,
}));

import { PATCH } from './route';

const params = { params: Promise.resolve({ id: 'assignment-1' }) };

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/workspace/task-assignments/assignment-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('task assignment update API', () => {
  beforeEach(() => {
    mockRequireApiRole.mockReset().mockResolvedValue({ role: 'operator', username: 'wufengyan' });
    mockWorkspaceOwnerIdForUser.mockReset().mockReturnValue('operator-wufengyan');
    mockUpdateTaskAssignment.mockReset();
    mockUpdateTaskAssignmentFeedback.mockReset().mockReturnValue({ id: 'assignment-1', feedback: '需要补拍侧面' });
  });

  it('lets an operator update feedback in their own owner scope', async () => {
    const response = await PATCH(request({ feedback: '需要补拍侧面' }), params);
    expect(response.status).toBe(200);
    expect(mockUpdateTaskAssignmentFeedback).toHaveBeenCalledWith('assignment-1', 'operator-wufengyan', '需要补拍侧面');
    expect(mockUpdateTaskAssignment).not.toHaveBeenCalled();
  });

  it('does not let an operator edit assignment ownership or quantity', async () => {
    const response = await PATCH(request({ pid: '1731', operatorId: 'operator-chenxi', quantity: 99 }), params);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'forbidden' });
    expect(mockUpdateTaskAssignment).not.toHaveBeenCalled();
  });

  it('maps cross-owner feedback rejection to a forbidden response', async () => {
    mockUpdateTaskAssignmentFeedback.mockImplementation(() => { throw new Error('forbidden'); });
    const response = await PATCH(request({ feedback: '越权反馈' }), params);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'forbidden' });
  });

  it('keeps full assignment editing available to administrators', async () => {
    mockRequireApiRole.mockResolvedValue({ role: 'admin', username: 'admin' });
    mockUpdateTaskAssignment.mockReturnValue({ id: 'assignment-1', pid: '1731', quantity: 20 });
    const response = await PATCH(request({ pid: '1731', source: 'cap', urgent: true, operatorId: 'operator-wufengyan', quantity: 20 }), params);
    expect(response.status).toBe(200);
    expect(mockUpdateTaskAssignment).toHaveBeenCalledWith('assignment-1', {
      pid: '1731',
      source: 'cap',
      urgent: true,
      operatorId: 'operator-wufengyan',
      quantity: 20,
    });
  });

  it('does not touch assignment storage when authentication fails', async () => {
    mockRequireApiRole.mockResolvedValue(NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 }));
    const response = await PATCH(request({ feedback: 'test' }), params);
    expect(response.status).toBe(403);
    expect(mockUpdateTaskAssignmentFeedback).not.toHaveBeenCalled();
  });
});
