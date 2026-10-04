import { describe, expect, it, vi } from 'vitest';
import { createQueueDeltaCache, createQueuePage, mergeQueueDelta, type QueueRow } from './queueProtocol';

type Task = QueueRow & { progress?: number };

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, status: 'queued', mode: 'video', createdAt: '2026-09-14T00:00:00.000Z', ...overrides };
}

describe('createQueuePage', () => {
  it('sorts newest first with deterministic ID ties without mutating the input', () => {
    const tasks = [task('b'), task('new', { createdAt: '2026-09-14T01:00:00.000Z' }), task('a')];
    expect(createQueuePage(tasks, {}).tasks.map((row) => row.id)).toEqual(['new', 'a', 'b']);
    expect(tasks.map((row) => row.id)).toEqual(['b', 'new', 'a']);
  });

  it('counts completed images and videos awaiting inventory across tabs', () => {
    const tasks = [
      task('draft', { status: 'draft' }), task('paused', { status: 'paused' }), task('running', { status: 'running' }),
      task('unsaved', { status: 'completed' }),
      task('saved', { status: 'completed', inventorySavedAt: '2026-09-14T01:00:00.000Z' }),
      task('image', { status: 'completed', mode: 'image' }),
      task('prompt', { status: 'completed', mode: 'prompt' }),
      task('unknown-mode', { status: 'completed', mode: undefined }),
      task('recoverable', { status: 'failed', errorInfo: { safeToRetry: true } }),
      task('failed', { status: 'failed', errorInfo: { safeToRetry: false } }),
      task('cancelled', { status: 'cancelled', errorInfo: { safeToRetry: true } }),
    ];
    const result = createQueuePage(tasks, { tab: 'active', pageSize: 1 });
    expect(result.counts).toEqual({ all: 11, active: 3, completed: 5, failed: 2, unsaved: 2, safeRecoverable: 1 });
    expect(result.tasks.map((row) => row.id)).toEqual(['draft']);
    expect(result.totalPages).toBe(3);
    expect(createQueuePage(tasks, { tab: 'completed' }).tasks).toHaveLength(5);
    expect(createQueuePage(tasks, { tab: 'failed' }).tasks.map((row) => row.id)).toEqual(['failed', 'recoverable']);
  });

  it('clamps zero-based pages and page sizes, including empty scopes', () => {
    const tasks = Array.from({ length: 105 }, (_, i) => task(String(i).padStart(3, '0')));
    expect(createQueuePage(tasks, {}).tasks).toHaveLength(50);
    expect(createQueuePage(tasks, { page: 999, pageSize: 1000 })).toMatchObject({ page: 1, pageSize: 100, totalPages: 2 });
    expect(createQueuePage(tasks, { page: -10, pageSize: 0 })).toMatchObject({ page: 0, pageSize: 1, totalPages: 105 });
    expect(createQueuePage(tasks, { page: 1.9, pageSize: 2.9 })).toMatchObject({ page: 1, pageSize: 2 });
    expect(createQueuePage(tasks, { page: Number.NaN, pageSize: Number.NaN })).toMatchObject({ page: 0, pageSize: 50 });
    expect(createQueuePage([], { page: 999 })).toMatchObject({ tasks: [], page: 0, totalPages: 1 });
  });

  it('focuses tasks or the first unsaved video within the selected tab', () => {
    const tasks = [
      task('a'), task('b', { status: 'completed', mode: 'image', inventorySavedAt: '2026-09-14T01:00:00.000Z' }), task('c'),
      task('d', { status: 'completed' }), task('e', { status: 'completed' }),
    ];
    expect(createQueuePage(tasks, { pageSize: 2, focusTaskId: 'e' })).toMatchObject({ page: 2, tasks: [tasks[4]] });
    expect(createQueuePage(tasks, { pageSize: 2, focusUnstored: true })).toMatchObject({ page: 1, tasks: [tasks[2], tasks[3]] });
    expect(createQueuePage(tasks, { tab: 'active', pageSize: 1, focusTaskId: 'e' })).toMatchObject({ page: 0, tasks: [tasks[0]] });
    expect(createQueuePage(tasks, { pageSize: 2, focusTaskId: 'a', focusUnstored: true }).page).toBe(0);
    expect(createQueuePage(tasks, { pageSize: 2, page: 1, focusTaskId: 'missing' }).page).toBe(1);
  });

  it('locates an unsaved image outside the first page and ignores saved images and prompts', () => {
    const tasks = Array.from({ length: 51 }, (_, index) => task(`new-${index}`, { mode: 'image', status: 'completed', inventorySavedAt: '2026-09-14T01:00:00.000Z', createdAt: `2026-09-14T${String(23 - Math.floor(index / 3)).padStart(2, '0')}:${String((index % 3) * 10).padStart(2, '0')}:00.000Z` }));
    tasks.push(task('unsaved-image', { mode: 'image', status: 'completed', createdAt: '2026-09-13T00:00:00.000Z' }));
    tasks.push(task('unsaved-prompt', { mode: 'prompt', status: 'completed', createdAt: '2026-09-12T00:00:00.000Z' }));
    const result = createQueuePage(tasks, { focusUnstored: true, pageSize: 50 });
    expect(result.counts.unsaved).toBe(1);
    expect(result.page).toBe(1);
    expect(result.tasks.map((row) => row.id)).toContain('unsaved-image');
  });
});

describe('createQueueDeltaCache', () => {
  it('reuses matching scope and revision without loading or sending unchanged rows', () => {
    const cache = createQueueDeltaCache<Task>();
    const load = vi.fn(() => createQueuePage([task('a')], {}));
    const first = cache.read({ scope: 'account/video/0', revision: 1, load });
    expect(first).toMatchObject({ reset: true, tasks: [task('a')], deletedTaskIds: [] });
    expect(first.token).toMatch(/^[0-9a-f-]{36}$/);
    const second = cache.read({ scope: 'account/video/0', revision: 1, since: first.token, load });
    expect(second).toMatchObject({ reset: false, tasks: [], deletedTaskIds: [], token: first.token });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('sends changed and added rows with deletions, and retains full updated counts', () => {
    const cache = createQueueDeltaCache<Task>();
    const first = cache.read({ scope: 's', revision: 1, load: () => createQueuePage([task('a'), task('b'), task('c')], {}) });
    const changed = task('b', { status: 'completed', progress: 100 });
    const second = cache.read({ scope: 's', revision: 2, since: first.token, load: () => createQueuePage([task('a'), changed, task('d')], {}) });
    expect(second).toMatchObject({ reset: false, tasks: [changed, task('d')], deletedTaskIds: ['c'] });
    expect(second.counts).toMatchObject({ all: 3, active: 2, completed: 1, unsaved: 1 });
  });

  it('removes rows displaced from the requested page even when they still exist in the scope', () => {
    const cache = createQueueDeltaCache<Task>();
    const first = cache.read({ scope: 's', revision: 1, load: () => createQueuePage([task('b'), task('c')], { pageSize: 2 }) });
    const second = cache.read({ scope: 's', revision: 2, since: first.token, load: () => createQueuePage([task('a'), task('b'), task('c')], { pageSize: 2 }) });
    expect(second).toMatchObject({ tasks: [task('a')], deletedTaskIds: ['c'], totalPages: 2 });
  });

  it('resets missing, unknown and cross-scope tokens even when the current revision is cached', () => {
    const cache = createQueueDeltaCache<Task>();
    const load = vi.fn(() => createQueuePage([task('a')], {}));
    const first = cache.read({ scope: 's', revision: 1, load });
    for (const since of [undefined, 'unknown']) {
      expect(cache.read({ scope: 's', revision: 1, since, load })).toMatchObject({ reset: true, tasks: [task('a')] });
    }
    expect(cache.read({ scope: 'other-account', revision: 1, since: first.token, load })).toMatchObject({ reset: true, tasks: [task('a')] });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reports no row changes when only counts or the revision change', () => {
    const cache = createQueueDeltaCache<Task>();
    const first = cache.read({ scope: 's', revision: 1, load: () => createQueuePage([task('a')], { pageSize: 1 }) });
    const second = cache.read({ scope: 's', revision: 2, since: first.token, load: () => createQueuePage([task('a'), task('b')], { pageSize: 1 }) });
    expect(second).toMatchObject({ reset: false, tasks: [], deletedTaskIds: [], totalPages: 2 });
    expect(second.counts.all).toBe(2);
    const third = cache.read({ scope: 's', revision: 3, since: second.token, load: () => createQueuePage([task('a'), task('b')], { pageSize: 1 }) });
    expect(third).toMatchObject({ reset: false, tasks: [], deletedTaskIds: [] });
  });

  it('compares saved row fingerprints when loader rows were changed in place', () => {
    const cache = createQueueDeltaCache<Task>();
    const row = task('a', { progress: 1 });
    const load = () => createQueuePage([row], {});
    const first = cache.read({ scope: 's', revision: 1, load });
    row.progress = 2;
    const second = cache.read({ scope: 's', revision: 2, since: first.token, load });
    expect(second.tasks).toEqual([task('a', { progress: 2 })]);
  });

  it('expires snapshots at the TTL boundary and reloads unchanged revisions', () => {
    let time = 1000;
    const cache = createQueueDeltaCache<Task>({ now: () => time, ttlMs: 100 });
    const load = vi.fn(() => createQueuePage([task('a')], {}));
    const first = cache.read({ scope: 's', revision: 1, load });
    time = 1099;
    expect(cache.read({ scope: 's', revision: 1, since: first.token, load }).reset).toBe(false);
    time = 1100;
    expect(cache.read({ scope: 's', revision: 1, since: first.token, load }).reset).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('bounds snapshots globally and evicts the least recently used snapshot', () => {
    const cache = createQueueDeltaCache<Task>({ maxSnapshots: 2 });
    const load = vi.fn(() => createQueuePage([task('a')], {}));
    const first = cache.read({ scope: 'first', revision: 1, load });
    const second = cache.read({ scope: 'second', revision: 1, load });
    cache.read({ scope: 'first', revision: 1, since: first.token, load });
    cache.read({ scope: 'third', revision: 1, load });
    expect(cache.read({ scope: 'first', revision: 1, since: first.token, load }).reset).toBe(false);
    expect(cache.read({ scope: 'second', revision: 1, since: second.token, load }).reset).toBe(true);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('resets an evicted baseline on a cache hit so stale client rows can be removed', () => {
    const cache = createQueueDeltaCache<Task>({ maxSnapshots: 1 });
    const first = cache.read({ scope: 's', revision: 1, load: () => createQueuePage([task('a'), task('b')], {}) });
    const second = cache.read({ scope: 's', revision: 2, since: first.token, load: () => createQueuePage([task('b')], {}) });
    expect(second).toMatchObject({ reset: false, deletedTaskIds: ['a'] });
    const load = vi.fn(() => createQueuePage([], {}));
    const third = cache.read({ scope: 's', revision: 2, since: first.token, load });
    expect(third).toMatchObject({ reset: true, tasks: [task('b')] });
    expect(mergeQueueDelta(first.tasks, third)).toEqual([task('b')]);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('mergeQueueDelta', () => {
  it('preserves the array and row identities for unchanged deltas and resets', () => {
    const cache = createQueueDeltaCache<Task>();
    const first = cache.read({ scope: 's', revision: 1, load: () => createQueuePage([task('a'), task('b')], {}) });
    const previous = mergeQueueDelta([], first);
    const unchanged = cache.read({ scope: 's', revision: 1, since: first.token, load: () => createQueuePage([], {}) });
    expect(mergeQueueDelta(previous, unchanged)).toBe(previous);
    const reset = cache.read({ scope: 's', revision: 2, load: () => createQueuePage([task('a'), task('b')], {}) });
    expect(mergeQueueDelta(previous, reset)).toBe(previous);
  });

  it('applies additions, changes, deletions and sorting while reusing identical rows', () => {
    const cache = createQueueDeltaCache<Task>();
    const first = cache.read({ scope: 's', revision: 1, load: () => createQueuePage([task('a'), task('b'), task('c')], {}) });
    const previous = mergeQueueDelta([], first);
    const changed = task('b', { progress: 50 });
    const newest = task('d', { createdAt: '2026-09-14T02:00:00.000Z' });
    const delta = cache.read({ scope: 's', revision: 2, since: first.token, load: () => createQueuePage([task('a'), changed, newest], {}) });
    const merged = mergeQueueDelta(previous, delta);
    expect(merged.map((row) => row.id)).toEqual(['d', 'a', 'b']);
    expect(merged[1]).toBe(previous[0]);
    expect(merged[2]).toBe(changed);
    expect(previous.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('resets to exactly the incoming page and preserves surviving identical rows', () => {
    const previous = [task('a'), task('b')];
    const cache = createQueueDeltaCache<Task>();
    const reset = cache.read({ scope: 's', revision: 1, load: () => createQueuePage([task('b')], {}) });
    const merged = mergeQueueDelta(previous, reset);
    expect(merged).toEqual([task('b')]);
    expect(merged[0]).toBe(previous[1]);
    const empty = cache.read({ scope: 'empty', revision: 1, load: () => createQueuePage([], {}) });
    expect(mergeQueueDelta(previous, empty)).toEqual([]);
  });
});
