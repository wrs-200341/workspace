import { NextRequest, NextResponse } from 'next/server';
import { aggregateEarnings, normalizeEarningsRows } from '@/lib/earningsTrend';
import { getRangeDates, type RangeKey } from '@/lib/downstream/dateRange';
import { requireApiRole } from '@/lib/auth/server';

function isRange(value: string | null): value is RangeKey { return value === 'week' || value === 'month' || value === 'year'; }

export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'operator']);
  if (auth instanceof Response) return auth;
  const requested = request.nextUrl.searchParams.get('range');
  const range: RangeKey = isRange(requested) ? requested : 'week';
  const { start, end } = getRangeDates(range);
  const configured = process.env.EARNINGS_API_URL;
  const defaultUpstream = 'http://127.0.0.1:9001/api/earnings/daily-trend';
  const upstream = configured && isAllowedUpstream(configured) ? configured : defaultUpstream;
  const headers: HeadersInit = { accept: 'application/json' };
  if (process.env.EARNINGS_TREND_TOKEN) headers.authorization = `Bearer ${process.env.EARNINGS_TREND_TOKEN}`;

  try {
    const response = await fetch(`${upstream}?from=${start}&to=${end}`, { headers, signal: AbortSignal.timeout(3500), cache: 'no-store' });
    if (!response.ok) throw new Error(`upstream_${response.status}`);
    const payload: unknown = await response.json();
    const raw = payload && typeof payload === 'object' && 'data' in payload ? (payload as { data?: unknown }).data : payload;
    const normalized = normalizeEarningsRows(raw);
    if (!normalized.length) throw new Error('upstream_empty_or_invalid_payload');
    return NextResponse.json({ success: true, source: '9001', range: { start, end }, data: aggregateEarnings(normalized) });
  } catch {
    return NextResponse.json({ success: true, source: 'unavailable', stale: true, warning: '9001 暂不可用，暂无同步数据', range: { start, end }, data: aggregateEarnings([]) });
  }
}

function isAllowedUpstream(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const allowed = process.env.EARNINGS_API_ALLOWED_HOSTS?.split(',').map((item) => item.trim()).filter(Boolean) ?? ['127.0.0.1', 'localhost'];
    return allowed.includes(url.hostname);
  } catch { return false; }
}
