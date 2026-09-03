import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { deleteAsset, getAsset, readAssetFile, renameAsset, updatePromptAsset } from '@/lib/workspace/assetStore';

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
    const file = readAssetFile(id, assetId);
    if (!file) return NextResponse.json({ success: false, error: 'asset_file_not_found' }, { status: 404 });
    const encodedName = encodeURIComponent(file.asset.name).replace(/[\\'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    const headers = new Headers({
      'content-type': file.asset.mimeType || 'application/octet-stream',
      'content-length': String(file.bytes.length),
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodedName}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    return new Response(new Uint8Array(file.bytes), { status: 200, headers });
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
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const body = await request.json().catch(() => null) as { name?: unknown; content?: unknown; category?: unknown } | null;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.name !== 'string' || !body.name.trim() || (body.content !== undefined && (typeof body.content !== 'string' || !body.content.trim()))) {
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
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  try {
    const asset = deleteAsset(id, assetId);
    return asset ? NextResponse.json({ success: true, data: { assetId: asset.id, deleted: true } }) : NextResponse.json({ success: false, error: 'asset_not_found' }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'asset_delete_failed' }, { status: 400 });
  }
}
