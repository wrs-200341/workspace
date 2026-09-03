export type EarningsRow = {
  date: string;
  orders: number;
  gmv: number;
  views: number;
  clicks: number;
  refunds: number;
};

export type AggregatedEarnings = EarningsRow;

export function aggregateEarnings(rows: readonly EarningsRow[]): AggregatedEarnings[] {
  const byDate = new Map<string, EarningsRow>();
  for (const row of rows) {
    const current = byDate.get(row.date) ?? {
      date: row.date,
      orders: 0,
      gmv: 0,
      views: 0,
      clicks: 0,
      refunds: 0,
    };
    byDate.set(row.date, {
      date: row.date,
      orders: current.orders + safeNumber(row.orders),
      gmv: current.gmv + safeNumber(row.gmv),
      views: current.views + safeNumber(row.views),
      clicks: current.clicks + safeNumber(row.clicks),
      refunds: current.refunds + safeNumber(row.refunds),
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function normalizeEarningsRows(input: unknown): EarningsRow[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 5000).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const date = typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : null;
    if (!date) return [];
    return [{ date, orders: safeNumber(row.orders), gmv: safeNumber(row.gmv), views: safeNumber(row.views), clicks: safeNumber(row.clicks), refunds: safeNumber(row.refunds) }];
  });
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function formatCompact(value: number): string {
  const amount = safeNumber(value);
  if (Math.abs(amount) >= 10000) return `${(amount / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  if (Math.abs(amount) >= 1000) return `${(amount / 1000).toFixed(1).replace(/\.0$/, '')}千`;
  return Math.round(amount).toLocaleString('zh-CN');
}

export function canViewDownstream(role: string | null | undefined): boolean {
  return role === 'operator' || role === 'admin';
}

// Upstream earnings are optional; do not fabricate a cached trend when the
// source is unavailable.  The chart renders its empty/zero state instead.
export const mockEarnings: EarningsRow[] = [];
