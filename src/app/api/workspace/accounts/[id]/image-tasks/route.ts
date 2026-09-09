import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount, workspaceOwnerIdForUser } from '@/lib/workspace/access';
import * as serverTasks from '@/lib/workspace/serverTasks';
import { businessDate } from '@/lib/workspace/tasks';
import { isProviderLiveEnabled, type ProviderId } from '@/lib/providers/config';
import { providerResponseSnapshot, sanitizeProviderError, syncProviderTask } from '@/lib/providers/client';
import { updateProviderTask } from '@/lib/providers/taskStore';
import { pumpProviderTasks, recoverOrphanedSchedulerTasks, retryProviderTaskOnFailure } from '@/lib/providers/concurrency';
import { cacheImageTaskOutputsBeforeCompletion, localImageOutputUrls, recoverPendingImageTaskOutputCache } from '@/lib/workspace/imageInventory';

const SYNC_THROTTLE_MS = 10_000;
const liveSyncInFlight = new Map<string, Promise<void>>();
const liveSyncLastStartedAt = new Map<string, number>();
let liveSyncRunning = false;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const date = request.nextUrl.searchParams.get('date');
  const ownerScope = request.nextUrl.searchParams.get('scope') === 'owner';
  const requestedOwnerId = request.nextUrl.searchParams.get('ownerId')?.trim() || undefined;
  const ownerId = ownerScope
    ? auth.role === 'operator' && requestedOwnerId ? requestedOwnerId : workspaceOwnerIdForUser(auth) ?? workspaceOwnerIdForAccount(id)
    : undefined;
  if (ownerScope && !ownerId) return NextResponse.json({ success: false, error: 'workspace_account_not_found' }, { status: 404 });
  recoverOrphanedSchedulerTasks();
  const filters = ownerScope ? { ownerId, mode: 'image' as const } : { accountId: id, mode: 'image' as const };
  const queueReader = Object.prototype.hasOwnProperty.call(serverTasks, 'getServerWorkspaceQueueTasks')
    ? serverTasks.getServerWorkspaceQueueTasks
    : serverTasks.getServerWorkspaceTasks;
  const tasks = queueReader(filters).filter((task) => !date || businessDate(task.createdAt) === date);
  const needsBackgroundWork = tasks.some((task) => task.status === 'processing' || (task.status === 'failed' && task.error === 'image_output_cache_failed'));
  // Keep queue reads local and responsive. Provider polling and output cache
  // recovery run after the lightweight response is prepared.
  if (needsBackgroundWork || request.nextUrl.searchParams.get('sync') === '1') {
    void Promise.resolve().then(() => {
      const fullTasks = serverTasks.getServerWorkspaceTasks(filters).filter((task) => !date || businessDate(task.createdAt) === date);
      if (needsBackgroundWork) void recoverPendingImageCaches(fullTasks);
      if (request.nextUrl.searchParams.get('sync') === '1') void syncLiveImageTasks(fullTasks);
    });
  }
  const queueTasks = tasks.map(toQueueTask);
  return NextResponse.json({ success: true, data: queueTasks, tasks: queueTasks });
}

async function recoverPendingImageCaches(tasks: ReturnType<typeof serverTasks.getServerWorkspaceTasks>): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  const pending = tasks.filter((task) => task.mode === 'image' && (
    task.status === 'processing'
    || (task.status === 'failed' && task.error === 'image_output_cache_failed')
  ));
  for (const task of pending.slice(0, 8)) {
    // Recover both in-flight cache retries and terminal cache failures where
    // a previous write won a race with the task status update.
    await recoverPendingImageTaskOutputCache(task.id).catch(() => null);
  }
}

function toQueueTask<T extends Record<string, unknown>>(task: T) {
  const { outputUrls: _outputUrls, outputBase64: _outputBase64, metadata, providerResponse: _providerResponse, ...summary } = task;
  const schedulerState = metadata && typeof metadata === 'object' && typeof (metadata as { schedulerState?: unknown }).schedulerState === 'string'
    ? (metadata as { schedulerState: string }).schedulerState
    : undefined;
  return schedulerState ? { ...summary, schedulerState } : summary;
}

function syncLiveImageTasks(tasks: ReturnType<typeof serverTasks.getServerWorkspaceTasks>): Promise<void> {
  if (liveSyncRunning) return Promise.resolve();
  liveSyncRunning = true;
  const run = runLiveImageTasks(tasks).finally(() => { liveSyncRunning = false; });
  return run.catch(() => undefined);
}

async function runLiveImageTasks(tasks: ReturnType<typeof serverTasks.getServerWorkspaceTasks>): Promise<void> {
  const active = tasks.filter((task) => task.provider && task.providerTaskId && ['submitting', 'queued', 'submitted', 'processing', 'running'].includes(task.status) && isProviderLiveEnabled(task.provider as ProviderId));
  // A manual refresh should make progress on the visible queue without
  // opening an upstream request for every historical task at once.
  for (const task of active.slice(0, 4)) {
    const key = `${task.provider}:${task.providerTaskId}`;
    const now = Date.now();
    if (liveSyncInFlight.has(key) || now - (liveSyncLastStartedAt.get(key) ?? 0) < SYNC_THROTTLE_MS) continue;
    liveSyncLastStartedAt.set(key, now);
    const run = (async () => {
      try {
        const status = await syncProviderTask(task.provider as ProviderId, task.providerTaskId!);
        const normalizedStatus = status.status === 'unknown' ? task.status : status.status;
        const cacheTask = task.provider && task.updatedAt
          ? { ...task, provider: task.provider as ProviderId, mode: 'image' as const, status: 'completed' as const, progress: 100, updatedAt: task.updatedAt, providerTaskId: status.providerTaskId ?? task.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64 }
          : null;
        const cache = normalizedStatus === 'completed' && cacheTask ? await cacheImageTaskOutputsBeforeCompletion(task.accountId, cacheTask) : null;
        const cachePending = normalizedStatus === 'completed' && cache && !cache.ready;
        const outputUrls = cache?.ready && cache.expected > 0
          ? localImageOutputUrls(task.accountId, { ...task, outputUrls: status.outputUrls, outputBase64: status.outputBase64 })
          : status.outputUrls;
        const outputBase64 = cache?.ready && cache.expected > 0 ? [] : status.outputBase64;
        const updated = updateProviderTask(task.id, { status: cachePending ? 'processing' : normalizedStatus, progress: cachePending ? 99 : status.progress, providerTaskId: status.providerTaskId ?? task.providerTaskId, outputUrls, outputBase64, error: status.error, providerResponse: status.status === 'failed' ? providerResponseSnapshot(new Error(status.error ?? 'provider_upstream_failed'), { body: status.response, method: 'GET' }) : undefined, metadata: { ...(task.metadata ?? {}), ...(cache ? { localOutputCount: cache.cached, localOutputExpected: cache.expected, localOutputReady: cache.ready } : {}) } });
        if (updated?.status === 'failed') retryProviderTaskOnFailure(task.id);
        pumpProviderTasks(typeof task.metadata?.ownerId === 'string' ? task.metadata.ownerId : task.accountId, 'image');
      } catch (error) {
        const providerResponse = providerResponseSnapshot(error);
        const updated = updateProviderTask(task.id, {
          status: 'failed',
          progress: 100,
          error: sanitizeProviderError(error instanceof Error ? error.message : 'provider_request_failed'),
          providerResponse,
        });
         if (updated?.status === 'failed') retryProviderTaskOnFailure(task.id);
        pumpProviderTasks(typeof task.metadata?.ownerId === 'string' ? task.metadata.ownerId : task.accountId, 'image');
      }
    })();
    liveSyncInFlight.set(key, run);
    try { await run; } finally { liveSyncInFlight.delete(key); }
  }
}
