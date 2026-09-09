import fs from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createProviderTask } from '@/lib/providers/taskStore';
import { dailyLimitForModel, getDailyQuotaUsage, remainingDailyQuota, shanghaiDateKey } from './dailyQuota';

const root = `D:\\all_projects\\workspace\\data\\daily-quota-test-${process.pid}`;
const previous = process.env.WORKSPACE_DATA_ROOT;

beforeEach(() => {
  process.env.WORKSPACE_DATA_ROOT = root;
  fs.rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.WORKSPACE_DATA_ROOT; else process.env.WORKSPACE_DATA_ROOT = previous;
});

function seedCompleted(id: string, model: string, ownerId: string, completedAt: string) {
  // `updateProviderTask` always stamps updatedAt with the real current time, so
  // the deterministic completion timestamp has to be set at creation instead.
  return createProviderTask({
    id,
    accountId: `${ownerId}-account`,
    mode: 'video',
    provider: 'miku-minimax',
    model,
    status: 'completed',
    createdAt: completedAt,
    inventorySavedAt: completedAt,
    metadata: { ownerId, modelId: model },
  });
}

describe('daily model quota', () => {
  it('defaults the metered models to fifty successes per operator per day', () => {
    expect(dailyLimitForModel('sd2-933-mini', {})).toBe(50);
    expect(dailyLimitForModel('minimax-h3-max', {})).toBe(50);
    expect(dailyLimitForModel('omni-fast-no-water', {})).toBeUndefined();
    // Uncapped models skip the check entirely.
    expect(remainingDailyQuota('operator-a', 'omni-fast-no-water')).toBeNull();
  });

  it('reads each cap from its environment variable', () => {
    expect(dailyLimitForModel('sd2-933-mini', { DAILY_QUOTA_SD2_933_MINI: '80' })).toBe(80);
    expect(dailyLimitForModel('minimax-h3-max', { DAILY_QUOTA_MINIMAX_H3_MAX: '120' })).toBe(120);
    // Each model is configured independently.
    expect(dailyLimitForModel('sd2-933-mini', { DAILY_QUOTA_MINIMAX_H3_MAX: '120' })).toBe(50);
    // Fractions are floored so the cap stays a whole number of clips.
    expect(dailyLimitForModel('minimax-h3-max', { DAILY_QUOTA_MINIMAX_H3_MAX: '10.9' })).toBe(10);
    // Unusable overrides fall back rather than zeroing or disabling the quota.
    for (const bad of ['', '0', '-5', 'abc']) {
      expect(dailyLimitForModel('minimax-h3-max', { DAILY_QUOTA_MINIMAX_H3_MAX: bad })).toBe(50);
    }
  });

  it('applies the configured cap to usage results', () => {
    const now = Date.parse('2026-09-08T06:00:00.000Z');
    seedCompleted('quota-env-1', 'minimax-h3-max', 'operator-a', '2026-09-08T06:00:00.000Z');
    expect(getDailyQuotaUsage('operator-a', 'minimax-h3-max', now, { DAILY_QUOTA_MINIMAX_H3_MAX: '3' }))
      .toMatchObject({ limit: 3, used: 1, remaining: 2 });
  });

  it('counts only this operator, this model and this Shanghai day', () => {
    const now = Date.parse('2026-09-08T06:00:00.000Z'); // 14:00 in Shanghai
    seedCompleted('quota-1', 'minimax-h3-max', 'operator-a', '2026-09-08T06:00:00.000Z');
    seedCompleted('quota-2', 'minimax-h3-max', 'operator-a', '2026-09-08T01:00:00.000Z');
    seedCompleted('quota-other-owner', 'minimax-h3-max', 'operator-b', '2026-09-08T06:00:00.000Z');
    seedCompleted('quota-other-model', 'sd2-933-mini', 'operator-a', '2026-09-08T06:00:00.000Z');
    seedCompleted('quota-yesterday', 'minimax-h3-max', 'operator-a', '2026-09-06T10:00:00.000Z');

    const usage = getDailyQuotaUsage('operator-a', 'minimax-h3-max', now, {});
    expect(usage).toMatchObject({ model: 'minimax-h3-max', limit: 50, used: 2, remaining: 48 });
    expect(getDailyQuotaUsage('operator-b', 'minimax-h3-max', now, {})).toMatchObject({ used: 1, remaining: 49 });
    expect(getDailyQuotaUsage('operator-a', 'sd2-933-mini', now, {})).toMatchObject({ used: 1, remaining: 49 });
  });

  it('ignores failed, cancelled and in-flight tasks so supplier errors cost no quota', () => {
    const now = Date.parse('2026-09-08T06:00:00.000Z');
    for (const status of ['failed', 'cancelled', 'running', 'queued'] as const) {
      createProviderTask({
        id: `quota-${status}`,
        accountId: 'operator-a-account',
        mode: 'video',
        provider: 'miku-minimax',
        model: 'minimax-h3-max',
        status,
        metadata: { ownerId: 'operator-a', modelId: 'minimax-h3-max' },
      });
    }
    expect(getDailyQuotaUsage('operator-a', 'minimax-h3-max', now, {})).toMatchObject({ used: 0, remaining: 50 });
  });

  it('reports the Shanghai day rather than UTC', () => {
    // 23:30 UTC is already the next calendar day in Shanghai (+08:00).
    expect(shanghaiDateKey('2026-09-07T23:30:00.000Z')).toBe('2026-09-08');
    expect(shanghaiDateKey('2026-09-07T15:00:00.000Z')).toBe('2026-09-07');
  });
});
