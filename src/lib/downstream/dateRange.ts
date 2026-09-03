export type RangeKey = 'week' | 'month' | 'year';

export type DateRange = { start: string; end: string };

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Returns calendar dates in Asia/Shanghai, independent of the host timezone. */
export function getRangeDates(range: RangeKey, now = new Date()): DateRange {
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const end = new Date(Date.UTC(
    shanghaiNow.getUTCFullYear(),
    shanghaiNow.getUTCMonth(),
    shanghaiNow.getUTCDate(),
  ));
  const start = new Date(end);

  if (range === 'week') start.setUTCDate(start.getUTCDate() - 6);
  if (range === 'month') start.setUTCDate(start.getUTCDate() - 29);
  if (range === 'year') start.setUTCDate(start.getUTCDate() - 364);

  return { start: formatDate(start), end: formatDate(end) };
}
