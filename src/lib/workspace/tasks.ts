export type WorkspaceTaskStatus = 'draft' | 'queued' | 'prompting' | 'submitting' | 'submitted' | 'processing' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled' | 'paused';

export type WorkspaceTask = {
  id: string;
  accountId: string;
  accountName?: string;
  pid: string;
  title: string;
  owner: string;
  mode: 'image' | 'prompt' | 'video';
  model: string;
  prompt?: string;
  status: WorkspaceTaskStatus;
  progress: number;
  createdAt: string;
  inventorySavedAt?: string;
  outputCount?: number;
  error?: string;
  errorInfo?: {
    code: string;
    category: string;
    title: string;
    message: string;
    action: string;
    safeToRetry: boolean;
  };
  provider?: string;
  providerTaskId?: string;
  outputUrls?: string[];
  outputBase64?: string[];
  providerResponse?: unknown;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type WorkspaceTaskSummary = {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  paused: number;
  inventorySavedToday: number;
  completedNotInInventory: number;
};

// Runtime tasks are persisted by the provider task store. Keep the initial
// catalogue empty so the queue and all status counters start at truthful zero
// instead of displaying fabricated demonstration jobs.
export const workspaceTasks: WorkspaceTask[] = [];

export function getWorkspaceTasks(filters: { ownerId?: string } = {}): WorkspaceTask[] {
  return workspaceTasks
    .filter((task) => !filters.ownerId || task.owner === filters.ownerId)
    .map((task) => ({ ...task, outputUrls: task.outputUrls ? [...task.outputUrls] : undefined, outputBase64: task.outputBase64 ? [...task.outputBase64] : undefined }));
}

const SHANGHAI_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function businessDate(value: Date | string | number = new Date()): string {
  return SHANGHAI_FORMATTER.format(new Date(value));
}

export function isInventorySavedToday(task: WorkspaceTask, now: Date | string | number = new Date()): boolean {
  return Boolean(task.inventorySavedAt && businessDate(task.inventorySavedAt) === businessDate(now));
}

export function isCompletedNotInInventory(task: WorkspaceTask, now: Date | string | number = new Date()): boolean {
  return task.status === 'completed' && !task.inventorySavedAt && businessDate(task.createdAt) === businessDate(now);
}

export function summarizeWorkspaceTasks(tasks: readonly WorkspaceTask[], now: Date | string | number = new Date()): WorkspaceTaskSummary {
  return tasks.reduce<WorkspaceTaskSummary>((summary, task) => ({
    total: summary.total + 1,
    queued: summary.queued + (task.status === 'queued' || task.status === 'retrying' ? 1 : 0),
    running: summary.running + (task.status === 'running' || task.status === 'retrying' ? 1 : 0),
    completed: summary.completed + (task.status === 'completed' ? 1 : 0),
    failed: summary.failed + (task.status === 'failed' ? 1 : 0),
    paused: summary.paused + (task.status === 'paused' ? 1 : 0),
    // These dashboard values represent successful task-level inventory
    // actions, so one task counts once even when it contains multiple files.
    inventorySavedToday: summary.inventorySavedToday + (isInventorySavedToday(task, now) ? 1 : 0),
    completedNotInInventory: summary.completedNotInInventory + (isCompletedNotInInventory(task, now) ? 1 : 0),
  }), { total: 0, queued: 0, running: 0, completed: 0, failed: 0, paused: 0, inventorySavedToday: 0, completedNotInInventory: 0 });
}

export function filterWorkspaceTasks(tasks: readonly WorkspaceTask[], status: WorkspaceTaskStatus | 'all'): WorkspaceTask[] {
  return status === 'all' ? [...tasks] : tasks.filter((task) => task.status === status);
}
