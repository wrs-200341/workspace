import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { getProviderCatalog, isProviderLiveEnabled } from '@/lib/providers/config';

export async function GET() {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  return NextResponse.json({ success: true, data: { providers: getProviderCatalog().map(({ liveEnv: _liveEnv, ...provider }) => ({ ...provider, configured: isProviderLiveEnabled(provider.id) })) } });
}
