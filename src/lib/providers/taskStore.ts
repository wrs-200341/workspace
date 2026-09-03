import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWorkspacePath } from '../storagePaths';
import { getProviderCatalog, type ProviderId } from './config';

export type ProviderTaskMode = 'image' | 'video' | 'prompt';
export type ProviderTaskStatus = 'draft' | 'queued' | 'prompting' | 'submitting' | 'submitted' | 'processing' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';

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
  inventorySavedAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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

export type ProviderTaskFilters = Partial<Pick<ProviderTask, 'accountId' | 'mode' | 'provider' | 'status' | 'providerTaskId'>>;

const TASKS_DIRECTORY = 'providers';
const TASKS_FILE = 'tasks.json';
const MAX_TEXT_LENGTH = 32_000;
const MAX_ARRAY_ITEMS = 64;
const VALID_MODES: readonly ProviderTaskMode[] = ['image', 'video', 'prompt'];
const VALID_STATUSES: readonly ProviderTaskStatus[] = ['draft', 'queued', 'prompting', 'submitting', 'submitted', 'processing', 'running', 'completed', 'failed', 'cancelled', 'paused'];
const VALID_PROVIDERS = new Set<ProviderId>(getProviderCatalog().map((entry) => entry.id));

/** Returns the only path used by this store. It is confined by storagePaths. */
export function providerTasksPath(): string {
  return getWorkspacePath(TASKS_DIRECTORY, TASKS_FILE);
}

function ensureStoreDirectory(): void {
  fs.mkdirSync(path.dirname(providerTasksPath()), { recursive: true });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readTasks(): ProviderTask[] {
  const file = providerTasksPath();
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('provider_tasks_invalid_store');
    return parsed.map(normalizeStoredTask);
  } catch (error) {
    if (isMissingFile(error)) return [];
    if (error instanceof SyntaxError) throw new Error('provider_tasks_invalid_store');
    throw error;
  }
}

function writeTasks(tasks: readonly ProviderTask[]): void {
  ensureStoreDirectory();
  const file = providerTasksPath();
  const temporary = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(tasks, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
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
    outputUrls: normalizeStringArray(value.outputUrls),
    outputBase64: normalizeStringArray(value.outputBase64),
    ...(text(value.error) ? { error: text(value.error) } : {}),
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
    outputUrls: normalizeStringArray(input.outputUrls),
    outputBase64: normalizeStringArray(input.outputBase64),
    ...(text(input.error) ? { error: text(input.error) } : {}),
    ...(text(input.inventorySavedAt) ? { inventorySavedAt: text(input.inventorySavedAt) } : {}),
    ...(record(input.metadata) ? { metadata: clone(input.metadata) } : {}),
    createdAt,
    updatedAt: createdAt,
  };
  const tasks = readTasks();
  if (tasks.some((candidate) => candidate.id === task.id)) throw new Error('task_id_exists');
  writeTasks([...tasks, task]);
  return clone(task);
}

export function listProviderTasks(filters: ProviderTaskFilters = {}): ProviderTask[] {
  return readTasks()
    .filter((task) => !filters.accountId || task.accountId === filters.accountId)
    .filter((task) => !filters.mode || task.mode === filters.mode)
    .filter((task) => !filters.provider || task.provider === filters.provider)
    .filter((task) => !filters.status || task.status === filters.status)
    .filter((task) => !filters.providerTaskId || task.providerTaskId === filters.providerTaskId)
    .map((task) => clone(task));
}

export function getProviderTask(id: string): ProviderTask | null {
  const normalizedId = text(id);
  if (!normalizedId) return null;
  const task = readTasks().find((candidate) => candidate.id === normalizedId);
  return task ? clone(task) : null;
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
    ...(hasOwn(candidate, 'inventorySavedAt') ? (text(candidate.inventorySavedAt) ? { inventorySavedAt: text(candidate.inventorySavedAt) } : { inventorySavedAt: undefined }) : {}),
    ...(hasOwn(candidate, 'metadata') ? (record(candidate.metadata) ? { metadata: clone(candidate.metadata) } : { metadata: undefined }) : {}),
    // Never permit callers to rewrite identity or original creation time.
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  writeTasks(tasks.map((task, taskIndex) => taskIndex === index ? next : task));
  return clone(next);
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
