import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { getWorkspaceOperatorForUser, getWorkspaceOperators, type WorkspaceCategory } from '@/lib/workspace/data';
import { createStoredAccount, listStoredAccounts } from '@/lib/workspace/accountStore';
import { withLiveAccountStatsList } from '@/lib/workspace/accountStats';

const categories: WorkspaceCategory[] = ['featured', 'remix'];

export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const queryOwner = request.nextUrl.searchParams.get('ownerId') || undefined;
  const category = request.nextUrl.searchParams.get('category') as WorkspaceCategory | null;
  if (category && !categories.includes(category)) return NextResponse.json({ success: false, error: 'invalid_category' }, { status: 400 });
  const recoveredOperators = getWorkspaceOperators();
  const ownOperator = auth.role === 'workspace'
    ? (recoveredOperators.find((operator) => operator.id === 'operator-chenxi') ?? recoveredOperators[1])
    : getWorkspaceOperatorForUser(auth.username, auth.displayName);
  const operators = auth.role === 'admin' ? recoveredOperators : ownOperator ? [ownOperator] : [];
  const ownerId = auth.role === 'admin' ? queryOwner : ownOperator?.id;
  const storedAccounts = listStoredAccounts({ ownerId, category: category ?? undefined });
  return NextResponse.json({ success: true, data: { operators, accounts: withLiveAccountStatsList(storedAccounts), ownerId: ownerId ?? null, category: category ?? 'all' } });
}

export async function POST(request: NextRequest) {
  // Operators can add accounts from their own workbench. The previous route
  // excluded this role even though the workspace UI exposes the Add Account
  // action to all three authenticated roles, so Emily and other operators
  // received a 403 immediately after submitting the form.
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({})) as { ownerId?: unknown; ownerName?: unknown; name?: unknown; category?: unknown; strategy?: unknown };
  const operators = getWorkspaceOperators();
  const own = auth.role === 'admin'
    ? operators[0]
    : auth.role === 'workspace'
      ? (operators.find((operator) => operator.id === 'operator-chenxi') ?? operators[1])
      : getWorkspaceOperatorForUser(auth.username, auth.displayName);
  const owner = auth.role === 'admin' && typeof body.ownerId === 'string' ? operators.find((operator) => operator.id === body.ownerId) : own;
  const category = body.category === 'remix' ? 'remix' : 'featured';
  if (!owner || typeof body.name !== 'string' || !body.name.trim()) return NextResponse.json({ success: false, error: 'account_name_required' }, { status: 400 });
  try { return NextResponse.json({ success: true, data: createStoredAccount({ ownerId: owner.id, ownerName: owner.name, name: body.name, category, strategy: typeof body.strategy === 'string' ? body.strategy : '' }) }, { status: 201 }); }
  catch { return NextResponse.json({ success: false, error: 'account_create_failed' }, { status: 400 }); }
}
