import { describe, expect, it } from 'vitest';
import { canonicalTaskProgress } from './taskProgress';

describe('canonical video task progress', () => {
  it('keeps local waiting at zero and provider queue at the submission band', () => {
    expect(canonicalTaskProgress({ mode: 'video', status: 'queued' })).toBe(0);
    expect(canonicalTaskProgress({ mode: 'video', status: 'queued', providerTaskId: 'upstream-1' })).toBe(35);
  });

  it('uses distinct prompt, submit, generation, and local-cache bands', () => {
    expect(canonicalTaskProgress({ mode: 'video', status: 'prompting', progress: 2 })).toBe(10);
    expect(canonicalTaskProgress({ mode: 'video', status: 'submitting', progress: 5 })).toBe(30);
    expect(canonicalTaskProgress({ mode: 'video', status: 'processing', progress: 0 })).toBe(70);
    expect(canonicalTaskProgress({ mode: 'video', status: 'processing', localOutputPending: true })).toBe(95);
    expect(canonicalTaskProgress({ mode: 'video', status: 'completed', localOutputPending: true })).toBe(100);
    expect(canonicalTaskProgress({ mode: 'video', status: 'completed', localOutputReady: true })).toBe(100);
  });

  it('normalizes terminal failures to a completed progress bar', () => {
    expect(canonicalTaskProgress({ mode: 'video', status: 'failed', progress: 42 })).toBe(100);
  });
});
