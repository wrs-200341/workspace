import { describe, expect, it } from 'vitest';
import { classifyTaskError } from './taskErrorInfo';

describe('task error classification', () => {
  it.each([undefined, 'upstream-uncertain'])('requires supplier verification for uncertain acceptance with provider ID %s', (providerTaskId) => {
    const info = classifyTaskError({
      mode: 'video',
      error: 'provider_submission_uncertain',
      providerResponse: undefined,
      providerTaskId,
      metadata: {},
    });
    expect(info).toMatchObject({ code: 'provider_submission_uncertain', category: 'submission_uncertain', title: '提交结果待供应商确认', safeToRetry: false });
    expect(info?.message).toContain('重复提交扣费');
    expect(info?.action).toContain('供应商');
  });

  it('does not classify an interrupted ambiguous submission as safe recovery', () => {
    const info = classifyTaskError({
      mode: 'video',
      error: 'provider_submission_uncertain',
      providerResponse: { body: 'temporarily unavailable' },
      providerTaskId: undefined,
      metadata: { schedulerInterruptedAt: '2026-09-14T01:00:00Z', promptGenerationPending: true, providerSubmissionUncertain: true },
    });
    expect(info).toMatchObject({ code: 'provider_submission_uncertain', category: 'submission_uncertain', safeToRetry: false });
  });

  it('honors the persisted uncertainty marker when a later generic error is recorded', () => {
    const info = classifyTaskError({
      mode: 'image',
      error: 'provider_request_failed',
      providerResponse: undefined,
      providerTaskId: undefined,
      metadata: { providerSubmissionUncertain: true },
    });
    expect(info).toMatchObject({ code: 'provider_submission_uncertain', category: 'submission_uncertain', safeToRetry: false });
  });

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
