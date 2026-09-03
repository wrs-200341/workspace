import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount, workspaceOwnerIdForUser } from '@/lib/workspace/access';
import { getServerWorkspaceTasks } from '@/lib/workspace/serverTasks';
import { businessDate } from '@/lib/workspace/tasks';
import { isProviderLiveEnabled, type ProviderId } from '@/lib/providers/config';
import { syncProviderTask } from '@/lib/providers/client';
import { updateProviderTask } from '@/lib/providers/taskStore';

const SYNC_THROTTLE_MS = 10_000;
const liveSyncInFlight = new Map<string, Promise<void>>();
const liveSyncLastStartedAt = new Map<string, number>();
let liveSyncQueue: Promise<void> = Promise.resolve();

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const date = request.nextUrl.searchParams.get('date');
  const ownerScope = request.nextUrl.searchParams.get('scope') === 'owner';
  const ownerId = ownerScope ? workspaceOwnerIdForUser(auth) ?? workspaceOwnerIdForAccount(id) : undefined;
  if (ownerScope && !ownerId) return NextResponse.json({ success: false, error: 'workspace_account_not_found' }, { status: 404 });
  const tasks = getServerWorkspaceTasks(ownerScope ? { ownerId, mode: 'image' } : { accountId: id, mode: 'image' }).filter((task) => !date || businessDate(task.createdAt) === date);
  // Keep queue reads local and responsive. Provider polling is opt-in and
  // runs in the background so slow upstreams never block rendering.
  if (request.nextUrl.searchParams.get('sync') === '1') void syncLiveImageTasks(tasks);
  const queueTasks = tasks.map(toQueueTask);
  return NextResponse.json({ success: true, data: queueTasks, tasks: queueTasks });
}

function toQueueTask<T extends Record<string, unknown>>(task: T) {
  const { outputUrls: _outputUrls, outputBase64: _outputBase64, metadata: _metadata, providerResponse: _providerResponse, ...summary } = task;
  return summary;
}

function syncLiveImageTasks(tasks: ReturnType<typeof getServerWorkspaceTasks>): Promise<void> {
  const run = liveSyncQueue.then(() => runLiveImageTasks(tasks));
  liveSyncQueue = run.catch(() => undefined);
  return run;
}

async function runLiveImageTasks(tasks: ReturnType<typeof getServerWorkspaceTasks>): Promise<void> {
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
        updateProviderTask(task.id, { status: status.status === 'unknown' ? task.status : status.status, progress: status.progress, providerTaskId: status.providerTaskId ?? task.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64, error: status.error });
      } catch { /* retain last-known local state */ }
    })();
    liveSyncInFlight.set(key, run);
    try { await run; } finally { liveSyncInFlight.delete(key); }
  }
}
