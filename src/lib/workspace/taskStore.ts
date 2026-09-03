import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getWorkspacePath } from '../storagePaths';
import { workspaceTasks, type WorkspaceTask, type WorkspaceTaskStatus } from './tasks';

export type PersistedWorkspaceTask = WorkspaceTask & {
  provider?: string;
  providerTaskId?: string;
  outputUrls?: string[];
  outputBase64?: string[];
  providerResponse?: unknown;
  updatedAt?: string;
};

const storeFile = () => getWorkspacePath('workspace', 'tasks.json');

function ensureStoreDir(): void { fs.mkdirSync(path.dirname(storeFile()), { recursive: true }); }

function readStore(): PersistedWorkspaceTask[] {
  ensureStoreDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return workspaceTasks.map((task) => ({ ...task }));
  }
}

function writeStore(tasks: PersistedWorkspaceTask[]): void {
  ensureStoreDir();
  const temp = `${storeFile()}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(tasks, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, storeFile());
}

export function listPersistedWorkspaceTasks(filters: { accountId?: string; ownerId?: string; mode?: WorkspaceTask['mode'] } = {}): PersistedWorkspaceTask[] {
  return readStore()
    .filter((task) => !filters.accountId || task.accountId === filters.accountId)
    .filter((task) => !filters.ownerId || task.owner === filters.ownerId)
    .filter((task) => !filters.mode || task.mode === filters.mode)
    .map((task) => ({ ...task, outputUrls: task.outputUrls ? [...task.outputUrls] : undefined, outputBase64: task.outputBase64 ? [...task.outputBase64] : undefined }));
}

export function getWorkspaceTaskById(id: string): PersistedWorkspaceTask | null {
  return listPersistedWorkspaceTasks().find((task) => task.id === id) ?? null;
}

export function createWorkspaceTask(input: Omit<PersistedWorkspaceTask, 'updatedAt'> & { id?: string }): PersistedWorkspaceTask {
  const tasks = readStore();
  const now = new Date().toISOString();
  const task: PersistedWorkspaceTask = { ...input, id: input.id ?? `task_${Date.now()}`, createdAt: input.createdAt || now, updatedAt: now };
  writeStore([...tasks.filter((item) => item.id !== task.id), task]);
  return { ...task };
}

export function updateWorkspaceTask(id: string, patch: Partial<PersistedWorkspaceTask> & { status?: WorkspaceTaskStatus }): PersistedWorkspaceTask | null {
  const tasks = readStore();
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return null;
  const updated: PersistedWorkspaceTask = { ...tasks[index], ...patch, id: tasks[index].id, updatedAt: new Date().toISOString() };
  const next = tasks.map((task, taskIndex) => taskIndex === index ? updated : task);
  writeStore(next);
  return { ...updated, outputUrls: updated.outputUrls ? [...updated.outputUrls] : undefined, outputBase64: updated.outputBase64 ? [...updated.outputBase64] : undefined };
}

export function resetWorkspaceTaskStore(): void {
  try { fs.rmSync(storeFile(), { force: true }); } catch { /* best effort for tests */ }
}
