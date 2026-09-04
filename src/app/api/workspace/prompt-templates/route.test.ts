import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireApiRole, mockListStoredAccounts, mockListAssets, mockCanAccessWorkspaceAccount } = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockListStoredAccounts: vi.fn(),
  mockListAssets: vi.fn(),
  mockCanAccessWorkspaceAccount: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/accountStore', () => ({ listStoredAccounts: mockListStoredAccounts }));
vi.mock('@/lib/workspace/assetStore', () => ({ listAssets: mockListAssets }));
vi.mock('@/lib/workspace/access', () => ({ canAccessWorkspaceAccount: mockCanAccessWorkspaceAccount }));

import { GET } from './route';

describe('prompt template category API', () => {
  beforeEach(() => {
    mockRequireApiRole.mockResolvedValue({ role: 'operator', username: 'emily', displayName: 'Emily' });
    mockCanAccessWorkspaceAccount.mockReturnValue(true);
    mockListStoredAccounts.mockReturnValue([
      { id: 'account-1', name: 'Account 1', ownerId: 'operator-emily' },
      { id: 'account-2', name: 'Account 2', ownerId: 'operator-other' },
    ]);
    mockListAssets.mockReturnValue([
      { id: 'legacy', kind: 'prompt', name: 'Legacy', content: 'old', updatedAt: '2026-09-01', accountId: 'account-1' },
      { id: 'image', kind: 'prompt', category: 'image', name: 'Image', content: 'image', updatedAt: '2026-09-02', accountId: 'account-1' },
      { id: 'video', kind: 'prompt', category: 'video', name: 'Video', content: 'video', updatedAt: '2026-09-03', accountId: 'account-1' },
    ]);
  });

  it('defaults legacy templates to video and filters by requested category', async () => {
    const response = await GET(new NextRequest('http://localhost/api/workspace/prompt-templates?accountId=account-1&category=video'));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.templates.map((item: { id: string; category: string }) => [item.id, item.category])).toEqual([
      ['legacy', 'video'],
      ['video', 'video'],
    ]);
  });

  it('rejects unsupported categories', async () => {
    const response = await GET(new NextRequest('http://localhost/api/workspace/prompt-templates?accountId=account-1&category=audio'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'prompt_category_invalid' });
  });

  it('requires an account scope and never aggregates other accounts', async () => {
    const missing = await GET(new NextRequest('http://localhost/api/workspace/prompt-templates?category=video'));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ success: false, error: 'prompt_account_required' });

    mockListAssets.mockImplementation((accountId: string) => accountId === 'account-1'
      ? [{ id: 'only-account-1', kind: 'prompt', category: 'video', name: 'Own', content: 'own', updatedAt: '2026-09-04', accountId }]
      : [{ id: 'other', kind: 'prompt', category: 'video', name: 'Other', content: 'other', updatedAt: '2026-09-04', accountId }]);
    const response = await GET(new NextRequest('http://localhost/api/workspace/prompt-templates?accountId=account-1&category=video'));
    const payload = await response.json();
    expect(payload.data.templates.map((item: { id: string; accountId: string }) => [item.id, item.accountId])).toEqual([['only-account-1', 'account-1']]);
    expect(mockListAssets).toHaveBeenCalledWith('account-1', 'prompt');
  });

  it('rejects an account outside the caller read scope', async () => {
    mockCanAccessWorkspaceAccount.mockReturnValue(false);
    mockListAssets.mockClear();
    const response = await GET(new NextRequest('http://localhost/api/workspace/prompt-templates?accountId=account-2&category=video'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'forbidden_account_scope' });
    expect(mockListAssets).not.toHaveBeenCalled();
  });
});
