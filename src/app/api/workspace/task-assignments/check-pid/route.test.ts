import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), check: vi.fn() }));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mocks.auth }));
vi.mock('@/lib/workspace/taskAssignmentPidCheck', () => ({ checkTaskAssignmentPid: mocks.check }));

import { POST } from './route';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/workspace/task-assignments/check-pid', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('task assignment PID check API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ role: 'admin', username: 'admin' });
    mocks.check.mockResolvedValue({ pid: '1731', source: 'tap', canMount: true, reason: 'TAP 可挂车' });
  });

  it('checks an administrator PID through the server-side 8003 integration', async () => {
    const response = await POST(request({ pid: '1731', source: 'tap' }));
    expect(response.status).toBe(200);
    expect(mocks.check).toHaveBeenCalledWith('1731', 'tap');
    expect(await response.json()).toMatchObject({ success: true, data: { canMount: true } });
  });

  it('does not expose the lookup to non-admin users', async () => {
    mocks.auth.mockResolvedValue(NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 }));
    const response = await POST(request({ pid: '1731', source: 'tap' }));
    expect(response.status).toBe(403);
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('returns a clear timeout status', async () => {
    mocks.check.mockRejectedValue(new Error('pid_check_timeout'));
    const response = await POST(request({ pid: '1731', source: 'tap' }));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ success: false, error: 'pid_check_timeout' });
  });
});
