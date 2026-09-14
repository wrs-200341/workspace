import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { getWorkspaceOperators } from '@/lib/workspace/data';
import { workspaceOwnerIdForUser } from '@/lib/workspace/access';
import { getServerWorkspaceTaskCounters, type WorkspaceOwnerTaskCounters } from '@/lib/workspace/serverTasks';

const EMPTY_COUNTERS: WorkspaceOwnerTaskCounters = {
  inventorySavedToday: 0,
  completedNotInInventory: 0,
  running: 0,
  queued: 0,
  failed: 0,
};

function addCounters(left: WorkspaceOwnerTaskCounters, right: WorkspaceOwnerTaskCounters): WorkspaceOwnerTaskCounters {
  return {
    inventorySavedToday: left.inventorySavedToday + right.inventorySavedToday,
    completedNotInInventory: left.completedNotInInventory + right.completedNotInInventory,
    running: left.running + right.running,
    queued: left.queued + right.queued,
    failed: left.failed + right.failed,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const operators = getWorkspaceOperators();
  const requestedOwner = request.nextUrl.searchParams.get('ownerId') || undefined;
  const ownerId = auth.role === 'workspace' ? workspaceOwnerIdForUser(auth) : requestedOwner;
  const counters = getServerWorkspaceTaskCounters(ownerId ? { ownerId } : {});
  const visibleOperators = auth.role === 'workspace'
    ? operators.filter((operator) => operator.id === ownerId)
    : ownerId
      ? operators.filter((operator) => operator.id === ownerId)
      : operators;
  const rows = visibleOperators.map((operator) => ({
    operatorId: operator.id,
    operatorName: operator.name,
    ...EMPTY_COUNTERS,
    ...(counters[operator.id] ?? {}),
  }));
  const summary = rows.reduce<WorkspaceOwnerTaskCounters>((total, row) => addCounters(total, row), { ...EMPTY_COUNTERS });
  return NextResponse.json({ success: true, data: { ownerId: ownerId ?? null, counters, rows, summary, updatedAt: new Date().toISOString() } });
}
