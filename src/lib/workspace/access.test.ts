import { describe, expect, it } from 'vitest';
import { canAccessWorkspaceAccount } from './access';

describe('workspace account ownership', () => {
  it('allows admins to inspect any account', () => {
    expect(canAccessWorkspaceAccount({ role: 'admin', username: 'admin' }, 'workspace-account-6-b')).toBe(true);
  });
  it('scopes workspace and operator accounts to their owner lane', () => {
    expect(canAccessWorkspaceAccount({ role: 'workspace', username: 'workspace' }, 'workspace-account-2-a')).toBe(true);
    expect(canAccessWorkspaceAccount({ role: 'workspace', username: 'workspace' }, 'workspace-account-1-a')).toBe(false);
    expect(canAccessWorkspaceAccount({ role: 'operator', username: 'guoqingqing' }, 'workspace-account-1-a')).toBe(true);
    expect(canAccessWorkspaceAccount({ role: 'operator', username: 'guoqingqing' }, 'workspace-account-2-a', { write: true })).toBe(false);
    expect(canAccessWorkspaceAccount({ role: 'operator', username: 'emily' }, 'workspace-account-1-a', { write: true })).toBe(false);
  });

  it('lets operators inspect other workspaces while keeping mutations owner-scoped', () => {
    const operator = { role: 'operator' as const, username: 'guoqingqing', displayName: '郭青青' };
    expect(canAccessWorkspaceAccount(operator, 'workspace-account-2-a')).toBe(true);
    expect(canAccessWorkspaceAccount(operator, 'workspace-account-2-a', { write: true })).toBe(false);
    expect(canAccessWorkspaceAccount(operator, 'workspace-account-1-a', { write: true })).toBe(true);
  });
});
