import type { AuthUser } from '@/lib/auth/policy';
import { getWorkspaceAccountById, getWorkspaceOperatorForUser } from './data';
import { listStoredAccounts } from './accountStore';

type WorkspaceIdentity = Pick<AuthUser, 'role' | 'username'> & { displayName?: string };

export function workspaceOwnerIdForUser(user: WorkspaceIdentity): string | undefined {
  if (user.role === 'admin') return undefined;
  if (user.role === 'workspace') return 'operator-chenxi';
  return getWorkspaceOperatorForUser(user.username, user.displayName ?? user.username).id;
}

export function workspaceOwnerIdForAccount(accountId: string): string | undefined {
  return (getWorkspaceAccountById(accountId) ?? listStoredAccounts().find((item) => item.id === accountId))?.ownerId;
}

/**
 * Maps the three product roles to the owner scope used by the recovered
 * workbench. Admin is global; the two operational roles are scoped to their
 * own workbench owner until a real user↔operator mapping is persisted.
 */
/**
 * Check account scope for a workspace request. Operators may inspect every
 * operator workspace, but only their own lane can be changed. Existing
 * callers default to read access; pass `{ write: true }` at mutation
 * boundaries.
 */
export function canAccessWorkspaceAccount(user: WorkspaceIdentity, accountId: string, options?: { write?: boolean }): boolean {
  if (user.role === 'admin') return true;
  if (!options?.write && user.role === 'operator') return Boolean(workspaceOwnerIdForAccount(accountId));
  return workspaceOwnerIdForAccount(accountId) === workspaceOwnerIdForUser(user);
}

export function canViewWorkspaceAccount(user: WorkspaceIdentity, accountId: string): boolean {
  return canAccessWorkspaceAccount(user, accountId);
}

export function canEditWorkspaceAccount(user: WorkspaceIdentity, accountId: string): boolean {
  return canAccessWorkspaceAccount(user, accountId, { write: true });
}
