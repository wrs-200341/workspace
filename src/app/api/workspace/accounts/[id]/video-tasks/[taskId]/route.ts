import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount } from '@/lib/workspace/access';
import { deleteProviderTask, findNextUnreviewedVideoTask, getProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { listStoredAccounts } from '@/lib/workspace/accountStore';
import { getServerWorkspaceTasks } from '@/lib/workspace/serverTasks';
import { applyTaskAction, type TaskAction } from '@/lib/workspace/taskActions';
import { productionRestoreConfig } from '@/lib/workspace/productionRestore';
import { listVideoTaskInventoryAssets, recoverPendingVideoTaskOutputCache, saveVideoTaskOutputsToAssets } from '@/lib/workspace/videoInventory';
import { countVideoOutputs } from '@/lib/providers/videoOutputUrls';
import { forgetProviderTask, hasConfirmedProviderFailure, pumpProviderTasks, removeQueuedProviderTask, requeueProviderTask } from '@/lib/providers/concurrency';
import { classifyTaskError } from '@/lib/providers/taskErrorInfo';
import { deleteStoredTaskOutputs } from '@/lib/providers/outputStore';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const persisted = getProviderTask(taskId);
  if (persisted && persisted.accountId === id && persisted.mode === 'video') {
    return NextResponse.json({ success: true, data: { ...persisted, errorInfo: classifyTaskError(persisted), restoreConfig: productionRestoreConfig(persisted), reviewUrl: `/workspace/accounts/${id}/production/video-tasks/${taskId}` } });
  }
  const task = getServerWorkspaceTasks({ accountId: id, mode: 'video' }).find((item) => item.id === taskId);
  if (!task) return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  return NextResponse.json({ success: true, data: { ...task, reviewUrl: `/workspace/accounts/${id}/production/video-tasks/${taskId}` } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const action = body?.action as string;
  if (!['retry', 'cancel', 'save-inventory', 'pause', 'resume', 'recover-provider'].includes(action)) return NextResponse.json({ success: false, error: 'invalid_task_action' }, { status: 400 });
  const persisted = getProviderTask(taskId);
  if (persisted && persisted.accountId === id && persisted.mode === 'video') {
    if (action === 'recover-provider') {
      if (!persisted.providerTaskId || persisted.error !== 'provider_task_stale') return NextResponse.json({ success: false, error: 'provider_recovery_unsupported' }, { status: 409 });
      const updated = updateProviderTask(taskId, { metadata: { ...(persisted.metadata ?? {}), providerStaleRecoverCheckedAt: undefined, recoveryRequestedAt: new Date().toISOString() } });
      return NextResponse.json({ success: true, data: updated ?? persisted }, { status: 202 });
    }
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
        const created = await saveVideoTaskOutputsToAssets(id, persisted);
        const assets = [...listVideoTaskInventoryAssets(id, persisted), ...created].filter((asset, index, all) => all.findIndex((candidate) => candidate.id === asset.id) === index);
        const expectedOutputs = countVideoOutputs(persisted.provider, persisted.outputUrls, persisted.outputBase64, Boolean(persisted.providerTaskId));
        if (assets.length === 0 || assets.length < expectedOutputs) return NextResponse.json({ success: false, error: 'video_outputs_unavailable' }, { status: 409 });
        const updated = updateProviderTask(taskId, { status: persisted.status, progress: persisted.progress, inventorySavedAt: persisted.inventorySavedAt ?? new Date().toISOString(), metadata: { ...(persisted.metadata ?? {}), inventoryAssetIds: assets.map((asset) => asset.id) } });
        const ownerId = workspaceOwnerIdForAccount(id);
        const ownerAccountIds = ownerId ? listStoredAccounts({ ownerId }).map((account) => account.id) : [id];
        const nextReviewTask = findNextUnreviewedVideoTask(ownerAccountIds, persisted);
        return NextResponse.json({
          success: true,
          data: updated,
          assets,
          nextReviewTask: nextReviewTask ? {
            id: nextReviewTask.id,
            accountId: nextReviewTask.accountId,
            createdAt: nextReviewTask.createdAt,
          } : null,
        });
      } catch (error) {
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'video_inventory_save_failed' }, { status: 400 });
      }
    }
    const next = applyTaskAction({ ...persisted, pid: 'pending', title: persisted.prompt || 'video generation', owner: 'operator-unassigned', mode: 'video', model: persisted.model || persisted.provider }, action as TaskAction);
    const updated = updateProviderTask(taskId, { status: next.status, progress: next.progress, error: next.error, providerResponse: undefined, inventorySavedAt: next.inventorySavedAt, providerTaskId: next.providerTaskId, outputUrls: next.outputUrls, outputBase64: next.outputBase64, ...(action === 'pause' ? { metadata: { ...(persisted.metadata ?? {}), schedulerState: 'paused', pausedByUserAt: new Date().toISOString() } } : {}) });
    if (action === 'cancel' || action === 'pause') pumpProviderTasks(typeof persisted.metadata?.ownerId === 'string' ? persisted.metadata.ownerId : persisted.accountId, 'video');
    return NextResponse.json({ success: true, data: updated });
  }
  const task = getServerWorkspaceTasks({ accountId: id, mode: 'video' }).find((item) => item.id === taskId);
  if (!task) return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  return NextResponse.json({ success: true, data: applyTaskAction(task, action as TaskAction) });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const task = getProviderTask(taskId);
  if (!task || task.accountId !== id || task.mode !== 'video') return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
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
