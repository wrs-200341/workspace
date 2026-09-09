import fs from 'node:fs';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { getProviderTask } from '@/lib/providers/taskStore';
import { getStoredVideoOutputFileInfo } from '@/lib/providers/outputStore';
import { dedupeVideoOutputUrls } from '@/lib/providers/videoOutputUrls';
import { cacheVideoTaskOutputLocally } from '@/lib/workspace/videoInventory';
import { getAssetFileInfo } from '@/lib/workspace/assetStore';

export const runtime = 'nodejs';

function safeTaskId(value: string): string { return /^[a-zA-Z0-9_-]+$/.test(value) ? value : 'task'; }

function readInventoryVideoFallback(accountId: string, task: { metadata?: Record<string, unknown> }, index: number): { filePath: string; size: number; mimeType: string } | null {
  const ids = Array.isArray(task.metadata?.inventoryAssetIds)
    ? task.metadata.inventoryAssetIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  const assetId = ids[index];
  if (!assetId) return null;
  const stored = getAssetFileInfo(accountId, assetId);
  if (!stored || stored.asset.kind !== 'inventory-video') return null;
  const mimeType = stored.asset.mimeType?.split(';', 1)[0].trim().toLowerCase() || 'video/mp4';
  if (!mimeType.startsWith('video/')) return null;
  return { filePath: stored.filePath, size: stored.size, mimeType };
}

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
    let output = getStoredVideoOutputFileInfo(id, taskId, index);
    if (!output) {
      // A cache miss may need the full provider response once; subsequent
      // requests use metadata only and stream the local file.
      await cacheVideoTaskOutputLocally(id, task, index);
      output = getStoredVideoOutputFileInfo(id, taskId, index);
    }
    if (!output && base64Index >= 0 && task.outputBase64[base64Index]) {
      await cacheVideoTaskOutputLocally(id, task, index);
      output = getStoredVideoOutputFileInfo(id, taskId, index);
    }
    const cached = output ?? readInventoryVideoFallback(id, task, index);
    if (!cached) return NextResponse.json({ success: false, error: 'output_unavailable' }, { status: 404 });
    const disposition = request.nextUrl.searchParams.get('download') === '1' ? 'attachment' : 'inline';
    const baseHeaders = {
      'content-type': cached.mimeType,
      'cache-control': 'private, max-age=3600',
      'content-disposition': `${disposition}; filename="workspace-${safeTaskId(taskId)}-${index + 1}.${cached.mimeType.includes('webm') ? 'webm' : cached.mimeType.includes('quicktime') ? 'mov' : 'mp4'}"`,
      'accept-ranges': 'bytes',
    };
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
      if (!match) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${cached.size}` } });
      const start = match[1] ? Number(match[1]) : Math.max(0, cached.size - Number(match[2] || 0));
      const end = Math.min(cached.size - 1, match[2] ? Number(match[2]) : cached.size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= cached.size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${cached.size}` } });
      const headers = new Headers({ ...baseHeaders, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${cached.size}` });
      return new Response(Readable.toWeb(fs.createReadStream(cached.filePath, { start, end })) as ReadableStream, { status: 206, headers });
    }
    const headers = new Headers({ ...baseHeaders, 'content-length': String(cached.size) });
    return new Response(Readable.toWeb(fs.createReadStream(cached.filePath)) as ReadableStream, { status: 200, headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const known = ['image_url_invalid', 'image_url_target_blocked', 'provider_not_configured', 'provider_unauthorized', 'provider_response_too_large', 'provider_video_content_invalid'];
    return NextResponse.json({ success: false, error: known.includes(code) ? code : 'output_unavailable' }, { status: code.startsWith('provider_') ? 502 : 404 });
  }
}
