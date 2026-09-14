import crypto from 'node:crypto';
import { acquireProviderWorkerLease, claimProviderTask, flushProviderTaskStore, getProviderTask, listProviderTaskSummaries, releaseProviderWorkerLease, renewProviderWorkerLease, updateProviderTask, type ProviderTaskSummary } from './taskStore';
import { getConcurrencyLimits, isPersistedActiveTask, retryProviderTaskOnFailure, taskModelId, taskOwnerId } from './concurrency';
import { executePersistedImageTask } from './imageTaskExecution';
import { executePersistedVideoTask } from './videoTaskExecution';
import { runProviderTaskRecoveryPass } from './providerTaskRecovery';
import { recoverPendingImageTaskOutputCache } from '@/lib/workspace/imageInventory';
import { recoverPendingVideoTaskOutputCache } from '@/lib/workspace/videoInventory';
import { processMockProviderTask } from './taskProcessor';
import { scheduleProductImageCleanup } from '@/lib/workspace/productImages';

const LEASE_MS = 60_000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_STATUSES = ['queued', 'prompting', 'submitting', 'submitted', 'processing', 'running', 'retrying', 'paused'] as const;

export function isDurableWaitingTask(task: ProviderTaskSummary, now = Date.now()): boolean {
  if ((task.mode !== 'image' && task.mode !== 'video') || task.providerTaskId || task.outputCount > 0) return false;
  if (!['queued', 'prompting', 'retrying'].includes(task.status) || task.metadata?.schedulerState !== 'waiting') return false;
  if (task.metadata?.providerSubmissionStartedAt || task.metadata?.providerAcceptedAt || task.metadata?.providerSubmissionUncertain === true) return false;
  const notBefore = typeof task.metadata?.schedulerRetryNotBefore === 'string' ? Date.parse(task.metadata.schedulerRetryNotBefore) : 0;
  return !Number.isFinite(notBefore) || notBefore <= now;
}

/** A single leased process owns submission and polling; the web process only writes jobs. */
export class DurableProviderWorker {
  readonly workerId = `${process.pid}:${crypto.randomUUID()}`;
  private stopping = false;
  private leased = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Map<string, Promise<void>>();
  private recovery: Promise<unknown> | undefined;
  private lastRecoveryAt = 0;
  private stopProductCleanup: (() => void) | undefined;

  start(): void {
    if (!acquireProviderWorkerLease(this.workerId, LEASE_MS)) throw new Error('provider_worker_already_running');
    this.leased = true;
    if (process.env.NODE_ENV !== 'test') this.stopProductCleanup = scheduleProductImageCleanup();
    this.heartbeat = setInterval(() => {
      try {
        if (!renewProviderWorkerLease(this.workerId, LEASE_MS)) this.stopping = true;
      } catch (error) {
        this.stopping = true;
        console.error('Provider worker lease renewal failed:', error instanceof Error ? error.message : 'unknown');
      }
    }, 10_000);
    this.recoverInterruptedDispatches();
  }

  private recoverInterruptedDispatches(): void {
    for (const summary of listProviderTaskSummaries({ statuses: ACTIVE_STATUSES })) {
      if (summary.mode !== 'image' && summary.mode !== 'video') continue;
      if (summary.providerTaskId || summary.outputCount > 0 || TERMINAL.has(summary.status) || summary.status === 'paused') continue;
      if (summary.metadata?.schedulerState !== 'dispatching' && summary.status !== 'submitting') continue;
      const task = getProviderTask(summary.id);
      if (!task || task.providerTaskId) continue;
      const uncertain = Boolean(task.metadata?.providerSubmissionStartedAt || task.metadata?.providerAcceptedAt)
        || (task.status === 'submitting' && !task.metadata?.schedulerWorkerId);
      updateProviderTask(task.id, uncertain ? {
        status: 'failed', progress: 100, error: 'provider_submission_uncertain',
        metadata: { ...(task.metadata ?? {}), schedulerState: 'terminal', providerSubmissionUncertain: true, schedulerRetryExhausted: true, schedulerInterruptedAt: new Date().toISOString() },
      } : {
        status: task.metadata?.promptGenerationPending === true ? 'prompting' : 'queued',
        metadata: { ...(task.metadata ?? {}), schedulerState: 'waiting', schedulerWorkerId: undefined },
      }, task.updatedAt);
    }
  }

  async tick(): Promise<void> {
    if (this.stopping || !this.leased) return;
    const all = listProviderTaskSummaries({ statuses: ACTIVE_STATUSES });
    const limits = getConcurrencyLimits();
    const counts = new Map<string, number>();
    const models = new Map<string, number>();
    const count = (task: ProviderTaskSummary) => {
      const scope = `${taskOwnerId(task)}:${task.mode}`;
      const model = `${scope}:${taskModelId(task)}`;
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
      models.set(model, (models.get(model) ?? 0) + 1);
    };
    for (const task of all) if (isPersistedActiveTask(task)) count(task);
    for (const summary of all.filter((task) => isDurableWaitingTask(task)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (this.stopping) break;
      const scope = `${taskOwnerId(summary)}:${summary.mode}`;
      const model = `${scope}:${taskModelId(summary)}`;
      if ((counts.get(scope) ?? 0) >= (summary.mode === 'image' ? limits.image : limits.video)) continue;
      if ((models.get(model) ?? 0) >= (summary.mode === 'image' ? limits.imageModel : limits.videoModel)) continue;
      const claimed = claimProviderTask(summary.id, this.workerId);
      if (!claimed) continue;
      count(summary);
      const execution = (async () => {
        try {
          if (claimed.mode === 'image') await executePersistedImageTask(claimed.id);
          else await executePersistedVideoTask(claimed.id);
        } catch (error) {
          const task = getProviderTask(claimed.id);
          if (task && !TERMINAL.has(task.status) && task.status !== 'paused' && !task.providerTaskId && task.metadata?.schedulerWorkerId === this.workerId) updateProviderTask(task.id, { status: 'failed', progress: 100, error: error instanceof Error ? error.message : 'worker_execution_failed' }, task.updatedAt);
        } finally {
          const task = getProviderTask(claimed.id);
          if (task?.status === 'failed') retryProviderTaskOnFailure(task.id);
          const latest = getProviderTask(claimed.id);
          if (latest && latest.status !== 'retrying' && latest.metadata?.schedulerWorkerId === this.workerId) updateProviderTask(latest.id, { metadata: { ...(latest.metadata ?? {}), schedulerState: TERMINAL.has(latest.status) || latest.status === 'paused' ? 'terminal' : 'provider-active', ...(TERMINAL.has(latest.status) ? { schedulerFinishedAt: new Date().toISOString() } : {}) } }, latest.updatedAt);
          this.running.delete(claimed.id);
        }
      })();
      this.running.set(claimed.id, execution);
    }
    if (!this.recovery && Date.now() - this.lastRecoveryAt >= 15_000) {
      this.lastRecoveryAt = Date.now();
      const failed = listProviderTaskSummaries({ status: 'failed' });
      this.recovery = this.recoverOutputs([...all, ...failed]).then(() => runProviderTaskRecoveryPass()).then((updated) => {
        for (const task of updated) if (task.status === 'failed') retryProviderTaskOnFailure(task.id);
      }).catch((error) => {
        console.error('Provider recovery pass failed:', error instanceof Error ? error.message : 'unknown');
      }).finally(() => { this.recovery = undefined; });
    }
  }

  private async recoverOutputs(tasks: ProviderTaskSummary[]): Promise<void> {
    const candidates = tasks.filter((task) => !this.running.has(task.id) && task.outputCount > 0 && task.metadata?.localOutputReady !== true && task.metadata?.localCacheExhausted !== true && (task.status === 'processing' || (task.status === 'failed' && ['image_output_cache_failed', 'video_output_cache_failed'].includes(task.error ?? ''))));
    for (const task of candidates.slice(0, 8)) {
      if (this.stopping) break;
      if (task.mode === 'image') await recoverPendingImageTaskOutputCache(task.id).catch(() => null);
      if (task.mode === 'video') await recoverPendingVideoTaskOutputCache(task.id).catch(() => null);
    }
    for (const task of tasks.filter((task) => !this.running.has(task.id) && task.metadata?.execution === 'mock' && !TERMINAL.has(task.status) && task.status !== 'paused').slice(0, 8)) await processMockProviderTask(task.id);
  }

  get isStopping(): boolean { return this.stopping; }

  async drain(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.running.values(), ...(this.recovery ? [this.recovery] : [])]);
    await flushProviderTaskStore();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.stopProductCleanup?.();
    if (this.leased) releaseProviderWorkerLease(this.workerId);
    this.leased = false;
  }
}
