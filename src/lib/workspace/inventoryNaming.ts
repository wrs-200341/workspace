import { listProviderTasks, type ProviderTask } from '@/lib/providers/taskStore';
import { businessDate } from './tasks';

function taskImageStem(value: string): string {
  const fileName = value.split(/[\\/]/).pop()?.trim() ?? value.trim();
  const stem = fileName.replace(/\.[^.]+$/, '').trim();
  return stem || fileName;
}

function taskSequence(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? Math.max(1, Math.round(numeric)) : 1;
}

/** The same human-readable name shown for a task in the production queue. */
type TaskNameInput = Pick<ProviderTask, 'id' | 'accountId' | 'mode' | 'prompt' | 'createdAt' | 'metadata'>;

function taskNameBase(task: TaskNameInput): string {
  const metadata = task.metadata ?? {};
  const referenceImageName = typeof metadata.referenceImageName === 'string' ? taskImageStem(metadata.referenceImageName) : '';
  return referenceImageName || task.prompt?.trim().slice(0, 80) || `${task.mode} generation`;
}

function taskNameKey(task: TaskNameInput): string {
  return `${task.accountId}|${task.mode}|${businessDate(task.createdAt)}|${taskNameBase(task)}`;
}

/**
 * Resolve the occurrence number for repeated submissions with the same task
 * name. A batch may already carry metadata.sequence (1, 2, ...); repeated
 * submissions continue after the existing occurrence count instead of
 * restarting at 1.
 */
function taskNameSequenceFor(task: TaskNameInput): number {
  const metadata = task.metadata ?? {};
  const configured = taskSequence(metadata.taskNameSequence ?? metadata.sequence);
  if (!task.id || !task.accountId) return configured;
  try {
    const key = taskNameKey(task);
    const occurrence = listProviderTasks({ accountId: task.accountId, mode: task.mode })
      .filter((candidate) => taskNameKey(candidate) === key)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || taskSequence(left.metadata?.sequence) - taskSequence(right.metadata?.sequence)
        || left.id.localeCompare(right.id))
      .findIndex((candidate) => candidate.id === task.id) + 1;
    return Math.max(configured, occurrence > 0 ? occurrence : configured);
  } catch {
    return configured;
  }
}

export function taskNameForInventory(task: TaskNameInput): string {
  const metadata = task.metadata ?? {};
  const hasReferenceName = typeof metadata.referenceImageName === 'string' && metadata.referenceImageName.trim();
  if (!hasReferenceName) return taskNameBase(task);
  return `${taskNameBase(task)}_${businessDate(task.createdAt)}_${taskNameSequenceFor(task)}`;
}

/** Build a safe display filename from the task name while preserving Unicode. */
export function inventoryFileName(task: TaskNameInput, index: number, extension: string): string {
  const rawName = taskNameForInventory(task);
  const safeName = rawName
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 96)
    .trim() || `task-${task.id}`;
  const normalizedIndex = Math.max(0, Math.round(index));
  // The first output keeps the task name exactly as displayed in the queue.
  // Additional outputs receive a deterministic suffix to avoid same-task
  // filename collisions while preserving the human-readable task name.
  const suffix = normalizedIndex === 0 ? '' : `_${String(normalizedIndex + 1).padStart(2, '0')}`;
  return `${safeName}${suffix}.${extension}`;
}
