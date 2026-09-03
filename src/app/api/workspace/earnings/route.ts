import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { getRangeDates, type RangeKey } from '@/lib/downstream/dateRange';

function isRange(value: string | null): value is RangeKey { return value === 'week' || value === 'month' || value === 'year'; }

export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'workspace', 'operator']);
  if (auth instanceof Response) return auth;
  const range: RangeKey = isRange(request.nextUrl.searchParams.get('range')) ? request.nextUrl.searchParams.get('range') as RangeKey : 'week';
  const { start, end } = getRangeDates(range);
  // No authorised earnings store is configured in this workspace yet. Return
  // an explicit empty result rather than labelling an in-memory fixture as
  // "mock" data or showing synthetic numbers.
  return NextResponse.json({ success: true, source: 'unavailable', range: { start, end }, data: [] });
}
