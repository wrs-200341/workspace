import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { listProductImageAssets, listProductImageFolders, listProductImages } from '@/lib/workspace/productImages';

export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const requestedAccountId = request.nextUrl.searchParams.get('accountId')?.trim() || '';
  if (!requestedAccountId && auth.role !== 'admin') return NextResponse.json({ success: false, error: 'account_scope_required' }, { status: 400 });
  if (requestedAccountId && !canAccessWorkspaceAccount(auth, requestedAccountId)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const assets = listProductImageAssets()
    .map(({ relativePath: _relativePath, ...asset }) => ({ ...asset, shared: asset.id.split(':')[1] === 'shared' }))
    .filter((asset) => asset.shared || !requestedAccountId || asset.id.split(':')[1] === requestedAccountId);
  const visibleRecord = (item: { accountId: string }) => item.accountId === 'shared' || !requestedAccountId || item.accountId === requestedAccountId;
  const imported = listProductImages().filter(visibleRecord);
  const folders = listProductImageFolders().filter(visibleRecord);
  return NextResponse.json({ success: true, data: { assets, imported, folders } });
}
