import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { deleteProviderTask, getProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { getServerWorkspaceTasks } from '@/lib/workspace/serverTasks';
import { applyTaskAction, type TaskAction } from '@/lib/workspace/taskActions';
import { productionRestoreConfig } from '@/lib/workspace/productionRestore';
import { cacheImageTaskOutputsBeforeCompletion, listImageTaskInventoryAssets, localImageOutputUrls, recoverPendingImageTaskOutputCache, saveImageTaskOutputsToAssets } from '@/lib/workspace/imageInventory';
import { forgetProviderTask, hasConfirmedProviderFailure, pumpProviderTasks, removeQueuedProviderTask, requeueProviderTask } from '@/lib/providers/concurrency';
import { classifyTaskError } from '@/lib/providers/taskErrorInfo';
import { deleteStoredTaskOutputs } from '@/lib/providers/outputStore';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  let persisted = getProviderTask(taskId);
  if (persisted && persisted.accountId === id && persisted.mode === 'image') {
    return NextResponse.json({ success: true, data: { ...persisted, errorInfo: classifyTaskError(persisted), restoreConfig: productionRestoreConfig(persisted), reviewUrl: `/workspace/accounts/${id}/production/image-tasks/${taskId}` } });
  }
  const task = getServerWorkspaceTasks({ accountId: id, mode: 'image' }).find((item) => item.id === taskId);
  if (!task) return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  return NextResponse.json({ success: true, data: { ...task, reviewUrl: `/workspace/accounts/${id}/production/image-tasks/${taskId}` } });
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
    if (action === 'resume' && persisted.status === 'paused' && persisted.providerTaskId) {
      const updated = updateProviderTask(taskId, {
        status: 'submitted',
        error: undefined,
        metadata: { ...(persisted.metadata ?? {}), schedulerState: 'provider-active', resumedAt: new Date().toISOString(), pausedByUserAt: undefined },
      }, persisted.updatedAt);
      return NextResponse.json({ success: Boolean(updated), data: updated ?? getProviderTask(taskId) }, { status: updated ? 202 : 409 });
    }
    if ((action === 'retry' || action === 'resume') && !hasConfirmedProviderFailure(persisted) && (persisted.providerTaskId || persisted.metadata?.providerAcceptedAt || persisted.metadata?.providerSubmissionUncertain === true)) return NextResponse.json({ success: false, error: 'provider_task_requires_status_recovery' }, { status: 409 });
    if (action === 'retry' || action === 'resume') {
      const accepted = requeueProviderTask(taskId);
      return NextResponse.json({ success: accepted, data: getProviderTask(taskId), ...(accepted ? {} : { error: 'task_not_retryable' }) }, { status: accepted ? 202 : 409 });
    }
    if (action === 'cancel' || action === 'pause') removeQueuedProviderTask(taskId);
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
    const updated = updateProviderTask(taskId, { status: next.status, progress: next.progress, error: next.error, providerResponse: undefined, inventorySavedAt: next.inventorySavedAt, providerTaskId: next.providerTaskId, outputUrls: next.outputUrls, outputBase64: next.outputBase64, ...(action === 'pause' ? { metadata: { ...(persisted.metadata ?? {}), schedulerState: 'paused', pausedByUserAt: new Date().toISOString() } } : {}) });
    if (action === 'cancel' || action === 'pause') pumpProviderTasks(typeof persisted.metadata?.ownerId === 'string' ? persisted.metadata.ownerId : persisted.accountId, 'image');
    return NextResponse.json({ success: true, data: updated });
  }
  const task = getServerWorkspaceTasks({ accountId: id, mode: 'image' }).find((item) => item.id === taskId);
  if (!task) return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  return NextResponse.json({ success: true, data: applyTaskAction(task, action) });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const task = getProviderTask(taskId);
  if (!task || task.accountId !== id || task.mode !== 'image') return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) return NextResponse.json({ success: false, error: 'active_task_cannot_delete' }, { status: 409 });
  try {
    deleteStoredTaskOutputs(id, taskId);
  } catch {
    return NextResponse.json({ success: false, error: 'task_output_cleanup_failed' }, { status: 500 });
  }
  forgetProviderTask(taskId);
  const restoreReason = request.nextUrl.searchParams.get('reason') === 'restore-config' ? 'restore-config' : undefined;
  if (restoreReason) deleteProviderTask(taskId, { restoreReason });
  else deleteProviderTask(taskId);
  return NextResponse.json({ success: true, data: { taskId, deleted: true } });
}
