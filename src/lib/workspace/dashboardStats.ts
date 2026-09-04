import type { WorkspaceAccount } from './data';
import { listStoredAccounts } from './accountStore';
import { withLiveAccountStatsList } from './accountStats';
import { getServerWorkspaceTasks } from './serverTasks';
import { businessDate, type WorkspaceTask } from './tasks';
import { countVideoOutputs } from '@/lib/providers/videoOutputUrls';

/**
 * Downstream performance is intentionally kept separate from production
 * counters.  The workspace has no trusted publisher/9001 sync store yet, so
 * these values stay zero until an upstream record is actually written.
 */
export type DownstreamTotals = {
  published: number;
  views: number;
  clicks: number;
  orders: number;
  gmv: number;
  refunds: number;
};

export type ProductionTaskStats = {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  paused: number;
  successfulOutputs: number;
  inventorySavedToday: number;
  completedNotInInventory: number;
  activeAccountsToday: number;
};

export type DashboardAccount = WorkspaceAccount & {
  published: number;
  views: number;
  orders: number;
  gmv: number;
  conversion: number;
  status: 'healthy' | 'attention';
};

export type DashboardVideo = {
  id: string;
  pid: string;
  account: string;
  title: string;
  publishedAt: string;
  views: number;
  clicks: number;
  likes: number;
  orders: number;
  gmv: number;
  cover: string;
};

export type DashboardProduct = {
  pid: string;
  title: string;
  mode: string;
  accounts: number;
  videos: number;
  gmv: number;
  status: string;
};

export type DashboardSnapshot = {
  accounts: DashboardAccount[];
  totals: DownstreamTotals;
  production: ProductionTaskStats;
  videos: DashboardVideo[];
  products: DashboardProduct[];
};

const EMPTY_TOTALS: DownstreamTotals = {
  published: 0,
  views: 0,
  clicks: 0,
  orders: 0,
  gmv: 0,
  refunds: 0,
};

function outputCount(task: WorkspaceTask): number {
  const inventoryIds = Array.isArray(task.metadata?.inventoryAssetIds)
    ? task.metadata.inventoryAssetIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  if (task.inventorySavedAt && inventoryIds.length > 0) return inventoryIds.length;
  return task.mode === 'video' ? countVideoOutputs(task.provider ?? '', task.outputUrls ?? [], task.outputBase64 ?? [], Boolean(task.providerTaskId)) : (task.outputUrls?.filter(Boolean).length ?? 0) + (task.outputBase64?.filter(Boolean).length ?? 0);
}

function isRunning(status: WorkspaceTask['status']): boolean {
  return ['prompting', 'submitting', 'submitted', 'processing', 'running', 'retrying'].includes(status);
}

/** Aggregate production counters from persisted tasks without mutating them. */
export function aggregateProductionTaskStats(tasks: readonly WorkspaceTask[], now: Date | string | number = new Date()): ProductionTaskStats {
  const today = businessDate(now);
  const activeAccounts = new Set<string>();
  const result = tasks.reduce<ProductionTaskStats>((summary, task) => {
    const outputs = outputCount(task);
    const completedWithOutput = task.status === 'completed' && outputs > 0;
    const savedToday = Boolean(outputs > 0 && task.inventorySavedAt && businessDate(task.inventorySavedAt) === today);
    const completedNotInInventory = task.status === 'completed' && outputs > 0 && !task.inventorySavedAt && businessDate(task.createdAt) === today;
    if (businessDate(task.createdAt) === today) activeAccounts.add(task.accountId);
    return {
      total: summary.total + 1,
      queued: summary.queued + (task.status === 'queued' || task.status === 'retrying' ? 1 : 0),
      running: summary.running + (isRunning(task.status) ? 1 : 0),
      completed: summary.completed + (task.status === 'completed' ? 1 : 0),
      failed: summary.failed + (task.status === 'failed' ? 1 : 0),
      paused: summary.paused + (task.status === 'paused' ? 1 : 0),
      successfulOutputs: summary.successfulOutputs + (completedWithOutput ? outputs : 0),
      inventorySavedToday: summary.inventorySavedToday + (savedToday ? outputs : 0),
      completedNotInInventory: summary.completedNotInInventory + (completedNotInInventory ? outputs : 0),
      activeAccountsToday: 0,
    };
  }, { total: 0, queued: 0, running: 0, completed: 0, failed: 0, paused: 0, successfulOutputs: 0, inventorySavedToday: 0, completedNotInInventory: 0, activeAccountsToday: 0 });
  return { ...result, activeAccountsToday: activeAccounts.size };
}

function accountRows(accounts: readonly WorkspaceAccount[]): DashboardAccount[] {
  return accounts.map((account) => ({
    ...account,
    // These fields are populated only by an authorised downstream sync. Do
    // not infer publishing performance from generated assets or tasks.
    published: account.publishedCount,
    views: 0,
    orders: 0,
    gmv: 0,
    conversion: 0,
    status: account.planStatus === 'draft' ? 'attention' : 'healthy',
  }));
}

/** Build the server-side snapshot consumed by the overview and tables. */
export function getDashboardSnapshot(now: Date | string | number = new Date()): DashboardSnapshot {
  const accounts = accountRows(withLiveAccountStatsList(listStoredAccounts()));
  const tasks = getServerWorkspaceTasks();
  return {
    accounts,
    totals: { ...EMPTY_TOTALS },
    production: aggregateProductionTaskStats(tasks, now),
    // No verified downstream publishing source exists yet. Keep these arrays
    // empty rather than exposing the old demonstration records.
    videos: [],
    products: [],
  };
}
