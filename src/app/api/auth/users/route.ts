import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { createUser, listUsers } from '@/lib/auth/store';
import type { Role } from '@/lib/auth/policy';

export async function GET() { const auth = await requireApiRole(['admin']); if (auth instanceof Response) return auth; return NextResponse.json({ success:true, data:listUsers() }); }

export async function POST(request: NextRequest) {
  const auth = await requireApiRole(['admin']); if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => null) as { username?: unknown; displayName?: unknown; role?: unknown; password?: unknown } | null;
  const isObject = body !== null && typeof body === 'object' && !Array.isArray(body);
  const role = body?.role;
  if (!isObject || typeof body?.username !== 'string' || typeof body?.displayName !== 'string' || typeof body?.password !== 'string' || !['admin','workspace','operator'].includes(String(role))) return NextResponse.json({ success:false, error:'invalid_user_payload' }, { status:400 });
  try { const user = createUser({ username:body.username, displayName:body.displayName, role:role as Role, password:body.password }); return NextResponse.json({ success:true, data:{ user } }, { status:201 }); }
  catch (error) { return NextResponse.json({ success:false, error:error instanceof Error ? error.message : 'user_create_failed' }, { status:400 }); }
}
