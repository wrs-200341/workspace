import type { WorkspaceAccount, WorkspaceCategory } from './data';
import type { Role } from '@/lib/auth/policy';

/** Return accounts in the selected owner lane and category. */
export function filterWorkspaceAccounts(
  accounts: readonly WorkspaceAccount[],
  ownerId: string | undefined,
  category: WorkspaceCategory,
): WorkspaceAccount[] {
  if (!ownerId) return [];
  return accounts.filter((account) => account.ownerId === ownerId && account.category === category);
}

export function countWorkspaceAccounts(
  accounts: readonly WorkspaceAccount[],
  ownerId: string | undefined,
  category: WorkspaceCategory,
): number {
  return filterWorkspaceAccounts(accounts, ownerId, category).length;
}

/**
 * UI edit scope mirrors the server's workspace access policy. Operators can
 * inspect every owner lane, but only their own lane is writable.
 */
export function canEditWorkspaceOwner(
  role: Role,
  selectedOwnerId: string | undefined,
  ownOwnerId: string,
  workspaceOwnerId = 'operator-chenxi',
): boolean {
  return role === 'admin'
    || (role === 'operator' && selectedOwnerId === ownOwnerId)
    || (role === 'workspace' && selectedOwnerId === workspaceOwnerId);
}
