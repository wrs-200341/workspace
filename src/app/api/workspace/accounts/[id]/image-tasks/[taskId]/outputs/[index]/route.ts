import { NextRequest, NextResponse } from 'next/server';
import { getProviderTask } from '@/lib/providers/taskStore';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { requireApiRole } from '@/lib/auth/server';
import { readStoredOutput } from '@/lib/providers/outputStore';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string; index: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId, index: rawIndex } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const task = getProviderTask(taskId);
  if (!task || task.accountId !== id || task.mode !== 'image') return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0 || index > 63) return NextResponse.json({ success: false, error: 'output_not_found' }, { status: 404 });
  const output = readStoredOutput(id, taskId, index);
  if (!output) return NextResponse.json({ success: false, error: 'output_not_found' }, { status: 404 });
  return new NextResponse(new Uint8Array(output.bytes), { status: 200, headers: { 'content-type': output.mimeType, 'cache-control': 'private, max-age=3600', 'content-length': String(output.bytes.length) } });
}
