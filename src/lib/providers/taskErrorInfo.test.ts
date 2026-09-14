import { describe, expect, it } from 'vitest';
import { classifyTaskError } from './taskErrorInfo';

describe('task error classification', () => {
  it('identifies a prompt task interrupted by a service restart as safe', () => {
    const info = classifyTaskError({
      mode: 'video',
      error: 'prompt_provider_failed',
      providerResponse: undefined,
      providerTaskId: undefined,
      metadata: { promptGenerationPending: true, schedulerInterruptedAt: '2026-09-09T12:00:00.000Z' },
    });
    expect(info).toMatchObject({ code: 'scheduler_prompt_interrupted', category: 'service_restart', safeToRetry: true });
  });

  it('does not mark an unknown submission timeout safe when a provider id exists', () => {
    const info = classifyTaskError({
      mode: 'video',
      error: 'provider_408',
      providerResponse: { endpoint: 'https://supplier.example/v1/videos' },
      providerTaskId: 'upstream-123',
      metadata: {},
    });
    expect(info).toMatchObject({ category: 'provider_timeout', safeToRetry: false });
  });

  it('explains a deterministic request rejection without suggesting blind retry', () => {
    const info = classifyTaskError({
      mode: 'video',
      error: 'provider_400',
      providerResponse: { rawBody: 'prompt accepts at most 2999 characters' },
      providerTaskId: undefined,
      metadata: {},
    });
    expect(info).toMatchObject({ category: 'invalid_request', safeToRetry: false });
  });

  it('names the supplier when an upstream quota response is available', () => {
    const info = classifyTaskError({
      mode: 'video',
      provider: 'grok-video',
      model: 'grok-imagine-video-1.5',
      error: 'provider_upstream_failed',
      providerResponse: { body: { error: { message: 'Client Key 限定范围中的可用账号额度等待恢复' } } },
      providerTaskId: 'task-123',
      metadata: {},
    });
    expect(info).toMatchObject({ code: 'provider_quota', category: 'provider_quota', title: 'snumom额度不足', safeToRetry: false });
  });
});
