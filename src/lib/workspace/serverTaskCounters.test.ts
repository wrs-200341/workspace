import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderTaskSummary } from '@/lib/providers/taskStore';

const mocks = vi.hoisted(() => ({
  summaries: vi.fn(),
  fullTasks: vi.fn(),
  revision: vi.fn(),
  accounts: vi.fn(),
  accountById: vi.fn(),
}));
vi.mock('@/lib/providers/taskStore', () => ({
  listProviderTaskSummaries: mocks.summaries,
  listProviderTasks: mocks.fullTasks,
  getProviderTaskStoreRevision: mocks.revision,
  getProviderTaskCounterAggregates: undefined,
}));
vi.mock('./accountStore', () => ({ listStoredAccounts: mocks.accounts }));
vi.mock('./data', () => ({ getWorkspaceAccountById: mocks.accountById }));

import { getServerWorkspaceTaskCounters, type WorkspaceOwnerTaskCounters } from './serverTasks';

const NOW = '2026-09-14T04:00:00.000Z';
const YESTERDAY = '2026-09-13T04:00:00.000Z';
const accountA = { id: 'account-a', ownerId: 'owner-a', name: 'Account A' };
const accountB = { id: 'account-b', ownerId: 'owner-a', name: 'Account B' };
const accountC = { id: 'account-c', ownerId: 'owner-b', name: 'Account C' };
let revision = 0;
let rows: ProviderTaskSummary[] = [];

function row(id: string, overrides: Partial<ProviderTaskSummary> = {}): ProviderTaskSummary {
  return {
    id,
    accountId: accountA.id,
    mode: 'video',
    provider: 'grok-video',
    status: 'completed',
    progress: 100,
    createdAt: NOW,
    updatedAt: NOW,
    outputCount: 1,
    ...overrides,
  };
}

function counters(overrides: Partial<WorkspaceOwnerTaskCounters> = {}): WorkspaceOwnerTaskCounters {
  return {
    inventorySavedToday: 0,
    completedNotInInventory: 0,
    running: 0,
    queued: 0,
    failed: 0,
    ...overrides,
  };
}

type Filters = Parameters<typeof getServerWorkspaceTaskCounters>[0];
function read(filters: Filters = {}, now: Date | string | number = NOW) {
  return getServerWorkspaceTaskCounters(filters, now);
}

describe('server workspace task counter cache', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // The production module cache intentionally survives between test cases.
    revision += 100;
    rows = [row('one')];
    mocks.revision.mockImplementation(() => revision);
    mocks.accounts.mockReturnValue([accountA, accountB, accountC]);
    mocks.summaries.mockImplementation((filters: {
      accountId?: string;
      accountIds?: readonly string[];
      mode?: ProviderTaskSummary['mode'];
    } = {}) => rows.filter((task) => (
      (!filters.accountId || task.accountId === filters.accountId)
      && (!filters.accountIds || filters.accountIds.includes(task.accountId))
      && (!filters.mode || task.mode === filters.mode)
    )));
  });

  it('reuses unchanged counters within one Shanghai business day without loading full tasks', () => {
    const initial = read({ ownerId: 'owner-a' });
    const unchanged = read({ ownerId: 'owner-a' }, '2026-09-14T15:59:59.999Z');

    expect(initial).toEqual({ 'owner-a': counters({ completedNotInInventory: 1 }) });
    expect(unchanged).toEqual(initial);
    expect(mocks.summaries).toHaveBeenCalledTimes(1);
    expect(mocks.summaries).toHaveBeenCalledWith({ accountId: undefined, mode: undefined });
    expect(mocks.fullTasks).not.toHaveBeenCalled();
  });

  it('invalidates on task updates and deletions when the store revision changes', () => {
    rows = [row('one', { status: 'queued', outputCount: 0 })];
    expect(read()).toEqual({ 'owner-a': counters({ queued: 1 }) });

    revision += 1;
    rows = [row('one')];
    expect(read()).toEqual({ 'owner-a': counters({ completedNotInInventory: 1 }) });

    revision += 1;
    rows = [];
    expect(read()).toEqual({});
    expect(read()).toEqual({});
    expect(mocks.summaries).toHaveBeenCalledTimes(3);
  });

  it('invalidates exactly at Shanghai midnight without a task revision change', () => {
    rows = [
      row('saved', { createdAt: YESTERDAY, inventorySavedAt: NOW }),
      row('unsaved'),
    ];

    expect(read({}, '2026-09-14T15:59:59.999Z')).toEqual({
      'owner-a': counters({ inventorySavedToday: 1, completedNotInInventory: 1 }),
    });
    expect(read({}, '2026-09-14T16:00:00.000Z')).toEqual({ 'owner-a': counters() });
    expect(read({}, '2026-09-15T01:00:00.000Z')).toEqual({ 'owner-a': counters() });
    expect(mocks.summaries).toHaveBeenCalledTimes(2);
  });

  it('keeps owner, account, and mode scopes separate and reuses each cached scope', () => {
    rows = [
      row('a-video', { status: 'running' }),
      row('a-image', { mode: 'image', status: 'queued' }),
      row('b-video', { accountId: accountB.id, status: 'failed' }),
      row('c-video', { accountId: accountC.id, status: 'retrying' }),
      row('c-prompt', { accountId: accountC.id, mode: 'prompt' }),
    ];
    const cases: Array<{ filters: Filters; expected: Record<string, WorkspaceOwnerTaskCounters> }> = [
      { filters: {}, expected: {
        'owner-a': counters({ running: 1, queued: 1, failed: 1 }),
        'owner-b': counters({ running: 1, queued: 1, completedNotInInventory: 1 }),
      } },
      { filters: { ownerId: 'owner-a' }, expected: { 'owner-a': counters({ running: 1, queued: 1, failed: 1 }) } },
      { filters: { ownerId: 'owner-b' }, expected: { 'owner-b': counters({ running: 1, queued: 1, completedNotInInventory: 1 }) } },
      { filters: { accountId: accountA.id }, expected: { 'owner-a': counters({ running: 1, queued: 1 }) } },
      { filters: { accountId: accountB.id }, expected: { 'owner-a': counters({ failed: 1 }) } },
      { filters: { mode: 'image' }, expected: { 'owner-a': counters({ queued: 1 }) } },
      { filters: { mode: 'prompt' }, expected: { 'owner-b': counters({ completedNotInInventory: 1 }) } },
      { filters: { ownerId: 'owner-b', accountId: accountC.id, mode: 'video' }, expected: { 'owner-b': counters({ running: 1, queued: 1 }) } },
      { filters: { ownerId: 'owner-a', accountId: accountC.id, mode: 'video' }, expected: {} },
    ];

    for (const { filters, expected } of cases) expect(read(filters)).toEqual(expected);
    for (const { filters, expected } of [...cases].reverse()) expect(read(filters)).toEqual(expected);
    expect(mocks.summaries).toHaveBeenCalledTimes(cases.length);
  });

  it('invalidates fallback owner attribution after account reassignment at the same task revision', () => {
    expect(read({ ownerId: 'owner-a' })).toEqual({ 'owner-a': counters({ completedNotInInventory: 1 }) });
    expect(read({ ownerId: 'owner-b' })).toEqual({});

    mocks.accounts.mockReturnValue([{ ...accountA, ownerId: 'owner-b' }, accountB, accountC]);

    expect(read({ ownerId: 'owner-a' })).toEqual({});
    expect(read({ ownerId: 'owner-b' })).toEqual({ 'owner-b': counters({ completedNotInInventory: 1 }) });
    expect(mocks.summaries).toHaveBeenCalledTimes(4);
  });

  it('preserves metadata owner attribution for conflicting and missing accounts', () => {
    rows = [
      row('conflicting', { accountId: accountC.id, metadata: { ownerId: 'owner-a' } }),
      row('orphan', { accountId: 'missing-account', metadata: { ownerId: 'owner-a' } }),
      row('other-owner', { metadata: { ownerId: 'owner-b' } }),
      row('unassigned', { accountId: 'missing-account', metadata: {} }),
    ];

    expect(read({ ownerId: 'owner-a' })).toEqual({ 'owner-a': counters({ completedNotInInventory: 2 }) });
    expect(read({ ownerId: 'owner-b' })).toEqual({ 'owner-b': counters({ completedNotInInventory: 1 }) });
    expect(read({ ownerId: 'operator-unassigned' })).toEqual({
      'operator-unassigned': counters({ completedNotInInventory: 1 }),
    });
    expect(mocks.summaries).toHaveBeenNthCalledWith(1, { accountId: undefined, mode: undefined });
  });

  it('uses the legacy account lookup when a task account is absent from stored accounts', () => {
    rows = [row('legacy', { accountId: 'legacy-account' })];
    mocks.accountById.mockImplementation((id: string) => id === 'legacy-account'
      ? { ...accountA, id: 'legacy-account', ownerId: 'legacy-owner' }
      : undefined);

    expect(read({ ownerId: 'legacy-owner' })).toEqual({
      'legacy-owner': counters({ completedNotInInventory: 1 }),
    });
    expect(mocks.accountById).toHaveBeenCalledWith('legacy-account');
  });

  it('returns defensive copies both when populating and when hitting the cache', () => {
    const initial = read();
    initial['owner-a'].completedNotInInventory = 99;
    initial.injected = counters({ failed: 99 });

    const second = read();
    expect(second).toEqual({ 'owner-a': counters({ completedNotInInventory: 1 }) });
    expect(second).not.toBe(initial);
    expect(second['owner-a']).not.toBe(initial['owner-a']);
    second['owner-a'].running = 99;
    delete second['owner-a'];

    expect(read()).toEqual({ 'owner-a': counters({ completedNotInInventory: 1 }) });
    expect(mocks.summaries).toHaveBeenCalledTimes(1);
  });

  it('preserves exact task-level totals for active states, saved outputs, and current-day unsaved completions', () => {
    rows = [
      ...(['running', 'processing', 'submitting', 'submitted', 'prompting', 'retrying'] as const)
        .map((status) => row(status, { status, createdAt: YESTERDAY, outputCount: 0 })),
      row('queued', { status: 'queued', createdAt: YESTERDAY, outputCount: 0 }),
      row('failed', { status: 'failed', createdAt: YESTERDAY, outputCount: 0 }),
      row('old-saved-today', { createdAt: YESTERDAY, inventorySavedAt: NOW, outputCount: 8 }),
      row('cancelled-saved-today', { status: 'cancelled', inventorySavedAt: NOW, outputCount: 3 }),
      row('completed-today-1', { outputCount: 2 }),
      row('completed-today-2', { outputCount: 5 }),
      row('old-unsaved', { createdAt: YESTERDAY }),
      row('saved-yesterday', { inventorySavedAt: YESTERDAY }),
      row('completed-no-outputs', { outputCount: 0 }),
      row('saved-no-outputs', { inventorySavedAt: NOW, outputCount: 0 }),
      row('draft', { status: 'draft' }),
      row('paused', { status: 'paused' }),
    ];

    expect(read()).toEqual({
      'owner-a': counters({ inventorySavedToday: 2, completedNotInInventory: 2, running: 6, queued: 2, failed: 1 }),
    });
  });

  it('evicts the least recently used scope after 32 cached entries', () => {
    for (let index = 0; index < 32; index += 1) read({ accountId: `cache-account-${index}` });
    expect(mocks.summaries).toHaveBeenCalledTimes(32);

    read({ accountId: 'cache-account-0' });
    expect(mocks.summaries).toHaveBeenCalledTimes(32);
    read({ accountId: 'cache-account-32' });
    expect(mocks.summaries).toHaveBeenCalledTimes(33);

    read({ accountId: 'cache-account-0' });
    read({ accountId: 'cache-account-2' });
    expect(mocks.summaries).toHaveBeenCalledTimes(33);
    read({ accountId: 'cache-account-1' });
    expect(mocks.summaries).toHaveBeenCalledTimes(34);
  });
});
