import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIntentPrefetcher } from './intentPrefetch';

describe('intent-only navigation prefetch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not prefetch on creation and waits for a sustained hover', () => {
    const prefetch = vi.fn();
    const scheduler = createIntentPrefetcher(prefetch);
    expect(prefetch).not.toHaveBeenCalled();

    scheduler.schedule('/workspace/accounts/a/production?mode=video');
    vi.advanceTimersByTime(119);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledWith('/workspace/accounts/a/production?mode=video');
  });

  it('cancels a brief pointer pass or focus that has moved elsewhere', () => {
    const prefetch = vi.fn();
    const scheduler = createIntentPrefetcher(prefetch);
    scheduler.schedule('/workspace/accounts/a/assets');
    vi.advanceTimersByTime(100);
    scheduler.cancel('/workspace/accounts/a/assets');
    vi.advanceTimersByTime(100);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('prefetches a focused link without the hover delay', () => {
    const prefetch = vi.fn();
    const scheduler = createIntentPrefetcher(prefetch);
    scheduler.schedule('/workspace', true);
    vi.advanceTimersByTime(0);
    expect(prefetch).toHaveBeenCalledWith('/workspace');
  });

  it('keeps only the latest intended destination instead of queueing every card', () => {
    const prefetch = vi.fn();
    const scheduler = createIntentPrefetcher(prefetch);
    scheduler.schedule('/workspace/accounts/a/assets');
    scheduler.schedule('/workspace/accounts/b/assets');
    scheduler.cancel('/workspace/accounts/a/assets');
    scheduler.schedule('/workspace/accounts/c/assets');
    vi.advanceTimersByTime(120);

    expect(prefetch.mock.calls).toEqual([['/workspace/accounts/c/assets']]);
  });

  it('throttles request launches during rapid focus changes', () => {
    const prefetch = vi.fn();
    const scheduler = createIntentPrefetcher(prefetch);
    scheduler.schedule('/workspace/accounts/a/assets', true);
    vi.advanceTimersByTime(0);
    scheduler.schedule('/workspace/accounts/b/assets', true);
    vi.advanceTimersByTime(200);
    scheduler.schedule('/workspace/accounts/c/assets', true);
    vi.advanceTimersByTime(299);
    expect(prefetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(prefetch.mock.calls).toEqual([['/workspace/accounts/a/assets'], ['/workspace/accounts/c/assets']]);
  });

  it('deduplicates recent routes but allows another request after the short TTL', () => {
    const prefetch = vi.fn();
    const scheduler = createIntentPrefetcher(prefetch);
    scheduler.schedule('/workspace', true);
    vi.advanceTimersByTime(0);
    scheduler.schedule('/workspace', true);
    vi.advanceTimersByTime(500);
    expect(prefetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    scheduler.schedule('/workspace', true);
    vi.advanceTimersByTime(0);
    expect(prefetch).toHaveBeenCalledTimes(2);
  });

  it('bounds the route tracking table to twelve destinations', () => {
    const prefetch = vi.fn();
    const scheduler = createIntentPrefetcher(prefetch);
    for (let index = 0; index < 13; index += 1) {
      scheduler.schedule(`/workspace/accounts/${index}/assets`, true);
      vi.advanceTimersByTime(500);
    }
    scheduler.schedule('/workspace/accounts/12/assets', true);
    vi.advanceTimersByTime(0);
    expect(prefetch).toHaveBeenCalledTimes(13);
    scheduler.schedule('/workspace/accounts/0/assets', true);
    vi.advanceTimersByTime(0);
    expect(prefetch).toHaveBeenCalledTimes(14);
  });

  it('resets pending work and route tracking on owner/auth changes or unmount', () => {
    const prefetch = vi.fn();
    const scheduler = createIntentPrefetcher(prefetch);
    scheduler.schedule('/workspace', true);
    vi.advanceTimersByTime(0);
    scheduler.schedule('/workspace/accounts/a/assets');
    scheduler.reset();
    vi.advanceTimersByTime(1000);
    expect(prefetch.mock.calls).toEqual([['/workspace']]);
    scheduler.schedule('/workspace', true);
    vi.advanceTimersByTime(0);
    expect(prefetch).toHaveBeenCalledTimes(2);
  });

  it('does not share route tracking between authenticated component owners', () => {
    const first = vi.fn();
    const second = vi.fn();
    createIntentPrefetcher(first).schedule('/workspace', true);
    createIntentPrefetcher(second).schedule('/workspace', true);
    vi.advanceTimersByTime(0);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('honors opt-out both when scheduling and immediately before requesting', () => {
    const prefetch = vi.fn();
    let enabled = false;
    const scheduler = createIntentPrefetcher(prefetch, () => enabled);
    scheduler.schedule('/workspace');
    vi.advanceTimersByTime(120);
    expect(prefetch).not.toHaveBeenCalled();
    enabled = true;
    scheduler.schedule('/workspace');
    enabled = false;
    vi.advanceTimersByTime(120);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('only accepts local route paths', () => {
    const prefetch = vi.fn();
    const scheduler = createIntentPrefetcher(prefetch);
    for (const href of ['', 'https://example.test/workspace', '//example.test/workspace', '/\\example.test/workspace', 'javascript:alert(1)']) {
      scheduler.schedule(href, true);
      vi.advanceTimersByTime(0);
    }
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('does not prevent navigation or retain a failed speculative request', () => {
    const prefetch = vi.fn().mockImplementationOnce(() => { throw new Error('router unavailable'); });
    const scheduler = createIntentPrefetcher(prefetch);
    scheduler.schedule('/workspace', true);
    expect(() => vi.advanceTimersByTime(0)).not.toThrow();
    scheduler.schedule('/workspace', true);
    vi.advanceTimersByTime(0);
    expect(prefetch).toHaveBeenCalledTimes(2);
  });
});
