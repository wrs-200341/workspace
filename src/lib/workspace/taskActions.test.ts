import { describe, expect, it } from 'vitest';
import { applyTaskAction, canDeleteTask } from './taskActions';
import type { WorkspaceTask } from './tasks';

const base: WorkspaceTask = { id: 't', accountId: 'a', pid: 'p', title: 't', owner: 'operator-guoqingqing', mode: 'video', model: 'grok', status: 'failed', progress: 40, createdAt: '2026-09-02T00:00:00.000Z', error: 'timeout' };

describe('workspace task actions', () => {
  it('retries failed work immutably', () => {
    const next = applyTaskAction(base, 'retry');
    expect(next).toMatchObject({ status: 'queued', progress: 0 });
    expect(next).not.toBe(base);
    expect(base.status).toBe('failed');
  });
  it('saves inventory once for completed tasks', () => {
    const saved = applyTaskAction({ ...base, status: 'completed', progress: 100 }, 'save-inventory', new Date('2026-09-02T03:00:00.000Z'));
    expect(saved.inventorySavedAt).toBe('2026-09-02T03:00:00.000Z');
    expect(applyTaskAction(saved, 'save-inventory').inventorySavedAt).toBe(saved.inventorySavedAt);
  });
  it('does not delete active work', () => {
    expect(canDeleteTask('running')).toBe(false);
    expect(canDeleteTask('completed')).toBe(true);
  });

  it('transitions active tasks through pause, resume, and cancel', () => {
    const running = { ...base, status: 'running' as const, progress: 35 };
    const paused = applyTaskAction(running, 'pause');
    expect(paused).toMatchObject({ status: 'paused', progress: 35 });
    expect(applyTaskAction(paused, 'resume')).toMatchObject({ status: 'queued', progress: 35 });
    expect(applyTaskAction(running, 'cancel')).toMatchObject({ status: 'cancelled', progress: 35 });
  });

  it('leaves incompatible actions unchanged', () => {
    const completed = { ...base, status: 'completed' as const, progress: 100 };
    expect(applyTaskAction(completed, 'pause')).toEqual(completed);
    expect(applyTaskAction(completed, 'cancel')).toEqual(completed);
    expect(applyTaskAction(base, 'resume')).toEqual(base);
  });
});
