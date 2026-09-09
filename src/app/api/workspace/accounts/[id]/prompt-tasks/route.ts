import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount, workspaceOwnerIdForUser } from '@/lib/workspace/access';
import * as serverTasks from '@/lib/workspace/serverTasks';
import { businessDate } from '@/lib/workspace/tasks';

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
  const filters = ownerScope ? { ownerId, mode: 'prompt' as const } : { accountId: id, mode: 'prompt' as const };
  const queueReader = Object.prototype.hasOwnProperty.call(serverTasks, 'getServerWorkspaceQueueTasks')
    ? serverTasks.getServerWorkspaceQueueTasks
    : serverTasks.getServerWorkspaceTasks;
  const tasks = queueReader(filters).filter((task) => !date || businessDate(task.createdAt) === date);
  return NextResponse.json({ success: true, data: tasks, tasks });
}
