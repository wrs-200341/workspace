import { describe, expect, it } from 'vitest';
import { businessDate, filterWorkspaceTasks, isCompletedNotInInventory, isInventorySavedToday, summarizeWorkspaceTasks, type WorkspaceTask } from './tasks';

const now = '2026-09-02T04:00:00.000Z'; // 12:00 Shanghai
const tasks: WorkspaceTask[] = [
  { id: 'saved', accountId: 'a', pid: 'p1', title: 'saved', owner: 'operator', mode: 'video', model: 'grok', status: 'completed', progress: 100, createdAt: '2026-09-02T01:00:00.000Z', inventorySavedAt: '2026-09-02T03:00:00.000Z', outputCount: 2 },
  { id: 'pending', accountId: 'a', pid: 'p2', title: 'pending', owner: 'operator', mode: 'video', model: 'grok', status: 'completed', progress: 100, createdAt: '2026-09-02T02:00:00.000Z' },
  { id: 'old', accountId: 'a', pid: 'p3', title: 'old', owner: 'operator', mode: 'video', model: 'grok', status: 'completed', progress: 100, createdAt: '2026-09-01T02:00:00.000Z' },
  { id: 'running', accountId: 'a', pid: 'p4', title: 'running', owner: 'operator', mode: 'video', model: 'grok', status: 'running', progress: 42, createdAt: '2026-09-02T02:00:00.000Z' },
];

describe('workspace task inventory rules', () => {
  it('uses Shanghai business dates', () => {
    expect(businessDate(now)).toBe('2026-09-02');
    expect(businessDate('2026-09-01T16:30:00.000Z')).toBe('2026-09-02');
  });

  it('counts only inventory timestamps, including multiple outputs', () => {
    expect(isInventorySavedToday(tasks[0], now)).toBe(true);
    expect(isInventorySavedToday(tasks[2], now)).toBe(false);
    expect(summarizeWorkspaceTasks(tasks, now).inventorySavedToday).toBe(1);
  });

  it('does not count completed tasks until inventory is saved', () => {
    expect(isCompletedNotInInventory(tasks[1], now)).toBe(true);
    expect(isCompletedNotInInventory(tasks[2], now)).toBe(false);
    expect(summarizeWorkspaceTasks(tasks, now).completedNotInInventory).toBe(1);
  });

  it('filters without mutating source tasks', () => {
    const filtered = filterWorkspaceTasks(tasks, 'completed');
    expect(filtered).toHaveLength(3);
    expect(filterWorkspaceTasks(tasks, 'all')).not.toBe(tasks);
    expect(tasks).toHaveLength(4);
  });
});
