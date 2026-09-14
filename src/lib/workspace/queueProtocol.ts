export type QueueTab = 'all' | 'active' | 'completed' | 'failed';

export type QueueCounts = {
  all: number;
  active: number;
  completed: number;
  failed: number;
  unsaved: number;
  safeRecoverable: number;
};

export type QueueRow = {
  id: string;
  status: string;
  createdAt: string;
  inventorySavedAt?: string;
  mode?: string;
  errorInfo?: { safeToRetry?: boolean };
};

export type QueuePage<T extends QueueRow> = {
  tasks: T[];
  counts: QueueCounts;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type QueueDelta<T extends QueueRow> = QueuePage<T> & {
  deletedTaskIds: string[];
  token: string;
  reset: boolean;
};

const ACTIVE_STATUSES = new Set([
  'draft', 'queued', 'prompting', 'submitting', 'submitted',
  'processing', 'running', 'retrying', 'paused',
]);

function compareRows(a: QueueRow, b: QueueRow): number {
  const createdAtDifference = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (Number.isFinite(createdAtDifference) && createdAtDifference !== 0) return createdAtDifference;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isUnsavedVideo(task: QueueRow): boolean {
  return task.mode === 'video' && task.status === 'completed' && !task.inventorySavedAt;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value === undefined || Number.isNaN(value) ? fallback : value)));
}

export function createQueuePage<T extends QueueRow>(
  tasks: readonly T[],
  options: { tab?: QueueTab; page?: number; pageSize?: number; focusTaskId?: string; focusUnstored?: boolean },
): QueuePage<T> {
  const tab = options.tab ?? 'all';
  const pageSize = clampInteger(options.pageSize, 50, 1, 100);
  const counts: QueueCounts = { all: tasks.length, active: 0, completed: 0, failed: 0, unsaved: 0, safeRecoverable: 0 };
  for (const task of tasks) {
    if (ACTIVE_STATUSES.has(task.status)) counts.active += 1;
    if (task.status === 'completed') counts.completed += 1;
    if (task.status === 'failed') counts.failed += 1;
    if (isUnsavedVideo(task)) counts.unsaved += 1;
    if (task.status === 'failed' && task.errorInfo?.safeToRetry) counts.safeRecoverable += 1;
  }

  const filtered = tasks.filter((task) => tab === 'all'
    || (tab === 'active' ? ACTIVE_STATUSES.has(task.status) : task.status === tab)).sort(compareRows);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  let page = clampInteger(options.page, 0, 0, totalPages - 1);
  const focusedIndex = options.focusTaskId
    ? filtered.findIndex((task) => task.id === options.focusTaskId)
    : options.focusUnstored ? filtered.findIndex(isUnsavedVideo) : -1;
  if (focusedIndex >= 0) page = Math.floor(focusedIndex / pageSize);

  return { tasks: filtered.slice(page * pageSize, (page + 1) * pageSize), counts, page, pageSize, totalPages };
}

type QueueSnapshot<T extends QueueRow> = {
  scope: string;
  revision: string | number;
  expiresAt: number;
  page: QueuePage<T>;
  rows: Map<string, string>;
};

export function createQueueDeltaCache<T extends QueueRow>(
  options: { maxSnapshots?: number; ttlMs?: number; now?: () => number } = {},
) {
  const maxSnapshots = clampInteger(options.maxSnapshots, 64, 1, 64);
  const ttlMs = options.ttlMs !== undefined && Number.isFinite(options.ttlMs)
    ? Math.max(1, options.ttlMs) : 5 * 60 * 1000;
  const now = options.now ?? Date.now;
  const snapshots = new Map<string, QueueSnapshot<T>>();

  return {
    read({ scope, revision, since, load }: {
      scope: string;
      revision: string | number;
      since?: string;
      load: () => QueuePage<T>;
    }): QueueDelta<T> {
      const time = now();
      for (const [token, snapshot] of snapshots) {
        if (snapshot.expiresAt <= time) snapshots.delete(token);
      }
      const candidate = since ? snapshots.get(since) : undefined;
      const previous = candidate?.scope === scope ? candidate : undefined;
      let currentToken: string | undefined;
      let current: QueueSnapshot<T> | undefined;
      for (const [token, snapshot] of snapshots) {
        if (snapshot.scope === scope && snapshot.revision === revision) {
          currentToken = token;
          current = snapshot;
          break;
        }
      }

      if (current && currentToken) {
        snapshots.delete(currentToken);
        snapshots.set(currentToken, current);
      } else {
        const page = load();
        current = {
          scope, revision, expiresAt: time + ttlMs, page,
          rows: new Map(page.tasks.map((task) => [task.id, JSON.stringify(task)])),
        };
        currentToken = globalThis.crypto.randomUUID();
        snapshots.set(currentToken, current);
        while (snapshots.size > maxSnapshots) snapshots.delete(snapshots.keys().next().value!);
      }

      // Validate the caller's baseline even on a revision cache hit: an evicted
      // or different-scope token must reset rows that are no longer on the page.
      const tasks = previous
        ? current.page.tasks.filter((task) => current.rows.get(task.id) !== previous.rows.get(task.id))
        : [...current.page.tasks];
      const deletedTaskIds = previous
        ? [...previous.rows.keys()].filter((id) => !current.rows.has(id)) : [];
      return { ...current.page, tasks, deletedTaskIds, token: currentToken, reset: !previous };
    },
  };
}

export function mergeQueueDelta<T extends QueueRow>(previous: readonly T[], delta: QueueDelta<T>): T[] {
  const previousById = new Map(previous.map((task) => [task.id, task]));
  const nextById = delta.reset ? new Map<string, T>() : new Map(previousById);
  for (const id of delta.deletedTaskIds) nextById.delete(id);
  for (const task of delta.tasks) {
    const existing = previousById.get(task.id);
    nextById.set(task.id, existing && JSON.stringify(existing) === JSON.stringify(task) ? existing : task);
  }
  const next = [...nextById.values()].sort(compareRows);
  if (next.length === previous.length && next.every((task, index) => task === previous[index])) return previous as T[];
  return next;
}
