import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { repairSavedImageTaskInventory } from '@/lib/workspace/imageInventory';
import { repairSavedVideoTaskInventory } from '@/lib/workspace/videoInventory';

export const runtime = 'nodejs';

/** Run the bounded, account-safe repair pass from the live server process. */
export async function POST(request: NextRequest) {
  const auth = await requireApiRole(['admin']);
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({})) as { accountIds?: unknown; includeRemote?: unknown };
  const accountIds = Array.isArray(body.accountIds)
    ? body.accountIds.filter((value): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.trim())).map((value) => value.trim())
    : undefined;
  const localOnly = body.includeRemote !== true;
  const dependencies = { localOnly };
  const repairedImages = await repairSavedImageTaskInventory(accountIds, dependencies);
  const repairedVideos = await repairSavedVideoTaskInventory(accountIds, dependencies);
  return NextResponse.json({ success: true, data: { repairedImages, repairedVideos, localOnly } });
}
