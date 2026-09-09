import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { deleteProviderTask, getProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { isProviderLiveEnabled } from '@/lib/providers/config';
import { providerResponseSnapshot, sanitizeProviderError, syncProviderTask } from '@/lib/providers/client';
import { getServerWorkspaceTasks } from '@/lib/workspace/serverTasks';
import { applyTaskAction, type TaskAction } from '@/lib/workspace/taskActions';
import { productionRestoreConfig } from '@/lib/workspace/productionRestore';
import { cacheImageTaskOutputsBeforeCompletion, listImageTaskInventoryAssets, localImageOutputUrls, recoverPendingImageTaskOutputCache, saveImageTaskOutputsToAssets } from '@/lib/workspace/imageInventory';
import { forgetProviderTask, pumpProviderTasks, removeQueuedProviderTask, requeueProviderTask, retryProviderTaskOnFailure } from '@/lib/providers/concurrency';

const DETAIL_SYNC_THROTTLE_MS = 10_000;
const detailSyncInFlight = new Map<string, Promise<void>>();
const detailSyncLastStartedAt = new Map<string, number>();

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  let persisted = getProviderTask(taskId);
  if (persisted && persisted.accountId === id && persisted.mode === 'image') {
    if ((persisted.status === 'processing' && persisted.metadata?.localOutputReady !== true)
      || (persisted.status === 'failed' && persisted.error === 'image_output_cache_failed')) {
      void recoverPendingImageTaskOutputCache(taskId).catch(() => null);
    }
    if (persisted.providerTaskId && isProviderLiveEnabled(persisted.provider) && ['submitting', 'queued', 'submitted', 'processing', 'running'].includes(persisted.status)) {
      void queueDetailProviderSync(taskId, persisted);
    }
    return NextResponse.json({ success: true, data: { ...persisted, restoreConfig: productionRestoreConfig(persisted), reviewUrl: `/workspace/accounts/${id}/production/image-tasks/${taskId}` } });
  }
  const task = getServerWorkspaceTasks({ accountId: id, mode: 'image' }).find((item) => item.id === taskId);
  if (!task) return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  return NextResponse.json({ success: true, data: { ...task, reviewUrl: `/workspace/accounts/${id}/production/image-tasks/${taskId}` } });
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
      const cacheTask = { ...task, mode: 'image' as const, status: 'completed' as const, progress: 100, providerTaskId: status.providerTaskId ?? task.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64 };
      const cache = normalizedStatus === 'completed' ? await cacheImageTaskOutputsBeforeCompletion(task.accountId, cacheTask) : null;
      const cachePending = normalizedStatus === 'completed' && cache && !cache.ready;
      const outputUrls = cache?.ready && cache.expected > 0
        ? localImageOutputUrls(task.accountId, { ...task, outputUrls: status.outputUrls, outputBase64: status.outputBase64 })
        : status.outputUrls;
      const outputBase64 = cache?.ready && cache.expected > 0 ? [] : status.outputBase64;
      updateProviderTask(taskId, { status: cachePending ? 'processing' : normalizedStatus, progress: cachePending ? 99 : status.progress, providerTaskId: status.providerTaskId ?? task.providerTaskId, outputUrls, outputBase64, error: status.error, providerResponse: undefined, metadata: { ...(task.metadata ?? {}), ...(cache ? { localOutputCount: cache.cached, localOutputExpected: cache.expected, localOutputReady: cache.ready } : {}) } });
      pumpProviderTasks(typeof task.metadata?.ownerId === 'string' ? task.metadata.ownerId : task.accountId, 'image');
    } catch (error) {
      const providerResponse = providerResponseSnapshot(error);
      const updated = updateProviderTask(taskId, { status: 'failed', progress: 100, error: sanitizeProviderError(error instanceof Error ? error.message : 'provider_request_failed'), providerResponse });
      if (updated?.status === 'failed') retryProviderTaskOnFailure(taskId);
      pumpProviderTasks(typeof task.metadata?.ownerId === 'string' ? task.metadata.ownerId : task.accountId, 'image');
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
  if (persisted && persisted.accountId === id && persisted.mode === 'image') {
    if (action === 'cancel' || action === 'pause') removeQueuedProviderTask(taskId);
    if (action === 'resume' && persisted.providerTaskId) return NextResponse.json({ success: false, error: 'provider_resume_unsupported' }, { status: 409 });
    if (action === 'save-inventory' && persisted.status === 'completed') {
      try {
        const assets = await saveImageTaskOutputsToAssets(id, persisted);
        const existing = listImageTaskInventoryAssets(id, persisted);
        const allAssets = [...existing, ...assets].filter((asset, index, all) => all.findIndex((candidate) => candidate.id === asset.id) === index);
        const expectedOutputs = persisted.outputUrls.filter((value) => value.trim()).length + persisted.outputBase64.filter((value) => value.trim()).length;
        if (allAssets.length === 0 || (expectedOutputs > 0 && allAssets.length < expectedOutputs)) {
          return NextResponse.json({ success: false, error: 'image_outputs_unavailable' }, { status: 409 });
        }
        const updated = updateProviderTask(taskId, {
          status: persisted.status,
          progress: persisted.progress,
          // Repeated requests are idempotent and must not create a second
          // inventory event or move an old task into today's counter.
          inventorySavedAt: persisted.inventorySavedAt ?? new Date().toISOString(),
          metadata: { ...(persisted.metadata ?? {}), inventoryAssetIds: allAssets.map((asset) => asset.id) },
        });
        return NextResponse.json({ success: true, data: updated, assets: allAssets });
      } catch (error) {
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'image_inventory_save_failed' }, { status: 400 });
      }
    }
    const next = applyTaskAction({ ...persisted, pid: 'pending', title: persisted.prompt || 'image generation', owner: 'operator-unassigned', mode: 'image', model: persisted.model || persisted.provider }, action);
    const updated = updateProviderTask(taskId, { status: next.status, progress: next.progress, error: next.error, providerResponse: undefined, inventorySavedAt: next.inventorySavedAt, providerTaskId: next.providerTaskId, outputUrls: next.outputUrls, outputBase64: next.outputBase64 });
    if ((action === 'retry' || action === 'resume') && updated?.status === 'queued') requeueProviderTask(taskId);
    if (action === 'cancel' || action === 'pause') pumpProviderTasks(typeof persisted.metadata?.ownerId === 'string' ? persisted.metadata.ownerId : persisted.accountId, 'image');
    return NextResponse.json({ success: true, data: updated });
  }
  const task = getServerWorkspaceTasks({ accountId: id, mode: 'image' }).find((item) => item.id === taskId);
  if (!task) return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  return NextResponse.json({ success: true, data: applyTaskAction(task, action) });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const task = getProviderTask(taskId);
  if (!task || task.accountId !== id || task.mode !== 'image') return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) return NextResponse.json({ success: false, error: 'active_task_cannot_delete' }, { status: 409 });
  forgetProviderTask(taskId);
  deleteProviderTask(taskId);
  return NextResponse.json({ success: true, data: { taskId, deleted: true } });
}
