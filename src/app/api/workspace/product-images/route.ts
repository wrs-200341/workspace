import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { listProductImageAssets, listProductImages } from '@/lib/workspace/productImages';

export async function GET() {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const assets = listProductImageAssets().map(({ relativePath: _relativePath, ...asset }) => ({ ...asset, shared: true }));
  return NextResponse.json({ success: true, data: { assets, imported: listProductImages() } });
}
