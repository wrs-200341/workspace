import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { getProviderTask } from '@/lib/providers/taskStore';
import { downloadProviderVideoContent } from '@/lib/providers/client';

/**
 * Authenticated video-output proxy. MGRouter (and the historical snumom /
 * OAIRegBox content endpoints) require a bearer token, so a browser cannot
 * safely use the persisted provider URL directly. The proxy keeps provider
 * credentials server-side and streams only the selected task output.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string; index: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId, index: rawIndex } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const task = getProviderTask(taskId);
  if (!task || task.accountId !== id || task.mode !== 'video') return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0 || index > 63) return NextResponse.json({ success: false, error: 'output_not_found' }, { status: 404 });
  if (!task.providerTaskId || !['grok-video', 'mgrouter-grok-video', 'oairegbox-omni'].includes(task.provider)) {
    return NextResponse.json({ success: false, error: 'output_proxy_unsupported' }, { status: 404 });
  }
  if (index >= task.outputUrls.length && index >= task.outputBase64.length) {
    return NextResponse.json({ success: false, error: 'output_not_found' }, { status: 404 });
  }
  try {
    const output = await downloadProviderVideoContent(task.provider, task.providerTaskId);
    return new NextResponse(new Uint8Array(output.bytes), {
      status: 200,
      headers: {
        'content-type': output.mimeType,
        'content-length': String(output.bytes.byteLength),
        'cache-control': 'private, max-age=3600',
        'content-disposition': `inline; filename="workspace-${taskId}-${index + 1}.mp4"`,
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const status = code === 'provider_not_configured' ? 503 : code.startsWith('provider_') ? 502 : 404;
    return NextResponse.json({ success: false, error: status === 502 || status === 503 ? code : 'output_unavailable' }, { status });
  }
}
