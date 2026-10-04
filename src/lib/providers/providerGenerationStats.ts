import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getProviderCatalog, type ProviderId } from './config';
import { taskTransaction, withTaskDatabase } from './taskDatabase';

export type ProviderGenerationEventType = 'call' | 'success' | 'restore' | 'inventory';
export type GenerationMode = 'image' | 'video';

export type ProviderGenerationEvent = {
  eventKey: string;
  taskId: string;
  accountId: string;
  mode: GenerationMode;
  provider: ProviderId;
  eventType: ProviderGenerationEventType;
  eventAt: string;
};

export type ProviderGenerationStat = {
  provider: ProviderId;
  providerName: string;
  mode: GenerationMode;
  calls: number;
  successes: number;
  restores: number;
  successfulRestores: number;
  failedRestores: number;
  inventories: number;
  successRate: number;
};

export type ProviderGenerationStats = {
  rows: ProviderGenerationStat[];
  totals: Omit<ProviderGenerationStat, 'provider' | 'providerName' | 'mode'>;
};

export type ProviderGenerationDailyStat = ProviderGenerationStat & {
  businessDate: string;
};

export type ProviderGenerationDailyStats = {
  rows: ProviderGenerationDailyStat[];
  totals: ProviderGenerationStats['totals'];
};

type DateFilters = { from?: string; to?: string };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizedDate(value: string | undefined): string | undefined {
  const date = value?.trim();
  return date && DATE_PATTERN.test(date) ? date : undefined;
}

function nextDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function dateWhere(filters: DateFilters): { where: string; parameters: string[] } {
  const from = normalizedDate(filters.from);
  const to = normalizedDate(filters.to);
  const clauses: string[] = [];
  const parameters: string[] = [];
  if (from) {
    clauses.push('event_at >= ?');
    parameters.push(new Date(`${from}T00:00:00+08:00`).toISOString());
  }
  if (to) {
    clauses.push('event_at < ?');
    parameters.push(new Date(`${nextDate(to)}T00:00:00+08:00`).toISOString());
  }
  return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', parameters };
}

function totalsFor(rows: readonly Pick<ProviderGenerationStat, 'calls' | 'successes' | 'restores' | 'successfulRestores' | 'failedRestores' | 'inventories'>[]): ProviderGenerationStats['totals'] {
  const totals = rows.reduce((total, row) => ({
    calls: total.calls + row.calls,
    successes: total.successes + row.successes,
    restores: total.restores + row.restores,
    successfulRestores: total.successfulRestores + row.successfulRestores,
    failedRestores: total.failedRestores + row.failedRestores,
    inventories: total.inventories + row.inventories,
    successRate: 0,
  }), { calls: 0, successes: 0, restores: 0, successfulRestores: 0, failedRestores: 0, inventories: 0, successRate: 0 });
  totals.successRate = totals.calls > 0 ? totals.successes / totals.calls : 0;
  return totals;
}

export function insertProviderGenerationEvent(database: DatabaseSync, event: ProviderGenerationEvent): boolean {
  return database.prepare(`INSERT OR IGNORE INTO provider_generation_events
    (event_key,task_id,account_id,mode,provider,event_type,event_at) VALUES (?,?,?,?,?,?,?)`)
    .run(event.eventKey, event.taskId, event.accountId, event.mode, event.provider, event.eventType, event.eventAt).changes > 0;
}

export function recordProviderGenerationRestore(input: {
  taskId: string;
  accountId: string;
  mode: GenerationMode;
  provider: ProviderId;
  outcome: 'success' | 'failed';
  reason: 'safe-retry';
  eventAt?: string;
}): boolean {
  const eventAt = input.eventAt ?? new Date().toISOString();
  return withTaskDatabase((database) => taskTransaction(database, () => insertProviderGenerationEvent(database, {
    eventKey: `restore-${input.outcome}:${input.taskId}:${input.reason}:${crypto.randomUUID()}`,
    taskId: input.taskId,
    accountId: input.accountId,
    mode: input.mode,
    provider: input.provider,
    eventType: 'restore',
    eventAt,
  })));
}

export function listProviderGenerationStats(filters: DateFilters = {}): ProviderGenerationStats {
  const { where, parameters } = dateWhere(filters);
  const catalog = new Map(getProviderCatalog().map((provider) => [provider.id, provider]));
  const rows = withTaskDatabase((database) => database.prepare(`SELECT provider,mode,
      SUM(event_type='call') calls,
      SUM(event_type='success') successes,
      SUM(event_type='restore') restores,
      SUM(event_type='restore' AND event_key LIKE 'restore-success:%') successful_restores,
      SUM(event_type='restore' AND event_key LIKE 'restore-failed:%') failed_restores,
      SUM(event_type='inventory') inventories
    FROM provider_generation_events${where}
    GROUP BY provider,mode
    ORDER BY calls DESC,successes DESC,provider ASC`).all(...parameters)).map((raw) => {
      const row = raw as Record<string, string | number | bigint>;
      const provider = String(row.provider) as ProviderId;
      const calls = Number(row.calls);
      const successes = Number(row.successes);
      return {
        provider,
        providerName: catalog.get(provider)?.name ?? provider,
        mode: String(row.mode) as GenerationMode,
        calls,
        successes,
        restores: Number(row.restores),
        successfulRestores: Number(row.successful_restores),
        failedRestores: Number(row.failed_restores),
        inventories: Number(row.inventories),
        successRate: calls > 0 ? successes / calls : 0,
      };
    });
  return { rows, totals: totalsFor(rows) };
}

export function listProviderGenerationDailyStats(filters: DateFilters = {}): ProviderGenerationDailyStats {
  const { where, parameters } = dateWhere(filters);
  const catalog = new Map(getProviderCatalog().map((provider) => [provider.id, provider]));
  const rows = withTaskDatabase((database) => database.prepare(`SELECT
      strftime('%Y-%m-%d',event_at,'+8 hours') business_date,provider,mode,
      SUM(event_type='call') calls,
      SUM(event_type='success') successes,
      SUM(event_type='restore') restores,
      SUM(event_type='restore' AND event_key LIKE 'restore-success:%') successful_restores,
      SUM(event_type='restore' AND event_key LIKE 'restore-failed:%') failed_restores,
      SUM(event_type='inventory') inventories
    FROM provider_generation_events${where}
    GROUP BY business_date,provider,mode
    ORDER BY business_date DESC,calls DESC,successes DESC,provider ASC`).all(...parameters)).map((raw) => {
      const row = raw as Record<string, string | number | bigint>;
      const provider = String(row.provider) as ProviderId;
      const calls = Number(row.calls);
      const successes = Number(row.successes);
      return {
        businessDate: String(row.business_date),
        provider,
        providerName: catalog.get(provider)?.name ?? provider,
        mode: String(row.mode) as GenerationMode,
        calls,
        successes,
        restores: Number(row.restores),
        successfulRestores: Number(row.successful_restores),
        failedRestores: Number(row.failed_restores),
        inventories: Number(row.inventories),
        successRate: calls > 0 ? successes / calls : 0,
      };
    });
  return { rows, totals: totalsFor(rows) };
}
