import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderTask } from './taskStore';

const state = vi.hoisted(() => ({ task: null as ProviderTask | null, events: [] as string[], submit: vi.fn(), prompt: vi.fn(), bigSnakePrompt: vi.fn(), flush: vi.fn(), cache: vi.fn(), appendSummary: vi.fn(), lookupSummary: vi.fn(), readAsset: vi.fn(), readProduct: vi.fn(), readFile: vi.fn(), publishAssets: vi.fn(), publishProducts: vi.fn(), live: false, version: 0, nextBatch: 0, conflictOnAcceptance: false }));

vi.mock('./taskStore', () => ({
  getProviderTask: (id: string) => state.task?.id === id ? structuredClone(state.task) : null,
  updateProviderTask: (id: string, patch: Partial<ProviderTask>, expectedUpdatedAt?: string) => {
    if (state.task?.id !== id || expectedUpdatedAt !== undefined && state.task.updatedAt !== expectedUpdatedAt) return null;
    if (patch.providerTaskId && state.conflictOnAcceptance) {
      state.conflictOnAcceptance = false;
      state.task.status = 'cancelled';
      state.task.updatedAt = `version-${++state.version}`;
      return null;
    }
    state.task = { ...state.task, ...patch, updatedAt: `version-${++state.version}` };
    return structuredClone(state.task);
  },
  flushProviderTaskStore: state.flush,
}));
vi.mock('./client', () => ({
  submitVideoWithFallback: state.submit,
  generateBigSnakePrompt: state.bigSnakePrompt,
  generateGeminiPrompt: state.prompt,
  generateGPTPrompt: state.prompt,
  generateOAIRegboxGPTPrompt: state.prompt,
  generateSecureSkillGPTPrompt: state.prompt,
  generatePromptWithFallback: state.prompt,
  normalizeProviderResponse: (_provider: string, response: Record<string, unknown>) => ({ status: 'unknown', progress: 0, outputUrls: [], outputBase64: [], ...response }),
  providerErrorInfo: (error: Error & { status?: number }) => ({ code: error?.message ?? 'provider_request_failed', status: error?.status }),
  providerResponseSnapshot: (_error: unknown, fallback?: { body?: unknown }) => ({ body: fallback?.body }),
  sanitizeProviderError: (message: string) => message,
}));
vi.mock('./config', () => ({ getProviderConfig: (provider: string) => ({ model: provider === 'dola-sd2' ? 'api_hmstudio_seedance_v2_0' : 'video-model', supports: { durations: [6], ratios: ['9:16'], resolutions: ['720p'] } }), isProviderLiveEnabled: () => state.live }));
vi.mock('./taskProcessor', () => ({ processMockProviderTask: vi.fn() }));
vi.mock('@/lib/workspace/referenceBridge', () => ({ publishAssetReferences: state.publishAssets }));
vi.mock('@/lib/workspace/productImages', () => ({ listProductImageAssets: () => [], publishProductImageReferences: state.publishProducts, getProductImageAbsolutePath: (id: string) => `/product-images/${id}.png`, readProductImageAsset: state.readProduct }));
vi.mock('@/lib/workspace/assetStore', () => ({ listAssets: () => [], readAssetFile: state.readAsset }));
vi.mock('node:fs', () => ({ default: { readFileSync: state.readFile } }));
vi.mock('@/lib/workspace/videoInventory', () => ({ cacheVideoTaskOutputsBeforeCompletion: state.cache }));
vi.mock('@/lib/workspace/productSummary', () => ({ appendProductSummary: state.appendSummary, lookupProductSummary: state.lookupSummary }));

import { executePersistedVideoTask } from './videoTaskExecution';

function seed(patch: Partial<ProviderTask> = {}): ProviderTask {
  state.task = { id: 'task', accountId: 'account', mode: 'video', provider: 'grok-video', model: 'video-model', prompt: 'original title', status: 'queued', progress: 0, outputUrls: [], outputBase64: [], metadata: { aspectRatio: '9:16', resolution: '720p', duration: 6, promptBatchId: `batch-${state.nextBatch++}` }, createdAt: '', updatedAt: 'initial', ...patch };
  return state.task;
}

function seedPrompt(extra: Record<string, unknown> = {}): ProviderTask {
  const task = seed();
  task.metadata = { ...task.metadata, promptMode: 'asset-template-child-prompt', promptGenerationPending: true, promptModelSelection: 'pomoai-gpt', ...extra };
  return task;
}

describe('persisted video execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.task = null;
    state.events = [];
    state.conflictOnAcceptance = false;
    state.live = false;
    state.readAsset.mockReset();
    state.readProduct.mockReset();
    state.readFile.mockReset();
    state.publishAssets.mockReset().mockReturnValue([]);
    state.publishProducts.mockReset().mockReturnValue([]);
    state.submit.mockReset().mockImplementation(async () => {
      state.events.push('submit');
      return { provider: 'grok-video', model: 'video-model', mode: 'live', response: { status: 'processing', providerTaskId: 'upstream-video' } };
    });
    state.prompt.mockReset().mockResolvedValue({ provider: 'pomoai-gpt-prompt', model: 'prompt-model', mode: 'live', text: 'generated child prompt', response: {} });
    state.bigSnakePrompt.mockReset().mockResolvedValue({ mode: 'live', text: 'generated BigSnake child prompt', response: {} });
    state.flush.mockReset().mockImplementation(async () => { state.events.push(state.task?.metadata?.providerAcceptedAt ? 'flush-accepted' : 'flush-started'); });
    state.cache.mockReset().mockImplementation(async () => {
      state.events.push('cache');
      return { ready: true, cached: 1, expected: 1 };
    });
    state.appendSummary.mockImplementation((prompt: string, summary: { description: string } | null) => summary ? `${prompt}\nEXCEL:${summary.description}` : prompt);
    state.lookupSummary.mockReturnValue(null);
  });

  it('never resubmits an existing upstream task ID', async () => {
    seed({ providerTaskId: 'existing-id', status: 'processing' });
    await executePersistedVideoTask('task');
    expect(state.submit).not.toHaveBeenCalled();
  });

  it.each(['image', 'product-image'] as const)('submits dola sd2 local %s bytes without publishing a public reference', async (kind) => {
    state.live = true;
    const bytes = new Uint8Array([1, 2, 3]);
    state.readAsset.mockReturnValue({ bytes, asset: { mimeType: 'image/png', name: 'reference.png' } });
    state.readProduct.mockReturnValue({ mimeType: 'image/png', name: 'reference.png' });
    state.readFile.mockReturnValue(bytes);
    seed({ provider: 'dola-sd2', model: 'dola-sd2', metadata: { referenceAssetOrder: [{ id: 'reference', kind }], ...(kind === 'image' ? { referenceAssetIds: ['reference'] } : { productImageAssetIds: ['reference'] }) } });
    state.submit.mockResolvedValue({ provider: 'dola-sd2', model: 'api_hmstudio_seedance_v2_0', mode: 'live', response: { status: 'processing', providerTaskId: 'paid-task' } });

    await executePersistedVideoTask('task');

    expect(state.submit).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'dola-sd2', model: 'api_hmstudio_seedance_v2_0', requestId: 'task', duration: 5,
      referenceImages: [], referenceFiles: [{ bytes, mimeType: 'image/png', fileName: 'reference.png' }],
    }), expect.objectContaining({ preventAmbiguousResubmission: true }));
    expect(state.publishAssets).not.toHaveBeenCalled();
    expect(state.publishProducts).not.toHaveBeenCalled();
    if (kind === 'image') expect(state.readAsset).toHaveBeenCalledWith('account', 'reference');
    else expect(state.readFile).toHaveBeenCalledWith('/product-images/reference.png');
    expect(state.task).toMatchObject({ status: 'processing', providerTaskId: 'paid-task' });
  });

  it('retains the workspace task id on a confirmed rejected dola retry', async () => {
    seed({ provider: 'dola-sd2', metadata: { externalReferenceImages: ['https://assets.example/reference.png'] } });
    state.submit.mockRejectedValueOnce(Object.assign(new Error('provider_invalid_request'), { status: 400 }));
    await executePersistedVideoTask('task');
    expect(state.task?.metadata?.providerSubmissionStartedAt).toBeUndefined();
    state.task!.status = 'retrying';
    await executePersistedVideoTask('task');
    expect(state.submit).toHaveBeenCalledTimes(2);
    expect(state.submit.mock.calls.map((call) => call[0].requestId)).toEqual(['task', 'task']);
    expect(state.submit.mock.calls[0][0].referenceImages).toEqual(['https://assets.example/reference.png']);
  });

  it('skips every supplier that already failed when resuming an asynchronous Grok failure', async () => {
    seed({
      provider: 'mgrouter-grok-video',
      metadata: {
        aspectRatio: '9:16', resolution: '720p', duration: 6,
        lastProviderFailure: 'mgrouter-grok-video',
        providerAttemptHistory: [
          { provider: 'grok-video', status: 'failed' },
          { provider: 'yuanai-grok-video', status: 'completed' },
        ],
      },
    });

    await executePersistedVideoTask('task');

    expect(state.submit).toHaveBeenCalledWith(expect.objectContaining({ provider: 'mgrouter-grok-video' }), expect.objectContaining({
      preventAmbiguousResubmission: true,
      skipProviders: ['grok-video', 'mgrouter-grok-video'],
    }));
  });

  it('does not mark dola image preparation failures as an uncertain paid submission', async () => {
    seed({ provider: 'dola-sd2', metadata: { externalReferenceImages: ['https://assets.example/reference.png'] } });
    state.submit.mockRejectedValue(new Error('reference_asset_file_invalid'));
    await executePersistedVideoTask('task');
    expect(state.task).toMatchObject({ status: 'failed', error: 'reference_asset_file_invalid', metadata: { providerSubmissionUncertain: false, providerSubmissionStartedAt: undefined } });
  });

  it('exhausts retries on an uncertain POST and does not submit it again', async () => {
    seed();
    state.submit.mockRejectedValue(new Error('fetch failed'));
    await executePersistedVideoTask('task');
    await executePersistedVideoTask('task');
    expect(state.submit).toHaveBeenCalledTimes(1);
    expect(state.submit.mock.calls[0][1]).toMatchObject({ preventAmbiguousResubmission: true });
    expect(state.task).toMatchObject({ status: 'failed', error: 'provider_submission_uncertain', metadata: { providerSubmissionUncertain: true, schedulerRetryExhausted: true } });
  });

  it('records confirmed upstream terminal failure without exhausting scheduler retries', async () => {
    seed();
    state.submit.mockResolvedValue({ provider: 'grok-video', model: 'video-model', mode: 'live', response: { status: 'failed', providerTaskId: 'failed-id', error: 'provider_upstream_failed' } });
    await executePersistedVideoTask('task');
    expect(state.task).toMatchObject({ status: 'failed', providerTaskId: 'failed-id', metadata: { lastProviderStatus: 'failed', schedulerRetryExhausted: false, providerAcceptedAt: expect.any(String) } });
    expect(state.cache).not.toHaveBeenCalled();
  });

  it('flushes synchronous output acceptance before the cache can suspend', async () => {
    seed();
    state.submit.mockImplementation(async () => {
      state.events.push('submit');
      return { provider: 'grok-video', model: 'video-model', mode: 'live', response: { status: 'completed', outputUrls: ['https://example.test/video.mp4'] } };
    });
    let finishCache!: (value: { ready: boolean; cached: number; expected: number }) => void;
    state.cache.mockImplementation(() => {
      state.events.push('cache');
      return new Promise((resolve) => { finishCache = resolve; });
    });
    const execution = executePersistedVideoTask('task');
    await vi.waitFor(() => expect(state.cache).toHaveBeenCalledTimes(1));
    expect(state.events).toEqual(['flush-started', 'submit', 'flush-accepted', 'cache']);
    expect(state.task).toMatchObject({ status: 'processing', outputUrls: ['https://example.test/video.mp4'], providerResponse: { body: { outputUrls: ['https://example.test/video.mp4'] } } });
    finishCache({ ready: true, cached: 1, expected: 1 });
    await execution;
    expect(state.task?.status).toBe('completed');
  });

  it.each(['cancelled', 'paused'] as const)('preserves %s during POST while retaining its accepted ID', async (status) => {
    seed();
    state.submit.mockImplementation(async () => {
      state.task!.status = status;
      return { provider: 'grok-video', model: 'video-model', mode: 'live', response: { status: 'processing', providerTaskId: 'accepted-id' } };
    });
    await executePersistedVideoTask('task');
    expect(state.task).toMatchObject({ status, providerTaskId: 'accepted-id' });
  });

  it('retries an optimistic checkpoint conflict using the latest cancellation state', async () => {
    seed();
    state.conflictOnAcceptance = true;
    await executePersistedVideoTask('task');
    expect(state.task).toMatchObject({ status: 'cancelled', providerTaskId: 'upstream-video' });
  });

  it('preserves cancellation while output caching completes', async () => {
    seed();
    state.submit.mockResolvedValue({ provider: 'grok-video', model: 'video-model', mode: 'live', response: { status: 'completed', outputUrls: ['https://example.test/video.mp4'] } });
    state.cache.mockImplementation(async () => {
      state.task!.status = 'cancelled';
      return { ready: true, cached: 1, expected: 1 };
    });
    await executePersistedVideoTask('task');
    expect(state.task?.status).toBe('cancelled');
  });

  it('preserves cancellation when the POST rejects', async () => {
    seed();
    state.submit.mockImplementation(async () => {
      state.task!.status = 'cancelled';
      throw Object.assign(new Error('provider_invalid_request'), { status: 400 });
    });
    await executePersistedVideoTask('task');
    expect(state.task?.status).toBe('cancelled');
    expect(state.task?.metadata?.providerSubmissionStartedAt).toBeUndefined();
  });

  it('records an overlength prompt as a local preflight failure instead of an uncertain submission', async () => {
    seed();
    state.submit.mockRejectedValue(new Error('video_prompt_too_long'));
    await executePersistedVideoTask('task');
    expect(state.submit).toHaveBeenCalledTimes(1);
    expect(state.task).toMatchObject({
      status: 'failed',
      error: 'video_prompt_too_long',
      metadata: { providerSubmissionUncertain: false, providerSubmissionStartedAt: undefined },
    });
  });

  it('clears the submission marker when cancelled after its flush but before POST', async () => {
    seed();
    state.flush.mockImplementationOnce(async () => { state.task!.status = 'cancelled'; });
    await executePersistedVideoTask('task');
    expect(state.submit).not.toHaveBeenCalled();
    expect(state.task?.status).toBe('cancelled');
    expect(state.task?.metadata?.providerSubmissionStartedAt).toBeUndefined();
  });

  it('does not submit after the worker claim changes during the pre-submit flush', async () => {
    seed({ metadata: { schedulerWorkerId: 'old-worker' } });
    state.flush.mockImplementationOnce(async () => { state.task!.metadata = { schedulerWorkerId: 'new-worker', providerSubmissionStartedAt: 'new-checkpoint' }; });
    await executePersistedVideoTask('task');
    expect(state.submit).not.toHaveBeenCalled();
    expect(state.task?.metadata).toMatchObject({ schedulerWorkerId: 'new-worker', providerSubmissionStartedAt: 'new-checkpoint' });
  });

  it('does not overwrite a cancellation when child-prompt generation rejects', async () => {
    seedPrompt();
    state.prompt.mockImplementation(async () => { state.task!.status = 'cancelled'; throw new Error('prompt_failed'); });
    await executePersistedVideoTask('task');
    expect(state.task?.status).toBe('cancelled');
    expect(state.submit).not.toHaveBeenCalled();
  });

  it('regenerates a failed child prompt before retrying video submission', async () => {
    seedPrompt();
    state.prompt.mockRejectedValueOnce(new Error('prompt_failed'));
    await executePersistedVideoTask('task');
    expect(state.task).toMatchObject({ status: 'failed', metadata: { promptGenerationPending: false, promptGenerationFailed: true } });
    state.task!.status = 'retrying';
    await executePersistedVideoTask('task');
    expect(state.prompt).toHaveBeenCalledTimes(2);
    expect(state.submit.mock.calls[0][0].prompt).toBe('generated child prompt');
  });

  it('does not submit after ownership changes while generating a child prompt', async () => {
    seedPrompt({ schedulerWorkerId: 'old-worker' });
    state.prompt.mockImplementation(async () => {
      state.task!.metadata!.schedulerWorkerId = 'new-worker';
      return { provider: 'pomoai-gpt-prompt', model: 'prompt-model', mode: 'live', text: 'stale child prompt', response: {} };
    });
    await executePersistedVideoTask('task');
    expect(state.submit).not.toHaveBeenCalled();
    expect(state.task?.prompt).toBe('original title');
  });

  it('uses the persisted workbook summary and title only in child-prompt generation', async () => {
    const summary = { pid: '123', title: 'Workbook title', description: 'Workbook product facts' };
    seedPrompt({ productSummary: summary, promptTitle: 'Requested product title', referenceImageName: '123_reference.png' });
    await executePersistedVideoTask('task');
    expect(state.lookupSummary).not.toHaveBeenCalled();
    expect(state.appendSummary).toHaveBeenCalledWith(expect.stringContaining('Requested product title'), summary);
    expect(state.prompt.mock.calls[0][0].prompt).toContain('EXCEL:Workbook product facts');
    expect(state.submit.mock.calls[0][0].prompt).toBe('generated child prompt');
  });

  it('instructs the child-prompt model to return only a body within 3600 UTF-8 bytes', async () => {
    seedPrompt();
    await executePersistedVideoTask('task');
    const generationPrompt = String(state.prompt.mock.calls[0][0].prompt);
    expect(generationPrompt).toContain('最多 3600 UTF-8 字节');
    expect(generationPrompt).toContain('只输出可以直接提交给视频模型的提示词正文');
    expect(generationPrompt).toContain('不要开场说明，不要结尾总结，不要字符数说明，不要 Markdown 代码块');
  });

  it('restores the BigSnake provider selector instead of treating its canonical model as GPT', async () => {
    seedPrompt({ promptModelSelection: undefined, promptProvider: 'bigsnake-prompt', promptModel: 'gpt-5.5' });
    await executePersistedVideoTask('task');
    expect(state.bigSnakePrompt).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.5' }));
    expect(state.prompt).not.toHaveBeenCalled();
    expect(state.submit.mock.calls[0][0].prompt).toBe('generated BigSnake child prompt');
  });
});
