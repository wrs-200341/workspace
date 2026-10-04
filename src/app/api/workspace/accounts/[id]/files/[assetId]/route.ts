import fs from 'node:fs';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { deleteAsset, getAsset, getAssetFileInfo, renameAsset, setAssetPublished, updatePromptAsset } from '@/lib/workspace/assetStore';
import { parseHttpByteRange } from '@/lib/httpByteRange';
import { deleteVideoInventoryAssetSources } from '@/lib/workspace/videoInventory';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; assetId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, assetId } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  try {
    const asset = getAsset(id, assetId);
    if (!asset) return NextResponse.json({ success: false, error: 'asset_not_found' }, { status: 404 });
    const download = request.nextUrl.searchParams.get('download') === '1';
    if (!download && request.nextUrl.searchParams.get('metadata') === '1') {
      return NextResponse.json({ success: true, data: { asset } }, { headers: { 'cache-control': 'private, no-store' } });
    }
    if (asset.kind === 'prompt') {
      if (!download) return NextResponse.json({ success: true, data: { asset } });
      const headers = new Headers({
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${asset.name || 'prompt'}.txt`).replace(/[\\'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      });
      return new Response(asset.content ?? '', { status: 200, headers });
    }
    const file = getAssetFileInfo(id, assetId);
    if (!file) return NextResponse.json({ success: false, error: 'asset_file_not_found' }, { status: 404 });
    const encodedName = encodeURIComponent(file.asset.name).replace(/[\\'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    const baseHeaders = {
      'content-type': file.asset.mimeType || 'application/octet-stream',
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodedName}`,
      // Asset IDs point to immutable uploaded files. A short private cache
      // keeps preview images/videos from being downloaded again on every
      // route transition without exposing account data to shared caches.
      'cache-control': download ? 'private, no-store' : 'private, max-age=300, stale-while-revalidate=3600',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
    };
    // Browsers request only a small byte range for video metadata and seek
    // operations. Returning the complete file here made every card preview
    // allocate and transfer the full clip, which was the main source of slow
    // asset-page loads.
    const range = request.headers.get('range');
    if (range) {
      const parsed = parseHttpByteRange(range, file.size);
      if (!parsed) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${file.size}` } });
      const { start, end } = parsed;
      const headers = new Headers({ ...baseHeaders, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${file.size}` });
      const stream = Readable.toWeb(fs.createReadStream(file.filePath, { start, end })) as ReadableStream;
      return new Response(stream, { status: 206, headers });
    }
    const headers = new Headers({ ...baseHeaders, 'content-length': String(file.size) });
    const stream = Readable.toWeb(fs.createReadStream(file.filePath)) as ReadableStream;
    return new Response(stream, { status: 200, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = message === 'account_id_invalid' || message === 'asset_id_invalid' ? 400 : 404;
    return NextResponse.json({ success: false, error: status === 400 ? message : 'asset_file_not_found' }, { status });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, assetId } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const body = await request.json().catch(() => null) as { name?: unknown; content?: unknown; category?: unknown; published?: unknown } | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ success: false, error: 'asset_name_required' }, { status: 400 });
  // A publish toggle carries no name/content, so it is handled before the
  // rename validation that every other PATCH body must satisfy.
  if (body.published !== undefined) {
    if (typeof body.published !== 'boolean') return NextResponse.json({ success: false, error: 'asset_published_invalid' }, { status: 400 });
    try {
      const asset = setAssetPublished(id, assetId, body.published);
      return asset ? NextResponse.json({ success: true, data: asset }) : NextResponse.json({ success: false, error: 'asset_not_found' }, { status: 404 });
    } catch (error) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'asset_publish_failed' }, { status: 400 });
    }
  }
  if (typeof body.name !== 'string' || !body.name.trim() || (body.content !== undefined && (typeof body.content !== 'string' || !body.content.trim()))) {
    return NextResponse.json({ success: false, error: 'asset_name_required' }, { status: 400 });
  }
  if (body.category !== undefined && body.category !== 'image' && body.category !== 'video') return NextResponse.json({ success: false, error: 'prompt_category_invalid' }, { status: 400 });
  try {
    const asset = body.content !== undefined
      ? updatePromptAsset(id, assetId, { name: body.name, content: body.content, category: body.category as 'image' | 'video' | undefined })
      : renameAsset(id, assetId, body.name);
    return asset ? NextResponse.json({ success: true, data: asset }) : NextResponse.json({ success: false, error: 'asset_not_found' }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'asset_rename_failed' }, { status: 400 });
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id, assetId } = await params;
  if (!canAccessWorkspaceAccount(auth, id, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  try {
    const asset = deleteAsset(id, assetId);
    if (!asset) return NextResponse.json({ success: false, error: 'asset_not_found' }, { status: 404 });
    const generated = asset.kind === 'inventory-video'
      ? deleteVideoInventoryAssetSources(id, asset.id)
      : { linkedTasks: 0, deletedGeneratedFiles: 0 };
    return NextResponse.json({
      success: true,
      data: {
        assetId: asset.id,
        deleted: true,
        sourceFileDeleted: Boolean(asset.relativePath),
        linkedTasks: generated.linkedTasks,
        deletedGeneratedFiles: generated.deletedGeneratedFiles,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'asset_delete_failed' }, { status: 400 });
  }
}
