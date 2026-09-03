import { describe, expect, it } from 'vitest';
import { getRangeDates, type RangeKey } from './dateRange';

describe('getRangeDates', () => {
  it.each<RangeKey>(['week', 'month', 'year'])('returns a stable %s range ending at today', (range) => {
    const end = new Date('2026-09-02T04:00:00.000Z');
    const result = getRangeDates(range, end);
    expect(result.end).toBe('2026-09-02');
    expect(result.start <= result.end).toBe(true);
  });

  it('uses Shanghai calendar boundaries rather than UTC boundaries', () => {
    const beforeShanghaiMidnight = new Date('2026-09-01T16:30:00.000Z');
    expect(getRangeDates('week', beforeShanghaiMidnight).end).toBe('2026-09-02');
  });
});
