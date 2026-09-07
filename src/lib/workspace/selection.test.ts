import { describe, expect, it } from 'vitest';
import type { WorkspaceAccount } from './data';
import { canEditWorkspaceOwner, countWorkspaceAccounts, filterWorkspaceAccounts } from './selection';

const accounts: WorkspaceAccount[] = [
  { id: 'qing-video', ownerId: 'operator-qing', ownerName: '青青', name: '精选', category: 'featured', strategy: '', promptCount: 0, fileCount: 0, videoCount: 0, publishedCount: 0, updatedAt: '', planStatus: 'planned' },
  { id: 'qing-remix', ownerId: 'operator-qing', ownerName: '青青', name: '混剪', category: 'remix', strategy: '', promptCount: 0, fileCount: 0, videoCount: 0, publishedCount: 0, updatedAt: '', planStatus: 'planned' },
  { id: 'chenxi-video', ownerId: 'operator-chenxi', ownerName: '陈曦', name: '精选', category: 'featured', strategy: '', promptCount: 0, fileCount: 0, videoCount: 0, publishedCount: 0, updatedAt: '', planStatus: 'planned' },
];

describe('workspace account selection', () => {
  it('keeps the selected owner lane isolated', () => {
    expect(filterWorkspaceAccounts(accounts, 'operator-chenxi', 'featured').map((account) => account.id)).toEqual(['chenxi-video']);
    expect(filterWorkspaceAccounts(accounts, 'operator-qing', 'featured').map((account) => account.id)).toEqual(['qing-video']);
  });

  it('returns no accounts when no owner is selected', () => {
    expect(filterWorkspaceAccounts(accounts, undefined, 'featured')).toEqual([]);
  });

  it('counts only the selected owner and category', () => {
    expect(countWorkspaceAccounts(accounts, 'operator-qing', 'featured')).toBe(1);
    expect(countWorkspaceAccounts(accounts, 'operator-qing', 'remix')).toBe(1);
    expect(countWorkspaceAccounts(accounts, 'operator-chenxi', 'remix')).toBe(0);
  });

  it('allows edits only in the authenticated operator lane', () => {
    expect(canEditWorkspaceOwner('operator', 'operator-qing', 'operator-qing')).toBe(true);
    expect(canEditWorkspaceOwner('operator', 'operator-chenxi', 'operator-qing')).toBe(false);
    expect(canEditWorkspaceOwner('admin', 'operator-chenxi', 'operator-qing')).toBe(true);
  });

  it('keeps a workspace login writable only in its own lane', () => {
    expect(canEditWorkspaceOwner('workspace', 'operator-test', 'operator-test')).toBe(true);
    expect(canEditWorkspaceOwner('workspace', 'operator-chenxi', 'operator-test')).toBe(false);
  });
});
