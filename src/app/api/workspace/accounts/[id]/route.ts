import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { canAccessWorkspaceAccount } from '@/lib/workspace/access';
import { updateStoredAccount, listStoredAccounts } from '@/lib/workspace/accountStore';
import { withLiveAccountStats } from '@/lib/workspace/accountStats';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // The workspace UI exposes account editing to operators as well as admins
  // and workspace users. Keep the API policy aligned with that surface so an
  // operator (such as Emily) can correct the account they just created.
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  try {
    const updated = updateStoredAccount(id, body);
    if (!updated) return NextResponse.json({ success: false, error: 'account_not_found' }, { status: 404 });
    // Return counters derived from current assets/tasks. The account store's
    // legacy counter fields are retained only for backwards compatibility.
    return NextResponse.json({ success: true, data: withLiveAccountStats(updated) });
  } catch (error) { return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'account_update_failed' }, { status: 400 }); }
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!canAccessWorkspaceAccount(auth, id)) return NextResponse.json({ success: false, error: 'forbidden_account_scope' }, { status: 403 });
  const account = listStoredAccounts().find((item) => item.id === id);
  return account ? NextResponse.json({ success: true, data: withLiveAccountStats(account) }) : NextResponse.json({ success: false, error: 'account_not_found' }, { status: 404 });
}
