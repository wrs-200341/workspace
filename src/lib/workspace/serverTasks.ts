import { getProviderTaskStoreRevision, listProviderTaskSummaries, listProviderTasks, type ProviderTask } from '@/lib/providers/taskStore';
import { getWorkspaceAccountById } from './data';
import type { WorkspaceAccount } from './data';
import { listStoredAccounts } from './accountStore';
import { businessDate, getWorkspaceTasks, type WorkspaceTask } from './tasks';
import { taskNameForInventory, taskNameSequenceMap } from './inventoryNaming';
import { countVideoOutputs } from '@/lib/providers/videoOutputUrls';
import { classifyTaskError } from '@/lib/providers/taskErrorInfo';
import { createQueueDeltaCache, createQueuePage, type QueueTab } from './queueProtocol';

export function providerTaskToWorkspaceTask(task: ProviderTask, accountIndex?: ReadonlyMap<string, WorkspaceAccount>, nameOccurrences?: ReadonlyMap<string, number>): WorkspaceTask {
  const account = accountIndex?.get(task.accountId) ?? getWorkspaceAccountById(task.accountId) ?? listStoredAccounts().find((candidate) => candidate.id === task.accountId);
  const metadata = task.metadata ?? {};
  const owner = typeof metadata.ownerId === 'string' ? metadata.ownerId : account?.ownerId ?? 'operator-unassigned';
  const outputCount = task.mode === 'video' ? countVideoOutputs(task.provider, task.outputUrls, task.outputBase64, Boolean(task.providerTaskId)) : task.outputUrls.length + task.outputBase64.length;
  const errorInfo = classifyTaskError(task);
  const title = taskNameForInventory(task, nameOccurrences?.get(task.id));
  return {
    id: task.id,
    accountId: task.accountId,
    ...(account?.name ? { accountName: account.name } : {}),
    pid: typeof metadata.pid === 'string' ? metadata.pid : 'pending',
    title,
    owner,
    mode: task.mode,
    model: task.model || task.provider,
    ...(task.prompt ? { prompt: task.prompt } : {}),
    status: task.status,
    progress: task.progress,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.inventorySavedAt ? { inventorySavedAt: task.inventorySavedAt } : {}),
    outputCount: outputCount || undefined,
    ...(task.error ? { error: task.error } : {}),
    ...(errorInfo ? { errorInfo } : {}),
    provider: task.provider,
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
    ...(task.providerTaskId ? { providerTaskId: task.providerTaskId } : {}),
    ...(task.outputUrls.length ? { outputUrls: [...task.outputUrls] } : {}),
    ...(task.outputBase64.length ? { outputBase64: [...task.outputBase64] } : {}),
  };
}

export function getServerWorkspaceTasks(filters: { ownerId?: string; accountId?: string; mode?: WorkspaceTask['mode'] } = {}): WorkspaceTask[] {
  // Build the account lookup once per request. The previous per-task fallback
  // re-read accounts.json for every persisted task in an owner queue.
  const accountIndex = new Map(listStoredAccounts().map((account) => [account.id, account]));
  // The task name key includes account and mode, so the filtered snapshot is
  // sufficient to compute occurrence numbers without another disk read.
  const filteredProviderTasks = listProviderTasks({ accountId: filters.accountId, mode: filters.mode });
  const nameOccurrences = taskNameSequenceMap(filteredProviderTasks);
  const persisted = filteredProviderTasks.map((task) => providerTaskToWorkspaceTask(task, accountIndex, nameOccurrences));
  const accountOwners = filters.ownerId
    ? new Map([...accountIndex.values()].map((account) => [account.id, account.ownerId]))
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

/**
 * Overview-only task projection. Do not use getServerWorkspaceTasks here:
 * that function intentionally includes provider outputs for queue/review
 * pages, while the workspace landing page only needs counters and labels.
 */
export function getServerWorkspaceTaskSummaries(filters: { ownerId?: string; accountId?: string; mode?: WorkspaceTask['mode'] } = {}): WorkspaceTask[] {
  const accountIndex = new Map(listStoredAccounts().map((account) => [account.id, account]));
  const providerTasks = listProviderTaskSummaries({ accountId: filters.accountId, mode: filters.mode });
  const nameOccurrences = taskNameSequenceMap(providerTasks);
  const projected = providerTasks.map((task) => {
    const account = accountIndex.get(task.accountId) ?? getWorkspaceAccountById(task.accountId);
    const owner = typeof task.metadata?.ownerId === 'string' ? task.metadata.ownerId : account?.ownerId ?? 'operator-unassigned';
    return {
      id: task.id,
      accountId: task.accountId,
      ...(account?.name ? { accountName: account.name } : {}),
      pid: typeof task.metadata?.pid === 'string' ? task.metadata.pid : 'pending',
      title: taskNameForInventory(task, nameOccurrences.get(task.id)),
      owner,
      mode: task.mode,
      model: task.model || task.provider,
      status: task.status,
      progress: task.progress,
      createdAt: task.createdAt,
      ...(task.inventorySavedAt ? { inventorySavedAt: task.inventorySavedAt } : {}),
      ...(task.outputCount > 0 ? { outputCount: task.outputCount } : {}),
    } satisfies WorkspaceTask;
  });
  return projected.filter((task) => !filters.ownerId || task.owner === filters.ownerId);
}

export type WorkspaceOwnerTaskCounters = {
  inventorySavedToday: number;
  completedNotInInventory: number;
  running: number;
  queued: number;
  failed: number;
};

/** Queue cards need scheduler metadata, but never output URLs/Base64 or the
 * full provider response. This projection keeps queue polling lightweight. */
type WorkspaceQueueFilters = { ownerId?: string; accountId?: string; mode?: WorkspaceTask['mode']; date?: string };

export function getServerWorkspaceQueueTasks(filters: WorkspaceQueueFilters = {}, accounts = listStoredAccounts()): WorkspaceTask[] {
  const accountIndex = new Map(accounts.map((account) => [account.id, account]));
  const accountIds = filters.ownerId
    ? [...accountIndex.values()].filter((account) => account.ownerId === filters.ownerId).map((account) => account.id)
    : undefined;
  const providerTasks = listProviderTaskSummaries({
    accountId: filters.accountId,
    accountIds,
    mode: filters.mode,
    createdBusinessDate: filters.date,
  });
  const nameOccurrences = taskNameSequenceMap(providerTasks);
  return providerTasks
    .map((task) => {
      const account = accountIndex.get(task.accountId) ?? getWorkspaceAccountById(task.accountId);
      const owner = typeof task.metadata?.ownerId === 'string' ? task.metadata.ownerId : account?.ownerId ?? 'operator-unassigned';
      return {
        id: task.id,
        accountId: task.accountId,
        ...(account?.name ? { accountName: account.name } : {}),
        pid: typeof task.metadata?.pid === 'string' ? task.metadata.pid : 'pending',
        title: taskNameForInventory(task, nameOccurrences.get(task.id)),
        owner,
        mode: task.mode,
        model: task.model || task.provider,
        status: task.status,
        progress: task.progress,
        createdAt: task.createdAt,
        ...(task.inventorySavedAt ? { inventorySavedAt: task.inventorySavedAt } : {}),
        ...(task.outputCount > 0 ? { outputCount: task.outputCount } : {}),
        ...(task.error ? { error: task.error } : {}),
        ...(task.errorInfo ? { errorInfo: task.errorInfo } : {}),
        provider: task.provider,
        ...(task.providerTaskId ? { providerTaskId: task.providerTaskId } : {}),
        ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
        ...(task.metadata ? { metadata: task.metadata } : {}),
      } satisfies WorkspaceTask;
    })
    .filter((task) => !filters.ownerId || task.owner === filters.ownerId);
}

const queueDeltaCache = createQueueDeltaCache<WorkspaceTask>();

/** Tokens are private to one authenticated queue view. The bounded cache stores
 * only page projections; a task-store revision hit never materializes tasks. */
export function getServerWorkspaceQueueDelta(filters: WorkspaceQueueFilters, options: {
  viewer: string;
  searchParams: URLSearchParams;
  project?: (task: WorkspaceTask) => WorkspaceTask;
}) {
  const params = options.searchParams;
  const tabValue = params.get('tab');
  const tab: QueueTab = tabValue === 'active' || tabValue === 'completed' || tabValue === 'failed' ? tabValue : 'all';
  const numberParam = (key: string, fallback: number, maximum: number) => {
    const value = Number(params.get(key) ?? fallback);
    return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : fallback;
  };
  const page = numberParam('page', 0, 1_000_000);
  const pageSize = Math.max(1, numberParam('limit', 50, 100));
  const focusTaskId = params.get('focusTaskId')?.slice(0, 300) || undefined;
  const focusUnstored = params.get('focusUnstored') === '1';
  const scopedFilters = { ...filters, date: filters.date || businessDate() };
  const accounts = listStoredAccounts().filter((account) => (!filters.ownerId || account.ownerId === filters.ownerId) && (!filters.accountId || account.id === filters.accountId));
  // Account reassignment and renaming do not mutate provider tasks, so include
  // their current authoritative membership and labels in revision validation.
  const revision = JSON.stringify([getProviderTaskStoreRevision(), accounts.map(({ id, ownerId, name }) => [id, ownerId, name])]);
  const scope = JSON.stringify([options.viewer, scopedFilters, tab, page, pageSize, focusTaskId, focusUnstored]);
  return queueDeltaCache.read({
    scope,
    revision,
    since: params.get('since')?.slice(0, 300) || undefined,
    load: () => createQueuePage(
      getServerWorkspaceQueueTasks(scopedFilters, accounts).map(options.project ?? ((task) => task)),
      { tab, page, pageSize, focusTaskId, focusUnstored },
    ),
  });
}

const EMPTY_OWNER_TASK_COUNTERS: WorkspaceOwnerTaskCounters = {
  inventorySavedToday: 0,
  completedNotInInventory: 0,
  running: 0,
  queued: 0,
  failed: 0,
};

const taskCounterCache = new Map<string, Record<string, WorkspaceOwnerTaskCounters>>();

function copyTaskCounters(counters: Record<string, WorkspaceOwnerTaskCounters>): Record<string, WorkspaceOwnerTaskCounters> {
  return Object.fromEntries(Object.entries(counters).map(([ownerId, values]) => [ownerId, { ...values }]));
}

/**
 * Reuse unchanged counter projections across polling requests. Account owner
 * changes and Shanghai midnight invalidate independently of task revisions.
 */
export function getServerWorkspaceTaskCounters(filters: { ownerId?: string; accountId?: string; mode?: WorkspaceTask['mode'] } = {}, now: Date | string | number = new Date()): Record<string, WorkspaceOwnerTaskCounters> {
  const accounts = listStoredAccounts();
  const today = businessDate(now);
  const key = JSON.stringify([
    getProviderTaskStoreRevision(), today, filters.ownerId ?? null, filters.accountId ?? null, filters.mode ?? null,
    accounts.map(({ id, ownerId }) => [id, ownerId]),
  ]);
  const cached = taskCounterCache.get(key);
  if (cached) {
    taskCounterCache.delete(key);
    taskCounterCache.set(key, cached);
    return copyTaskCounters(cached);
  }
  const accountIndex = new Map(accounts.map((account) => [account.id, account]));
  const counters = new Map<string, WorkspaceOwnerTaskCounters>();
  // Metadata ownership historically overrides account ownership here, even
  // for reassigned/orphan tasks. An accountIds prefilter would change totals.
  for (const task of listProviderTaskSummaries({ accountId: filters.accountId, mode: filters.mode })) {
    const account = accountIndex.get(task.accountId) ?? getWorkspaceAccountById(task.accountId);
    const owner = typeof task.metadata?.ownerId === 'string' ? task.metadata.ownerId : account?.ownerId ?? 'operator-unassigned';
    if (filters.ownerId && owner !== filters.ownerId) continue;
    const current = counters.get(owner) ?? { ...EMPTY_OWNER_TASK_COUNTERS };
    const outputs = task.outputCount;
    const savedToday = outputs > 0 && Boolean(task.inventorySavedAt && businessDate(task.inventorySavedAt) === today);
    const completedNotInInventory = task.status === 'completed' && outputs > 0 && !task.inventorySavedAt && businessDate(task.createdAt) === today;
    // The landing counter is a count of successful inventory actions/tasks,
    // not the number of output files attached to each task.
    current.inventorySavedToday += savedToday ? 1 : 0;
    current.completedNotInInventory += completedNotInInventory ? 1 : 0;
    current.running += ['running', 'processing', 'submitting', 'submitted', 'prompting', 'retrying'].includes(task.status) ? 1 : 0;
    current.queued += task.status === 'queued' || task.status === 'retrying' ? 1 : 0;
    current.failed += task.status === 'failed' ? 1 : 0;
    counters.set(owner, current);
  }
  const result = Object.fromEntries(counters);
  taskCounterCache.set(key, result);
  while (taskCounterCache.size > 32) taskCounterCache.delete(taskCounterCache.keys().next().value!);
  return copyTaskCounters(result);
}
