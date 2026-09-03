import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireApiRole, mockGetUserById, mockUpdateUser, mockDeleteUser } = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockGetUserById: vi.fn(),
  mockUpdateUser: vi.fn(),
  mockDeleteUser: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/auth/store', () => ({ getUserById: mockGetUserById, updateUser: mockUpdateUser, deleteUser: mockDeleteUser }));

import { DELETE, GET, PATCH } from './route';

const params = { params: Promise.resolve({ id: 'user-emily' }) };

describe('admin user CRUD API', () => {
  beforeEach(() => {
    mockGetUserById.mockReset();
    mockUpdateUser.mockReset();
    mockDeleteUser.mockReset();
    mockRequireApiRole.mockResolvedValue({ id: 'user-admin', role: 'admin', username: 'admin' });
    mockGetUserById.mockReturnValue({ id: 'user-emily', username: 'emily', displayName: 'Emily', role: 'operator', active: true });
    mockUpdateUser.mockReturnValue({ id: 'user-emily', username: 'emily', displayName: 'Emily Zhang', role: 'workspace', active: true });
    mockDeleteUser.mockReturnValue({ id: 'user-emily' });
  });

  it('reads a user without exposing password hash', async () => {
    const response = await GET(new NextRequest('http://localhost/api/auth/users/user-emily'), params);
    expect(response.status).toBe(200);
    expect((await response.json()).data.user.username).toBe('emily');
  });

  it('updates display name, role, and optional password', async () => {
    const response = await PATCH(new NextRequest('http://localhost/api/auth/users/user-emily', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Emily Zhang', role: 'workspace', password: 'new-password-123' }),
    }), params);
    expect(response.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith('user-emily', expect.objectContaining({ displayName: 'Emily Zhang', role: 'workspace', password: 'new-password-123' }));
  });

  it('deletes a user and invalidates its sessions', async () => {
    const response = await DELETE(new NextRequest('http://localhost/api/auth/users/user-emily', { method: 'DELETE' }), params);
    expect(response.status).toBe(200);
    expect(mockDeleteUser).toHaveBeenCalledWith('user-emily');
  });

  it('rejects unauthorised access before reading data', async () => {
    mockRequireApiRole.mockResolvedValue(NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 }));
    const response = await GET(new NextRequest('http://localhost/api/auth/users/user-emily'), params);
    expect(response.status).toBe(403);
    expect(mockGetUserById).not.toHaveBeenCalled();
  });
});
