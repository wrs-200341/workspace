import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { deleteProviderTask, getProviderTask, updateProviderTask } from '@/lib/providers/taskStore';
import { isProviderLiveEnabled } from '@/lib/providers/config';
import { sanitizeProviderError, syncProviderTask } from '@/lib/providers/client';
import { getServerWorkspaceTasks } from '@/lib/workspace/serverTasks';
import { applyTaskAction, type TaskAction } from '@/lib/workspace/taskActions';
import { productionRestoreConfig } from '@/lib/workspace/productionRestore';
import { repairSavedVideoTaskInventory, saveVideoTaskOutputsToAssets } from '@/lib/workspace/videoInventory';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  await repairSavedVideoTaskInventory([id]);
  const persisted = getProviderTask(taskId);
  if (persisted && persisted.accountId === id && persisted.mode === 'video') {
    let current = persisted;
    const legacyGenericError = persisted.error === 'provider request failed' || persisted.error === 'provider_request_failed';
    if (persisted.providerTaskId && isProviderLiveEnabled(persisted.provider) && (
      ['submitting', 'queued', 'submitted', 'processing', 'running'].includes(persisted.status) ||
      (persisted.status === 'failed' && legacyGenericError)
    )) {
      try {
        const status = await syncProviderTask(persisted.provider, persisted.providerTaskId);
        current = updateProviderTask(taskId, { status: status.status === 'unknown' ? persisted.status : status.status, progress: status.progress, providerTaskId: status.providerTaskId ?? persisted.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64, error: status.error }) ?? persisted;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.startsWith('provider_')) {
          current = updateProviderTask(taskId, { status: 'failed', progress: 100, error: sanitizeProviderError(message) }) ?? persisted;
        }
      }
    }
    return NextResponse.json({ success: true, data: { ...current, restoreConfig: productionRestoreConfig(current), reviewUrl: `/workspace/accounts/${id}/production/video-tasks/${taskId}` } });
  }
  const task = getServerWorkspaceTasks({ accountId: id, mode: 'video' }).find((item) => item.id === taskId);
  if (!task) return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  return NextResponse.json({ success: true, data: { ...task, reviewUrl: `/workspace/accounts/${id}/production/video-tasks/${taskId}` } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  await repairSavedVideoTaskInventory([id]);
  const body = await request.json().catch(() => ({}));
  const action = body?.action as TaskAction;
  if (!['retry', 'cancel', 'save-inventory', 'pause', 'resume'].includes(action)) return NextResponse.json({ success: false, error: 'invalid_task_action' }, { status: 400 });
  const persisted = getProviderTask(taskId);
  if (persisted && persisted.accountId === id && persisted.mode === 'video') {
    if (action === 'save-inventory' && persisted.status === 'completed' && !persisted.inventorySavedAt) {
      try {
        const assets = await saveVideoTaskOutputsToAssets(id, persisted);
        if (assets.length === 0) return NextResponse.json({ success: false, error: 'video_outputs_unavailable' }, { status: 409 });
        const updated = updateProviderTask(taskId, { status: persisted.status, progress: persisted.progress, inventorySavedAt: new Date().toISOString(), metadata: { ...(persisted.metadata ?? {}), inventoryAssetIds: assets.map((asset) => asset.id) } });
        return NextResponse.json({ success: true, data: updated, assets });
      } catch (error) {
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'video_inventory_save_failed' }, { status: 400 });
      }
    }
    const next = applyTaskAction({ ...persisted, pid: 'pending', title: persisted.prompt || 'video generation', owner: 'operator-unassigned', mode: 'video', model: persisted.model || persisted.provider }, action);
    const updated = updateProviderTask(taskId, { status: next.status, progress: next.progress, error: next.error, inventorySavedAt: next.inventorySavedAt, providerTaskId: next.providerTaskId, outputUrls: next.outputUrls, outputBase64: next.outputBase64 });
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
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const task = getProviderTask(taskId);
  if (!task || task.accountId !== id || task.mode !== 'video') return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) return NextResponse.json({ success: false, error: 'active_task_cannot_delete' }, { status: 409 });
  deleteProviderTask(taskId);
  return NextResponse.json({ success: true, data: { taskId, deleted: true } });
}
