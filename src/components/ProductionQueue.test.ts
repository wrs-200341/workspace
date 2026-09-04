import { describe, expect, it } from 'vitest';
import { promptReviewHref, queueStatusLabel, reviewHref } from './ProductionQueue';

describe('production queue navigation', () => {
  it('opens review pages for image and video tasks', () => {
    expect(reviewHref('account/1', 'video', 'task/1')).toBe('/workspace/accounts/account%2F1/production/video-tasks/task%2F1');
    expect(reviewHref('account/1', 'image', 'task/1')).toBe('/workspace/accounts/account%2F1/production/image-tasks/task%2F1');
  });

  it('uses restore configuration for prompt tasks and prompt anchor for media reviews', () => {
    expect(reviewHref('account/1', 'prompt', 'task/1')).toBe('/workspace/accounts/account%2F1/production?mode=prompt&restoreTaskId=task%2F1');
    expect(promptReviewHref('account/1', 'video', 'task/1')).toBe('/workspace/accounts/account%2F1/production/video-tasks/task%2F1#prompt');
  });
});

describe('production queue status labels', () => {
  it('distinguishes local waiting from an upstream provider queue', () => {
    expect(queueStatusLabel({ status: 'queued' })).toBe('本地排队中');
    expect(queueStatusLabel({ status: 'queued', schedulerState: 'provider-active', providerTaskId: 'upstream-1' })).toBe('供应商排队中');
    expect(queueStatusLabel({ status: 'queued', providerTaskId: 'upstream-2' })).toBe('供应商排队中');
  });
});
