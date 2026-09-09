import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { listProductImageAssets, listProductImageFolders, listProductImages, readProductImageFolder } from '@/lib/workspace/productImages';

export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const requestedAccountId = request.nextUrl.searchParams.get('accountId')?.trim() || '';
  if (!requestedAccountId && auth.role !== 'admin') return NextResponse.json({ success: false, error: 'account_scope_required' }, { status: 400 });
  if (requestedAccountId && !canAccessWorkspaceAccount(auth, requestedAccountId)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  // A `pid` query opens one folder: images are read lazily here so the folder
  // list stays cheap for accounts holding thousands of PIDs.
  const requestedPid = request.nextUrl.searchParams.get('pid')?.trim() || '';
  if (requestedPid) {
    // Product folders are shared across every operator account, so the lookup
    // is global; the account id above is only used for the access check.
    const folder = readProductImageFolder(undefined, requestedPid);
    if (!folder) return NextResponse.json({ success: false, error: 'product_folder_not_found' }, { status: 404 });
    const { relativePath: _relativePath, files: _files, ...rest } = folder;
    const images = (folder.images ?? []).map(({ relativePath: _path, ...asset }) => ({ ...asset, kind: 'product-image' as const, shared: true }));
    return NextResponse.json({ success: true, data: { folder: { ...rest, images } } });
  }
  const folders = listProductImageFolders(undefined);
  return NextResponse.json({ success: true, data: { folders } });
}
