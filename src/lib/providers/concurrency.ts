import { getProviderTask, listProviderTasks, updateProviderTask, type ProviderTask, type ProviderTaskMode, type ProviderTaskStatus } from './taskStore';

/**
 * Workspace production concurrency policy.
 *
 * An operator may run up to 20 image/video jobs combined at the same time.
 * Within that shared pool, one model is capped at five active jobs. The
 * limits can be tuned through environment variables without changing source.
 */
export const DEFAULT_MODEL_CONCURRENCY = 5;
export const DEFAULT_IMAGE_CONCURRENCY = 20;
export const DEFAULT_VIDEO_CONCURRENCY = 20;

export type ProductionMode = 'image' | 'video';
export type ConcurrencyLimits = { model: number; image: number; video: number };
export type SchedulerJob = {
  taskId: string;
  ownerId: string;
  mode: ProductionMode;
  model: string;
  run: () => Promise<void>;
};

type Scope = { ownerId: string; mode: ProductionMode };

// Only work that has actually started at the provider consumes a concurrency
// slot. A task waiting in the local queue is intentionally unlimited and does
// not count toward either the per-model or operator-wide execution limit.
const ACTIVE_STATUSES: readonly ProviderTaskStatus[] = ['prompting', 'submitting', 'submitted', 'processing', 'running'];
const WAITING_STATE = 'waiting';
const PROVIDER_ACTIVE_STATE = 'provider-active';
const DISPATCHING_STATE = 'dispatching';

/** Jobs are process-local, while task state remains persisted on D:. */
const pendingJobs: SchedulerJob[] = [];
const registeredJobs = new Map<string, SchedulerJob>();
const MAX_REGISTERED_JOBS = 256;
const MAX_PENDING_JOBS = 1_000;
const reservations = new Map<string, Scope>();
const pumpingScopes = new Set<string>();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : fallback;
}

export function getConcurrencyLimits(env: Readonly<Record<string, string | undefined>> = process.env): ConcurrencyLimits {
  return {
    model: positiveInteger(env.WORKSPACE_MODEL_CONCURRENCY, DEFAULT_MODEL_CONCURRENCY),
    image: positiveInteger(env.WORKSPACE_IMAGE_CONCURRENCY, DEFAULT_IMAGE_CONCURRENCY),
    video: positiveInteger(env.WORKSPACE_VIDEO_CONCURRENCY, DEFAULT_VIDEO_CONCURRENCY),
  };
}

export function schedulerState(task: Pick<ProviderTask, 'metadata'>): string | undefined {
  const value = task.metadata?.schedulerState;
  return typeof value === 'string' ? value : undefined;
}

export function taskOwnerId(task: Pick<ProviderTask, 'accountId' | 'metadata'>): string {
  const owner = task.metadata?.ownerId;
  return typeof owner === 'string' && owner.trim() ? owner.trim() : task.accountId;
}

export function taskModelId(task: Pick<ProviderTask, 'provider' | 'model' | 'metadata'>): string {
  const model = typeof task.model === 'string' && task.model.trim()
    ? task.model.trim()
    : typeof task.metadata?.modelId === 'string' && task.metadata.modelId.trim()
      ? task.metadata.modelId.trim()
      : task.provider;
  return model.toLowerCase();
}

export function isSchedulerWaiting(task: Pick<ProviderTask, 'status' | 'metadata'>): boolean {
  return schedulerState(task) === WAITING_STATE;
}

export function isPersistedActiveTask(task: Pick<ProviderTask, 'status' | 'metadata' | 'providerTaskId'>): boolean {
  if (ACTIVE_STATUSES.includes(task.status)) return !isSchedulerWaiting(task);
  // A paused task that already has a provider task is still consuming an
  // upstream slot because the current pause action is local-only.
  if (task.status === 'paused' && Boolean(task.providerTaskId)) return true;
  // `queued` is ambiguous: it is either waiting locally or waiting at the
  // provider after a successful submission. Only the latter consumes a slot.
  return task.status === 'queued' && (schedulerState(task) === PROVIDER_ACTIVE_STATE || Boolean(task.providerTaskId));
}

function scopeKey(scope: Scope): string {
  return scope.ownerId;
}

function modeLimit(mode: ProductionMode, limits: ConcurrencyLimits): number {
  return Math.min(limits.image, limits.video);
}

function currentCounts(scope: Scope): { total: number; byModel: Map<string, number> } {
  const byModel = new Map<string, number>();
  let total = 0;
  for (const task of listProviderTasks()) {
    if (taskOwnerId(task) !== scope.ownerId || !isPersistedActiveTask(task)) continue;
    total += 1;
    const model = taskModelId(task);
    byModel.set(model, (byModel.get(model) ?? 0) + 1);
  }
  return { total, byModel };
}

function canStart(job: SchedulerJob, counts: { total: number; byModel: Map<string, number> }, limits: ConcurrencyLimits): boolean {
  if (counts.total >= modeLimit(job.mode, limits)) return false;
  return (counts.byModel.get(job.model.toLowerCase()) ?? 0) < limits.model;
}

function markDispatching(job: SchedulerJob): void {
  const current = getProviderTask(job.taskId);
  if (!current) return;
  updateProviderTask(job.taskId, {
    status: 'submitting',
    progress: Math.max(current.progress, 5),
    metadata: {
      ...(current.metadata ?? {}),
      schedulerState: DISPATCHING_STATE,
      schedulerOwnerId: job.ownerId,
      schedulerMode: job.mode,
      schedulerModel: job.model,
      schedulerStartedAt: new Date().toISOString(),
    },
  });
}

function markFinishedState(taskId: string): void {
  const current = getProviderTask(taskId);
  if (!current) return;
  const active = ACTIVE_STATUSES.includes(current.status) || (current.status === 'queued' && Boolean(current.providerTaskId));
  updateProviderTask(taskId, {
    metadata: {
      ...(current.metadata ?? {}),
      schedulerState: active ? PROVIDER_ACTIVE_STATE : 'terminal',
      ...(active ? {} : { schedulerFinishedAt: new Date().toISOString() }),
    },
  });
}

async function pumpScope(scope: Scope): Promise<void> {
  const key = scopeKey(scope);
  if (pumpingScopes.has(key)) return;
  pumpingScopes.add(key);
  try {
    const limits = getConcurrencyLimits();
    for (;;) {
      const counts = currentCounts(scope);
      // Image and video jobs share the operator-wide pool. Looking only at
      // the mode that happened to release a slot can strand jobs from the
      // other mode indefinitely, so dispatch the first runnable job for the
      // owner regardless of its media mode.
      const index = pendingJobs.findIndex((job) => job.ownerId === scope.ownerId && canStart(job, counts, limits));
      if (index < 0) break;
      const [job] = pendingJobs.splice(index, 1);
      const current = getProviderTask(job.taskId);
      if (!current || ['cancelled', 'failed', 'completed'].includes(current.status)) continue;
      reservations.set(job.taskId, scope);
      markDispatching(job);
      void (async () => {
        try {
          await job.run();
        } catch {
          const current = getProviderTask(job.taskId);
          if (current && ['submitting', 'queued'].includes(current.status)) {
            updateProviderTask(job.taskId, { status: 'failed', progress: 100, error: 'scheduler_dispatch_failed' });
          }
        } finally {
          const finished = getProviderTask(job.taskId);
          if (finished?.status === 'completed') registeredJobs.delete(job.taskId);
          markFinishedState(job.taskId);
          reservations.delete(job.taskId);
          void pumpScope(scope);
        }
      })();
    }
  } finally {
    pumpingScopes.delete(key);
  }
}

/** Enqueue a live image/video submission and start it when its limits allow. */
export function enqueueProviderTask(job: SchedulerJob): void {
  const normalized: SchedulerJob = { ...job, ownerId: job.ownerId.trim() || 'unassigned', model: job.model.trim() || 'unknown' };
  while (registeredJobs.size >= MAX_REGISTERED_JOBS) {
    const oldest = registeredJobs.keys().next().value;
    if (!oldest) break;
    registeredJobs.delete(oldest);
  }
  if (pendingJobs.length >= MAX_PENDING_JOBS) {
    updateProviderTask(normalized.taskId, { status: 'failed', progress: 100, error: 'scheduler_queue_full', metadata: { ...(getProviderTask(normalized.taskId)?.metadata ?? {}), schedulerState: 'terminal' } });
    return;
  }
  registeredJobs.set(normalized.taskId, normalized);
  const current = getProviderTask(normalized.taskId);
  if (current) {
    updateProviderTask(normalized.taskId, {
      status: 'queued',
      metadata: {
        ...(current.metadata ?? {}),
        schedulerState: WAITING_STATE,
        schedulerOwnerId: normalized.ownerId,
        schedulerMode: normalized.mode,
        schedulerModel: normalized.model,
      },
    });
  }
  if (!pendingJobs.some((candidate) => candidate.taskId === normalized.taskId)) pendingJobs.push(normalized);
  void pumpScope({ ownerId: normalized.ownerId, mode: normalized.mode });
}

/** Requeue a task after a local retry/resume action while the server process is alive. */
export function requeueProviderTask(taskId: string): boolean {
  const job = registeredJobs.get(taskId);
  if (!job || pendingJobs.some((candidate) => candidate.taskId === taskId)) return Boolean(job);
  const current = getProviderTask(taskId);
  if (!current || reservations.has(taskId)) return false;
  const retryableStatus = current.status === 'failed' || current.status === 'cancelled' || (current.status === 'queued' && !current.providerTaskId);
  if (!retryableStatus) return false;
  pendingJobs.push(job);
  updateProviderTask(taskId, { status: 'queued', progress: 0, metadata: { ...(current.metadata ?? {}), schedulerState: WAITING_STATE } });
  void pumpScope({ ownerId: job.ownerId, mode: job.mode });
  return true;
}

export function forgetProviderTask(taskId: string): void {
  registeredJobs.delete(taskId);
  removeQueuedProviderTask(taskId);
}

/** Trigger queued jobs after a poll/cancel/completion releases a slot. */
export function pumpProviderTasks(ownerId: string, mode: ProductionMode): void {
  void pumpScope({ ownerId: ownerId.trim() || 'unassigned', mode });
}

/** Remove a pending job when a user deletes/cancels it before dispatch. */
export function removeQueuedProviderTask(taskId: string): boolean {
  const index = pendingJobs.findIndex((job) => job.taskId === taskId);
  if (index < 0) return false;
  pendingJobs.splice(index, 1);
  return true;
}

/** Test helper; production callers should never need to clear scheduler state. */
export function resetSchedulerForTests(): void {
  pendingJobs.splice(0, pendingJobs.length);
  registeredJobs.clear();
  reservations.clear();
  pumpingScopes.clear();
}

export const schedulerInternals = {
  pendingJobs,
  reservations,
  WAITING_STATE,
  PROVIDER_ACTIVE_STATE,
};
