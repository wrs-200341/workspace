import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWorkspacePath } from '../storagePaths';
import { listInventorySavedVideoTaskSummariesSince, type ProviderTaskSummary } from '../providers/taskStore';
import { listStoredAccounts } from './accountStore';
import { getWorkspaceAccounts, getWorkspaceOperators } from './data';
import { taskNameForInventory } from './inventoryNaming';

export type TaskAssignment = {
  id: string;
  pid: string;
  source: 'tap' | 'cap';
  urgent: boolean;
  operatorId: string;
  operatorName: string;
  quantity: number;
  feedback: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskAssignmentProgress = TaskAssignment & {
  completedQuantity: number;
  pendingQuantity: number;
  crawlStatus?: 'pending' | 'running' | 'completed' | 'failed';
  crawlError?: string;
  crawlBatchId?: string;
  tapSales?: number | null;
  localOrders?: number | null;
  productName?: string | null;
  productPreviewUrl?: string | null;
  productRating?: number | null;
  commissionAmount?: string | null;
  productStock?: number | string | null;
};

type TaskAssignmentInput = { pid: unknown; source?: unknown; urgent?: unknown; operatorId: unknown; quantity: unknown };
type TaskAssignmentOperatorInput = { operatorId: unknown; quantity: unknown };
export type TaskAssignmentBatchCreateResult = {
  created: TaskAssignment[];
  createdPids: string[];
  skippedPids: string[];
};
type CacheEntry = { mtimeMs: number; size: number; assignments: TaskAssignment[] };

const cache = new Map<string, CacheEntry>();
const storeFile = () => getWorkspacePath('workspace', 'task-assignments.json');

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeStoredAssignment(value: unknown): TaskAssignment | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const valid = typeof row.id === 'string'
    && typeof row.pid === 'string'
    && typeof row.operatorId === 'string'
    && typeof row.operatorName === 'string'
    && typeof row.quantity === 'number'
    && Number.isInteger(row.quantity)
    && typeof row.createdAt === 'string'
    && typeof row.updatedAt === 'string';
  if (!valid) return null;
  return {
    id: row.id as string,
    pid: row.pid as string,
    source: row.source === 'cap' ? 'cap' : 'tap',
    urgent: row.urgent === true,
    operatorId: row.operatorId as string,
    operatorName: row.operatorName as string,
    quantity: row.quantity as number,
    feedback: typeof row.feedback === 'string' ? row.feedback : '',
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function read(): TaskAssignment[] {
  const file = storeFile();
  try {
    const stat = fs.statSync(file);
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.assignments;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const assignments = Array.isArray(parsed)
      ? parsed.map(normalizeStoredAssignment).filter((item): item is TaskAssignment => item !== null)
      : [];
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, assignments });
    return assignments;
  } catch {
    cache.delete(file);
    return [];
  }
}

function write(assignments: readonly TaskAssignment[]): void {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(assignments, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  const stat = fs.statSync(file);
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, assignments: [...assignments] });
}

function normalizePid(value: unknown): string {
  const pid = typeof value === 'string' ? value.trim() : '';
  if (!pid || pid.length > 120 || !/^[A-Za-z0-9._-]+$/.test(pid)) throw new Error('invalid_pid');
  return pid;
}

function normalizeSource(value: unknown): 'tap' | 'cap' {
  const source = value === undefined || value === 'tap' ? 'tap' : value === 'cap' ? 'cap' : null;
  if (!source) throw new Error('invalid_source');
  return source;
}

function normalizeUrgent(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  throw new Error('invalid_urgent');
}

function normalizeOperatorInput(input: TaskAssignmentOperatorInput): { operatorId: string; operatorName: string; quantity: number } {
  const operatorId = typeof input.operatorId === 'string' ? input.operatorId.trim() : '';
  const operator = getWorkspaceOperators().find((item) => item.id === operatorId);
  if (!operator) throw new Error('operator_not_found');
  const quantity = typeof input.quantity === 'number' ? input.quantity : Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) throw new Error('invalid_quantity');
  return { operatorId: operator.id, operatorName: operator.name, quantity };
}

function normalizeInput(input: TaskAssignmentInput): { pid: string; source: 'tap' | 'cap'; urgent: boolean; operatorId: string; operatorName: string; quantity: number } {
  return {
    pid: normalizePid(input.pid),
    source: normalizeSource(input.source),
    urgent: normalizeUrgent(input.urgent),
    ...normalizeOperatorInput(input),
  };
}

function normalizeFeedback(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid_feedback');
  const feedback = value.trim();
  if (feedback.length > 2_000) throw new Error('invalid_feedback');
  return feedback;
}

export function listTaskAssignments(operatorId?: string): TaskAssignment[] {
  return read()
    .filter((assignment) => !operatorId || assignment.operatorId === operatorId)
    .map(clone)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.pid.localeCompare(b.pid));
}

function matchesTaskPid(taskName: string, pid: string): boolean {
  if (taskName === pid) return true;
  if (!taskName.startsWith(pid)) return false;
  const boundary = taskName.charAt(pid.length);
  return boundary === '_' || boundary === '-';
}

export function calculateTaskAssignmentProgress(
  assignments: readonly TaskAssignment[],
  tasks: readonly ProviderTaskSummary[],
): TaskAssignmentProgress[] {
  const completed = new Map(assignments.map((assignment) => [assignment.id, 0]));
  const assignmentsByOperator = new Map<string, TaskAssignment[]>();
  for (const assignment of assignments) {
    assignmentsByOperator.set(assignment.operatorId, [...(assignmentsByOperator.get(assignment.operatorId) ?? []), assignment]);
  }
  const accountOwners = new Map(
    [...getWorkspaceAccounts(), ...listStoredAccounts()].map((account) => [account.id, account.ownerId]),
  );

  for (const task of tasks) {
    if (task.mode !== 'video' || !task.inventorySavedAt) continue;
    const metadataOwner = typeof task.metadata?.ownerId === 'string' ? task.metadata.ownerId.trim() : '';
    const ownerId = metadataOwner || accountOwners.get(task.accountId);
    if (!ownerId) continue;
    const candidates = assignmentsByOperator.get(ownerId);
    if (!candidates?.length) continue;
    const savedAt = Date.parse(task.inventorySavedAt);
    if (!Number.isFinite(savedAt)) continue;
    const taskName = taskNameForInventory(task, 1);
    for (const assignment of candidates) {
      const assignmentCreatedAt = Date.parse(assignment.createdAt);
      if (!Number.isFinite(assignmentCreatedAt) || savedAt < assignmentCreatedAt || !matchesTaskPid(taskName, assignment.pid)) continue;
      completed.set(assignment.id, (completed.get(assignment.id) ?? 0) + 1);
    }
  }

  return assignments.map((assignment) => {
    const completedQuantity = completed.get(assignment.id) ?? 0;
    return {
      ...assignment,
      completedQuantity,
      pendingQuantity: Math.max(assignment.quantity - completedQuantity, 0),
    };
  });
}

export function listTaskAssignmentsWithProgress(operatorId?: string): TaskAssignmentProgress[] {
  const assignments = listTaskAssignments(operatorId);
  if (!assignments.length) return [];
  const earliestCreatedAt = assignments.reduce(
    (earliest, assignment) => assignment.createdAt < earliest ? assignment.createdAt : earliest,
    assignments[0].createdAt,
  );
  return calculateTaskAssignmentProgress(assignments, listInventorySavedVideoTaskSummariesSince(earliestCreatedAt));
}

export function createTaskAssignment(input: TaskAssignmentInput): TaskAssignment {
  const normalized = normalizeInput(input);
  const now = new Date().toISOString();
  const assignment: TaskAssignment = {
    id: `assignment-${crypto.randomUUID()}`,
    ...normalized,
    feedback: '',
    createdAt: now,
    updatedAt: now,
  };
  write([...read(), assignment]);
  return clone(assignment);
}

export function createTaskAssignments(inputs: readonly TaskAssignmentInput[]): TaskAssignment[] {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 10) throw new Error('invalid_assignments');
  const normalized = inputs.map(normalizeInput);
  if (new Set(normalized.map((item) => item.operatorId)).size !== normalized.length) throw new Error('duplicate_operator');
  const now = new Date().toISOString();
  const created = normalized.map((item): TaskAssignment => ({
    id: `assignment-${crypto.randomUUID()}`,
    ...item,
    feedback: '',
    createdAt: now,
    updatedAt: now,
  }));
  write([...read(), ...created]);
  return created.map(clone);
}

export function createTaskAssignmentsForPids(
  pidInputs: readonly unknown[],
  sourceInput: unknown,
  operatorInputs: readonly TaskAssignmentOperatorInput[],
  urgentInput?: unknown,
): TaskAssignmentBatchCreateResult {
  if (!Array.isArray(pidInputs) || pidInputs.length < 1 || pidInputs.length > 500) throw new Error('invalid_pids');
  if (!Array.isArray(operatorInputs) || operatorInputs.length < 1 || operatorInputs.length > 10) throw new Error('invalid_assignments');

  const source = normalizeSource(sourceInput);
  const urgent = normalizeUrgent(urgentInput);
  const operators = operatorInputs.map(normalizeOperatorInput);
  if (new Set(operators.map((item) => item.operatorId)).size !== operators.length) throw new Error('duplicate_operator');

  const uniquePids: string[] = [];
  const submittedPidKeys = new Set<string>();
  for (const input of pidInputs) {
    const pid = normalizePid(input);
    const key = pid.toLowerCase();
    if (submittedPidKeys.has(key)) continue;
    submittedPidKeys.add(key);
    uniquePids.push(pid);
  }

  const current = read();
  const existingPidKeys = new Set(current.map((item) => item.pid.toLowerCase()));
  const createdPids = uniquePids.filter((pid) => !existingPidKeys.has(pid.toLowerCase()));
  const skippedPids = uniquePids.filter((pid) => existingPidKeys.has(pid.toLowerCase()));
  const now = new Date().toISOString();
  const created = createdPids.flatMap((pid) => operators.map((operator): TaskAssignment => ({
    id: `assignment-${crypto.randomUUID()}`,
    pid,
    source,
    urgent,
    ...operator,
    feedback: '',
    createdAt: now,
    updatedAt: now,
  })));
  if (created.length) write([...current, ...created]);
  return { created: created.map(clone), createdPids: [...createdPids], skippedPids: [...skippedPids] };
}

export function updateTaskAssignment(id: string, input: TaskAssignmentInput): TaskAssignment | null {
  const assignments = read();
  const index = assignments.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const updated: TaskAssignment = {
    ...assignments[index],
    ...normalizeInput(input),
    updatedAt: new Date().toISOString(),
  };
  write(assignments.map((item, itemIndex) => itemIndex === index ? updated : item));
  return clone(updated);
}

export function updateTaskAssignmentFeedback(id: string, operatorId: string | undefined, feedbackInput: unknown): TaskAssignment | null {
  const assignments = read();
  const index = assignments.findIndex((item) => item.id === id);
  if (index < 0) return null;
  if (operatorId && assignments[index].operatorId !== operatorId) throw new Error('forbidden');
  const updated: TaskAssignment = {
    ...assignments[index],
    feedback: normalizeFeedback(feedbackInput),
    updatedAt: new Date().toISOString(),
  };
  write(assignments.map((item, itemIndex) => itemIndex === index ? updated : item));
  return clone(updated);
}

export function deleteTaskAssignment(id: string): boolean {
  const assignments = read();
  if (!assignments.some((item) => item.id === id)) return false;
  write(assignments.filter((item) => item.id !== id));
  return true;
}
