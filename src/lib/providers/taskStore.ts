import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { getWorkspacePath } from '../storagePaths';
import { getProviderCatalog, type ProviderId } from './config';
import { countVideoOutputs, dedupeVideoOutputUrls } from './videoOutputUrls';
import { classifyTaskError, type TaskErrorInfo } from './taskErrorInfo';
import { bumpTaskRevision, closeTaskDatabase, taskDatabasePath, taskTransaction, withTaskDatabase } from './taskDatabase';

export type ProviderTaskMode = 'image' | 'video' | 'prompt';
export type ProviderTaskStatus = 'draft' | 'queued' | 'prompting' | 'submitting' | 'submitted' | 'processing' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled' | 'paused';

export type ProviderTask = {
  id: string;
  accountId: string;
  mode: ProviderTaskMode;
  provider: ProviderId;
  model?: string;
  prompt?: string;
  status: ProviderTaskStatus;
  progress: number;
  providerTaskId?: string;
  outputUrls: string[];
  outputBase64: string[];
  error?: string;
  /** Bounded supplier response snapshot retained for post-failure diagnosis. */
  providerResponse?: unknown;
  inventorySavedAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/**
 * Small projection used by overview pages. Keeping this separate from
 * ProviderTask is important: persisted task metadata may contain prompt
 * context, provider responses and output payloads that the overview never
 * renders.
 */
export type ProviderTaskSummary = Pick<ProviderTask, 'id' | 'accountId' | 'mode' | 'provider' | 'model' | 'status' | 'progress' | 'providerTaskId' | 'error' | 'inventorySavedAt' | 'createdAt' | 'updatedAt'> & {
  prompt?: string;
  outputCount: number;
  metadata?: Record<string, unknown>;
  errorInfo?: TaskErrorInfo;
};

export type CreateProviderTaskInput = {
  accountId: string;
  mode?: ProviderTaskMode;
  provider: ProviderId;
  model?: string;
  prompt?: string;
  status?: ProviderTaskStatus;
  progress?: number;
  providerTaskId?: string;
  outputUrls?: readonly string[];
  outputBase64?: readonly string[];
  error?: string;
  providerResponse?: unknown;
  inventorySavedAt?: string;
  metadata?: Record<string, unknown>;
  id?: string;
  createdAt?: string;
};

export type ProviderTaskPatch = Partial<Omit<ProviderTask, 'id' | 'createdAt' | 'updatedAt'>> & {
  // Accepted for compatibility with untrusted request bodies; ignored below.
  id?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ProviderTaskFilters = Partial<Pick<ProviderTask, 'accountId' | 'mode' | 'provider' | 'status' | 'providerTaskId'>> & {
  accountIds?: readonly string[];
  createdBusinessDate?: string;
  ids?: readonly string[];
  statuses?: readonly ProviderTaskStatus[];
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
};


const MAX_TEXT_LENGTH = 32_000;
const MAX_ARRAY_ITEMS = 64;
const MAX_OUTPUT_BASE64_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_BASE64_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_OUTPUT_BASE64_HEADER_LENGTH = 1024;
const VALID_MODES: readonly ProviderTaskMode[] = ['image', 'video', 'prompt'];
const VALID_STATUSES: readonly ProviderTaskStatus[] = ['draft', 'queued', 'prompting', 'submitting', 'submitted', 'processing', 'running', 'retrying', 'completed', 'failed', 'cancelled', 'paused'];
const VALID_PROVIDERS = new Set<ProviderId>(getProviderCatalog().map((entry) => entry.id));
const SHANGHAI_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

export const providerTasksPath = taskDatabasePath;
export const closeProviderTaskStore = closeTaskDatabase;

export function legacyProviderTasksPath(): string {
  return getWorkspacePath('providers', 'tasks.json');
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function withStore<T>(run: (database: DatabaseSync) => T): T {
  return withTaskDatabase((database) => {
    if (!database.prepare("SELECT value FROM task_store_meta WHERE key='imported'").get()) {
      if (fs.existsSync(legacyProviderTasksPath())) throw new Error('provider_tasks_migration_required');
      database.prepare("INSERT OR IGNORE INTO task_store_meta VALUES ('imported', 'empty')").run();
    }
    return run(database);
  });
}

type TaskRow = { core: string; content: string };
function hydrateTask(row: TaskRow): ProviderTask {
  const core = JSON.parse(row.core) as ProviderTask;
  const details = JSON.parse(row.content) as Partial<ProviderTask>;
  return { ...core, ...details, ...(core.metadata || details.metadata ? { metadata: { ...core.metadata, ...details.metadata } } : {}) };
}

function splitTask(task: ProviderTask): TaskRow {
  const { prompt, providerResponse, outputBase64, metadata, ...base } = task;
  const small: Record<string, unknown> = {};
  const large: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if ((typeof value === 'string' && value.length > 1024) || (value && typeof value === 'object')) large[key] = value;
    else small[key] = value;
  }
  return {
    core: JSON.stringify({ ...base, ...(metadata ? { metadata: small } : {}) }),
    content: JSON.stringify({ prompt, providerResponse, outputBase64, ...(metadata ? { metadata: large } : {}) }),
  };
}

function putTask(database: DatabaseSync, task: ProviderTask, insertOnly = false): void {
  const split = splitTask(task);
  const sql = `INSERT INTO provider_tasks
    (id,account_id,mode,provider,status,provider_task_id,created_at,updated_at,business_date,core,summary)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ${insertOnly ? '' : `ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,mode=excluded.mode,
      provider=excluded.provider,status=excluded.status,provider_task_id=excluded.provider_task_id,
      updated_at=excluded.updated_at,business_date=excluded.business_date,core=excluded.core,summary=excluded.summary`}`;
  database.prepare(sql).run(task.id,task.accountId,task.mode,task.provider,task.status,task.providerTaskId ?? null,
    task.createdAt,task.updatedAt,taskBusinessDate(task.createdAt),split.core,JSON.stringify(buildProviderTaskSummary(task)));
  // Progress changes do not rewrite the long prompt snapshot pages.
  database.prepare(`INSERT INTO provider_task_details(task_id,content) VALUES (?,?)
    ON CONFLICT(task_id) DO UPDATE SET content=excluded.content
    WHERE provider_task_details.content <> excluded.content`).run(task.id,split.content);
}

function readTask(database: DatabaseSync, id: string): ProviderTask | null {
  const row = database.prepare(`SELECT t.core,d.content FROM provider_tasks t
    JOIN provider_task_details d ON d.task_id=t.id WHERE t.id=?`).get(id);
  return row ? hydrateTask(row as TaskRow) : null;
}

function readLegacyMigrationSource(source: string): { content: Buffer | null; digest: string } {
  try {
    const content = fs.readFileSync(source);
    return { content, digest: crypto.createHash('sha256').update(content).digest('hex') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: null, digest: 'absent' };
    throw error;
  }
}

/** Explicit maintenance operation: stop the legacy writer before importing. */
export function migrateProviderTaskStore(): { count: number; source: string; database: string; alreadyImported: boolean; sourceSha256: string | null } {
  return withTaskDatabase((database) => taskTransaction(database, () => {
    const source = legacyProviderTasksPath();
    const snapshot = readLegacyMigrationSource(source);
    const existing = database.prepare("SELECT value FROM task_store_meta WHERE key='imported'").get();
    const storedDigest = database.prepare("SELECT value FROM task_store_meta WHERE key='imported_source_sha256'").get()?.value;
    const count = Number(database.prepare('SELECT COUNT(*) AS count FROM provider_tasks').get()?.count ?? 0);
    const result = (taskCount: number) => ({ count: taskCount, source, database: providerTasksPath(), alreadyImported: Boolean(existing), sourceSha256: snapshot.content ? snapshot.digest : null });
    const verifySourceUnchanged = () => {
      if (readLegacyMigrationSource(source).digest !== snapshot.digest) throw new Error('legacy_task_store_changed_during_migration');
    };
    if (existing && storedDigest !== undefined) {
      if (storedDigest !== snapshot.digest) throw new Error('provider_tasks_legacy_source_changed_since_import');
      verifySourceUnchanged();
      return result(count);
    }
    const tasks: unknown = snapshot.content ? JSON.parse(snapshot.content.toString('utf8')) : [];
    if (!Array.isArray(tasks)) throw new Error('provider_tasks_invalid_store');
    if (existing) {
      // Older migrated databases have no provenance marker. Establish it only
      // when every original field and row still agrees; never replace live rows.
      const sourceIds = new Set<string>();
      if (count !== tasks.length || tasks.some((value) => {
        if (!record(value) || typeof value.id !== 'string' || sourceIds.has(value.id)) return true;
        sourceIds.add(value.id);
        return !isDeepStrictEqual(readTask(database, value.id), value);
      })) {
        throw new Error('provider_tasks_migration_provenance_missing');
      }
    } else {
      if (count > 0) throw new Error('provider_tasks_unmarked_store_not_empty');
      for (const value of tasks) {
        normalizeStoredTask(value);
        putTask(database,value as ProviderTask,true);
        if (!isDeepStrictEqual(readTask(database,(value as ProviderTask).id),value)) throw new Error('provider_tasks_migration_mismatch');
      }
    }
    // Validation occurs before the marker/commit, so a changed source rolls
    // back the imported rows as well. Persisted provenance also protects retries.
    verifySourceUnchanged();
    database.prepare("INSERT INTO task_store_meta VALUES ('imported_source_sha256',?)").run(snapshot.digest);
    if (!existing) {
      database.prepare("INSERT INTO task_store_meta VALUES ('imported',?)").run(new Date().toISOString());
      bumpTaskRevision(database);
    }
    return result(tasks.length);
  }));
}

export function backupProviderTaskStore(destination: string): void {
  withStore((database) => database.prepare('VACUUM INTO ?').run(path.resolve(destination)));
}

export async function flushProviderTaskStore(): Promise<void> {
  // Every mutation commits before returning; there are no pending snapshots.
}

export function getProviderTaskStoreRevision(): number {
  return withStore((database) => Number(database.prepare("SELECT value FROM task_store_meta WHERE key='revision'").get()?.value ?? 0));
}

function taskQuery(filters: ProviderTaskFilters): { clause: string; params: SQLInputValue[]; order: string } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  for (const [column,value] of [
    ['account_id',filters.accountId],['mode',filters.mode],['provider',filters.provider],
    ['status',filters.status],['provider_task_id',filters.providerTaskId],['business_date',filters.createdBusinessDate],
  ] as const) {
    if (value) { clauses.push(`t.${column}=?`); params.push(value); }
  }
  for (const [column,values] of [['account_id',filters.accountIds],['id',filters.ids],['status',filters.statuses]] as const) {
    if (!values) continue;
    if (!values.length) { clauses.push('0'); continue; }
    clauses.push(`t.${column} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  }
  let order = filters.order === 'desc' ? ' ORDER BY t.created_at DESC,t.id DESC' : ' ORDER BY t.rowid ASC';
  if (filters.limit !== undefined || filters.offset !== undefined) {
    order += ' LIMIT ? OFFSET ?';
    params.push(filters.limit === undefined ? -1 : Math.max(0,Math.floor(filters.limit)),Math.max(0,Math.floor(filters.offset ?? 0)));
  }
  return {clause:clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',params,order};
}
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const valueTrimmed = value.trim();
  return valueTrimmed ? valueTrimmed.slice(0, MAX_TEXT_LENGTH) : undefined;
}

function requiredText(value: unknown, errorCode: string): string {
  const valueText = text(value);
  if (!valueText) throw new Error(errorCode);
  return valueText;
}

function validateMode(value: unknown): ProviderTaskMode {
  if (typeof value === 'string' && (VALID_MODES as readonly string[]).includes(value)) return value as ProviderTaskMode;
  throw new Error('mode_invalid');
}

function validateStatus(value: unknown): ProviderTaskStatus {
  if (typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value)) return value as ProviderTaskStatus;
  throw new Error('status_invalid');
}

function validateProvider(value: unknown): ProviderId {
  if (typeof value === 'string' && VALID_PROVIDERS.has(value as ProviderId)) return value as ProviderId;
  throw new Error('provider_invalid');
}

function normalizeProgress(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : 0;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, MAX_TEXT_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_ARRAY_ITEMS);
}

function normalizeOutputBase64(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_ARRAY_ITEMS) throw new Error('output_base64_too_many_items');
  let totalBytes = 0;
  let totalLength = 0;
  return value.filter((item): item is string => typeof item === 'string').map((item) => {
    const output = item.trim();
    // Binary outputs must stay complete; ordinary text truncation corrupts files.
    if (output.length > Math.ceil(MAX_OUTPUT_BASE64_BYTES / 3) * 4 + MAX_OUTPUT_BASE64_HEADER_LENGTH) {
      throw new Error('output_base64_too_large');
    }
    const payloadStart = output.startsWith('data:') ? output.indexOf(',') + 1 : 0;
    if (payloadStart > MAX_OUTPUT_BASE64_HEADER_LENGTH) throw new Error('output_base64_header_too_large');
    const bytes = Buffer.byteLength(output.slice(payloadStart), 'base64');
    if (bytes > MAX_OUTPUT_BASE64_BYTES) throw new Error('output_base64_too_large');
    totalBytes += bytes;
    totalLength += output.length;
    if (totalBytes > MAX_OUTPUT_BASE64_TOTAL_BYTES
      || totalLength > Math.ceil(MAX_OUTPUT_BASE64_TOTAL_BYTES / 3) * 4 + MAX_ARRAY_ITEMS * MAX_OUTPUT_BASE64_HEADER_LENGTH) {
      throw new Error('output_base64_total_too_large');
    }
    return output;
  }).filter(Boolean);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function taskBusinessDate(value: string): string {
  return SHANGHAI_DAY_FORMATTER.format(new Date(value));
}

function normalizeStoredTask(value: unknown): ProviderTask {
  if (!record(value)) throw new Error('provider_tasks_invalid_store');
  return {
    id: requiredText(value.id, 'task_id_invalid'),
    accountId: requiredText(value.accountId, 'account_id_required'),
    mode: validateMode(value.mode),
    provider: validateProvider(value.provider),
    ...(text(value.model) ? { model: text(value.model) } : {}),
    ...(text(value.prompt) ? { prompt: text(value.prompt) } : {}),
    status: validateStatus(value.status),
    progress: normalizeProgress(value.progress),
    ...(text(value.providerTaskId) ? { providerTaskId: text(value.providerTaskId) } : {}),
    outputUrls: validateMode(value.mode) === 'video' ? dedupeVideoOutputUrls(String(value.provider), normalizeStringArray(value.outputUrls)) : normalizeStringArray(value.outputUrls),
    outputBase64: normalizeOutputBase64(value.outputBase64),
    ...(text(value.error) ? { error: text(value.error) } : {}),
    ...(record(value.providerResponse) ? { providerResponse: clone(value.providerResponse) } : {}),
    ...(text(value.inventorySavedAt) ? { inventorySavedAt: text(value.inventorySavedAt) } : {}),
    ...(record(value.metadata) ? { metadata: clone(value.metadata) } : {}),
    createdAt: requiredText(value.createdAt, 'task_created_at_invalid'),
    updatedAt: requiredText(value.updatedAt, 'task_updated_at_invalid'),
  };
}

function taskId(value: unknown): string {
  return text(value) ?? `provider-task-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}


export function createProviderTask(input: CreateProviderTaskInput): ProviderTask { return createProviderTasks([input])[0]; }

export function createProviderTasks(inputs: readonly CreateProviderTaskInput[]): ProviderTask[] {
  if (!inputs.length) return [];
  const created = inputs.map((input) => {
    const createdAt = text(input.createdAt) ?? new Date().toISOString();
    return normalizeStoredTask({...input,id:taskId(input.id),mode:input.mode ?? 'video',status:input.status ?? 'queued',
      outputUrls:input.outputUrls ?? [],outputBase64:input.outputBase64 ?? [],progress:input.progress ?? 0,
      createdAt,updatedAt:createdAt});
  });
  return withStore((database) => taskTransaction(database, () => {
    const ids = new Set<string>();
    for (const task of created) {
      if (ids.has(task.id) || database.prepare('SELECT id FROM provider_tasks WHERE id=?').get(task.id)) throw new Error('task_id_exists');
      ids.add(task.id);
      putTask(database,task,true);
    }
    bumpTaskRevision(database);
    return clone(created);
  }));
}

export function listProviderTasks(filters: ProviderTaskFilters = {}): ProviderTask[] {
  return withStore((database) => {
    const query = taskQuery(filters);
    return database.prepare(`SELECT t.core,d.content FROM provider_tasks t
      JOIN provider_task_details d ON d.task_id=t.id${query.clause}${query.order}`)
      .all(...query.params).map((row) => hydrateTask(row as TaskRow));
  });
}

function summaryMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const result: Record<string, unknown> = {};
  // These fields are the only metadata consumed by workspace overview
  // projections (owner, PID/name and inventory output counts).
  for (const key of [
    'ownerId', 'pid', 'referenceImageName', 'taskNameMode', 'taskName', 'taskNameSequence', 'sequence',
    'schedulerState', 'schedulerOwnerId', 'schedulerMode', 'schedulerModel', 'schedulerRuntimeId',
    'execution', 'promptGenerationPending', 'promptProvider', 'promptModel', 'promptMode',
    'localOutputReady', 'localOutputCount', 'localOutputExpected',
    'providerTaskAcceptedAt', 'schedulerStartedAt', 'providerStaleRecoverCheckedAt',
    'promptGenerationUsedTemplate', 'providerSubmissionStartedAt', 'providerSubmissionUncertain',
    'providerAcceptedAt', 'schedulerRetryExhausted', 'schedulerRetryCount', 'schedulerRetryNotBefore',
    'workerId', 'schedulerWorkerId', 'recoveryRequestedAt', 'modelId', 'maxRetries', 'localCacheExhausted',
  ]) {
    const value = metadata[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result[key] = value;
  }
  const inventoryIds = metadata.inventoryAssetIds;
  if (Array.isArray(inventoryIds)) {
    result.inventoryAssetIds = inventoryIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).slice(0, MAX_ARRAY_ITEMS);
  }
  const fallbackProviders = metadata.promptFallbackProviders;
  if (Array.isArray(fallbackProviders)) {
    result.promptFallbackProviders = fallbackProviders.filter((value): value is string => typeof value === 'string').slice(0, MAX_ARRAY_ITEMS);
  }
  return Object.keys(result).length ? result : undefined;
}

function buildProviderTaskSummary(task: ProviderTask): ProviderTaskSummary {
  const inventoryIds = Array.isArray(task.metadata?.inventoryAssetIds)
    ? task.metadata.inventoryAssetIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  const outputCount = task.inventorySavedAt && inventoryIds.length > 0
    ? inventoryIds.length
    : countTaskOutputs(task);
  const errorInfo = classifyTaskError(task);
  const metadata = summaryMetadata(task.metadata);
  return {
    id: task.id,
    accountId: task.accountId,
    mode: task.mode,
    provider: task.provider,
    ...(task.model ? { model: task.model } : {}),
    ...(task.prompt ? { prompt: task.prompt.slice(0, 120) } : {}),
    status: task.status,
    progress: task.progress,
    ...(task.providerTaskId ? { providerTaskId: task.providerTaskId } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(errorInfo ? { errorInfo } : {}),
    ...(task.inventorySavedAt ? { inventorySavedAt: task.inventorySavedAt } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    outputCount,
    ...(metadata ? { metadata } : {}),
  };
}


export function listProviderTaskSummaries(filters: ProviderTaskFilters = {}): ProviderTaskSummary[] {
  return withStore((database) => {
    const query = taskQuery(filters);
    return database.prepare(`SELECT t.summary FROM provider_tasks t${query.clause}${query.order}`)
      .all(...query.params).map((row) => JSON.parse(String(row.summary)) as ProviderTaskSummary);
  });
}

function countTaskOutputs(task: ProviderTask): number {
  return task.mode === 'video'
    ? countVideoOutputs(task.provider,task.outputUrls,task.outputBase64,Boolean(task.providerTaskId))
    : task.outputUrls.filter((value) => value.trim()).length + task.outputBase64.filter((value) => value.trim()).length;
}

export function getProviderTask(id: string): ProviderTask | null {
  const normalizedId = text(id);
  return normalizedId ? withStore((database) => readTask(database,normalizedId)) : null;
}

function patchedTask(current: ProviderTask, patch: ProviderTaskPatch): ProviderTask {
  const candidate = record(patch) ? patch as Record<string, unknown> : {};
  const next: ProviderTask = {
    ...current,
    ...(candidate.accountId !== undefined ? { accountId: requiredText(candidate.accountId, 'account_id_required') } : {}),
    ...(candidate.mode !== undefined ? { mode: validateMode(candidate.mode) } : {}),
    ...(candidate.provider !== undefined ? { provider: validateProvider(candidate.provider) } : {}),
    ...(hasOwn(candidate, 'model') ? (text(candidate.model) ? { model: text(candidate.model) } : { model: undefined }) : {}),
    ...(hasOwn(candidate, 'prompt') ? (text(candidate.prompt) ? { prompt: text(candidate.prompt) } : { prompt: undefined }) : {}),
    ...(candidate.status !== undefined ? { status: validateStatus(candidate.status) } : {}),
    ...(candidate.progress !== undefined ? { progress: normalizeProgress(candidate.progress) } : {}),
    ...(hasOwn(candidate, 'providerTaskId') ? (text(candidate.providerTaskId) ? { providerTaskId: text(candidate.providerTaskId) } : { providerTaskId: undefined }) : {}),
    ...(candidate.outputUrls !== undefined ? { outputUrls: normalizeStringArray(candidate.outputUrls) } : {}),
    ...(candidate.outputBase64 !== undefined ? { outputBase64: normalizeOutputBase64(candidate.outputBase64) } : {}),
    ...(hasOwn(candidate, 'error') ? (text(candidate.error) ? { error: text(candidate.error) } : { error: undefined }) : {}),
    ...(hasOwn(candidate, 'providerResponse') ? (record(candidate.providerResponse) ? { providerResponse: clone(candidate.providerResponse) } : { providerResponse: undefined }) : {}),
    ...(hasOwn(candidate, 'inventorySavedAt') ? (text(candidate.inventorySavedAt) ? { inventorySavedAt: text(candidate.inventorySavedAt) } : { inventorySavedAt: undefined }) : {}),
    ...(hasOwn(candidate, 'metadata') ? (record(candidate.metadata) ? { metadata: clone(candidate.metadata) } : { metadata: undefined }) : {}),
    // Never permit callers to rewrite identity or original creation time.
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date(Math.max(Date.now(), (Date.parse(current.updatedAt) || 0) + 1)).toISOString(),
  };
  const normalizedNext = next.mode === 'video' ? { ...next, outputUrls: dedupeVideoOutputUrls(next.provider, next.outputUrls) } : next;

  return normalizedNext;
}

export function updateProviderTask(id: string, patch: ProviderTaskPatch, expectedUpdatedAt?: string): ProviderTask | null {
  const normalizedId = text(id);
  if (!normalizedId) return null;
  return withStore((database) => taskTransaction(database, () => {
    const current = readTask(database,normalizedId);
    if (!current) return null;
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) return null;
    const next = patchedTask(current,patch);
    putTask(database,next);
    bumpTaskRevision(database);
    return clone(next);
  }));
}

export function deleteProviderTask(id: string): boolean {
  const normalizedId = text(id);
  if (!normalizedId) return false;
  return withStore((database) => taskTransaction(database, () => {
    const changed = database.prepare('DELETE FROM provider_tasks WHERE id=?').run(normalizedId).changes > 0;
    if (changed) bumpTaskRevision(database);
    return changed;
  }));
}

function processAlive(pid: number): boolean {
  try { process.kill(pid,0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export function acquireProviderWorkerLease(workerId: string, leaseMs: number, pid = process.pid): boolean {
  return withStore((database) => taskTransaction(database, () => {
    const lease = database.prepare('SELECT * FROM provider_worker_lease WHERE singleton=1').get();
    if (lease && lease.worker_id !== workerId && (Number(lease.expires_at) > Date.now() || processAlive(Number(lease.pid)))) return false;
    database.prepare(`INSERT INTO provider_worker_lease VALUES (1,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET worker_id=excluded.worker_id,pid=excluded.pid,expires_at=excluded.expires_at`)
      .run(workerId,pid,Date.now()+leaseMs);
    return true;
  }));
}

export function renewProviderWorkerLease(workerId: string, leaseMs: number): boolean {
  return withStore((database) => database.prepare('UPDATE provider_worker_lease SET expires_at=? WHERE singleton=1 AND worker_id=?')
    .run(Date.now()+leaseMs,workerId).changes > 0);
}

export function releaseProviderWorkerLease(workerId: string): void {
  withStore((database) => { database.prepare('DELETE FROM provider_worker_lease WHERE singleton=1 AND worker_id=?').run(workerId); });
}

export function claimProviderTask(taskId: string, workerId: string): ProviderTask | null {
  return withStore((database) => taskTransaction(database, () => {
    const lease = database.prepare('SELECT worker_id,expires_at FROM provider_worker_lease WHERE singleton=1').get();
    if (!lease || lease.worker_id !== workerId || Number(lease.expires_at) <= Date.now()) return null;
    const task = readTask(database,taskId);
    if (!task || task.providerTaskId || !['queued','retrying','prompting'].includes(task.status)) return null;
    const metadata = task.metadata ?? {};
    if (metadata.schedulerState !== 'waiting' || metadata.providerSubmissionUncertain === true) return null;
    const notBefore = Date.parse(String(metadata.schedulerRetryNotBefore ?? ''));
    if (Number.isFinite(notBefore) && notBefore > Date.now()) return null;
    const next = patchedTask(task,{status:metadata.promptGenerationPending === true ? 'prompting' : 'submitting',metadata:{...metadata,schedulerState:'dispatching',schedulerWorkerId:workerId,
      schedulerStartedAt:new Date().toISOString()}});
    putTask(database,next);
    bumpTaskRevision(database);
    return next;
  }));
}
