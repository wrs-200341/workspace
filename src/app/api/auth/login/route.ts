import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE } from '@/lib/auth/server';
import { authenticate, createSession, listUsers } from '@/lib/auth/store';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password) return NextResponse.json({ success:false, error:'credentials_required' }, { status:400 });
  if (!listUsers().length) return NextResponse.json({ success:false, error:'auth_not_initialized' }, { status:503 });
  const user = authenticate(username, password);
  if (!user) return NextResponse.json({ success:false, error:'invalid_credentials' }, { status:401 });
  const response = NextResponse.json({ success:true, data:{ user } });
  // The current LAN deployment is served over HTTP. Keep Secure opt-in so the
  // browser does not discard the session cookie on http://192.168.1.126:3000.
  const secure = process.env.WORKSPACE_COOKIE_SECURE === 'true';
  response.cookies.set(AUTH_COOKIE, createSession(user.id), { httpOnly:true, sameSite:'lax', secure, path:'/', maxAge:7 * 86400 });
  return response;
}
