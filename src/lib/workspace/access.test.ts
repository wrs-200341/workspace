import { describe, expect, it } from 'vitest';
import { canAccessWorkspaceAccount, workspaceOwnerIdForUser } from './access';

describe('workspace account access', () => {
  it('allows admins to inspect any account', () => {
    expect(canAccessWorkspaceAccount({ role: 'admin', username: 'admin' }, 'workspace-account-6-b')).toBe(true);
  });

  it('derives an isolated owner lane from a workspace login', () => {
    const user = { role: 'workspace' as const, username: 'ceshi', displayName: 'test' };
    expect(workspaceOwnerIdForUser(user)).toBe('operator-ceshi');
    expect(canAccessWorkspaceAccount(user, 'workspace-account-custom-1788344417852-7902a545')).toBe(false);
    expect(canAccessWorkspaceAccount(user, 'workspace-account-2-a')).toBe(false);
  });

  it('keeps operator reads broad while scoping operator writes', () => {
    const operator = { role: 'operator' as const, username: 'guoqingqing', displayName: '郭青青' };
    expect(canAccessWorkspaceAccount(operator, 'workspace-account-2-a')).toBe(true);
    expect(canAccessWorkspaceAccount(operator, 'workspace-account-2-a', { write: true })).toBe(false);
    expect(canAccessWorkspaceAccount(operator, 'workspace-account-1-a', { write: true })).toBe(true);
  });
});
