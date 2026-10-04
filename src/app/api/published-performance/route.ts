import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { aggregatePublishedPerformance, normalizePublishedVideos, type PublishedPerformance } from '@/lib/workspace/publishedPerformance';
import { mergeEarningsProductImages, normalizeEarningsVideos } from '@/lib/workspace/showroomPerformance';

export const dynamic = 'force-dynamic';

type RangeKey = 'all' | 'today' | '7d' | '30d';
type CacheEntry = { expiresAt: number; data: PublishedPerformance; syncedAt: string };
type UpstreamKind = 'publisher' | 'videos' | 'products';

const cache = new Map<RangeKey, CacheEntry>();
const CACHE_TTL_MS = 60_000;
const MAX_UPSTREAM_BYTES = 12 * 1024 * 1024;

function rangeKey(value: string | null): RangeKey {
  return value === 'today' || value === '7d' || value === '30d' ? value : 'all';
}

function businessDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function upstreamRange(range: RangeKey): { from?: string; to?: string } {
  if (range === 'all') return {};
  const today = businessDate();
  return {
    from: range === 'today' ? today : addDays(today, range === '7d' ? -6 : -29),
    to: today,
  };
}

function upstreamUrl(kind: UpstreamKind): URL {
  const defaults = {
    publisher: 'http://127.0.0.1:8766/api/integrations/workspace/published-videos',
    videos: 'http://127.0.0.1:9001/api/earnings/videos',
    products: 'http://127.0.0.1:9001/api/earnings/products',
  } as const;
  const configured = kind === 'publisher'
    ? process.env.PUBLISHER_VIDEOS_API_URL
    : kind === 'videos' ? process.env.EARNINGS_VIDEOS_API_URL : process.env.EARNINGS_PRODUCTS_API_URL;
  const fallback = new URL(defaults[kind]);
  if (!configured) return fallback;
  try {
    const url = new URL(configured);
    const allowed = (kind === 'publisher' ? process.env.PUBLISHER_API_ALLOWED_HOSTS : process.env.EARNINGS_API_ALLOWED_HOSTS)
      ?.split(',').map((item) => item.trim()).filter(Boolean) ?? ['127.0.0.1', 'localhost'];
    return ['http:', 'https:'].includes(url.protocol) && allowed.includes(url.hostname) ? url : fallback;
  } catch {
    return fallback;
  }
}

async function readUpstream(kind: UpstreamKind, range: RangeKey): Promise<unknown> {
  const url = upstreamUrl(kind);
  const dates = upstreamRange(range);
  if (dates.from) url.searchParams.set('from', dates.from);
  if (dates.to) url.searchParams.set('to', kind === 'publisher' ? dates.to : addDays(dates.to, 1));
  const timeout = Math.max(500, Math.min(30_000, Number(process.env.PUBLISHED_PERFORMANCE_TIMEOUT_MS || 7_000)));
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`${kind}_upstream_${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_UPSTREAM_BYTES) throw new Error(`${kind}_upstream_too_large`);
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_UPSTREAM_BYTES) throw new Error(`${kind}_upstream_too_large`);
  return JSON.parse(text) as unknown;
}

export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'operator']);
  if (auth instanceof Response) return auth;
  const range = rangeKey(request.nextUrl.searchParams.get('range'));
  const force = request.nextUrl.searchParams.get('refresh') === '1';
  const cached = cache.get(range);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ success: true, source: 'cache', range, syncedAt: cached.syncedAt, data: cached.data });
  }

  try {
    const [publisherPayload, earningsPayload, productPayload] = await Promise.all([
      readUpstream('publisher', range),
      readUpstream('videos', range),
      readUpstream('products', range),
    ]);
    const earnings = mergeEarningsProductImages(normalizeEarningsVideos(earningsPayload), productPayload);
    const data = aggregatePublishedPerformance(normalizePublishedVideos(publisherPayload), earnings, productPayload);
    const syncedAt = new Date().toISOString();
    cache.set(range, { expiresAt: Date.now() + CACHE_TTL_MS, data, syncedAt });
    return NextResponse.json({ success: true, source: '8766+9001', range, syncedAt, data });
  } catch {
    if (cached) {
      return NextResponse.json({ success: true, source: 'stale-cache', stale: true, range, syncedAt: cached.syncedAt, data: cached.data });
    }
    return NextResponse.json({ success: false, error: 'published_performance_source_unavailable' }, { status: 502 });
  }
}
