import crypto from 'node:crypto';
import { getProviderTask, listProviderTaskSummaries, updateProviderTask, type ProviderTask, type ProviderTaskMode, type ProviderTaskStatus } from './taskStore';
import * as taskStore from './taskStore';
import { workspaceOwnerIdForAccount } from '@/lib/workspace/access';
import { canonicalTaskProgress } from './taskProgress';

/**
 * Workspace production concurrency policy.
 *
 * Image and video jobs have separate operator-wide pools. Video gets the
 * larger lane because it is the main throughput bottleneck in production.
 * Model limits are also mode-specific so a hot video model cannot starve
 * image generation.
 */
export const DEFAULT_IMAGE_MODEL_CONCURRENCY = 5;
export const DEFAULT_VIDEO_MODEL_CONCURRENCY = 20;
export const DEFAULT_IMAGE_CONCURRENCY = 20;
export const DEFAULT_VIDEO_CONCURRENCY = 50;

export type ProductionMode = 'image' | 'video';
export type ConcurrencyLimits = { imageModel: number; videoModel: number; image: number; video: number };
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
export const SCHEDULER_RUNTIME_ID = crypto.randomUUID();
const ORPHANED_TASK_AGE_MS = 2 * 60 * 1000;
/** Every production task gets two automatic retries after its first failure. */
export const DEFAULT_MAX_RETRIES = 2;
const RETRYING_STATUS: ProviderTaskStatus = 'retrying';
const RETRY_BACKOFF_MS = 300;

/** Jobs are process-local, while task state remains persisted on D:. */
const pendingJobs: SchedulerJob[] = [];
const registeredJobs = new Map<string, SchedulerJob>();
const MAX_REGISTERED_JOBS = 256;
const MAX_PENDING_JOBS = 1_000;
const reservations = new Map<string, Scope>();
const pumpingScopes = new Set<string>();
const pumpAgainScopes = new Set<string>();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : fallback;
}

export function getConcurrencyLimits(env: Readonly<Record<string, string | undefined>> = process.env): ConcurrencyLimits {
  return {
    imageModel: positiveInteger(env.WORKSPACE_IMAGE_MODEL_CONCURRENCY, DEFAULT_IMAGE_MODEL_CONCURRENCY),
    videoModel: positiveInteger(env.WORKSPACE_VIDEO_MODEL_CONCURRENCY, DEFAULT_VIDEO_MODEL_CONCURRENCY),
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
  const expected = workspaceOwnerIdForAccount(task.accountId);
  // Persisted owner metadata is an optimization for queue filtering, not an
  // authority. When the account store knows the owner, always prefer that
  // server-side mapping so a malformed task cannot escape its concurrency
  // lane. Synthetic/test accounts retain their explicit metadata owner.
  if (expected?.trim()) return expected.trim();
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
  return mode === 'image' ? limits.image : limits.video;
}

function currentCounts(scope: Scope, mode: ProductionMode): { total: number; byModel: Map<string, number> } {
  const byModel = new Map<string, number>();
  let total = 0;
  for (const task of listProviderTaskSummaries()) {
    if (taskOwnerId(task) !== scope.ownerId || task.mode !== mode || !isPersistedActiveTask(task)) continue;
    total += 1;
    const model = taskModelId(task);
    byModel.set(model, (byModel.get(model) ?? 0) + 1);
  }
  return { total, byModel };
}

function canStart(job: SchedulerJob, counts: { total: number; byModel: Map<string, number> }, limits: ConcurrencyLimits): boolean {
  if (counts.total >= modeLimit(job.mode, limits)) return false;
  return (counts.byModel.get(job.model.toLowerCase()) ?? 0) < (job.mode === 'image' ? limits.imageModel : limits.videoModel);
}

function markDispatching(job: SchedulerJob): void {
  const current = getProviderTask(job.taskId);
  if (!current) return;
  // Automatic child-prompt jobs are already in a user-visible `prompting`
  // phase when they enter the scheduler. Keep that phase while reserving a
  // slot; the job itself advances to `submitting` only after prompt
  // generation has completed.
  const promptGenerationPending = current.status === 'prompting' || current.metadata?.promptGenerationPending === true;
  updateProviderTask(job.taskId, {
    status: promptGenerationPending ? 'prompting' : 'submitting',
    progress: promptGenerationPending
      ? canonicalTaskProgress({ mode: job.mode, status: 'prompting', progress: current.progress, promptGenerationPending: true })
      : canonicalTaskProgress({ mode: job.mode, status: 'submitting', progress: current.progress }),
    metadata: {
      ...(current.metadata ?? {}),
      schedulerState: DISPATCHING_STATE,
      schedulerOwnerId: job.ownerId,
      schedulerMode: job.mode,
      schedulerModel: job.model,
      schedulerStartedAt: new Date().toISOString(),
      schedulerRuntimeId: SCHEDULER_RUNTIME_ID,
    },
  });
}

function markFinishedState(taskId: string): void {
  const current = getProviderTask(taskId);
  if (!current) return;
  if (current.status === RETRYING_STATUS) {
    updateProviderTask(taskId, {
      metadata: {
        ...(current.metadata ?? {}),
        schedulerState: WAITING_STATE,
      },
    });
    return;
  }
  const active = ACTIVE_STATUSES.includes(current.status) || (current.status === 'queued' && Boolean(current.providerTaskId));
  updateProviderTask(taskId, {
    metadata: {
      ...(current.metadata ?? {}),
      schedulerState: active ? PROVIDER_ACTIVE_STATE : 'terminal',
      ...(active ? {} : { schedulerFinishedAt: new Date().toISOString() }),
    },
  });
}

function retryCount(task: ProviderTask): number {
  const value = task.metadata?.schedulerRetryCount;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function maxRetries(task: ProviderTask): number {
  if (task.metadata?.schedulerRetryExhausted === true) return 0;
  const value = task.metadata?.maxRetries;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_MAX_RETRIES;
}

/**
 * Mark a failed dispatch as retrying and put it back in the local queue. The
 * task keeps its original id and all request metadata; only the persisted
 * retry counter changes. This makes retries visible as one logical task.
 */
function scheduleRetry(job: SchedulerJob, task: ProviderTask): boolean {
  const attempts = retryCount(task);
  const limit = maxRetries(task);
  if (attempts >= limit) return false;
  const nextRetry = attempts + 1;
  const updated = updateProviderTask(task.id, {
    status: RETRYING_STATUS,
    // Keep the task in the active/visible portion of the queue without
    // pretending that a provider request is currently running.
    progress: canonicalTaskProgress({ mode: job.mode, status: 'retrying', progress: task.progress }),
    error: undefined,
    // A retry is a new upstream submission.  Clear the previous provider
    // handle and outputs so the stale request cannot be counted as an active
    // slot (or accidentally polled) while the replacement is waiting.
    providerTaskId: undefined,
    outputUrls: [],
    outputBase64: [],
    metadata: {
      ...(task.metadata ?? {}),
      schedulerRetryCount: nextRetry,
      maxRetries: limit,
      lastRetryAt: new Date().toISOString(),
      schedulerState: WAITING_STATE,
      retrying: true,
    },
  });
  if (!updated) return false;
  // Defer re-enqueueing very briefly to avoid a tight failure loop and to let
  // the queue poller render the explicit “retrying” state first.
  setTimeout(() => {
    const latest = getProviderTask(job.taskId);
    if (!latest || latest.status !== RETRYING_STATUS) return;
    if (!pendingJobs.some((candidate) => candidate.taskId === job.taskId)) pendingJobs.push(job);
    void pumpScope({ ownerId: job.ownerId, mode: job.mode });
  }, RETRY_BACKOFF_MS * Math.max(1, nextRetry));
  return true;
}

async function pumpScope(scope: Scope): Promise<void> {
  const key = scopeKey(scope);
  if (pumpingScopes.has(key)) {
    pumpAgainScopes.add(key);
    return;
  }
  pumpingScopes.add(key);
  try {
    for (;;) {
      pumpAgainScopes.delete(key);
      const limits = getConcurrencyLimits();
      for (;;) {
        const countsByMode = {
          image: currentCounts(scope, 'image'),
          video: currentCounts(scope, 'video'),
        } satisfies Record<ProductionMode, { total: number; byModel: Map<string, number> }>;
        // Dispatch the first runnable job for the owner regardless of its media
        // mode. Each mode has its own pool, so a saturated video lane no longer
        // blocks image work and vice versa.
        const index = pendingJobs.findIndex((job) => job.ownerId === scope.ownerId && canStart(job, countsByMode[job.mode], limits));
        if (index < 0) break;
        const [job] = pendingJobs.splice(index, 1);
        const current = getProviderTask(job.taskId);
        if (!current || ['cancelled', 'failed', 'completed'].includes(current.status)) continue;
        reservations.set(job.taskId, scope);
        markDispatching(job);
        void (async () => {
          try {
            await job.run();
          } catch (error) {
            const current = getProviderTask(job.taskId);
            if (current && !['completed', 'cancelled', 'failed'].includes(current.status)) {
              updateProviderTask(job.taskId, {
                status: 'failed',
                progress: 100,
                error: error instanceof Error && error.message ? error.message : 'scheduler_dispatch_failed',
              });
            }
          } finally {
            const finished = getProviderTask(job.taskId);
            // Provider adapters generally persist failures and resolve their
            // promise. Inspect the task after run() so both rejected promises
            // and persisted failed statuses receive the same retry treatment.
            const retryScheduled = finished?.status === 'failed' ? scheduleRetry(job, finished) : false;
            if (finished?.status === 'completed') {
              updateProviderTask(job.taskId, {
                metadata: {
                  ...(finished.metadata ?? {}),
                  retrying: false,
                },
              });
            }
            if (finished?.status === 'completed' || (finished?.status === 'failed' && !retryScheduled)) registeredJobs.delete(job.taskId);
            markFinishedState(job.taskId);
            reservations.delete(job.taskId);
            if (!retryScheduled) void pumpScope(scope);
          }
        })();
      }
      if (!pumpAgainScopes.has(key)) break;
    }
  } finally {
    pumpingScopes.delete(key);
    pumpAgainScopes.delete(key);
  }
}

/** Enqueue a live image/video submission and start it when its limits allow. */
export function enqueueProviderTask(job: SchedulerJob): boolean {
  const normalized: SchedulerJob = { ...job, ownerId: job.ownerId.trim() || 'unassigned', model: job.model.trim() || 'unknown' };
  while (registeredJobs.size >= MAX_REGISTERED_JOBS) {
    const oldest = registeredJobs.keys().next().value;
    if (!oldest) break;
    registeredJobs.delete(oldest);
  }
  if (pendingJobs.length >= MAX_PENDING_JOBS) {
    updateProviderTask(normalized.taskId, { status: 'failed', progress: 100, error: 'scheduler_queue_full', metadata: { ...(getProviderTask(normalized.taskId)?.metadata ?? {}), schedulerState: 'terminal' } });
    return false;
  }
  registeredJobs.set(normalized.taskId, normalized);
  const current = getProviderTask(normalized.taskId);
  if (current) {
    const metadata = current.metadata ?? {};
    // Route handlers create tasks with the waiting scheduler metadata already
    // attached. Once this process has stamped its runtime id, avoid rewriting
    // the entire (potentially multi-megabyte) tasks.json file on re-enqueue.
    const alreadyWaiting = (current.status === 'queued' || current.status === 'prompting' || current.status === 'retrying')
      && metadata.schedulerState === WAITING_STATE
      && metadata.schedulerOwnerId === normalized.ownerId
      && metadata.schedulerMode === normalized.mode
      && metadata.schedulerModel === normalized.model
      && metadata.schedulerRuntimeId === SCHEDULER_RUNTIME_ID;
    if (!alreadyWaiting) {
      updateProviderTask(normalized.taskId, {
        // Preserve the prompt-generation phase for automatic child-prompt
        // tasks. Regular jobs are normalized to the local queued state.
        status: current.status === 'prompting' ? 'prompting' : 'queued',
        metadata: {
          ...metadata,
          schedulerState: WAITING_STATE,
          schedulerOwnerId: normalized.ownerId,
          schedulerMode: normalized.mode,
          schedulerModel: normalized.model,
          schedulerRuntimeId: SCHEDULER_RUNTIME_ID,
        },
      });
    }
  }
  if (!pendingJobs.some((candidate) => candidate.taskId === normalized.taskId)) pendingJobs.push(normalized);
  void pumpScope({ ownerId: normalized.ownerId, mode: normalized.mode });
  return true;
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
  const resetRetries = current.status === 'failed';
  updateProviderTask(taskId, {
    status: 'queued',
    progress: 0,
    // Failed/cancelled tasks may retain the old upstream id.  A manual
    // requeue must start a fresh provider request and should therefore not
    // consume a slot before the scheduler dispatches it.
    providerTaskId: undefined,
    outputUrls: [],
    outputBase64: [],
    metadata: {
      ...(current.metadata ?? {}),
      schedulerState: WAITING_STATE,
      ...(resetRetries ? { schedulerRetryCount: 0, retrying: false, maxRetries: DEFAULT_MAX_RETRIES } : {}),
    },
  });
  void pumpScope({ ownerId: job.ownerId, mode: job.mode });
  return true;
}

/**
 * Apply the automatic retry policy to a task whose provider poll reported a
 * failure. This is used by the background queue synchronizers, where the
 * scheduler job itself is not the code that observed the failed response.
 */
export function retryProviderTaskOnFailure(taskId: string): boolean {
  const job = registeredJobs.get(taskId);
  const current = getProviderTask(taskId);
  if (!job || !current || current.status !== 'failed') return false;
  return scheduleRetry(job, current);
}

export function forgetProviderTask(taskId: string): void {
  registeredJobs.delete(taskId);
  removeQueuedProviderTask(taskId);
}

/** Trigger queued jobs after a poll/cancel/completion releases a slot. */
export function pumpProviderTasks(ownerId: string, mode: ProductionMode): void {
  void pumpScope({ ownerId: ownerId.trim() || 'unassigned', mode });
}

/**
 * Fail jobs left in the process-local scheduler by a prior server instance.
 * Jobs that already have a providerTaskId remain pollable and are untouched;
 * only never-submitted dispatch/waiting records are eligible. A short age
 * threshold avoids racing a freshly-created job in the current process.
 */
export function recoverOrphanedSchedulerTasks(now = Date.now(), options: { force?: boolean } = {}): ProviderTask[] {
  const recovered: ProviderTask[] = [];
  if (process.env.NODE_ENV === 'test' && !options.force) return recovered;
  // Some lightweight route tests mock only the task methods they exercise;
  // keep recovery optional when that read helper is not present.
  for (const task of listProviderTaskSummaries()) {
    // `retrying` is also process-local. When a process restarts after a
    // provider/dispatch failure, its retry timer and registered job are gone
    // even though the persisted task still says "retrying". These tasks have
    // no upstream id, so converting them to a safe, recoverable failure is
    // preferable to leaving them in the queue forever.
    if (task.providerTaskId || !['queued', 'submitting', 'prompting', 'retrying'].includes(task.status)) continue;
    const state = schedulerState(task);
    // `terminal` normally means "nothing left to do", but a task that is still
    // queued with no provider task id has no way to progress: the scheduler
    // considers it finished while the queue shows it as waiting. Recover those
    // too, otherwise they sit in the UI forever.
    const strandedTerminal = state === 'terminal' && task.status === 'queued';
    if (state !== WAITING_STATE && state !== DISPATCHING_STATE && !strandedTerminal) continue;
    const runtimeId = task.metadata?.schedulerRuntimeId;
    // A stranded task is already finished from the scheduler's point of view,
    // so the current runtime having produced it is not a reason to skip it.
    if (runtimeId === SCHEDULER_RUNTIME_ID && !strandedTerminal) continue;
    const updatedAt = Date.parse(task.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt < ORPHANED_TASK_AGE_MS) continue;
    // Queue polling and a recovery request can run concurrently. Re-read the
    // full record immediately before writing so an old summary cannot overwrite
    // a freshly restored task's metadata and status.
    const latest = getProviderTask(task.id);
    if (!latest || latest.updatedAt !== task.updatedAt || latest.status !== task.status || Boolean(latest.providerTaskId) !== Boolean(task.providerTaskId)) continue;
    const updated = updateProviderTask(latest.id, {
      status: 'failed',
      progress: 100,
      // A prompting task has not reached any provider yet. Keep this distinct
      // from a real prompt-provider rejection so operators can safely restore
      // it after a process restart.
      error: latest.status === 'prompting'
        ? 'scheduler_prompt_interrupted'
        : latest.status === 'retrying'
          ? 'scheduler_retry_interrupted'
          : strandedTerminal
            ? 'provider_response_unrecognized'
            : 'scheduler_interrupted',
      metadata: {
        ...(latest.metadata ?? {}),
        schedulerState: 'terminal',
        schedulerInterruptedAt: new Date(now).toISOString(),
        schedulerRuntimeId: SCHEDULER_RUNTIME_ID,
      },
    });
    if (updated) recovered.push(updated);
  }
  return recovered;
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
