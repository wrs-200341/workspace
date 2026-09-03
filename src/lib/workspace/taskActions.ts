import type { WorkspaceTask, WorkspaceTaskStatus } from './tasks';

export type TaskAction = 'retry' | 'cancel' | 'save-inventory' | 'pause' | 'resume';

export function applyTaskAction(task: WorkspaceTask, action: TaskAction, now = new Date()): WorkspaceTask {
  const next: WorkspaceTask = { ...task };
  if (action === 'retry' && (task.status === 'failed' || task.status === 'cancelled')) {
    return { ...next, status: 'queued', progress: 0, error: undefined, providerTaskId: undefined, outputUrls: undefined, outputBase64: undefined };
  }
  if (action === 'cancel' && ['queued', 'prompting', 'submitting', 'submitted', 'processing', 'running', 'paused'].includes(task.status)) {
    return { ...next, status: 'cancelled' };
  }
  if (action === 'pause' && ['queued', 'prompting', 'submitting', 'submitted', 'processing', 'running'].includes(task.status)) {
    return { ...next, status: 'paused' };
  }
  if (action === 'resume' && task.status === 'paused') {
    return { ...next, status: 'queued' };
  }
  if (action === 'save-inventory' && task.status === 'completed' && !task.inventorySavedAt) {
    return { ...next, inventorySavedAt: now.toISOString() };
  }
  return next;
}

export function canDeleteTask(status: WorkspaceTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
