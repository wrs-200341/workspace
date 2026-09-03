import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { deleteUser, getUserById, updateUser } from '@/lib/auth/store';
import type { Role } from '@/lib/auth/policy';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const user = getUserById(id);
  return user ? NextResponse.json({ success: true, data: { user } }) : NextResponse.json({ success: false, error: 'user_not_found' }, { status: 404 });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await request.json().catch(() => null) as { displayName?: unknown; role?: unknown; password?: unknown } | null;
  const isObject = body !== null && typeof body === 'object' && !Array.isArray(body);
  if (!isObject || Object.keys(body as object).length === 0 || (body.displayName !== undefined && typeof body.displayName !== 'string') || (body.role !== undefined && !['admin', 'workspace', 'operator'].includes(String(body.role))) || (body.password !== undefined && typeof body.password !== 'string')) {
    return NextResponse.json({ success: false, error: 'invalid_user_payload' }, { status: 400 });
  }
  if (id === auth.id && body.role !== undefined && body.role !== 'admin') return NextResponse.json({ success: false, error: 'self_admin_demotion_forbidden' }, { status: 400 });
  try {
    const user = updateUser(id, { displayName: body.displayName as string | undefined, role: body.role as Role | undefined, password: body.password as string | undefined });
    return NextResponse.json({ success: true, data: { user } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'user_update_failed' }, { status: 400 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole(['admin']);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (id === auth.id) return NextResponse.json({ success: false, error: 'self_delete_forbidden' }, { status: 400 });
  try {
    const user = deleteUser(id);
    return NextResponse.json({ success: true, data: { userId: user.id, deleted: true } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'user_delete_failed' }, { status: 400 });
  }
}
