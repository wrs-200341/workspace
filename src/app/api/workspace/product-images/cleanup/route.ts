import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { cleanupExpiredProductImages } from '@/lib/workspace/productImages';

/** Admin-only maintenance endpoint. The scheduler invokes the same function at Shanghai midnight. */
export async function POST(request: NextRequest) {
  const auth = await requireApiRole(['admin']);
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({})) as { dryRun?: unknown };
  const dryRun = body.dryRun === true;
  return NextResponse.json({ success: true, data: cleanupExpiredProductImages(new Date(), { dryRun }) });
}
