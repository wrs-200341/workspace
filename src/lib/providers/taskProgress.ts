import type { ProviderTaskStatus } from './taskStore';

type TaskProgressInput = {
  mode?: 'video' | 'image' | 'prompt' | string;
  status: ProviderTaskStatus | string;
  progress?: number;
  providerTaskId?: string;
  schedulerState?: string;
  promptGenerationPending?: boolean;
  localOutputReady?: boolean;
  localOutputPending?: boolean;
};

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Map provider/scheduler phases to a stable progress contract for video jobs.
 * Provider-specific percentages are intentionally kept inside the generation
 * band so queue progress does not jump backwards when an upstream API reports
 * a different scale.
 */
export function canonicalTaskProgress(input: TaskProgressInput): number {
  const raw = Number.isFinite(input.progress) ? Number(input.progress) : 0;
  if (input.mode !== 'video') return clamp(raw);

  if (input.status === 'failed' || input.status === 'cancelled') return 100;
  // `completed` is a terminal provider state. A missing/late local-cache
  // marker must not make an already completed task look unfinished in the
  // queue; cache recovery is represented by the `processing` state instead.
  if (input.status === 'completed') return 100;
  if (input.localOutputPending === true) return 95;
  if (input.status === 'prompting' || input.promptGenerationPending === true) return Math.max(10, Math.min(20, raw || 10));
  if (input.status === 'retrying') return 5;
  if (input.status === 'submitting') return 30;
  if (input.status === 'submitted') return 40;
  if (input.status === 'queued') {
    return input.providerTaskId || input.schedulerState === 'provider-active' ? 35 : 0;
  }
  if (input.status === 'processing' || input.status === 'running') {
    // A provider percentage of 0 means “accepted but not started”. Keep it
    // visibly in the generation phase instead of showing an apparent reset.
    return Math.max(70, Math.min(89, raw > 0 ? 70 + Math.round(raw * 0.19) : 70));
  }
  if (input.status === 'paused') return Math.max(0, Math.min(89, raw));
  return clamp(raw);
}
