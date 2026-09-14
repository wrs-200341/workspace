import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { getProductImageAbsolutePath, readProductImageAsset } from '@/lib/workspace/productImages';
import { getProductImageThumbnail, productImageFileVersion } from '@/lib/workspace/productImageThumbnails';
import fs from 'node:fs';
import { Readable } from 'node:stream';

export const runtime = 'nodejs';

/** Serve one shared product image for the reference picker preview. */
export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const assetId = request.nextUrl.searchParams.get('assetId')?.trim() || '';
  if (!assetId || assetId.length > 512) return NextResponse.json({ success: false, error: 'asset_id_invalid' }, { status: 400 });
  const asset = readProductImageAsset(assetId);
  if (!asset) return NextResponse.json({ success: false, error: 'asset_not_found' }, { status: 404 });
  const ownerId = asset.id.split(':')[1] || '';
  if (ownerId !== 'shared' && !canAccessWorkspaceAccount(auth, ownerId)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  try {
    const filePath = getProductImageAbsolutePath(assetId);
    const thumbnail = request.nextUrl.searchParams.get('thumbnail') === '1';
    const sourceStat = await fs.promises.stat(filePath);
    if (!sourceStat.isFile() || !sourceStat.size) throw new Error('reference_asset_not_found');
    let file = { filePath, mimeType: asset.mimeType || 'application/octet-stream', size: sourceStat.size, version: productImageFileVersion(sourceStat) };
    let resized = false;
    if (thumbnail) {
      try {
        file = await getProductImageThumbnail(filePath);
        resized = true;
      } catch (error) {
        // Some imported formats (notably BMP) are browser-readable but lack a bundled decoder.
        if (!(error instanceof Error) || error.message !== 'product_thumbnail_format_unsupported') throw error;
      }
    }
    const etag = `"${resized ? 'thumb-480-v1' : 'original'}-${file.version}"`;
    const versionMatches = request.nextUrl.searchParams.get('v') === file.version;
    const headers = {
      'content-type': file.mimeType,
      'cache-control': versionMatches ? 'private, max-age=31536000, immutable' : 'private, max-age=300, must-revalidate',
      'etag': etag,
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
      'vary': 'Cookie',
    };
    if (request.headers.get('if-none-match')?.split(',').some((value) => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) {
      return new Response(null, { status: 304, headers });
    }
    const stream = Readable.toWeb(fs.createReadStream(file.filePath)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: {
        ...headers,
        'content-length': String(file.size),
      },
    });
  } catch (error) {
    if (error instanceof Error && ['product_thumbnail_busy', 'product_thumbnail_source_changed'].includes(error.message)) {
      return NextResponse.json({ success: false, error: error.message }, { status: 503, headers: { 'retry-after': '1', 'cache-control': 'no-store' } });
    }
    return NextResponse.json({ success: false, error: 'asset_file_not_found' }, { status: 404 });
  }
}
