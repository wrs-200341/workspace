import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { checkTaskAssignmentPid } from '@/lib/workspace/taskAssignmentPidCheck';

function statusForError(code: string): number {
  if (code === 'invalid_pid' || code === 'invalid_source') return 400;
  if (code === 'pid_check_timeout') return 504;
  return 502;
}

export async function POST(request: NextRequest) {
  const auth = await requireApiRole(['admin']);
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  try {
    const data = await checkTaskAssignmentPid(body.pid, body.source);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'pid_check_failed';
    return NextResponse.json({ success: false, error: code }, { status: statusForError(code) });
  }
}
