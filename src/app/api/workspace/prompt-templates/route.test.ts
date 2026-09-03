import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireApiRole, mockGetWorkspaceOperatorForUser, mockListStoredAccounts, mockListAssets } = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockGetWorkspaceOperatorForUser: vi.fn(),
  mockListStoredAccounts: vi.fn(),
  mockListAssets: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/data', () => ({ getWorkspaceOperatorForUser: mockGetWorkspaceOperatorForUser }));
vi.mock('@/lib/workspace/accountStore', () => ({ listStoredAccounts: mockListStoredAccounts }));
vi.mock('@/lib/workspace/assetStore', () => ({ listAssets: mockListAssets }));

import { GET } from './route';

describe('prompt template category API', () => {
  beforeEach(() => {
    mockRequireApiRole.mockResolvedValue({ role: 'operator', username: 'emily', displayName: 'Emily' });
    mockGetWorkspaceOperatorForUser.mockReturnValue({ id: 'operator-emily', username: 'emily', name: 'Emily' });
    mockListStoredAccounts.mockReturnValue([{ id: 'account-1', name: 'Account 1', ownerId: 'operator-emily' }]);
    mockListAssets.mockReturnValue([
      { id: 'legacy', kind: 'prompt', name: 'Legacy', content: 'old', updatedAt: '2026-09-01', accountId: 'account-1' },
      { id: 'image', kind: 'prompt', category: 'image', name: 'Image', content: 'image', updatedAt: '2026-09-02', accountId: 'account-1' },
      { id: 'video', kind: 'prompt', category: 'video', name: 'Video', content: 'video', updatedAt: '2026-09-03', accountId: 'account-1' },
    ]);
  });

  it('defaults legacy templates to video and filters by requested category', async () => {
    const response = await GET(new NextRequest('http://localhost/api/workspace/prompt-templates?category=video'));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.templates.map((item: { id: string; category: string }) => [item.id, item.category])).toEqual([
      ['legacy', 'video'],
      ['video', 'video'],
    ]);
  });

  it('rejects unsupported categories', async () => {
    const response = await GET(new NextRequest('http://localhost/api/workspace/prompt-templates?category=audio'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'prompt_category_invalid' });
  });
});
