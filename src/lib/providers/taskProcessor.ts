import { getProviderTask, listProviderTasks, updateProviderTask, type ProviderTask, type ProviderTaskStatus } from './taskStore';
import { revokeAssetReference } from '../workspace/referenceBridge';

const MOCK_EXECUTION = 'mock';
const WORKER_NAME = 'workspace-mock-worker';

function isMockTask(task: ProviderTask): boolean {
  const execution = task.metadata && typeof task.metadata.execution === 'string' ? task.metadata.execution : undefined;
  return execution === MOCK_EXECUTION;
}

function isProcessableStatus(status: ProviderTaskStatus): boolean {
  return status === 'draft' || status === 'queued' || status === 'prompting' || status === 'submitting' || status === 'submitted' || status === 'processing' || status === 'running' || status === 'retrying';
}

function patchMetadata(task: ProviderTask, extra: Record<string, unknown>): Record<string, unknown> {
  return { ...(task.metadata ?? {}), ...extra, processedBy: WORKER_NAME };
}

/**
 * Progress one mock task through the same lifecycle states used by live
 * providers. This function never performs network I/O and intentionally does
 * not invent output URLs or media bytes; a completed mock task has zero
 * outputs until a real provider is enabled.
 */
export async function processMockProviderTask(taskId: string): Promise<ProviderTask | null> {
  const task = getProviderTask(taskId);
  if (!task) return null;
  if (!isMockTask(task) || !isProcessableStatus(task.status)) return task;

  let current = task;
  const steps: ReadonlyArray<{ status: ProviderTaskStatus; progress: number }> = [
    { status: 'prompting', progress: 5 },
    { status: 'submitting', progress: 15 },
    { status: 'submitted', progress: 25 },
    { status: 'processing', progress: 60 },
    { status: 'completed', progress: 100 },
  ];
  for (const step of steps) {
    const updated = updateProviderTask(current.id, {
      status: step.status,
      progress: step.progress,
      metadata: patchMetadata(current, {
        workerState: step.status,
        ...(step.status === 'completed' ? { processedAt: new Date().toISOString(), referencesCleanedAt: new Date().toISOString() } : {}),
      }),
      ...(step.status === 'completed' ? { error: undefined } : {}),
    });
    if (!updated) return null;
    current = updated;
    if (step.status === 'completed') {
      const tokens = Array.isArray(current.metadata?.referenceTokens)
        ? current.metadata.referenceTokens.filter((token): token is string => typeof token === 'string')
        : [];
      tokens.forEach((token) => revokeAssetReference(token));
    }
  }
  return current;
}

/** Process every queued mock task. Live and paused tasks are left untouched. */
export async function processMockProviderTasks(): Promise<ProviderTask[]> {
  const pending = listProviderTasks().filter((task) => isMockTask(task) && isProcessableStatus(task.status));
  const processed: ProviderTask[] = [];
  for (const task of pending) {
    const result = await processMockProviderTask(task.id);
    if (result && result.status === 'completed') processed.push(result);
  }
  return processed;
}
