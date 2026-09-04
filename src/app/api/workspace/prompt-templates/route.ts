import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { listStoredAccounts } from '@/lib/workspace/accountStore';
import { listAssets } from '@/lib/workspace/assetStore';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';

export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const requestedAccountId = request.nextUrl.searchParams.get('accountId')?.trim() || undefined;
  // Prompt templates are account-owned assets.  Requiring an explicit account
  // scope prevents the picker from accidentally exposing templates belonging
  // to another workspace account or operator.
  if (!requestedAccountId) return NextResponse.json({ success: false, error: 'prompt_account_required' }, { status: 400 });
  if (!canAccessWorkspaceAccount(auth, requestedAccountId)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const requestedCategory = request.nextUrl.searchParams.get('category');
  if (requestedCategory && requestedCategory !== 'image' && requestedCategory !== 'video') return NextResponse.json({ success: false, error: 'prompt_category_invalid' }, { status: 400 });
  // `canAccessWorkspaceAccount` above is the authoritative scope check. Do
  // not apply the authenticated operator's own owner filter here: operators
  // are allowed to inspect another operator's workspace in read-only mode,
  // and that account's templates must remain visible in its own picker.
  const accounts = listStoredAccounts().filter((account) => account.id === requestedAccountId);
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
