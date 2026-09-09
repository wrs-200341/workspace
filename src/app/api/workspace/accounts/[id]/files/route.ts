import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { assertAssetAccountId, createPromptAsset, createUploadedAsset, createUploadedAssets, listAssets, type AssetKind } from '@/lib/workspace/assetStore';
import { importExternalImageAsset } from '@/lib/workspace/externalImageImport';

const kinds: AssetKind[] = ['prompt', 'image', 'inventory-video', 'audio'];

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  let accountId: string;
  try { accountId = assertAssetAccountId(id); } catch { return NextResponse.json({ success: false, error: 'account_id_invalid' }, { status: 400 }); }
  if (!canAccessWorkspaceAccount(auth, accountId)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const kind = request.nextUrl.searchParams.get('kind') as AssetKind | null;
  const category = request.nextUrl.searchParams.get('category');
  if (kind && !kinds.includes(kind)) return NextResponse.json({ success: false, error: 'invalid_asset_kind' }, { status: 400 });
  if (category && category !== 'image' && category !== 'video') return NextResponse.json({ success: false, error: 'prompt_category_invalid' }, { status: 400 });
  try {
    const assets = listAssets(accountId, kind ?? undefined).filter((asset) => !category || (asset.category ?? 'video') === category);
    return NextResponse.json({ success: true, data: { accountId, assets } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'asset_list_failed';
    return NextResponse.json({ success: false, error: message === 'account_id_invalid' ? message : 'asset_list_failed' }, { status: message === 'account_id_invalid' ? 400 : 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  let accountId: string;
  try { accountId = assertAssetAccountId(id); } catch { return NextResponse.json({ success: false, error: 'account_id_invalid' }, { status: 400 }); }
  if (!canAccessWorkspaceAccount(auth, accountId, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const contentType = request.headers.get('content-type') || '';
  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const kind = form.get('kind');
      const batchEntries = form.getAll('files');
      const legacyFile = form.get('file');
      const entries = batchEntries.length ? batchEntries : legacyFile ? [legacyFile] : [];
      if (!entries.length || entries.some((entry) => !(entry instanceof File)) || !kinds.includes(kind as AssetKind) || kind === 'prompt') {
        return NextResponse.json({ success: false, error: 'asset_file_required' }, { status: 400 });
      }
      const files = entries as File[];
      if (files.length > 50 || files.reduce((total, file) => total + file.size, 0) > 250 * 1024 * 1024) {
        return NextResponse.json({ success: false, error: 'asset_upload_batch_too_large' }, { status: 413 });
      }
      if (batchEntries.length) {
        const assets = createUploadedAssets(accountId, kind as Exclude<AssetKind, 'prompt'>, await Promise.all(files.map(async (file) => ({ name: file.name, type: file.type, size: file.size, arrayBuffer: await file.arrayBuffer() }))));
        return NextResponse.json({ success: true, data: { assets } }, { status: 201 });
      }
      const file = files[0];
      return NextResponse.json({ success: true, data: createUploadedAsset(accountId, kind as Exclude<AssetKind, 'prompt'>, { name: file.name, type: file.type, size: file.size, arrayBuffer: await file.arrayBuffer() }) }, { status: 201 });
    }
    const body = await request.json().catch(() => ({})) as { kind?: unknown; name?: unknown; content?: unknown; url?: unknown; category?: unknown };
    if (body.kind === 'image' && typeof body.url === 'string') {
      if (!body.url.trim()) return NextResponse.json({ success: false, error: 'image_url_required' }, { status: 400 });
      const asset = await importExternalImageAsset(accountId, body.url, { name: typeof body.name === 'string' ? body.name : undefined });
      return NextResponse.json({ success: true, data: asset }, { status: 201 });
    }
    if (body.kind !== 'prompt' || typeof body.name !== 'string' || typeof body.content !== 'string') return NextResponse.json({ success: false, error: 'prompt_asset_required' }, { status: 400 });
    if (body.category !== undefined && body.category !== 'image' && body.category !== 'video') return NextResponse.json({ success: false, error: 'prompt_category_invalid' }, { status: 400 });
    return NextResponse.json({ success: true, data: createPromptAsset(accountId, { name: body.name, content: body.content, category: body.category as 'image' | 'video' | undefined }) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'asset_create_failed';
    const known = new Set([
      'account_id_invalid', 'image_url_invalid', 'image_url_target_blocked', 'image_redirect_invalid',
      'image_redirect_limit', 'image_file_too_large', 'image_file_empty', 'image_content_invalid',
      'image_content_type_invalid', 'image_url_required', 'external_asset_auth_required',
      'asset_file_invalid', 'asset_file_type_invalid', 'asset_content_required',
      'asset_upload_batch_too_large',
    ]);
    const status = message === 'external_asset_auth_required' ? 422 : message === 'image_file_too_large' ? 413 : message === 'asset_file_type_invalid' ? 415 : 400;
    return NextResponse.json({ success: false, error: known.has(message) || message.startsWith('image_source_http_') ? message : 'asset_create_failed' }, { status });
  }
}
