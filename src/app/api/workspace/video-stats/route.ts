import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { getWorkspaceOperators } from '@/lib/workspace/data';
import { workspaceOwnerIdForUser } from '@/lib/workspace/access';
import { summarizeWorkspaceTasks } from '@/lib/workspace/tasks';
import { getServerWorkspaceTasks } from '@/lib/workspace/serverTasks';

export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const operators = getWorkspaceOperators();
  const requestedOwner = request.nextUrl.searchParams.get('ownerId') || undefined;
  const ownerId = auth.role === 'admin' ? requestedOwner : workspaceOwnerIdForUser(auth);
  const tasks = getServerWorkspaceTasks({ ownerId });
  const summary = summarizeWorkspaceTasks(tasks);
  const rows = (auth.role === 'admin' ? operators : operators.filter((operator) => operator.id === ownerId)).map((operator) => ({ operatorId: operator.id, operatorName: operator.name, ...summarizeWorkspaceTasks(getServerWorkspaceTasks({ ownerId: operator.id })) }));
  return NextResponse.json({ success: true, data: { ownerId: ownerId ?? null, rows, summary, updatedAt: new Date().toISOString() } });
}
