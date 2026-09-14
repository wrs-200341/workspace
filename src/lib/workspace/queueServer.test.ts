import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ summaries: vi.fn(), fullTasks: vi.fn(), revision: vi.fn(), accounts: vi.fn() }));
vi.mock('@/lib/providers/taskStore', () => ({
  listProviderTaskSummaries: mocks.summaries,
  listProviderTasks: mocks.fullTasks,
  getProviderTaskStoreRevision: mocks.revision,
}));
vi.mock('./accountStore', () => ({ listStoredAccounts: mocks.accounts }));
vi.mock('./data', () => ({ getWorkspaceAccountById: vi.fn() }));

import { getServerWorkspaceQueueDelta } from './serverTasks';

let sequence = 0;
let viewer = '';
const account = { id: 'account-a', ownerId: 'owner-a', name: 'Account A' };
function row(id: string, overrides: Record<string, unknown> = {}) {
  return { id, accountId: 'account-a', mode: 'video', provider: 'grok-video', status: 'completed', progress: 100, createdAt: '2026-09-14T01:00:00.000Z', updatedAt: '2026-09-14T01:00:00.000Z', outputCount: 1, metadata: { ownerId: 'owner-a' }, ...overrides };
}
function read(query = '', overrides: { ownerId?: string; mode?: 'image' | 'video'; date?: string } = {}) {
  return getServerWorkspaceQueueDelta({ ownerId: 'owner-a', mode: 'video', date: '2026-09-14', ...overrides }, { viewer, searchParams: new URLSearchParams(query) });
}

describe('scoped server queue deltas', () => {
  beforeEach(() => {
    viewer = `viewer-${++sequence}`;
    vi.clearAllMocks();
    mocks.accounts.mockReturnValue([account]);
    mocks.summaries.mockReturnValue([row('one'), row('two')]);
    mocks.revision.mockReturnValue(1);
  });

  it('reuses unchanged indexed summaries and never loads full provider tasks', () => {
    const initial = read();
    const unchanged = read(`since=${initial.token}`);
    expect(initial.reset).toBe(true);
    expect(unchanged).toMatchObject({ reset: false, tasks: [], deletedTaskIds: [], token: initial.token });
    expect(mocks.summaries).toHaveBeenCalledTimes(1);
    expect(mocks.summaries).toHaveBeenCalledWith({ accountId: undefined, accountIds: ['account-a'], mode: 'video', createdBusinessDate: '2026-09-14' });
    expect(mocks.fullTasks).not.toHaveBeenCalled();
  });

  it('returns task removals and exact counts after a store revision', () => {
    const initial = read();
    mocks.revision.mockReturnValue(2);
    mocks.summaries.mockReturnValue([row('two', { status: 'failed', error: 'provider_timeout', errorInfo: { safeToRetry: true } })]);
    const delta = read(`since=${initial.token}`);
    expect(delta.reset).toBe(false);
    expect(delta.deletedTaskIds).toEqual(['one']);
    expect(delta.tasks.map((task) => task.id)).toEqual(['two']);
    expect(delta.counts).toMatchObject({ all: 1, failed: 1, completed: 0, unsaved: 0, safeRecoverable: 1 });
  });

  it('resets tokens across dates, owners, modes and authenticated viewers', () => {
    const initial = read();
    expect(read(`since=${initial.token}`, { date: '2026-09-13' }).reset).toBe(true);
    expect(read(`since=${initial.token}`, { mode: 'image' }).reset).toBe(true);
    expect(read(`since=${initial.token}`, { ownerId: 'owner-b' }).reset).toBe(true);
    viewer = 'other-viewer';
    expect(read(`since=${initial.token}`).reset).toBe(true);
  });

  it('invalidates account names and membership independently of task revisions', () => {
    const initial = read();
    mocks.accounts.mockReturnValue([{ ...account, name: 'Renamed' }]);
    const renamed = read(`since=${initial.token}`);
    expect(renamed.tasks.every((task) => task.accountName === 'Renamed')).toBe(true);
    mocks.accounts.mockReturnValue([{ ...account, ownerId: 'owner-b' }]);
    mocks.summaries.mockReturnValue([]);
    const reassigned = read(`since=${renamed.token}`);
    expect(reassigned.deletedTaskIds).toEqual(['one', 'two']);
    expect(reassigned.counts.all).toBe(0);
    expect(mocks.summaries).toHaveBeenLastCalledWith(expect.objectContaining({ accountIds: [] }));
  });

  it('bounds pages while preserving whole-day counts and focus outside the first page', () => {
    mocks.summaries.mockReturnValue(Array.from({ length: 120 }, (_, index) => row(String(index).padStart(3, '0'))));
    const page = read('focusTaskId=115&limit=50');
    expect(page.tasks).toHaveLength(20);
    expect(page.tasks.some((task) => task.id === '115')).toBe(true);
    expect(page).toMatchObject({ page: 2, totalPages: 3, pageSize: 50, counts: { all: 120, completed: 120, unsaved: 120 } });
  });

  it('excludes tasks with a conflicting metadata owner even on an owned account', () => {
    mocks.summaries.mockReturnValue([row('one'), row('other', { metadata: { ownerId: 'owner-b' } })]);
    expect(read().tasks.map((task) => task.id)).toEqual(['one']);
  });
});
