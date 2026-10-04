import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWorkspacePath } from '../storagePaths';
import {
  checkProductGalleryPids,
  createProductImageCrawlBatch,
  getProductImageCrawlBatchStatus,
  productSourceErrorDetail,
  runProductImageCrawlBatch,
  type ProductImageCrawlType,
} from './productImages';

export type TaskAssignmentImageCrawlStatus = 'pending' | 'running' | 'completed' | 'failed';

export type TaskAssignmentImageCrawl = {
  pid: string;
  batchType: ProductImageCrawlType;
  status: TaskAssignmentImageCrawlStatus;
  batchId?: string;
  error?: string;
  attemptedAt?: string;
  checkedAt?: string;
  updatedAt: string;
};

export type TaskAssignmentImageCrawlQueueResult = {
  requested: number;
  queued: number;
  completed: number;
  active: number;
};

type CrawlGateway = {
  check(pids: readonly string[]): Promise<{ existing: string[]; missing: string[] }>;
  createBatch(pids: readonly string[], batchType: ProductImageCrawlType, name: string): Promise<{ batchId?: string; existing: string[]; submitted: string[] }>;
  runBatch(batchId: string): Promise<void>;
  getBatchStatus?(batchId: string): Promise<{ status: string; syncStage?: string }>;
};

type StoreCache = { file: string; mtimeMs: number; size: number; records: TaskAssignmentImageCrawl[] };

const SOURCE_TIMEOUT_MS = 5_000;
const PID_CHUNK_SIZE = 100;
const RUNNING_REFRESH_MS = 5_000;
const storeFile = () => getWorkspacePath('workspace', 'task-assignment-image-crawls.json');
let cache: StoreCache | null = null;
let processingPromise: Promise<void> | null = null;
let processingRequested = false;
let refreshPromise: Promise<void> | null = null;

const defaultGateway: CrawlGateway = {
  check: (pids) => checkProductGalleryPids(pids, fetch, SOURCE_TIMEOUT_MS),
  createBatch: (pids, batchType, name) => createProductImageCrawlBatch(pids, batchType, name, fetch, SOURCE_TIMEOUT_MS),
  runBatch: (batchId) => runProductImageCrawlBatch(batchId, fetch, SOURCE_TIMEOUT_MS),
  getBatchStatus: (batchId) => getProductImageCrawlBatchStatus(batchId, fetch, SOURCE_TIMEOUT_MS),
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizePid(value: unknown): string | null {
  const pid = typeof value === 'string' ? value.trim() : '';
  return /^\d{16,20}$/.test(pid) ? pid : null;
}

function normalizeBatchType(value: unknown): ProductImageCrawlType {
  return value === 'non_clothing' ? 'non_clothing' : 'clothing';
}

function normalizeRecord(value: unknown): TaskAssignmentImageCrawl | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const pid = normalizePid(row.pid);
  const statuses: TaskAssignmentImageCrawlStatus[] = ['pending', 'running', 'completed', 'failed'];
  if (!pid || !statuses.includes(row.status as TaskAssignmentImageCrawlStatus) || typeof row.updatedAt !== 'string') return null;
  return {
    pid,
    batchType: normalizeBatchType(row.batchType),
    status: row.status as TaskAssignmentImageCrawlStatus,
    ...(typeof row.batchId === 'string' && row.batchId.trim() ? { batchId: row.batchId.trim() } : {}),
    ...(typeof row.error === 'string' && row.error.trim() ? { error: row.error.trim() } : {}),
    ...(typeof row.attemptedAt === 'string' ? { attemptedAt: row.attemptedAt } : {}),
    ...(typeof row.checkedAt === 'string' ? { checkedAt: row.checkedAt } : {}),
    updatedAt: row.updatedAt,
  };
}

function read(): TaskAssignmentImageCrawl[] {
  const file = storeFile();
  try {
    const stat = fs.statSync(file);
    if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.records;
    const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const records = Array.isArray(payload)
      ? payload.map(normalizeRecord).filter((item): item is TaskAssignmentImageCrawl => item !== null)
      : [];
    cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, records };
    return records;
  } catch {
    cache = null;
    return [];
  }
}

function write(records: readonly TaskAssignmentImageCrawl[]): void {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(records, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  const stat = fs.statSync(file);
  cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, records: [...records] };
}

function updateRecords(pids: readonly string[], update: (record: TaskAssignmentImageCrawl) => TaskAssignmentImageCrawl): void {
  const selected = new Set(pids);
  if (!selected.size) return;
  const records = read();
  let changed = false;
  const next = records.map((record) => {
    if (!selected.has(record.pid)) return record;
    changed = true;
    return update(record);
  });
  if (changed) write(next);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function crawlError(error: unknown): string {
  const detail = productSourceErrorDetail(error);
  if (detail) return detail;
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'product_source_timeout') return '8765 图库服务连接超时';
  if (code === 'fetch failed' || code.includes('ECONNREFUSED')) return '8765 图库服务未启动';
  if (code.startsWith('product_source_http_')) return `8765 图库服务请求失败（${code.slice('product_source_http_'.length)}）`;
  return '8765 图库爬图提交失败';
}

function batchName(batchType: ProductImageCrawlType): string {
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  return `workspace-${day}-${batchType}-${crypto.randomUUID().slice(0, 8)}`;
}

export function listTaskAssignmentImageCrawls(pidsInput?: readonly string[]): TaskAssignmentImageCrawl[] {
  const selected = pidsInput ? new Set(pidsInput.map(normalizePid).filter((pid): pid is string => Boolean(pid))) : null;
  return read().filter((record) => !selected || selected.has(record.pid)).map(clone);
}

/** Persist the intent before returning to the browser. Actual 8765 work runs
 * in the background so a slow/offline gallery never delays task assignment. */
export function queueTaskAssignmentImageCrawls(
  pidsInput: readonly unknown[],
  batchTypeInput: unknown,
  options: { start?: boolean } = {},
): TaskAssignmentImageCrawlQueueResult {
  const batchType = normalizeBatchType(batchTypeInput);
  const pids = [...new Set(pidsInput.map(normalizePid).filter((pid): pid is string => Boolean(pid)))];
  const current = read();
  const byPid = new Map(current.map((record) => [record.pid, record]));
  const now = new Date().toISOString();
  let queued = 0;
  let completed = 0;
  let active = 0;

  for (const pid of pids) {
    const previous = byPid.get(pid);
    if (previous?.status === 'completed') {
      completed += 1;
      continue;
    }
    if (previous?.status === 'pending' || previous?.status === 'running') {
      active += 1;
      continue;
    }
    byPid.set(pid, {
      pid,
      batchType,
      status: 'pending',
      updatedAt: now,
    });
    queued += 1;
  }

  if (queued) write([...byPid.values()]);
  if ((queued || active) && options.start !== false) scheduleTaskAssignmentImageCrawls();
  return { requested: pids.length, queued, completed, active };
}

export async function processTaskAssignmentImageCrawlsNow(gateway: CrawlGateway = defaultGateway): Promise<void> {
  const pending = read().filter((record) => record.status === 'pending');
  const byType = new Map<ProductImageCrawlType, string[]>([['clothing', []], ['non_clothing', []]]);
  for (const record of pending) byType.get(record.batchType)?.push(record.pid);

  for (const [batchType, pids] of byType) {
    for (const group of chunks(pids, PID_CHUNK_SIZE)) {
      if (!group.length) continue;
      const attemptedAt = new Date().toISOString();
      updateRecords(group, (record) => ({ ...record, attemptedAt, error: undefined, updatedAt: attemptedAt }));
      try {
        const check = await gateway.check(group);
        const existing = new Set(check.existing);
        if (existing.size) {
          updateRecords([...existing], (record) => ({ ...record, status: 'completed', checkedAt: attemptedAt, error: undefined, updatedAt: attemptedAt }));
        }
        const missing = check.missing.filter((pid) => !existing.has(pid));
        if (!missing.length) continue;
        const created = await gateway.createBatch(missing, batchType, batchName(batchType));
        if (created.existing.length) {
          updateRecords(created.existing, (record) => ({ ...record, status: 'completed', checkedAt: attemptedAt, error: undefined, updatedAt: attemptedAt }));
        }
        if (!created.submitted.length) continue;
        if (!created.batchId) throw new Error('product_crawl_batch_missing');
        updateRecords(created.submitted, (record) => ({
          ...record,
          status: 'running',
          batchId: created.batchId,
          error: undefined,
          updatedAt: new Date().toISOString(),
        }));
        try {
          await gateway.runBatch(created.batchId);
        } catch (error) {
          const message = crawlError(error);
          updateRecords(created.submitted, (record) => ({ ...record, status: 'failed', error: message, updatedAt: new Date().toISOString() }));
        }
      } catch (error) {
        const message = crawlError(error);
        updateRecords(group, (record) => record.status === 'completed'
          ? record
          : { ...record, status: 'failed', error: message, updatedAt: new Date().toISOString() });
      }
    }
  }
}

export async function refreshTaskAssignmentImageCrawlsNow(gateway: Pick<CrawlGateway, 'check' | 'getBatchStatus'> = defaultGateway): Promise<void> {
  const now = Date.now();
  const running = read().filter((record) => {
    if (record.status !== 'running') return false;
    const checkedAt = record.checkedAt ? Date.parse(record.checkedAt) : 0;
    return !Number.isFinite(checkedAt) || now - checkedAt >= RUNNING_REFRESH_MS;
  });
  for (const group of chunks(running.map((record) => record.pid), PID_CHUNK_SIZE)) {
    if (!group.length) continue;
    try {
      const result = await gateway.check(group);
      const stamp = new Date().toISOString();
      const existing = new Set(result.existing);
      updateRecords(group, (record) => ({
        ...record,
        status: existing.has(record.pid) ? 'completed' : record.status,
        checkedAt: stamp,
        ...(existing.has(record.pid) ? { error: undefined } : {}),
        updatedAt: existing.has(record.pid) ? stamp : record.updatedAt,
      }));
      if (gateway.getBatchStatus) {
        const missingRecords = read().filter((record) => group.includes(record.pid) && record.status === 'running' && !existing.has(record.pid) && record.batchId);
        const batchIds = [...new Set(missingRecords.map((record) => record.batchId).filter((batchId): batchId is string => Boolean(batchId)))];
        for (const batchId of batchIds) {
          try {
            const batch = await gateway.getBatchStatus(batchId);
            const terminalFailure = batch.status === 'failed' || batch.status === 'cancelled' || batch.syncStage === 'sync_failed';
            if (!terminalFailure) continue;
            const affected = missingRecords.filter((record) => record.batchId === batchId).map((record) => record.pid);
            const error = batch.syncStage === 'sync_failed' ? '8765 图片同步失败' : batch.status === 'cancelled' ? '8765 爬图批次已取消' : '8765 爬图批次执行失败';
            updateRecords(affected, (record) => ({ ...record, status: 'failed', error, checkedAt: stamp, updatedAt: stamp }));
          } catch {
            // Keep the accepted batch running when its detail endpoint is
            // temporarily unavailable. Gallery checks continue independently.
          }
        }
      }
    } catch {
      // A transient status refresh must not turn an accepted scrape into a
      // failure. The next task-list poll will try the single batch check again.
    }
  }
}

export function scheduleTaskAssignmentImageCrawls(): void {
  processingRequested = true;
  if (processingPromise) return;
  processingPromise = (async () => {
    do {
      processingRequested = false;
      await processTaskAssignmentImageCrawlsNow();
      await refreshTaskAssignmentImageCrawlsNow();
    } while (processingRequested);
  })().catch(() => undefined).finally(() => {
    processingPromise = null;
    if (processingRequested) scheduleTaskAssignmentImageCrawls();
  });
}

export function scheduleTaskAssignmentImageCrawlRefresh(): void {
  if (!refreshPromise) {
    refreshPromise = refreshTaskAssignmentImageCrawlsNow()
      .catch(() => undefined)
      .finally(() => { refreshPromise = null; });
  }
  if (read().some((record) => record.status === 'pending')) scheduleTaskAssignmentImageCrawls();
}
