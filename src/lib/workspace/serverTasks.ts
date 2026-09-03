import { listProviderTasks, type ProviderTask } from '@/lib/providers/taskStore';
import { getWorkspaceAccountById } from './data';
import { listStoredAccounts } from './accountStore';
import { businessDate, getWorkspaceTasks, type WorkspaceTask } from './tasks';

function taskSequence(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? Math.max(1, Math.round(numeric)) : 1;
}

function taskImageStem(value: string): string {
  const fileName = value.split(/[\\/]/).pop()?.trim() ?? value.trim();
  const stem = fileName.replace(/\.[^.]+$/, '').trim();
  return stem || fileName;
}

export function providerTaskToWorkspaceTask(task: ProviderTask): WorkspaceTask {
  const account = getWorkspaceAccountById(task.accountId) ?? listStoredAccounts().find((candidate) => candidate.id === task.accountId);
  const metadata = task.metadata ?? {};
  const owner = typeof metadata.ownerId === 'string' ? metadata.ownerId : account?.ownerId ?? 'operator-unassigned';
  const outputCount = task.outputUrls.length + task.outputBase64.length;
  const referenceImageName = typeof metadata.referenceImageName === 'string' ? taskImageStem(metadata.referenceImageName) : '';
  const title = referenceImageName
    ? `${referenceImageName}_${businessDate(task.createdAt)}_${taskSequence(metadata.sequence)}`
    : task.prompt?.slice(0, 80) || `${task.mode} generation`;
  return {
    id: task.id,
    accountId: task.accountId,
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
