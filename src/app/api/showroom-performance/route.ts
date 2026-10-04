import { NextRequest, NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/server';
import { listStoredAccounts } from '@/lib/workspace/accountStore';
import {
  aggregateShowroomPerformance,
  mergeEarningsProductImages,
  normalizeEarningsVideos,
  type ShowroomPerformance,
} from '@/lib/workspace/showroomPerformance';

export const dynamic = 'force-dynamic';

type RangeKey = 'all' | 'today' | '7d' | '30d';
type CacheEntry = { expiresAt: number; data: ShowroomPerformance; syncedAt: string };

const cache = new Map<RangeKey, CacheEntry>();
const CACHE_TTL_MS = 60_000;
const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024;

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
    to: addDays(today, 1),
  };
}

function allowedUpstream(kind: 'videos' | 'products'): URL {
  const videosFallback = new URL('http://127.0.0.1:9001/api/earnings/videos');
  const videosConfigured = process.env.EARNINGS_VIDEOS_API_URL;
  const fallback = new URL(kind === 'videos'
    ? videosFallback
    : 'http://127.0.0.1:9001/api/earnings/products');
  let configured = kind === 'videos' ? videosConfigured : process.env.EARNINGS_PRODUCTS_API_URL;
  if (kind === 'products' && !configured && videosConfigured) {
    try {
      const derived = new URL(videosConfigured);
      derived.pathname = derived.pathname.endsWith('/videos')
        ? `${derived.pathname.slice(0, -'/videos'.length)}/products`
        : '/api/earnings/products';
      configured = derived.toString();
    } catch {
      configured = undefined;
    }
  }
  if (!configured) return fallback;
  try {
    const url = new URL(configured);
    const hosts = process.env.EARNINGS_API_ALLOWED_HOSTS?.split(',').map((item) => item.trim()).filter(Boolean) ?? ['127.0.0.1', 'localhost'];
    return ['http:', 'https:'].includes(url.protocol) && hosts.includes(url.hostname) ? url : fallback;
  } catch {
    return fallback;
  }
}

async function readUpstream(kind: 'videos' | 'products', range: RangeKey): Promise<unknown> {
  const url = allowedUpstream(kind);
  const dates = upstreamRange(range);
  if (dates.from) url.searchParams.set('from', dates.from);
  if (dates.to) url.searchParams.set('to', dates.to);
  const timeout = Math.max(500, Math.min(30_000, Number(process.env.EARNINGS_API_TIMEOUT_MS || 5_000)));
  const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`earnings_upstream_${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_UPSTREAM_BYTES) throw new Error('earnings_upstream_too_large');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_UPSTREAM_BYTES) throw new Error('earnings_upstream_too_large');
  return JSON.parse(text) as unknown;
}

export async function GET(request: NextRequest) {
  const auth = await requireApiRole(['admin', 'operator']);
  if (auth instanceof Response) return auth;
  const range = rangeKey(request.nextUrl.searchParams.get('range'));
  const force = request.nextUrl.searchParams.get('refresh') === '1';
  const cached = cache.get(range);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ success: true, source: '9001-cache', range, syncedAt: cached.syncedAt, data: cached.data });
  }

  try {
    const [videoRows, productRows] = await Promise.all([
      readUpstream('videos', range),
      readUpstream('products', range),
    ]);
    const videos = mergeEarningsProductImages(normalizeEarningsVideos(videoRows), productRows);
    const data = aggregateShowroomPerformance(listStoredAccounts({ category: 'featured' }), videos);
    const syncedAt = new Date().toISOString();
    cache.set(range, { expiresAt: Date.now() + CACHE_TTL_MS, data, syncedAt });
    return NextResponse.json({ success: true, source: '9001', range, syncedAt, data });
  } catch {
    if (cached) return NextResponse.json({ success: true, source: '9001-stale-cache', stale: true, range, syncedAt: cached.syncedAt, data: cached.data });
    return NextResponse.json({ success: false, error: 'earnings_source_unavailable' }, { status: 502 });
  }
}
