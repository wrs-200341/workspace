import { listProviderTasks, type ProviderTask } from '@/lib/providers/taskStore';
import { getWorkspaceAccountById } from './data';
import { listStoredAccounts } from './accountStore';
import { getWorkspaceTasks, type WorkspaceTask } from './tasks';
import { taskNameForInventory } from './inventoryNaming';

export function providerTaskToWorkspaceTask(task: ProviderTask): WorkspaceTask {
  const account = getWorkspaceAccountById(task.accountId) ?? listStoredAccounts().find((candidate) => candidate.id === task.accountId);
  const metadata = task.metadata ?? {};
  const owner = typeof metadata.ownerId === 'string' ? metadata.ownerId : account?.ownerId ?? 'operator-unassigned';
  const outputCount = task.outputUrls.length + task.outputBase64.length;
  const title = taskNameForInventory(task);
  return {
    id: task.id,
    accountId: task.accountId,
    ...(account?.name ? { accountName: account.name } : {}),
    pid: typeof metadata.pid === 'string' ? metadata.pid : 'pending',
    title,
    owner,
    mode: task.mode,
    model: task.model || task.provider,
    status: task.status,
    progress: task.progress,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.inventorySavedAt ? { inventorySavedAt: task.inventorySavedAt } : {}),
    outputCount: outputCount || undefined,
    ...(task.error ? { error: task.error } : {}),
    provider: task.provider,
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
    ...(task.providerTaskId ? { providerTaskId: task.providerTaskId } : {}),
    ...(task.outputUrls.length ? { outputUrls: [...task.outputUrls] } : {}),
    ...(task.outputBase64.length ? { outputBase64: [...task.outputBase64] } : {}),
  };
}

export function getServerWorkspaceTasks(filters: { ownerId?: string; accountId?: string; mode?: WorkspaceTask['mode'] } = {}): WorkspaceTask[] {
  const persisted = listProviderTasks({ accountId: filters.accountId, mode: filters.mode }).map(providerTaskToWorkspaceTask);
  const accountOwners = filters.ownerId
    ? new Map(listStoredAccounts().map((account) => [account.id, account.ownerId]))
    : undefined;
  if (accountOwners) {
    for (const task of persisted) {
      if (accountOwners.has(task.accountId)) continue;
      const account = getWorkspaceAccountById(task.accountId);
      if (account) accountOwners.set(account.id, account.ownerId);
    }
  }
  const scoped = [...getWorkspaceTasks({ ownerId: filters.ownerId }), ...persisted]
    .filter((task) => !filters.accountId || task.accountId === filters.accountId)
    .filter((task) => !filters.mode || task.mode === filters.mode)
    .filter((task) => !filters.ownerId || (task.owner === filters.ownerId && accountOwners?.get(task.accountId) === filters.ownerId));
  return Array.from(new Map(scoped.map((task) => [task.id, task])).values())
    .map((task) => ({ ...task, outputUrls: task.outputUrls ? [...task.outputUrls] : undefined, outputBase64: task.outputBase64 ? [...task.outputBase64] : undefined }));
}
