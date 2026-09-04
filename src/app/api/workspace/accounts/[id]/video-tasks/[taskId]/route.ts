import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { deleteProviderTask, getProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { isProviderLiveEnabled } from '@/lib/providers/config';
import { providerResponseSnapshot, sanitizeProviderError, syncProviderTask } from '@/lib/providers/client';
import { getServerWorkspaceTasks } from '@/lib/workspace/serverTasks';
import { applyTaskAction, type TaskAction } from '@/lib/workspace/taskActions';
import { productionRestoreConfig } from '@/lib/workspace/productionRestore';
import { cacheVideoTaskOutputsBeforeCompletion, listVideoTaskInventoryAssets, saveVideoTaskOutputsToAssets } from '@/lib/workspace/videoInventory';
import { countVideoOutputs } from '@/lib/providers/videoOutputUrls';
import { forgetProviderTask, pumpProviderTasks, removeQueuedProviderTask, requeueProviderTask, retryProviderTaskOnFailure } from '@/lib/providers/concurrency';

const DETAIL_SYNC_THROTTLE_MS = 10_000;
const detailSyncInFlight = new Map<string, Promise<void>>();
const detailSyncLastStartedAt = new Map<string, number>();

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const persisted = getProviderTask(taskId);
  if (persisted && persisted.accountId === id && persisted.mode === 'video') {
    const legacyGenericError = persisted.error === 'provider request failed' || persisted.error === 'provider_request_failed';
    if (persisted.providerTaskId && isProviderLiveEnabled(persisted.provider) && (
      ['submitting', 'queued', 'submitted', 'processing', 'running'].includes(persisted.status) ||
      (persisted.status === 'failed' && legacyGenericError)
    )) {
      void queueDetailProviderSync(taskId, persisted);
    }
    return NextResponse.json({ success: true, data: { ...persisted, restoreConfig: productionRestoreConfig(persisted), reviewUrl: `/workspace/accounts/${id}/production/video-tasks/${taskId}` } });
  }
  const task = getServerWorkspaceTasks({ accountId: id, mode: 'video' }).find((item) => item.id === taskId);
  if (!task) return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  return NextResponse.json({ success: true, data: { ...task, reviewUrl: `/workspace/accounts/${id}/production/video-tasks/${taskId}` } });
}

function queueDetailProviderSync(taskId: string, task: NonNullable<ReturnType<typeof getProviderTask>>): Promise<void> {
  const key = `${task.provider}:${task.providerTaskId}`;
  const existing = detailSyncInFlight.get(key);
  if (existing) return existing;
  const now = Date.now();
  if (now - (detailSyncLastStartedAt.get(key) ?? 0) < DETAIL_SYNC_THROTTLE_MS) return Promise.resolve();
  detailSyncLastStartedAt.set(key, now);
  const run = (async () => {
    try {
      const status = await syncProviderTask(task.provider, task.providerTaskId!);
      const normalizedStatus = status.status === 'unknown' ? task.status : status.status;
      const cacheTask = { ...task, status: 'completed' as const, progress: 100, providerTaskId: status.providerTaskId ?? task.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64 };
      const cache = normalizedStatus === 'completed' ? await cacheVideoTaskOutputsBeforeCompletion(task.accountId, cacheTask) : null;
      const cachePending = normalizedStatus === 'completed' && cache && !cache.ready;
      const updated = updateProviderTask(taskId, { status: cachePending ? 'processing' : normalizedStatus, progress: cachePending ? 99 : status.progress, providerTaskId: status.providerTaskId ?? task.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64, error: status.error, providerResponse: status.status === 'failed' ? providerResponseSnapshot(new Error(status.error ?? 'provider_upstream_failed'), { body: status.response, method: 'GET' }) : undefined, metadata: { ...(task.metadata ?? {}), ...(cache ? { localOutputCount: cache.cached, localOutputExpected: cache.expected, localOutputReady: cache.ready } : {}) } });
      if (updated?.status === 'failed') retryProviderTaskOnFailure(taskId);
      pumpProviderTasks(typeof task.metadata?.ownerId === 'string' ? task.metadata.ownerId : task.accountId, 'video');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.startsWith('provider_')) {
        const updated = updateProviderTask(taskId, { status: 'failed', progress: 100, error: sanitizeProviderError(message), providerResponse: providerResponseSnapshot(error) });
        if (updated?.status === 'failed') retryProviderTaskOnFailure(taskId);
        pumpProviderTasks(typeof task.metadata?.ownerId === 'string' ? task.metadata.ownerId : task.accountId, 'video');
      }
    }
  })();
  detailSyncInFlight.set(key, run);
  return run.finally(() => { detailSyncInFlight.delete(key); });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const action = body?.action as TaskAction;
  if (!['retry', 'cancel', 'save-inventory', 'pause', 'resume'].includes(action)) return NextResponse.json({ success: false, error: 'invalid_task_action' }, { status: 400 });
  const persisted = getProviderTask(taskId);
  if (persisted && persisted.accountId === id && persisted.mode === 'video') {
    if (action === 'cancel' || action === 'pause') removeQueuedProviderTask(taskId);
    if (action === 'resume' && persisted.providerTaskId) return NextResponse.json({ success: false, error: 'provider_resume_unsupported' }, { status: 409 });
    if (action === 'save-inventory' && persisted.status === 'completed') {
      try {
        const created = await saveVideoTaskOutputsToAssets(id, persisted);
        const assets = [...listVideoTaskInventoryAssets(id, persisted), ...created].filter((asset, index, all) => all.findIndex((candidate) => candidate.id === asset.id) === index);
        const expectedOutputs = countVideoOutputs(persisted.provider, persisted.outputUrls, persisted.outputBase64, Boolean(persisted.providerTaskId));
        if (assets.length === 0 || assets.length < expectedOutputs) return NextResponse.json({ success: false, error: 'video_outputs_unavailable' }, { status: 409 });
        const updated = updateProviderTask(taskId, { status: persisted.status, progress: persisted.progress, inventorySavedAt: persisted.inventorySavedAt ?? new Date().toISOString(), metadata: { ...(persisted.metadata ?? {}), inventoryAssetIds: assets.map((asset) => asset.id) } });
        return NextResponse.json({ success: true, data: updated, assets });
      } catch (error) {
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'video_inventory_save_failed' }, { status: 400 });
      }
    }
    const next = applyTaskAction({ ...persisted, pid: 'pending', title: persisted.prompt || 'video generation', owner: 'operator-unassigned', mode: 'video', model: persisted.model || persisted.provider }, action);
    const updated = updateProviderTask(taskId, { status: next.status, progress: next.progress, error: next.error, providerResponse: undefined, inventorySavedAt: next.inventorySavedAt, providerTaskId: next.providerTaskId, outputUrls: next.outputUrls, outputBase64: next.outputBase64 });
    if ((action === 'retry' || action === 'resume') && updated?.status === 'queued') requeueProviderTask(taskId);
    if (action === 'cancel' || action === 'pause') pumpProviderTasks(typeof persisted.metadata?.ownerId === 'string' ? persisted.metadata.ownerId : persisted.accountId, 'video');
    return NextResponse.json({ success: true, data: updated });
  }
  const task = getServerWorkspaceTasks({ accountId: id, mode: 'video' }).find((item) => item.id === taskId);
  if (!task) return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  return NextResponse.json({ success: true, data: applyTaskAction(task, action) });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const task = getProviderTask(taskId);
  if (!task || task.accountId !== id || task.mode !== 'video') return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) return NextResponse.json({ success: false, error: 'active_task_cannot_delete' }, { status: 409 });
  forgetProviderTask(taskId);
  deleteProviderTask(taskId);
  return NextResponse.json({ success: true, data: { taskId, deleted: true } });
}
