import { describe, expect, it } from 'vitest';
import { aggregateEarnings, canViewDownstream, formatCompact, normalizeEarningsRows, type EarningsRow } from './earningsTrend';

const rows: EarningsRow[] = [
  { date: '2026-09-01', orders: 4, gmv: 1200, views: 40000, clicks: 800, refunds: 40 },
  { date: '2026-09-01', orders: 3, gmv: 800, views: 20000, clicks: 500, refunds: 0 },
  { date: '2026-09-02', orders: 8, gmv: 2400, views: 90000, clicks: 1800, refunds: 120 },
];

describe('aggregateEarnings', () => {
  it('groups duplicate daily rows and calculates rates from totals', () => {
    expect(aggregateEarnings(rows)).toEqual([
      { date: '2026-09-01', orders: 7, gmv: 2000, views: 60000, clicks: 1300, refunds: 40 },
      { date: '2026-09-02', orders: 8, gmv: 2400, views: 90000, clicks: 1800, refunds: 120 },
    ]);
  });
});

describe('formatCompact', () => {
  it('formats large values for KPI cards', () => {
    expect(formatCompact(1254000)).toBe('125.4万');
    expect(formatCompact(932)).toBe('932');
  });
});

describe('permissions', () => {
  it('only exposes downstream navigation to operator roles', () => {
    expect(canViewDownstream('operator')).toBe(true);
    expect(canViewDownstream('admin')).toBe(true);
    expect(canViewDownstream('viewer')).toBe(false);
  });
});

describe('normalizeEarningsRows', () => {
  it('drops malformed rows and caps the upstream payload', () => {
    expect(normalizeEarningsRows([
      { date: '2026-09-02', orders: '8', gmv: 1 },
      { date: 'bad-date', orders: 2 },
      null,
    ])).toEqual([{ date: '2026-09-02', orders: 0, gmv: 1, views: 0, clicks: 0, refunds: 0 }]);
  });
});
