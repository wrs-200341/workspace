import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount, workspaceOwnerIdForUser } from '@/lib/workspace/access';
import { getServerWorkspaceTasks } from '@/lib/workspace/serverTasks';
import { businessDate } from '@/lib/workspace/tasks';
import { isProviderLiveEnabled, type ProviderId } from '@/lib/providers/config';
import { syncProviderTask } from '@/lib/providers/client';
import { updateProviderTask } from '@/lib/providers/taskStore';

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
  await Promise.all(tasks.filter((task) => task.provider && task.providerTaskId && ['submitting', 'queued', 'submitted', 'processing', 'running'].includes(task.status) && isProviderLiveEnabled(task.provider as ProviderId)).map(async (task) => {
    try {
      const status = await syncProviderTask(task.provider as ProviderId, task.providerTaskId!);
      updateProviderTask(task.id, { status: status.status === 'unknown' ? task.status : status.status, progress: status.progress, providerTaskId: status.providerTaskId ?? task.providerTaskId, outputUrls: status.outputUrls, outputBase64: status.outputBase64, error: status.error });
    } catch { /* retain last-known local state */ }
  }));
  const refreshed = getServerWorkspaceTasks(ownerScope ? { ownerId, mode: 'image' } : { accountId: id, mode: 'image' }).filter((task) => !date || businessDate(task.createdAt) === date);
  return NextResponse.json({ success: true, data: refreshed, tasks: refreshed });
}
