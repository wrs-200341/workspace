import { describe, expect, it } from 'vitest';
import { classifyTaskError } from './taskErrorInfo';

describe('task error classification', () => {
  it('requires a reference image before retrying an image-reference model', () => {
    expect(classifyTaskError({ mode: 'video', error: 'reference_images_required', metadata: {} })).toMatchObject({
      category: 'invalid_request', title: '缺少参考图', safeToRetry: false,
    });
  });

  it.each([undefined, 'upstream-uncertain'])('requires supplier verification for uncertain acceptance with provider ID %s', (providerTaskId) => {
    const info = classifyTaskError({
      mode: 'video',
      error: 'provider_submission_uncertain',
      providerResponse: undefined,
      providerTaskId,
      metadata: {},
    });
    expect(info).toMatchObject({ code: 'provider_submission_uncertain', category: 'submission_uncertain', safeToRetry: false });
    expect(info?.title).toContain('提交');
    expect(`${info?.message} ${info?.action}`).toContain('重复');
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

  it('identifies an OAIRegBox video submission timeout after child prompt generation succeeded', () => {
    const info = classifyTaskError({
      mode: 'video',
      provider: 'oairegbox-omni',
      model: 'omni-fast-no-water',
      error: 'provider_submission_uncertain',
      providerResponse: { code: 'provider_408', endpoint: 'https://newapi-2.oairegbox.cc/v1/videos', stage: 'video_submission', timeoutMs: 120000 },
      providerTaskId: undefined,
      metadata: {
        promptMode: 'asset-template-child-prompt',
        promptGenerationPending: false,
        promptGenerationFailed: false,
        promptProvider: 'secure-skill-gpt-prompt',
        promptModel: 'gpt-5.5',
        failureStage: 'video_submission',
        failureProvider: 'oairegbox-omni',
        failureModel: 'omni-fast-no-water',
        providerSubmissionUncertain: true,
      },
    });
    expect(info).toMatchObject({
      title: 'OAIRegBox 视频提交超时',
      category: 'submission_uncertain',
      safeToRetry: false,
    });
    expect(info?.message).toContain('子提示词已由 secure-skill · gpt-5.5 成功生成');
    expect(info?.message).toContain('OAIRegBox · omni-fast-no-water');
    expect(info?.action).toContain('没有自动重新提交');
  });

  it('identifies a prompt-provider failure before video submission', () => {
    const info = classifyTaskError({
      mode: 'video',
      provider: 'oairegbox-omni',
      model: 'omni-fast-no-water',
      error: 'provider_request_failed',
      providerResponse: { code: 'provider_network_error', stage: 'prompt_generation' },
      providerTaskId: undefined,
      metadata: {
        promptGenerationFailed: true,
        promptProvider: 'secure-skill-gpt-prompt',
        promptModel: 'gpt-5.5',
        failureStage: 'prompt_generation',
        failureProvider: 'secure-skill-gpt-prompt',
        failureModel: 'gpt-5.5',
      },
    });
    expect(info).toMatchObject({ title: 'secure-skill · gpt-5.5 子提示词生成失败', safeToRetry: true });
    expect(info?.message).toContain('视频任务尚未提交');
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
    expect(info).toMatchObject({
      code: 'scheduler_prompt_interrupted',
      category: 'service_restart',
      title: '服务重启导致子提示词生成环节被中断',
      message: '',
      action: '',
      safeToRetry: true,
    });
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

  it('explains a locally rejected overlength Grok video prompt', () => {
    const info = classifyTaskError({
      mode: 'video',
      provider: 'grok-video',
      model: 'grok-imagine-video-1.5（按次）',
      error: 'video_prompt_too_long',
      providerResponse: undefined,
      providerTaskId: undefined,
      metadata: {},
    });
    expect(info).toMatchObject({
      code: 'video_prompt_too_long',
      category: 'invalid_request',
      title: '提示词超长',
      safeToRetry: false,
    });
    expect(info?.message).toBe('');
    expect(info?.action).toBe('请缩短提示词后重新提交。');
  });

  it('shows a provider body byte-limit failure as prompt too long before restart metadata', () => {
    const info = classifyTaskError({
      mode: 'video',
      provider: 'grok-video',
      model: 'grok-imagine-video-1.5-preview',
      error: 'provider_400',
      providerResponse: { body: { code: 'prompt_too_long', message: 'prompt 最长 4096 字节（UTF-8），当前 4211 字节' } },
      providerTaskId: undefined,
      metadata: { promptGenerationPending: true, schedulerInterruptedAt: '2026-09-14T01:00:00.000Z' },
    });
    expect(info).toMatchObject({ code: 'video_prompt_too_long', title: '提示词超长', safeToRetry: false });
  });

  it('shows which model failed when a generated child prompt is too long for video submission', () => {
    const info = classifyTaskError({
      mode: 'video',
      provider: 'grok-video',
      model: 'grok-imagine-video-1.5（按次）',
      error: 'video_prompt_too_long',
      providerResponse: { code: 'video_prompt_too_long' },
      providerTaskId: undefined,
      metadata: {
        promptMode: 'asset-template-child-prompt',
        promptGenerationPending: false,
        promptGenerationFailed: false,
        promptGenerationUsedTemplate: false,
        promptProvider: 'pomoai-gpt-prompt',
        promptModel: 'claude-opus-4-8',
      },
    });
    expect(info).toMatchObject({
      code: 'video_prompt_too_long',
      title: 'snumom 视频提交前校验失败：提示词超长',
      safeToRetry: false,
    });
    expect(info?.message).toContain('子提示词模型 PomoAI · claude-opus-4-8 已成功生成');
    expect(info?.message).toContain('错误环节：视频模型 snumom · grok-imagine-video-1.5（按次）的提交前校验环节');
    expect(info?.message).toContain('视频供应商尚未收到任务');
    expect(info?.action).toBe('');
  });

  it('adds both model outcomes to an upstream video-generation failure', () => {
    const info = classifyTaskError({
      mode: 'video',
      provider: 'minimax-h3',
      model: 'minimax-h3',
      error: 'provider_upstream_failed',
      providerResponse: { body: { status: 'failed' } },
      providerTaskId: 'video-123',
      metadata: {
        promptMode: 'asset-template-child-prompt',
        promptGenerationPending: false,
        promptGenerationFailed: false,
        promptProvider: 'secure-skill-gpt-prompt',
        promptModel: 'gpt-5.5',
      },
    });
    expect(info?.title).toContain('secure-skill 视频生成失败');
    expect(info?.message).toContain('子提示词模型 secure-skill · gpt-5.5 已成功生成');
    expect(info?.message).toContain('视频模型 secure-skill · minimax-h3的上游生成环节');
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

  it('attributes a submission failure to the supplier identified by the response endpoint', () => {
    const info = classifyTaskError({
      mode: 'video',
      provider: 'grok-video',
      model: 'grok-imagine-video-1.5（按次）',
      error: 'provider_403',
      providerResponse: {
        endpoint: 'https://raw.mgrouter.com/v1/videos/generations',
        body: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient account balance' },
      },
      providerTaskId: undefined,
      metadata: {
        promptMode: 'asset-template-child-prompt',
        promptGenerationPending: false,
        promptGenerationFailed: false,
        promptProvider: 'gpt-2999-prompt',
        promptModel: 'gpt-5.5',
        failureStage: 'video_submission',
        failureProvider: 'grok-video',
        failureModel: 'grok-imagine-video-1.5（按次）',
      },
    });
    expect(info).toMatchObject({
      code: 'provider_quota',
      title: 'mgrouter 视频提交失败：mgrouter额度不足',
      safeToRetry: false,
    });
    expect(info?.message).toContain('错误环节：视频模型 mgrouter · grok-imagine-video-1.5（按次）的提交环节');
  });
});
