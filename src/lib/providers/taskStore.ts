import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWorkspacePath } from '../storagePaths';
import { getProviderCatalog, type ProviderId } from './config';
import { countVideoOutputs, dedupeVideoOutputUrls } from './videoOutputUrls';
import { classifyTaskError, type TaskErrorInfo } from './taskErrorInfo';

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
};

const TASKS_DIRECTORY = 'providers';
const TASKS_FILE = 'tasks.json';
const MAX_TEXT_LENGTH = 32_000;
const MAX_ARRAY_ITEMS = 64;
// Keep in-memory updates immediate while coalescing disk writes. A busy
// provider queue otherwise serializes the entire historical task file for
// every progress transition and can delay unrelated route responses.
const PERSIST_DEBOUNCE_MS = Math.max(50, Number(process.env.WORKSPACE_TASK_PERSIST_DEBOUNCE_MS || 250));
const VALID_MODES: readonly ProviderTaskMode[] = ['image', 'video', 'prompt'];
const VALID_STATUSES: readonly ProviderTaskStatus[] = ['draft', 'queued', 'prompting', 'submitting', 'submitted', 'processing', 'running', 'retrying', 'completed', 'failed', 'cancelled', 'paused'];
const VALID_PROVIDERS = new Set<ProviderId>(getProviderCatalog().map((entry) => entry.id));
const SHANGHAI_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Returns the only path used by this store. It is confined by storagePaths. */
export function providerTasksPath(): string {
  return getWorkspacePath(TASKS_DIRECTORY, TASKS_FILE);
}

function ensureStoreDirectory(): void {
  fs.mkdirSync(path.dirname(providerTasksPath()), { recursive: true });
}

let cachedMtimeMs = 0;
let cachedSize = -1;
let cachedFile = '';
let cachedTasks: ProviderTask[] = [];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneFast(task: ProviderTask): ProviderTask {
  return {
    ...task,
    outputUrls: task.outputUrls ? [...task.outputUrls] : [],
    outputBase64: task.outputBase64 ? [...task.outputBase64] : [],
    metadata: task.metadata ? { ...task.metadata } : undefined,
    providerResponse: task.providerResponse ? JSON.parse(JSON.stringify(task.providerResponse)) : undefined,
  };
}

function readTasks(): ProviderTask[] {
  const file = providerTasksPath();
  if (file === cachedFile && (pendingPersist || persistInFlight)) return cachedTasks;
  try {
    const stat = fs.statSync(file);
    if (file === cachedFile && stat.mtimeMs === cachedMtimeMs && stat.size === cachedSize) {
      return cachedTasks;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('provider_tasks_invalid_store');
    cachedMtimeMs = stat.mtimeMs;
    cachedSize = stat.size;
    cachedFile = file;
    cachedTasks = parsed.map(normalizeStoredTask);
    return cachedTasks;
  } catch (error) {
    if (isMissingFile(error)) {
      cachedMtimeMs = 0;
      cachedSize = -1;
      cachedFile = file;
      cachedTasks = [];
      return [];
    }
    if (error instanceof SyntaxError) throw new Error('provider_tasks_invalid_store');
    throw error;
  }
}

function writeTasks(tasks: readonly ProviderTask[]): void {
  ensureStoreDirectory();
  const file = providerTasksPath();
  // Keep unit-test writes deterministic. Production uses the coalesced async
  // path below so a burst of scheduler updates does not synchronously rewrite
  // the entire (potentially tens-of-megabytes) task store on every transition.
  if (process.env.NODE_ENV === 'test') {
    writeTasksSync(file, tasks);
    return;
  }
  const snapshot = [...tasks];
  // Make the store path exist immediately for first-run health checks. The
  // complete snapshot is flushed asynchronously a few milliseconds later.
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', { encoding: 'utf8', mode: 0o600 });
  cachedMtimeMs = 0;
  cachedSize = -1;
  cachedFile = file;
  cachedTasks = snapshot;
  pendingPersist = snapshot;
  schedulePersist();
}

function writeTasksSync(file: string, tasks: readonly ProviderTask[]): void {
  const temporary = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(tasks, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
    try {
      const stat = fs.statSync(file);
      cachedMtimeMs = stat.mtimeMs;
      cachedSize = stat.size;
      cachedFile = file;
      cachedTasks = [...tasks];
    } catch {
      cachedMtimeMs = 0;
      cachedSize = -1;
      cachedFile = file;
      cachedTasks = [];
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

let pendingPersist: ProviderTask[] | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight = false;

function schedulePersist(): void {
  if (persistTimer || persistInFlight) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushPersist();
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

async function flushPersist(): Promise<void> {
  if (persistInFlight || !pendingPersist) return;
  const snapshot = pendingPersist;
  pendingPersist = null;
  persistInFlight = true;
  const file = providerTasksPath();
  const temporary = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temporary, file);
    try {
      const stat = await fs.promises.stat(file);
      // Do not replace a newer in-memory snapshot that arrived while the
      // previous disk write was in flight.
      if (!pendingPersist) {
        cachedMtimeMs = stat.mtimeMs;
        cachedSize = stat.size;
        cachedFile = file;
        cachedTasks = snapshot;
      }
    } catch {
      // The in-memory cache remains authoritative until the next flush.
    }
  } catch {
    // Keep the latest snapshot queued for a later retry; transient disk errors
    // must not turn a successful provider task into a failed request.
    pendingPersist = pendingPersist ? [...pendingPersist] : snapshot;
  } finally {
    persistInFlight = false;
    try { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); } catch { /* best effort cleanup */ }
    if (pendingPersist) schedulePersist();
  }
}

/** Flush coalesced task updates before a maintenance process exits. */
export async function flushProviderTaskStore(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  for (let attempt = 0; attempt < 200 && (pendingPersist || persistInFlight); attempt += 1) {
    if (persistInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    await flushPersist();
  }
  if (pendingPersist || persistInFlight) throw new Error('provider_tasks_flush_failed');
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT');
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

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function taskBusinessDate(value: string): string {
  return SHANGHAI_DAY_FORMATTER.format(new Date(value));
}

function taskMatchesFilters(task: ProviderTask, filters: ProviderTaskFilters): boolean {
  if (filters.accountId && task.accountId !== filters.accountId) return false;
  if (filters.accountIds && !filters.accountIds.includes(task.accountId)) return false;
  if (filters.mode && task.mode !== filters.mode) return false;
  if (filters.provider && task.provider !== filters.provider) return false;
  if (filters.status && task.status !== filters.status) return false;
  if (filters.providerTaskId && task.providerTaskId !== filters.providerTaskId) return false;
  if (filters.createdBusinessDate && taskBusinessDate(task.createdAt) !== filters.createdBusinessDate) return false;
  return true;
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
    outputBase64: normalizeStringArray(value.outputBase64),
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

export function createProviderTask(input: CreateProviderTaskInput): ProviderTask {
  return createProviderTasks([input])[0];
}

/** Create several tasks with a single tasks.json read/write. Route handlers
 * use this for count>1 submissions so large persisted queues do not incur one
 * full-file rewrite per output. */
export function createProviderTasks(inputs: readonly CreateProviderTaskInput[]): ProviderTask[] {
  if (!inputs.length) return [];
  const created: ProviderTask[] = inputs.map((input) => {
  const createdAt = text(input.createdAt) ?? new Date().toISOString();
  const task: ProviderTask = {
    id: taskId(input.id),
    accountId: requiredText(input.accountId, 'account_id_required'),
    mode: input.mode === undefined ? 'video' : validateMode(input.mode),
    provider: validateProvider(input.provider),
    ...(text(input.model) ? { model: text(input.model) } : {}),
    ...(text(input.prompt) ? { prompt: text(input.prompt) } : {}),
    status: input.status === undefined ? 'queued' : validateStatus(input.status),
    progress: normalizeProgress(input.progress),
    ...(text(input.providerTaskId) ? { providerTaskId: text(input.providerTaskId) } : {}),
    outputUrls: input.mode === 'video' || input.mode === undefined ? dedupeVideoOutputUrls(String(input.provider), normalizeStringArray(input.outputUrls)) : normalizeStringArray(input.outputUrls),
    outputBase64: normalizeStringArray(input.outputBase64),
    ...(text(input.error) ? { error: text(input.error) } : {}),
    ...(record(input.providerResponse) ? { providerResponse: clone(input.providerResponse) } : {}),
    ...(text(input.inventorySavedAt) ? { inventorySavedAt: text(input.inventorySavedAt) } : {}),
    ...(record(input.metadata) ? { metadata: clone(input.metadata) } : {}),
    createdAt,
    updatedAt: createdAt,
  };
    return task;
  });
  const ids = new Set<string>();
  for (const task of created) {
    if (ids.has(task.id)) throw new Error('task_id_exists');
    ids.add(task.id);
  }
  const tasks = readTasks();
  if (created.some((task) => tasks.some((candidate) => candidate.id === task.id))) throw new Error('task_id_exists');
  writeTasks([...tasks, ...created]);
  return created.map(clone);
}

export function listProviderTasks(filters: ProviderTaskFilters = {}): ProviderTask[] {
  return readTasks()
    .filter((task) => taskMatchesFilters(task, filters))
    .map((task) => cloneFast(task));
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

/** Read only the fields needed by overview counters and cards. */
export function listProviderTaskSummaries(filters: ProviderTaskFilters = {}): ProviderTaskSummary[] {
  return readTasks()
    .filter((task) => taskMatchesFilters(task, filters))
    .map((task) => {
      const inventoryIds = Array.isArray(task.metadata?.inventoryAssetIds)
        ? task.metadata.inventoryAssetIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        : [];
      const outputCount = task.inventorySavedAt && inventoryIds.length > 0
        ? inventoryIds.length
        : countTaskOutputs(task);
      const errorInfo = classifyTaskError(task);
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
        ...(summaryMetadata(task.metadata) ? { metadata: summaryMetadata(task.metadata) } : {}),
      };
    });
}

function countTaskOutputs(task: ProviderTask): number {
  return task.mode === 'video'
    ? countVideoOutputs(task.provider, task.outputUrls, task.outputBase64, Boolean(task.providerTaskId))
    : task.outputUrls.filter((value) => value.trim()).length + task.outputBase64.filter((value) => value.trim()).length;
}

export function getProviderTask(id: string): ProviderTask | null {
  const normalizedId = text(id);
  if (!normalizedId) return null;
  const task = readTasks().find((candidate) => candidate.id === normalizedId);
  return task ? cloneFast(task) : null;
}

export function updateProviderTask(id: string, patch: ProviderTaskPatch): ProviderTask | null {
  const normalizedId = text(id);
  if (!normalizedId) return null;
  const tasks = readTasks();
  const index = tasks.findIndex((task) => task.id === normalizedId);
  if (index < 0) return null;
  const current = tasks[index];
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
    ...(candidate.outputBase64 !== undefined ? { outputBase64: normalizeStringArray(candidate.outputBase64) } : {}),
    ...(hasOwn(candidate, 'error') ? (text(candidate.error) ? { error: text(candidate.error) } : { error: undefined }) : {}),
    ...(hasOwn(candidate, 'providerResponse') ? (record(candidate.providerResponse) ? { providerResponse: clone(candidate.providerResponse) } : { providerResponse: undefined }) : {}),
    ...(hasOwn(candidate, 'inventorySavedAt') ? (text(candidate.inventorySavedAt) ? { inventorySavedAt: text(candidate.inventorySavedAt) } : { inventorySavedAt: undefined }) : {}),
    ...(hasOwn(candidate, 'metadata') ? (record(candidate.metadata) ? { metadata: clone(candidate.metadata) } : { metadata: undefined }) : {}),
    // Never permit callers to rewrite identity or original creation time.
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  const normalizedNext = next.mode === 'video' ? { ...next, outputUrls: dedupeVideoOutputUrls(next.provider, next.outputUrls) } : next;
  writeTasks(tasks.map((task, taskIndex) => taskIndex === index ? normalizedNext : task));
  return clone(normalizedNext);
}

export function deleteProviderTask(id: string): boolean {
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  if (!normalizedId) return false;
  const tasks = readTasks();
  const next = tasks.filter((task) => task.id !== normalizedId);
  if (next.length === tasks.length) return false;
  writeTasks(next);
  return true;
}
