import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { canAccessRole, type AuthUser, type Role } from './policy';
import { revokeSession, resolveSession } from './store';

export const AUTH_COOKIE = 'workspace_session';

export async function getCurrentUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  return resolveSession(cookieStore.get(AUTH_COOKIE)?.value);
}

export async function requirePageRole(allowed: readonly Role[], loginPath = '/'): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(loginPath)}`);
  if (!canAccessRole(user.role, allowed)) redirect('/forbidden');
  return user;
}

export async function requireApiRole(allowed: readonly Role[]): Promise<AuthUser | Response> {
  const user = await getCurrentUser();
  if (!user) return Response.json({ success: false, error: 'unauthorized' }, { status: 401 });
  if (!canAccessRole(user.role, allowed)) return Response.json({ success: false, error: 'forbidden' }, { status: 403 });
  return user;
}

export async function logoutCurrentSession(): Promise<void> {
  const cookieStore = await cookies();
  revokeSession(cookieStore.get(AUTH_COOKIE)?.value);
}
