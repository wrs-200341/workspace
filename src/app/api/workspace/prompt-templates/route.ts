import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { getWorkspaceOperatorForUser } from '@/lib/workspace/data';
import { listStoredAccounts } from '@/lib/workspace/accountStore';
import { listAssets } from '@/lib/workspace/assetStore';

export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const ownerId = auth.role === 'admin'
    ? undefined
    : auth.role === 'workspace'
      ? 'operator-chenxi'
      : getWorkspaceOperatorForUser(auth.username, auth.displayName).id;
  const requestedAccountId = request.nextUrl.searchParams.get('accountId')?.trim() || undefined;
  const requestedCategory = request.nextUrl.searchParams.get('category');
  if (requestedCategory && requestedCategory !== 'image' && requestedCategory !== 'video') return NextResponse.json({ success: false, error: 'prompt_category_invalid' }, { status: 400 });
  const accounts = listStoredAccounts(ownerId ? { ownerId } : {}).filter((account) => !requestedAccountId || account.id === requestedAccountId);
  const templates = accounts.flatMap((account) => listAssets(account.id, 'prompt').map((asset) => ({
    id: asset.id,
    name: asset.name,
    content: asset.content ?? '',
    accountId: account.id,
    accountName: account.name,
    category: asset.category ?? 'video',
    updatedAt: asset.updatedAt,
  }))).filter((template) => !requestedCategory || template.category === requestedCategory);
  return NextResponse.json({ success: true, data: { templates } });
}
