import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { workspaceOwnerIdForUser } from '@/lib/workspace/access';
import { deleteTaskAssignment, updateTaskAssignment, updateTaskAssignmentFeedback } from '@/lib/workspace/taskAssignments';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  try {
    if (Object.prototype.hasOwnProperty.call(body, 'feedback')) {
      const operatorId = auth.role === 'admin' ? undefined : workspaceOwnerIdForUser(auth);
      const updated = updateTaskAssignmentFeedback(id, operatorId, body.feedback);
      return updated
        ? NextResponse.json({ success: true, data: updated })
        : NextResponse.json({ success: false, error: 'assignment_not_found' }, { status: 404 });
    }
    if (auth.role !== 'admin') return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 });
    const updated = updateTaskAssignment(id, { pid: body.pid, source: body.source, urgent: body.urgent, operatorId: body.operatorId, quantity: body.quantity });
    return updated
      ? NextResponse.json({ success: true, data: updated })
      : NextResponse.json({ success: false, error: 'assignment_not_found' }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'assignment_update_failed';
    return NextResponse.json({ success: false, error: message }, { status: message === 'forbidden' ? 403 : 400 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  return deleteTaskAssignment(id)
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: 'assignment_not_found' }, { status: 404 });
}
