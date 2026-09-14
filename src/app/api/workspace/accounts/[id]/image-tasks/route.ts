import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount, workspaceOwnerIdForAccount, workspaceOwnerIdForUser } from '@/lib/workspace/access';
import * as serverTasks from '@/lib/workspace/serverTasks';
import { businessDate } from '@/lib/workspace/tasks';


export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = performance.now();
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
  const filters = ownerScope ? { ownerId, mode: 'image' as const, date: date || undefined } : { accountId: id, mode: 'image' as const, date: date || undefined };
  if (request.nextUrl.searchParams.get('queue') === 'delta') {
    const data = serverTasks.getServerWorkspaceQueueDelta(filters, { viewer: `${auth.role}:${auth.username}:${id}`, searchParams: request.nextUrl.searchParams, project: toQueueTask });
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'private, no-store', 'Server-Timing': `queue;dur=${(performance.now() - startedAt).toFixed(1)}` } });
  }
  const queueReader = Object.prototype.hasOwnProperty.call(serverTasks, 'getServerWorkspaceQueueTasks')
    ? serverTasks.getServerWorkspaceQueueTasks
    : serverTasks.getServerWorkspaceTasks;
  const { date: _date, ...legacyFilters } = filters;
  const tasks = queueReader(Object.prototype.hasOwnProperty.call(serverTasks, 'getServerWorkspaceQueueTasks') ? filters : legacyFilters).filter((task) => !date || businessDate(task.createdAt) === date);
  const queueTasks = tasks.map(toQueueTask);
  return NextResponse.json({ success: true, data: queueTasks, tasks: queueTasks });
}


function toQueueTask<T extends Record<string, unknown>>(task: T) {
  const { outputUrls: _outputUrls, outputBase64: _outputBase64, metadata, providerResponse: _providerResponse, ...summary } = task;
  const schedulerState = metadata && typeof metadata === 'object' && typeof (metadata as { schedulerState?: unknown }).schedulerState === 'string'
    ? (metadata as { schedulerState: string }).schedulerState
    : undefined;
  return schedulerState ? { ...summary, schedulerState } : summary;
}
