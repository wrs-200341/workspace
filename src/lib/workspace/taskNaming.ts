export type TaskNameMode = 'auto' | 'manual';

/** Parse the optional task naming mode without trusting an arbitrary value. */
export function parseTaskNameMode(value: unknown): TaskNameMode | undefined {
  return value === 'auto' || value === 'manual' ? value : undefined;
}

/** Keep a user supplied name bounded before it is persisted in task metadata. */
export function normalizeTaskName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 120) : undefined;
}

/**
 * Validate the explicit naming contract used by image/video production.
 * Returning a stable error id keeps API and client validation consistent.
 * A missing mode is intentionally accepted for old API clients.
 */
export function validateTaskNaming(mode: TaskNameMode | undefined, name: string | undefined, referenceImageCount: number): string | undefined {
  if (!mode) return undefined;
  if (mode === 'manual' && !name) return 'task_name_required';
  if (mode === 'auto' && referenceImageCount < 1) return 'task_name_reference_required';
  return undefined;
}
