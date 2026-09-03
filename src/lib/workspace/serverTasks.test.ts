import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockListProviderTasks, mockGetWorkspaceAccountById, mockListStoredAccounts, mockGetWorkspaceTasks } = vi.hoisted(() => ({
  mockListProviderTasks: vi.fn(),
  mockGetWorkspaceAccountById: vi.fn(),
  mockListStoredAccounts: vi.fn(),
  mockGetWorkspaceTasks: vi.fn(),
}));

vi.mock('@/lib/providers/taskStore', () => ({ listProviderTasks: mockListProviderTasks }));
vi.mock('./data', () => ({ getWorkspaceAccountById: mockGetWorkspaceAccountById }));
vi.mock('./accountStore', () => ({ listStoredAccounts: mockListStoredAccounts }));
vi.mock('./tasks', () => ({
  getWorkspaceTasks: mockGetWorkspaceTasks,
  businessDate: (value: string | Date | number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(value)),
}));

import { getServerWorkspaceTasks, providerTaskToWorkspaceTask } from './serverTasks';

function providerTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    accountId: 'workspace-account-1-a',
    mode: 'video',
    provider: 'grok-video',
    model: 'grok-imagine-video-1.5',
    prompt: 'product turntable',
    status: 'queued',
    progress: 0,
    outputUrls: [],
    outputBase64: [],
    createdAt: '2026-09-02T16:30:00.000Z',
    updatedAt: '2026-09-02T16:30:00.000Z',
    ...overrides,
  };
}

describe('server workspace task projection and owner scope', () => {
  beforeEach(() => {
    mockListProviderTasks.mockReset();
    mockGetWorkspaceAccountById.mockReset();
    mockListStoredAccounts.mockReset().mockReturnValue([]);
    mockGetWorkspaceTasks.mockReset().mockReturnValue([]);
  });

  it('titles a task from its first reference filename, Shanghai business date, and sequence number', () => {
    mockGetWorkspaceAccountById.mockReturnValue({ id: 'workspace-account-1-a', ownerId: 'operator-emily', ownerName: 'Emily', name: 'account a' });
    const task = providerTask({
      metadata: { referenceImageName: 'hero.png', sequence: 2 },
      createdAt: '2026-09-02T16:30:00.000Z', // 2026-09-03 in Asia/Shanghai
    });

    expect(providerTaskToWorkspaceTask(task as never)).toMatchObject({
      title: 'hero_2026-09-03_2',
      accountId: 'workspace-account-1-a',
    });
  });

  it('returns all tasks for an operator across their accounts without leaking another operator', () => {
    const accounts = new Map([
      ['workspace-account-1-a', { id: 'workspace-account-1-a', ownerId: 'operator-emily', ownerName: 'Emily', name: 'Emily A' }],
      ['workspace-account-1-b', { id: 'workspace-account-1-b', ownerId: 'operator-emily', ownerName: 'Emily', name: 'Emily B' }],
      ['workspace-account-2-a', { id: 'workspace-account-2-a', ownerId: 'operator-sarah', ownerName: 'Sarah', name: 'Sarah A' }],
    ]);
    mockGetWorkspaceAccountById.mockImplementation((id: string) => accounts.get(id));
    mockListProviderTasks.mockReturnValue([
      providerTask({ id: 'emily-a', accountId: 'workspace-account-1-a' }),
      providerTask({ id: 'emily-b', accountId: 'workspace-account-1-b' }),
      providerTask({ id: 'sarah-a', accountId: 'workspace-account-2-a' }),
    ]);

    const result = getServerWorkspaceTasks({ ownerId: 'operator-emily', mode: 'video' });

    expect(result.map((task) => task.id)).toEqual(['emily-a', 'emily-b']);
    expect(result.every((task) => task.owner === 'operator-emily')).toBe(true);
    expect(mockListProviderTasks).toHaveBeenCalledWith({ accountId: undefined, mode: 'video' });
  });
});
