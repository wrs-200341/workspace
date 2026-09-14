/**
 * Per-operator daily success quotas for metered video models.
 *
 * Some suppliers bill per finished clip, so a runaway queue is a direct cost.
 * These models are capped by *successful* generations per operator per day:
 * failed, cancelled and still-running tasks never consume quota, so an
 * operator is not punished for a supplier error.
 *
 * The day boundary is Asia/Shanghai to match how the team reports output, and
 * counting uses each task's own completion time rather than its creation time —
 * a clip that starts at 23:55 and finishes after midnight belongs to the day it
 * actually completed.
 */
import { listProviderTaskSummaries, type ProviderTaskSummary } from '@/lib/providers/taskStore';

/**
 * Model ids that are capped, keyed by the environment variable holding the
 * daily limit per operator. Defaults preserve the original 50/day behavior
 * when the variable is unset.
 */
const DAILY_SUCCESS_LIMIT_ENV: Readonly<Record<string, string>> = {
  'sd2-933-mini': 'DAILY_QUOTA_SD2_933_MINI',
  'minimax-h3-max': 'DAILY_QUOTA_MINIMAX_H3_MAX',
};
const DEFAULT_DAILY_SUCCESS_LIMIT = 50;

export type DailyQuotaUsage = {
  model: string;
  limit: number;
  used: number;
  remaining: number;
  date: string;
};

export function shanghaiDateKey(value: Date | number | string = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function dailyLimitForModel(model: string, env: Readonly<Record<string, string | undefined>> = process.env): number | undefined {
  const envVar = DAILY_SUCCESS_LIMIT_ENV[model.trim()];
  if (!envVar) return undefined;
  const configured = Number(env[envVar]);
  // A blank, zero, negative, or non-numeric override falls back to the
  // default rather than silently disabling or zeroing the quota.
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_DAILY_SUCCESS_LIMIT;
}

/** A task counts against quota only once it has actually produced a video. */
function isSuccessfulOn(task: ProviderTaskSummary, model: string, ownerId: string, dateKey: string): boolean {
  if (task.mode !== 'video' || task.status !== 'completed') return false;
  if ((task.metadata?.modelId ?? task.model ?? '') !== model && task.model !== model) return false;
  const taskOwner = typeof task.metadata?.ownerId === 'string' && task.metadata.ownerId ? task.metadata.ownerId : task.accountId;
  if (taskOwner !== ownerId) return false;
  // `inventorySavedAt` is set when outputs land locally; fall back to updatedAt
  // for records written before that field existed.
  const completedAt = task.inventorySavedAt || task.updatedAt || task.createdAt;
  return shanghaiDateKey(completedAt) === dateKey;
}

export function getDailyQuotaUsage(ownerId: string, model: string, now: Date | number = new Date(), env: Readonly<Record<string, string | undefined>> = process.env): DailyQuotaUsage | null {
  const limit = dailyLimitForModel(model, env);
  if (limit === undefined) return null;
  const dateKey = shanghaiDateKey(now);
  const used = listProviderTaskSummaries({ mode: 'video', status: 'completed' })
    .filter((task) => isSuccessfulOn(task, model, ownerId, dateKey))
    .length;
  return { model, limit, used, remaining: Math.max(0, limit - used), date: dateKey };
}

/**
 * How many further submissions of `model` this operator may still make.
 *
 * Returns `null` for uncapped models so callers can skip the check entirely.
 */
export function remainingDailyQuota(ownerId: string, model: string, now: Date | number = new Date()): number | null {
  return getDailyQuotaUsage(ownerId, model, now)?.remaining ?? null;
}
