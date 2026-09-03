import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { getProviderTask } from '@/lib/providers/taskStore';
import { readStoredVideoOutput } from '@/lib/providers/outputStore';
import { dedupeVideoOutputUrls } from '@/lib/providers/videoOutputUrls';
import { cacheVideoTaskOutputLocally } from '@/lib/workspace/videoInventory';

function safeTaskId(value: string): string { return /^[a-zA-Z0-9_-]+$/.test(value) ? value : 'task'; }

/**
 * Serve a task output from the server-side cache. A cache miss performs one
 * authenticated/provider fetch on the server and stores the bytes before the
 * response is returned, so the browser never talks to a supplier CDN.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; taskId: string; index: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, taskId, index: rawIndex } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const task = getProviderTask(taskId);
  if (!task || task.accountId !== id || task.mode !== 'video') return NextResponse.json({ success: false, error: 'task_not_found' }, { status: 404 });
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0 || index > 63) return NextResponse.json({ success: false, error: 'output_not_found' }, { status: 404 });

  const urls = dedupeVideoOutputUrls(task.provider, task.outputUrls);
  const base64Index = index - urls.length;
  try {
    if (!readStoredVideoOutput(id, taskId, index)) await cacheVideoTaskOutputLocally(id, task, index);
    const output = readStoredVideoOutput(id, taskId, index);
    if (!output && base64Index >= 0 && task.outputBase64[base64Index]) {
      await cacheVideoTaskOutputLocally(id, task, index);
    }
    const cached = readStoredVideoOutput(id, taskId, index);
    if (!cached) return NextResponse.json({ success: false, error: 'output_unavailable' }, { status: 404 });
    const disposition = request.nextUrl.searchParams.get('download') === '1' ? 'attachment' : 'inline';
    return new NextResponse(new Uint8Array(cached.bytes), {
      status: 200,
      headers: {
        'content-type': cached.mimeType,
        'content-length': String(cached.bytes.byteLength),
        'cache-control': 'private, max-age=3600',
        'content-disposition': `${disposition}; filename="workspace-${safeTaskId(taskId)}-${index + 1}.${cached.mimeType.includes('webm') ? 'webm' : cached.mimeType.includes('quicktime') ? 'mov' : 'mp4'}"`,
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const known = ['image_url_invalid', 'image_url_target_blocked', 'provider_not_configured', 'provider_unauthorized', 'provider_response_too_large', 'provider_video_content_invalid'];
    return NextResponse.json({ success: false, error: known.includes(code) ? code : 'output_unavailable' }, { status: code.startsWith('provider_') ? 502 : 404 });
  }
}
