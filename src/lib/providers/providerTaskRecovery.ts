import { getProviderTask, listProviderTaskSummaries, updateProviderTask, type ProviderTask, type ProviderTaskStatus, type ProviderTaskSummary } from './taskStore';
import { isProviderLiveEnabled, type ProviderId } from './config';
import { providerResponseSnapshot, syncProviderTask } from './client';
import { canonicalTaskProgress } from './taskProgress';
import { cacheVideoTaskOutputsBeforeCompletion, localVideoOutputUrls } from '@/lib/workspace/videoInventory';
import { cacheImageTaskOutputsBeforeCompletion, localImageOutputUrls } from '@/lib/workspace/imageInventory';
import { workspaceOwnerIdForAccount } from '@/lib/workspace/access';

const ACTIVE_PROVIDER_STATUSES = new Set<ProviderTaskStatus>(['queued', 'submitting', 'submitted', 'processing', 'running', 'paused']);
const DEFAULT_PROVIDER_ACTIVE_STALE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RECOVERY_INTERVAL_MS = 15_000;
const DEFAULT_RECOVERY_BATCH_SIZE = 12;
const DEFAULT_STALE_RECOVERY_RECHECK_MS = 5 * 60 * 1000;
const POLL_METADATA_WRITE_MS = 60_000;

type RecoveryCallbacks = {
  onTaskFinalized?: (task: ProviderTask) => void;
};

export type ProviderTaskSyncOptions = {
  force?: boolean;
  /** Active task has exceeded the stale window; non-terminal upstream status becomes provider_task_stale. */
  finalIfStale?: boolean;
  /** Failed provider_task_stale task is being checked without creating a new upstream request. */
  recoverStaleFailed?: boolean;
  source?: string;
};

const syncInFlight = new Map<string, Promise<ProviderTask | null>>();
const syncLastStartedAt = new Map<string, number>();
let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerRunning = false;
let workerCallbacks: RecoveryCallbacks = {};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : fallback;
}

function positiveDuration(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function providerActiveStaleMs(): number {
  return positiveDuration(process.env.WORKSPACE_PROVIDER_ACTIVE_STALE_MS, DEFAULT_PROVIDER_ACTIVE_STALE_MS);
}

function recoveryIntervalMs(): number {
  return positiveDuration(process.env.WORKSPACE_PROVIDER_RECOVERY_INTERVAL_MS, DEFAULT_RECOVERY_INTERVAL_MS);
}

function recoveryBatchSize(): number {
  return positiveInteger(process.env.WORKSPACE_PROVIDER_RECOVERY_BATCH_SIZE, DEFAULT_RECOVERY_BATCH_SIZE);
}

export function ownerIdForProviderTask(task: Pick<ProviderTask, 'accountId' | 'metadata'>): string {
  const mapped = workspaceOwnerIdForAccount(task.accountId);
  if (mapped?.trim()) return mapped.trim();
  const owner = task.metadata?.ownerId;
  return typeof owner === 'string' && owner.trim() ? owner.trim() : task.accountId;
}

type RecoverableTaskView = Pick<ProviderTaskSummary, 'id' | 'accountId' | 'mode' | 'provider' | 'status' | 'providerTaskId' | 'metadata' | 'createdAt' | 'updatedAt' | 'error'>;

function providerActiveAnchorMs(task: RecoverableTaskView): number {
  const candidates = [
    task.metadata?.providerTaskAcceptedAt,
    task.metadata?.schedulerStartedAt,
    task.createdAt,
  ];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const updatedAt = Date.parse(task.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt : Date.now();
}

function isProviderActive(task: RecoverableTaskView): boolean {
  if (!task.providerTaskId || (task.mode !== 'video' && task.mode !== 'image')) return false;
  if (!isProviderLiveEnabled(task.provider)) return false;
  if (task.status === 'queued') return task.metadata?.schedulerState === 'provider-active' || Boolean(task.providerTaskId);
  return ACTIVE_PROVIDER_STATUSES.has(task.status);
}

function isStaleActive(task: RecoverableTaskView, now = Date.now()): boolean {
  return isProviderActive(task) && now - providerActiveAnchorMs(task) >= providerActiveStaleMs();
}

function shouldPollActive(task: RecoverableTaskView): boolean {
  return isProviderActive(task);
}

function shouldRecoverFailedStale(task: RecoverableTaskView, now = Date.now()): boolean {
  if ((task.mode !== 'video' && task.mode !== 'image') || task.status !== 'failed' || task.error !== 'provider_task_stale') return false;
  if (!task.providerTaskId || !isProviderLiveEnabled(task.provider)) return false;
  const checkedAt = typeof task.metadata?.providerStaleRecoverCheckedAt === 'string'
    ? Date.parse(task.metadata.providerStaleRecoverCheckedAt)
    : 0;
  return !Number.isFinite(checkedAt) || checkedAt <= 0 || now - checkedAt >= DEFAULT_STALE_RECOVERY_RECHECK_MS;
}

function syncKey(task: ProviderTask): string {
  return `${task.provider}:${task.providerTaskId ?? task.id}`;
}

function shouldWriteNonTerminalUpdate(task: ProviderTask, status: ProviderTaskStatus, progress: number): boolean {
  if (task.status !== status || task.progress !== progress) return true;
  const lastSyncAt = typeof task.metadata?.lastProviderSyncAt === 'string'
    ? Date.parse(task.metadata.lastProviderSyncAt)
    : 0;
  return !Number.isFinite(lastSyncAt) || lastSyncAt <= 0 || Date.now() - lastSyncAt >= POLL_METADATA_WRITE_MS;
}

function statusForProvider(status: string): ProviderTaskStatus {
  if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'paused' || status === 'queued' || status === 'running' || status === 'processing' || status === 'submitted') return status;
  return 'running';
}

function terminal(status: ProviderTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function markProviderTaskStale(task: ProviderTask, detail?: { response?: unknown; error?: unknown; source?: string }): ProviderTask | null {
  const now = new Date().toISOString();
  return updateProviderTask(task.id, {
    status: 'failed',
    progress: 100,
    error: 'provider_task_stale',
    providerResponse: detail?.response !== undefined || detail?.error
      ? providerResponseSnapshot(detail.error ?? new Error('provider_task_stale'), { body: detail.response, method: 'GET' })
      : task.providerResponse,
    metadata: {
      ...(task.metadata ?? {}),
      schedulerState: 'terminal',
      providerTaskStaleAt: now,
      providerTaskFinalSyncAt: now,
      schedulerFinishedAt: now,
      ...(detail?.source ? { providerTaskFinalSyncSource: detail.source } : {}),
    },
  }, task.updatedAt);
}

async function applyProviderStatus(
  task: ProviderTask,
  status: Awaited<ReturnType<typeof syncProviderTask>>,
  options: ProviderTaskSyncOptions,
): Promise<ProviderTask | null> {
  const latest = getProviderTask(task.id);
  if (!latest || (latest.mode !== 'video' && latest.mode !== 'image') || latest.providerTaskId !== task.providerTaskId || latest.status === 'cancelled' || latest.status === 'paused') return latest;
  const now = new Date().toISOString();
  const normalizedStatus = status.status === 'unknown' ? latest.status : statusForProvider(status.status);
  const providerTaskId = status.providerTaskId ?? latest.providerTaskId;
  const baseMetadata = {
    ...(latest.metadata ?? {}),
    schedulerState: terminal(normalizedStatus) ? 'terminal' : 'provider-active',
    providerTaskAcceptedAt: typeof latest.metadata?.providerTaskAcceptedAt === 'string'
      ? latest.metadata.providerTaskAcceptedAt
      : typeof latest.metadata?.schedulerStartedAt === 'string'
        ? latest.metadata.schedulerStartedAt
        : latest.createdAt,
    lastProviderSyncAt: now,
    lastProviderStatus: status.status,
    ...(options.source ? { lastProviderSyncSource: options.source } : {}),
  };

  if (normalizedStatus === 'completed') {
    const cacheTask: ProviderTask = {
      ...latest,
      status: 'completed',
      progress: 100,
      providerTaskId,
      outputUrls: status.outputUrls,
      outputBase64: status.outputBase64,
    };
    // Preserve the supplier response before downloading anything. A worker
    // crash during caching must resume these outputs, never the POST request.
    const checkpoint = updateProviderTask(latest.id, { status: 'processing', outputUrls: status.outputUrls, outputBase64: status.outputBase64, metadata: { ...(latest.metadata ?? {}), ...baseMetadata, schedulerState: 'provider-active' } }, latest.updatedAt);
    if (!checkpoint) return getProviderTask(latest.id);
    const cache = latest.mode === 'image'
      ? await cacheImageTaskOutputsBeforeCompletion(latest.accountId, cacheTask)
      : await cacheVideoTaskOutputsBeforeCompletion(latest.accountId, cacheTask);
    const afterCache = getProviderTask(latest.id);
    if (!afterCache || afterCache.providerTaskId !== task.providerTaskId || afterCache.status === 'cancelled' || afterCache.status === 'paused') return afterCache;
    const noOutput = cache.expected === 0;
    const cachePending = cache.expected > 0 && !cache.ready;
    const finalStatus: ProviderTaskStatus = noOutput ? 'failed' : cachePending ? 'processing' : 'completed';
    return updateProviderTask(latest.id, {
      status: finalStatus,
      progress: canonicalTaskProgress({
        mode: latest.mode,
        status: finalStatus,
        progress: status.progress,
        providerTaskId,
        schedulerState: cachePending ? 'provider-active' : 'terminal',
        localOutputReady: cache.ready,
        localOutputPending: cachePending,
      }),
      providerTaskId,
      outputUrls: cache.ready && cache.expected > 0 ? latest.mode === 'image' ? localImageOutputUrls(latest.accountId, cacheTask) : localVideoOutputUrls(latest.accountId, latest.id, cache.expected) : status.outputUrls,
      outputBase64: cache.ready && cache.expected > 0 ? [] : status.outputBase64,
      error: noOutput ? 'provider_upstream_failed' : undefined,
      providerResponse: noOutput
        ? providerResponseSnapshot(new Error('provider_upstream_failed'), { body: status.response, method: 'GET' })
        : undefined,
      metadata: {
        ...baseMetadata,
        ...(afterCache.metadata ?? {}),
        schedulerState: finalStatus === 'completed' || finalStatus === 'failed' ? 'terminal' : 'provider-active',
        ...(finalStatus === 'completed' || finalStatus === 'failed' ? { schedulerFinishedAt: now } : {}),
        localOutputCount: cache.cached,
        localOutputExpected: cache.expected,
        localOutputReady: cache.ready,
        ...(options.recoverStaleFailed ? { providerStaleRecoveredAt: now } : {}),
      },
    }, afterCache.updatedAt);
  }

  if (normalizedStatus === 'failed' || normalizedStatus === 'cancelled') {
    return updateProviderTask(latest.id, {
      status: normalizedStatus,
      progress: 100,
      providerTaskId,
      outputUrls: status.outputUrls,
      outputBase64: status.outputBase64,
      error: status.error || 'provider_upstream_failed',
      providerResponse: providerResponseSnapshot(new Error(status.error || 'provider_upstream_failed'), { body: status.response, method: 'GET' }),
      metadata: {
        ...baseMetadata,
        schedulerState: 'terminal',
        schedulerFinishedAt: now,
        lastProviderFailure: latest.provider,
        ...(options.recoverStaleFailed ? { providerStaleRecoveredAt: now } : {}),
      },
    }, latest.updatedAt);
  }

  if (options.finalIfStale) return markProviderTaskStale(latest, { response: status.response, source: options.source });

  if (options.recoverStaleFailed && latest.status === 'failed' && latest.error === 'provider_task_stale') {
    return updateProviderTask(latest.id, {
      status: 'failed',
      progress: 100,
      error: 'provider_task_stale',
      providerResponse: providerResponseSnapshot(new Error('provider_task_stale'), { body: status.response, method: 'GET' }),
      metadata: {
        ...(latest.metadata ?? {}),
        providerStaleRecoverCheckedAt: now,
        providerStaleRecoverStatus: status.status,
      },
    }, latest.updatedAt);
  }

  const nextProgress = canonicalTaskProgress({
    mode: latest.mode,
    status: normalizedStatus,
    progress: status.progress,
    providerTaskId,
    schedulerState: 'provider-active',
  });
  if (!shouldWriteNonTerminalUpdate(latest, normalizedStatus, nextProgress)) return latest;
  return updateProviderTask(latest.id, {
    status: normalizedStatus,
    progress: nextProgress,
    providerTaskId,
    outputUrls: status.outputUrls.length ? status.outputUrls : latest.outputUrls,
    outputBase64: status.outputBase64.length ? status.outputBase64 : latest.outputBase64,
    error: undefined,
    metadata: baseMetadata,
  }, latest.updatedAt);
}

export function syncMediaProviderTask(taskOrId: ProviderTask | string, options: ProviderTaskSyncOptions = {}): Promise<ProviderTask | null> {
  const initial = typeof taskOrId === 'string' ? getProviderTask(taskOrId) : taskOrId;
  if (!initial || (initial.mode !== 'video' && initial.mode !== 'image') || !initial.providerTaskId || !isProviderLiveEnabled(initial.provider)) return Promise.resolve(initial ?? null);
  const key = syncKey(initial);
  const existing = syncInFlight.get(key);
  if (existing) return existing;
  const now = Date.now();
  if (!options.force && now - (syncLastStartedAt.get(key) ?? 0) < 10_000) return Promise.resolve(initial);
  syncLastStartedAt.set(key, now);
  const run = (async () => {
    const latest = getProviderTask(initial.id);
    if (!latest || (latest.mode !== 'video' && latest.mode !== 'image') || !latest.providerTaskId) return latest;
    try {
      const status = await syncProviderTask(latest.provider, latest.providerTaskId);
      const updated = await applyProviderStatus(latest, status, options);
      return updated;
    } catch (error) {
      const current = getProviderTask(latest.id);
      if (!current) return null;
      if (current.status === 'cancelled' || current.status === 'paused' || current.providerTaskId !== latest.providerTaskId) return current;
      if (options.finalIfStale) return markProviderTaskStale(current, { error, source: options.source });
      if (options.recoverStaleFailed && current.status === 'failed' && current.error === 'provider_task_stale') {
        return updateProviderTask(current.id, {
          status: 'failed',
          progress: 100,
          error: 'provider_task_stale',
          providerResponse: providerResponseSnapshot(error),
          metadata: {
            ...(current.metadata ?? {}),
            providerStaleRecoverCheckedAt: new Date().toISOString(),
            providerStaleRecoverStatus: 'sync_failed',
          },
        }, current.updatedAt);
      }
      return current;
    }
  })().finally(() => {
    syncInFlight.delete(key);
  });
  syncInFlight.set(key, run);
  return run;
}

export const syncVideoProviderTask = syncMediaProviderTask;

function fairSelect<T extends RecoverableTaskView>(tasks: T[], limit: number): T[] {
  const groups = new Map<string, T[]>();
  for (const task of tasks) {
    const key = `${ownerIdForProviderTask(task)}:${task.provider}`;
    const group = groups.get(key) ?? [];
    group.push(task);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  }
  const selected: T[] = [];
  while (selected.length < limit && groups.size > 0) {
    for (const [key, group] of groups) {
      const task = group.shift();
      if (task) selected.push(task);
      if (!group.length) groups.delete(key);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

export async function runProviderTaskRecoveryPass(options: { limit?: number } = {}): Promise<ProviderTask[]> {
  if (process.env.NODE_ENV === 'test' || process.env.WORKSPACE_PROVIDER_WORKER !== 'true') return [];
  const now = Date.now();
  const limit = options.limit ?? recoveryBatchSize();
  // This worker runs periodically while users are clicking through the UI.
  // Never read/clone full provider tasks here: production tasks can contain
  // megabytes of prompt/provider metadata, and cloning them blocks the Node
  // event loop. Use the bounded summary projection and load full records only
  // for the small selected batch.
  const tasks = listProviderTaskSummaries({ statuses: [...ACTIVE_PROVIDER_STATUSES, 'failed'] });
  const staleActive = tasks.filter((task) => isStaleActive(task, now));
  const active = tasks.filter((task) => shouldPollActive(task) && !isStaleActive(task, now));
  const failedStale = tasks.filter((task) => shouldRecoverFailedStale(task, now));
  const selected = [
    ...fairSelect(staleActive, limit),
    ...fairSelect(active, Math.max(0, limit - Math.min(limit, staleActive.length))),
  ].slice(0, limit);
  if (selected.length < limit) selected.push(...fairSelect(failedStale, limit - selected.length));

  const updated: ProviderTask[] = [];
  for (const task of selected) {
    const next = await syncMediaProviderTask(task.id, {
      force: isStaleActive(task, now) || task.status === 'failed',
      finalIfStale: isStaleActive(task, now),
      recoverStaleFailed: task.status === 'failed' && task.error === 'provider_task_stale',
      source: task.status === 'failed' ? 'stale-recovery' : isStaleActive(task, now) ? 'stale-final-sync' : 'background-worker',
    }).catch(() => null);
    if (next) updated.push(next);
    if (next && terminal(next.status)) workerCallbacks.onTaskFinalized?.(next);
  }
  return updated;
}

export function ensureProviderTaskRecoveryWorker(callbacks: RecoveryCallbacks = {}): void {
  workerCallbacks = { ...workerCallbacks, ...callbacks };
  if (process.env.NODE_ENV === 'test' || process.env.WORKSPACE_PROVIDER_WORKER !== 'true' || workerTimer) return;
  const tick = () => {
    if (workerRunning) return;
    workerRunning = true;
    void runProviderTaskRecoveryPass().finally(() => { workerRunning = false; });
  };
  workerTimer = setInterval(tick, recoveryIntervalMs());
  workerTimer.unref?.();
  void Promise.resolve().then(tick);
}
