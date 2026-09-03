import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireApiRole, mockGetWorkspaceOperators, mockGetWorkspaceOperatorForUser, mockCreateStoredAccount, mockListStoredAccounts } = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockGetWorkspaceOperators: vi.fn(),
  mockGetWorkspaceOperatorForUser: vi.fn(),
  mockCreateStoredAccount: vi.fn(),
  mockListStoredAccounts: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/data', () => ({ getWorkspaceOperators: mockGetWorkspaceOperators, getWorkspaceOperatorForUser: mockGetWorkspaceOperatorForUser }));
vi.mock('@/lib/workspace/accountStore', () => ({ createStoredAccount: mockCreateStoredAccount, listStoredAccounts: mockListStoredAccounts }));

import { GET, POST } from './route';

describe('workspace account creation API', () => {
  beforeEach(() => {
    mockRequireApiRole.mockResolvedValue({ role: 'operator', username: 'emily', displayName: 'Emily', active: true, id: 'emily' });
    mockGetWorkspaceOperators.mockReturnValue([
      { id: 'operator-guoqingqing', username: 'guoqingqing', name: '郭青青', accountCount: 0 },
      { id: 'operator-chenxi', username: 'chenxi', name: '陈曦', accountCount: 0 },
    ]);
    mockGetWorkspaceOperatorForUser.mockReturnValue({ id: 'operator-emily', username: 'emily', name: 'Emily', accountCount: 0 });
    mockCreateStoredAccount.mockReset();
    mockListStoredAccounts.mockReset();
    mockCreateStoredAccount.mockReturnValue({ id: 'account-emily', ownerId: 'operator-emily', ownerName: 'Emily', name: '测试账号', category: 'featured' });
    mockListStoredAccounts.mockReturnValue([]);
  });

  it('allows an operator to create an account scoped to their own workspace owner', async () => {
    const response = await POST(new NextRequest('http://localhost/api/workspace/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '测试账号', category: 'featured', strategy: '' }),
    }));

    expect(response.status).toBe(201);
    expect(mockCreateStoredAccount).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'operator-emily',
      ownerName: 'Emily',
      name: '测试账号',
    }));
  });

  it('still rejects a missing account name', async () => {
    const response = await POST(new NextRequest('http://localhost/api/workspace/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'featured' }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'account_name_required' });
    expect(mockCreateStoredAccount).not.toHaveBeenCalled();
  });

  it('lists an operator\'s accounts under the same deterministic owner id', async () => {
    mockListStoredAccounts.mockReturnValue([{ id: 'account-emily', ownerId: 'operator-emily', name: 'Emily 账号' }]);
    const response = await GET(new NextRequest('http://localhost/api/workspace/accounts'));
    expect(response.status).toBe(200);
    expect(mockListStoredAccounts).toHaveBeenCalledWith({ ownerId: 'operator-emily', category: undefined });
  });
});
