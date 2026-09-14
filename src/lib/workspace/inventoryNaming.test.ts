import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockListProviderTaskSummaries } = vi.hoisted(() => ({ mockListProviderTaskSummaries: vi.fn() }));
vi.mock('@/lib/providers/taskStore', () => ({ listProviderTaskSummaries: mockListProviderTaskSummaries }));

import { inventoryFileName, taskNameForInventory } from './inventoryNaming';

const first = {
  id: 'task-1', accountId: 'account-1', mode: 'image' as const, prompt: 'ignored prompt',
  createdAt: '2026-09-03T01:00:00.000Z', metadata: { referenceImageName: '1734636212522550693-3.png', sequence: 1 },
};
const second = { ...first, id: 'task-2', createdAt: '2026-09-03T02:00:00.000Z', metadata: { ...first.metadata, sequence: 1 } };

describe('inventory task naming', () => {
  beforeEach(() => mockListProviderTaskSummaries.mockReset().mockReturnValue([first, second]));

  it('continues the occurrence number for repeated task names on the same day', () => {
    expect(taskNameForInventory(first)).toBe('1734636212522550693-3_2026-09-03_1');
    expect(taskNameForInventory(second)).toBe('1734636212522550693-3_2026-09-03_2');
    expect(mockListProviderTaskSummaries).toHaveBeenLastCalledWith({ accountId: 'account-1', mode: 'image', createdBusinessDate: '2026-09-03' });
  });

  it('keeps a prompt-only task name aligned with the queue title', () => {
    expect(taskNameForInventory({ ...first, metadata: {}, prompt: 'product' })).toBe('product');
  });

  it('uses the resolved task name for inventory files', () => {
    expect(inventoryFileName(second, 0, 'png')).toBe('1734636212522550693-3_2026-09-03_2.png');
    expect(inventoryFileName(second, 1, 'png')).toBe('1734636212522550693-3_2026-09-03_2_02.png');
  });

  it('adds the date and sequence to manually named tasks without references', () => {
    const manual = { ...first, id: 'manual-1', prompt: 'ignored', metadata: { taskNameMode: 'manual', taskName: 'Summer launch', sequence: 1 } };
    expect(taskNameForInventory(manual, 1)).toBe('Summer launch_2026-09-03_1');
  });

  it('uses the manual name as the grouping key for repeated submissions', () => {
    const manual = { ...first, id: 'manual-1', metadata: { taskNameMode: 'manual', taskName: 'Summer launch', sequence: 1 } };
    expect(taskNameForInventory(manual)).toBe('Summer launch_2026-09-03_1');
  });
});
