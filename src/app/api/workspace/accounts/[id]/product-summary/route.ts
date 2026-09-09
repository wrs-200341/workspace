import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { assertAssetAccountId } from '@/lib/workspace/assetStore';
import { getProductSummaryWorkbookInfo, lookupProductSummaryForAccount, saveProductSummaryWorkbook } from '@/lib/workspace/productSummary';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  let accountId: string;
  try { accountId = assertAssetAccountId(id); } catch { return NextResponse.json({ success: false, error: 'account_id_invalid' }, { status: 400 }); }
  if (!canAccessWorkspaceAccount(auth, accountId)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const referenceName = _request.nextUrl.searchParams.get('referenceName')?.trim() || '';
  const info = getProductSummaryWorkbookInfo(accountId);
  const match = referenceName ? lookupProductSummaryForAccount(accountId, referenceName) : null;
  return NextResponse.json({ success: true, data: { ...info, match } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  let accountId: string;
  try { accountId = assertAssetAccountId(id); } catch { return NextResponse.json({ success: false, error: 'account_id_invalid' }, { status: 400 }); }
  if (!canAccessWorkspaceAccount(auth, accountId, { write: true })) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: 'product_summary_file_required' }, { status: 400 });
    const info = saveProductSummaryWorkbook(accountId, { name: file.name, type: file.type, size: file.size, arrayBuffer: await file.arrayBuffer() });
    return NextResponse.json({ success: true, data: info }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'product_summary_upload_failed';
    const known = new Set(['product_summary_file_required', 'product_summary_file_invalid', 'product_summary_file_type_invalid']);
    return NextResponse.json({ success: false, error: known.has(message) ? message : 'product_summary_upload_failed' }, { status: message === 'product_summary_file_type_invalid' ? 415 : 400 });
  }
}
