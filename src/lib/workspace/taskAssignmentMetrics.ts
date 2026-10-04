import { listStoredAccounts } from './accountStore';
import { aggregateShowroomPerformance, normalizeEarningsVideos } from './showroomPerformance';

export type TaskAssignmentMetrics = {
  tapSales: number | null;
  localOrders: number | null;
  productName: string | null;
  productPreviewUrl: string | null;
  productRating: number | null;
  commissionAmount: string | null;
  productStock: number | string | null;
};

export type TaskAssignmentMetricsRequest = {
  pid: string;
  source: 'tap' | 'cap';
};

type ProductMetrics = Omit<TaskAssignmentMetrics, 'localOrders'>;

type MetricsCacheEntry = {
  expiresAt: number;
  values: Map<string, TaskAssignmentMetrics>;
};

const CACHE_TTL_MS = 60_000;
const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024;
const cache = new Map<string, MetricsCacheEntry>();
const pending = new Map<string, Promise<Map<string, TaskAssignmentMetrics>>>();

function uniquePids(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => /^[A-Za-z0-9._-]{1,120}$/.test(value)))].sort();
}

export function taskAssignmentMetricsKey(pid: string, source: 'tap' | 'cap'): string {
  return `${source}:${pid}`;
}

function uniqueRequests(values: readonly TaskAssignmentMetricsRequest[]): TaskAssignmentMetricsRequest[] {
  const result = new Map<string, TaskAssignmentMetricsRequest>();
  for (const value of values) {
    const pid = value.pid.trim();
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(pid)) continue;
    const source = value.source === 'cap' ? 'cap' : 'tap';
    result.set(taskAssignmentMetricsKey(pid, source), { pid, source });
  }
  return [...result.values()].sort((left, right) => taskAssignmentMetricsKey(left.pid, left.source).localeCompare(taskAssignmentMetricsKey(right.pid, right.source)));
}

function allowedUrl(configured: string | undefined, fallback: string, allowedHostsVariable: string): URL {
  const fallbackUrl = new URL(fallback);
  if (!configured) return fallbackUrl;
  try {
    const url = new URL(configured);
    const hosts = process.env[allowedHostsVariable]?.split(',').map((item) => item.trim()).filter(Boolean)
      ?? ['127.0.0.1', 'localhost'];
    return ['http:', 'https:'].includes(url.protocol) && hosts.includes(url.hostname) ? url : fallbackUrl;
  } catch {
    return fallbackUrl;
  }
}

async function readJson(url: URL, init: RequestInit = {}): Promise<unknown> {
  const timeout = Math.max(500, Math.min(10_000, Number(process.env.TASK_ASSIGNMENT_METRICS_TIMEOUT_MS || 3_000)));
  const headers = new Headers(init.headers);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(timeout),
    headers,
  });
  if (!response.ok) throw new Error(`task_assignment_metrics_upstream_${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_UPSTREAM_BYTES) throw new Error('task_assignment_metrics_upstream_too_large');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_UPSTREAM_BYTES) throw new Error('task_assignment_metrics_upstream_too_large');
  return JSON.parse(text) as unknown;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function moneyFromAmount(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  return raw.replace(/^earn\s+/i, '');
}

function calculatedCommission(price: unknown, rate: unknown, currency: unknown): string | null {
  const numericPrice = finiteNumber(price);
  const numericRate = finiteNumber(rate);
  if (numericPrice === null || numericRate === null) return null;
  const prefix = currency === 'USD' || !currency ? '$' : `${String(currency)} `;
  return `${prefix}${(numericPrice * numericRate / 100).toFixed(2)}`;
}

function emptyProductMetrics(): ProductMetrics {
  return {
    tapSales: null,
    productName: null,
    productPreviewUrl: null,
    productRating: null,
    commissionAmount: null,
    productStock: null,
  };
}

export function normalizeTapSales(input: unknown, pids: readonly string[]): Map<string, number | null> {
  const result = new Map<string, number | null>(pids.map((pid) => [pid, null]));
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  const rows = input as Record<string, unknown>;
  for (const pid of pids) {
    const row = rows[pid];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    result.set(pid, finiteNonNegativeInteger((row as Record<string, unknown>).sales_volume));
  }
  return result;
}

export function normalizeTapProducts(statsInput: unknown, detailsInputs: readonly unknown[], pids: readonly string[]): Map<string, ProductMetrics> {
  const result = new Map(pids.map((pid) => [pid, emptyProductMetrics()]));
  for (const payload of detailsInputs) {
    const rows = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Array.isArray((payload as Record<string, unknown>).items)
        ? (payload as Record<string, unknown>).items as unknown[]
        : [payload]
      : [];
    for (const value of rows) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      const pid = text(row.product_id);
      if (!pid || !result.has(pid)) continue;
      const stock = finiteNonNegativeInteger(row.stock);
      result.set(pid, {
        tapSales: finiteNonNegativeInteger(row.sales_volume),
        productName: text(row.product_name),
        productPreviewUrl: text(row.product_image_url),
        productRating: finiteNumber(row.rating),
        commissionAmount: moneyFromAmount(row.commission_amount) ?? calculatedCommission(row.price, row.commission_rate, row.currency),
        productStock: stock,
      });
    }
  }
  if (statsInput && typeof statsInput === 'object' && !Array.isArray(statsInput)) {
    const stats = statsInput as Record<string, unknown>;
    for (const pid of pids) {
      const row = stats[pid];
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const current = result.get(pid) ?? emptyProductMetrics();
      const values = row as Record<string, unknown>;
      const stock = finiteNonNegativeInteger(values.stock);
      result.set(pid, {
        ...current,
        tapSales: finiteNonNegativeInteger(values.sales_volume) ?? current.tapSales,
        productName: text(values.product_name) ?? current.productName,
        productPreviewUrl: text(values.product_image_url) ?? current.productPreviewUrl,
        productRating: finiteNumber(values.rating) ?? current.productRating,
        commissionAmount: moneyFromAmount(values.commission_amount)
          ?? calculatedCommission(values.price, values.commission_rate, values.currency)
          ?? current.commissionAmount,
        productStock: stock ?? current.productStock,
      });
    }
  }
  return result;
}

export function normalizeCapProducts(inputs: readonly unknown[], pids: readonly string[]): Map<string, ProductMetrics> {
  const result = new Map(pids.map((pid) => [pid, emptyProductMetrics()]));
  for (const payload of inputs) {
    const rows = payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray((payload as Record<string, unknown>).items)
      ? (payload as Record<string, unknown>).items as unknown[]
      : [];
    for (const value of rows) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      const pid = text(row.product_id);
      if (!pid || !result.has(pid)) continue;
      const stockStatus = finiteNumber(row.stock_status);
      result.set(pid, {
        tapSales: finiteNonNegativeInteger(row.sales_volume),
        productName: text(row.product_name),
        productPreviewUrl: text(row.product_image_url),
        productRating: finiteNumber(row.rating),
        commissionAmount: moneyFromAmount(row.earn_amount) ?? calculatedCommission(row.price, row.commission_rate, row.currency),
        productStock: stockStatus === null ? null : stockStatus > 0 ? '有库存' : '缺货',
      });
    }
  }
  return result;
}

export function aggregateLocalOrdersByPid(
  videos: readonly { productId: string; orders: number }[],
  pids: readonly string[],
): Map<string, number> {
  const requested = new Set(pids);
  const result = new Map(pids.map((pid) => [pid, 0]));
  for (const video of videos) {
    if (!requested.has(video.productId)) continue;
    result.set(video.productId, (result.get(video.productId) ?? 0) + Math.max(0, Math.round(video.orders)));
  }
  return result;
}

async function fetchBatchedProductLists(
  pids: readonly string[],
  configured: string | undefined,
  fallback: string,
  allowedHostsVariable: string,
): Promise<unknown[]> {
  const batches: string[][] = [];
  for (let index = 0; index < pids.length; index += 100) batches.push(pids.slice(index, index + 100));
  return Promise.all(batches.map((batch) => {
    const url = allowedUrl(configured, fallback, allowedHostsVariable);
    url.searchParams.set('product_ids', batch.join(','));
    url.searchParams.set('page_size', '500');
    return readJson(url);
  }));
}

async function fetchTapProducts(pids: readonly string[]): Promise<Map<string, ProductMetrics>> {
  if (!pids.length) return new Map();
  const statsUrl = allowedUrl(
    process.env.TAP_PRODUCT_STATS_API_URL,
    'http://127.0.0.1:8003/api/product-pools/lookup-stats',
    'TAP_PRODUCT_STATS_ALLOWED_HOSTS',
  );
  const detailBatches: string[][] = [];
  for (let index = 0; index < pids.length; index += 8) detailBatches.push(pids.slice(index, index + 8));
  const detailsRequest = (async () => {
    const rows: unknown[] = [];
    for (const batch of detailBatches) {
      const batchRows = await Promise.all(batch.map(async (pid) => {
        const url = allowedUrl(
          process.env.TAP_PRODUCT_DETAIL_API_URL,
          'http://127.0.0.1:8003/api/product-pools',
          'TAP_PRODUCT_STATS_ALLOWED_HOSTS',
        );
        url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(pid)}`;
        try {
          return await readJson(url);
        } catch {
          return null;
        }
      }));
      rows.push(...batchRows.filter((row) => row !== null));
    }
    return rows;
  })();
  const [statsResult, detailsResult] = await Promise.allSettled([
    readJson(statsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product_ids: pids }),
    }),
    detailsRequest,
  ]);
  return normalizeTapProducts(
    statsResult.status === 'fulfilled' ? statsResult.value : null,
    detailsResult.status === 'fulfilled' ? detailsResult.value : [],
    pids,
  );
}

async function fetchCapProducts(pids: readonly string[]): Promise<Map<string, ProductMetrics>> {
  if (!pids.length) return new Map();
  const payloads = await fetchBatchedProductLists(
    pids,
    process.env.CAP_PRODUCT_POOL_API_URL,
    'http://127.0.0.1:8003/api/cap/products',
    'TAP_PRODUCT_STATS_ALLOWED_HOSTS',
  );
  return normalizeCapProducts(payloads, pids);
}

async function fetchLocalOrders(pids: readonly string[]): Promise<Map<string, number>> {
  const url = allowedUrl(
    process.env.EARNINGS_VIDEOS_API_URL,
    'http://127.0.0.1:9001/api/earnings/videos',
    'EARNINGS_API_ALLOWED_HOSTS',
  );
  const payload = await readJson(url);
  const showroomVideos = aggregateShowroomPerformance(
    listStoredAccounts({ category: 'featured' }),
    normalizeEarningsVideos(payload),
  ).videos;
  return aggregateLocalOrdersByPid(showroomVideos, pids);
}

async function fetchMetrics(requests: readonly TaskAssignmentMetricsRequest[]): Promise<Map<string, TaskAssignmentMetrics>> {
  const allPids = uniquePids(requests.map((request) => request.pid));
  const [tapResult, capResult, localResult] = await Promise.allSettled([
    fetchTapProducts(allPids),
    fetchCapProducts(allPids),
    fetchLocalOrders(allPids),
  ]);
  const tapValues = tapResult.status === 'fulfilled' ? tapResult.value : new Map<string, ProductMetrics>();
  const capValues = capResult.status === 'fulfilled' ? capResult.value : new Map<string, ProductMetrics>();
  return new Map(requests.map((request) => {
    const preferred = request.source === 'cap' ? capValues.get(request.pid) : tapValues.get(request.pid);
    const fallback = request.source === 'cap' ? tapValues.get(request.pid) : capValues.get(request.pid);
    const product = preferred?.productName || preferred?.productPreviewUrl ? preferred : fallback ?? preferred ?? emptyProductMetrics();
    return [taskAssignmentMetricsKey(request.pid, request.source), {
      ...product,
      localOrders: localResult.status === 'fulfilled' ? localResult.value.get(request.pid) ?? 0 : null,
    }];
  }));
}

export async function loadTaskAssignmentMetrics(values: readonly TaskAssignmentMetricsRequest[]): Promise<Map<string, TaskAssignmentMetrics>> {
  const requests = uniqueRequests(values);
  if (!requests.length) return new Map();
  const key = requests.map((request) => taskAssignmentMetricsKey(request.pid, request.source)).join('\n');
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.values;
  const active = pending.get(key);
  if (active) return active;

  const request = fetchMetrics(requests).then((metrics) => {
    if (cache.size >= 32) cache.clear();
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, values: metrics });
    return metrics;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
