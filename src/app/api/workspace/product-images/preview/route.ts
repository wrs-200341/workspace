import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { getProductImageAbsolutePath, readProductImageAsset } from '@/lib/workspace/productImages';
import fs from 'node:fs';

/** Serve one shared product image for the reference picker preview. */
export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const assetId = request.nextUrl.searchParams.get('assetId')?.trim() || '';
  if (!assetId || assetId.length > 512) return NextResponse.json({ success: false, error: 'asset_id_invalid' }, { status: 400 });
  const asset = readProductImageAsset(assetId);
  if (!asset) return NextResponse.json({ success: false, error: 'asset_not_found' }, { status: 404 });
  try {
    const filePath = getProductImageAbsolutePath(assetId);
    const bytes = fs.readFileSync(filePath);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': asset.mimeType || 'application/octet-stream',
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline',
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'asset_file_not_found' }, { status: 404 });
  }
}
