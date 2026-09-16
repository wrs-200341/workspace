import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockTask = {
  id: string;
  accountId: string;
  mode: 'video';
  provider: string;
  model: string;
  prompt?: string;
  status: string;
  progress: number;
  outputUrls: string[];
  outputBase64: string[];
  metadata: Record<string, unknown>;
};

const {
  mockRequireApiRole,
  mockCanAccessWorkspaceAccount,
  mockGetProviderConfig,
  mockCreateProviderTasks,
  mockGetProviderTask,
  mockUpdateProviderTask,
  mockEnqueueProviderTask,
  mockGenerateBigSnakePrompt,
  mockGenerateGPTPrompt,
  mockGenerateGeminiPrompt,
  mockSubmitVideo,
  mockNormalizeProviderResponse,
  mockProviderResponseSnapshot,
  mockIsProviderLiveEnabled,
  mockValidateGenerationRequest,
  mockGetVideoCapability,
  mockValidateVideoCapability,
  mockFirstReferenceImageName,
  mockLookupProductSummary,
  mockAppendProductSummary,
  mockListAssets,
  mockCacheVideoTaskOutputsBeforeCompletion,
  mockProcessMockProviderTask,
  mockGetDailyQuotaUsage,
} = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockCanAccessWorkspaceAccount: vi.fn(),
  mockGetProviderConfig: vi.fn(),
  mockCreateProviderTasks: vi.fn(),
  mockGetProviderTask: vi.fn(),
  mockUpdateProviderTask: vi.fn(),
  mockEnqueueProviderTask: vi.fn(),
  mockGenerateBigSnakePrompt: vi.fn(),
  mockGenerateGPTPrompt: vi.fn(),
  mockGenerateGeminiPrompt: vi.fn(),
  mockSubmitVideo: vi.fn(),
  mockNormalizeProviderResponse: vi.fn(),
  mockProviderResponseSnapshot: vi.fn(),
  mockIsProviderLiveEnabled: vi.fn(),
  mockValidateGenerationRequest: vi.fn(),
  mockGetVideoCapability: vi.fn(),
  mockValidateVideoCapability: vi.fn(),
  mockFirstReferenceImageName: vi.fn(),
  mockLookupProductSummary: vi.fn(),
  mockAppendProductSummary: vi.fn(),
  mockListAssets: vi.fn(),
  mockCacheVideoTaskOutputsBeforeCompletion: vi.fn(),
  mockProcessMockProviderTask: vi.fn(),
  mockGetDailyQuotaUsage: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/access', () => ({
  canAccessWorkspaceAccount: mockCanAccessWorkspaceAccount,
  workspaceOwnerIdForAccount: vi.fn(() => 'operator-a'),
}));
vi.mock('@/lib/providers/config', () => ({
  getProviderConfig: mockGetProviderConfig,
  isProviderLiveEnabled: mockIsProviderLiveEnabled,
}));
vi.mock('@/lib/providers/taskStore', () => ({
  createProviderTasks: mockCreateProviderTasks,
  getProviderTask: mockGetProviderTask,
  updateProviderTask: mockUpdateProviderTask,
  flushProviderTaskStore: vi.fn(async () => undefined),
}));
vi.mock('@/lib/providers/concurrency', () => ({
  enqueueProviderTask: mockEnqueueProviderTask,
  SCHEDULER_RUNTIME_ID: 'test-runtime',
}));
vi.mock('@/lib/providers/client', () => ({
  generateBigSnakePrompt: mockGenerateBigSnakePrompt,
  generateGPTPrompt: mockGenerateGPTPrompt,
  generateGeminiPrompt: mockGenerateGeminiPrompt,
  submitVideo: mockSubmitVideo,
  submitVideoWithFallback: mockSubmitVideo,
  normalizeProviderResponse: mockNormalizeProviderResponse,
  providerResponseSnapshot: mockProviderResponseSnapshot,
  providerErrorInfo: vi.fn((error: Error) => ({ code: error.message })),
  sanitizeProviderError: vi.fn((value: string) => value),
}));
vi.mock('@/lib/providers/validation', () => ({ validateGenerationRequest: mockValidateGenerationRequest }));
vi.mock('@/lib/workspace/referenceBridge', () => ({ publishAssetReferences: vi.fn(() => []) }));
vi.mock('@/lib/workspace/productImages', () => ({
  publishProductImageReferences: vi.fn(() => []),
  getProductImageAbsolutePath: vi.fn(),
  listProductImageAssets: vi.fn(() => []),
}));
vi.mock('@/lib/workspace/assetStore', () => ({ listAssets: mockListAssets, readAssetFile: vi.fn() }));
vi.mock('@/lib/workspace/taskMetadata', () => ({ firstReferenceImageName: mockFirstReferenceImageName }));
vi.mock('@/lib/workspace/productSummary', () => ({
  appendProductSummary: mockAppendProductSummary,
  lookupProductSummary: mockLookupProductSummary,
  lookupProductSummaryForAccount: mockLookupProductSummary,
}));
vi.mock('@/lib/providers/taskProcessor', () => ({ processMockProviderTask: mockProcessMockProviderTask }));
vi.mock('@/lib/workspace/production/video-capabilities', () => ({
  getVideoCapability: mockGetVideoCapability,
  validateVideoCapability: mockValidateVideoCapability,
}));
vi.mock('@/lib/workspace/videoInventory', () => ({ cacheVideoTaskOutputsBeforeCompletion: mockCacheVideoTaskOutputsBeforeCompletion }));
vi.mock('@/lib/workspace/production/dailyQuota', () => ({ getDailyQuotaUsage: mockGetDailyQuotaUsage }));

import { POST } from './route';
import { executePersistedVideoTask } from '@/lib/providers/videoTaskExecution';

const params = { params: Promise.resolve({ id: 'account-1' }) };
let tasks = new Map<string, MockTask>();
let queuedIds: string[] = [];

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/workspace/accounts/account-1/generate-video', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: '商品展示',
    provider: 'grok-video',
    model: 'grok-model',
    promptMode: 'asset-template-child-prompt',
    promptModel: 'bigsnake',
    count: 2,
    duration: 6,
    aspectRatio: '9:16',
    resolution: '720p',
    ...overrides,
  };
}

describe('generate-video automatic child prompt queueing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tasks = new Map();
    queuedIds = [];
    mockRequireApiRole.mockResolvedValue({ role: 'admin', username: 'admin' });
    mockCanAccessWorkspaceAccount.mockReturnValue(true);
    mockGetProviderConfig.mockImplementation((id: string) => ({
      model: id === 'bigsnake-prompt' ? 'gpt-5.5' : 'grok-model',
      supports: { durations: [6], ratios: ['9:16'], resolutions: ['720p'], referenceImages: 10, referenceVideos: 0, referenceAudios: 0 },
    }));
    mockIsProviderLiveEnabled.mockReturnValue(false);
    mockValidateGenerationRequest.mockImplementation((value: Record<string, unknown>) => ({ ...value }));
    mockGetVideoCapability.mockReturnValue({});
    mockValidateVideoCapability.mockReset();
    mockFirstReferenceImageName.mockReturnValue('');
    mockLookupProductSummary.mockReturnValue(undefined);
    mockAppendProductSummary.mockImplementation((prompt: string) => prompt);
    mockListAssets.mockReturnValue([]);
    mockGenerateBigSnakePrompt.mockReset();
    mockGenerateGPTPrompt.mockReset();
    mockGenerateGeminiPrompt.mockReset();
    mockSubmitVideo.mockReset().mockResolvedValue({ mode: 'mock', provider: 'grok-video', model: 'grok-model', response: {} });
    mockNormalizeProviderResponse.mockReset().mockReturnValue({ status: 'queued', providerTaskId: 'mock-upstream', progress: 5, outputUrls: [], outputBase64: [] });
    mockProviderResponseSnapshot.mockImplementation((error: unknown) => ({ code: error instanceof Error ? error.message : 'provider_error' }));
    mockCacheVideoTaskOutputsBeforeCompletion.mockReset();
    mockProcessMockProviderTask.mockReset();
    mockGetDailyQuotaUsage.mockReset().mockReturnValue(null);
    mockCreateProviderTasks.mockImplementation((inputs: Array<Record<string, unknown>>) => inputs.map((input, index) => {
      const task: MockTask = {
        id: `task-${index + 1}`,
        accountId: String(input.accountId),
        mode: 'video',
        provider: String(input.provider),
        model: String(input.model),
        prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
        status: String(input.status ?? 'queued'),
        progress: Number(input.progress ?? 0),
        outputUrls: [],
        outputBase64: [],
        metadata: (input.metadata ?? {}) as Record<string, unknown>,
      };
      tasks.set(task.id, task);
      return task;
    }));
    mockGetProviderTask.mockImplementation((id: string) => tasks.get(id) ?? null);
    mockUpdateProviderTask.mockImplementation((id: string, patch: Partial<MockTask>) => {
      const current = tasks.get(id);
      if (!current) return null;
      const next = { ...current, ...patch, metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata };
      tasks.set(id, next);
      return next;
    });
    mockEnqueueProviderTask.mockImplementation((input: { taskId: string; run?: () => Promise<void> }) => {
      expect(input.run).toBeUndefined();
      queuedIds.push(input.taskId);
      return true;
    });
  });

  it('rejects automatic naming when no reference image is selected', async () => {
    const response = await POST(request(baseBody({ taskNameMode: 'auto' })), params);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ success: false, error: 'task_name_reference_required' });
    expect(mockCreateProviderTasks).not.toHaveBeenCalled();
  });

  it('queues dola sd2 with its pinned supplier model, local reference and five-second default', async () => {
    mockGetProviderConfig.mockReturnValue({ model: 'api_hmstudio_seedance_v2_0', supports: { durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ratios: ['9:16'], resolutions: ['720p'] } });
    const response = await POST(request(baseBody({ provider: 'dola-sd2', model: 'dola sd2', modelId: 'dola-sd2', count: 1, duration: undefined, promptMode: 'manual', referenceAssetIds: ['image-1'] })), params);
    expect(response.status).toBe(202);
    expect(mockValidateGenerationRequest).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'dola-sd2', model: 'api_hmstudio_seedance_v2_0', duration: 5,
      referenceImages: ['https://pending.invalid/reference-image'],
    }));
    expect(tasks.get('task-1')).toMatchObject({ provider: 'dola-sd2', model: 'api_hmstudio_seedance_v2_0', metadata: { duration: 5, referenceAssetIds: ['image-1'] } });
    expect(queuedIds).toEqual(['task-1']);
    expect(mockSubmitVideo).not.toHaveBeenCalled();
  });

  it.each([
    [{ referenceAssetIds: [] }, 'reference_images_required'],
    [{ referenceAssetIds: ['image-1', 'image-2'] }, 'too_many_reference_images'],
    [{ referenceVideoAssetIds: ['video-1'] }, 'too_many_reference_videos'],
    [{ referenceAudios: ['https://assets.example/reference.mp3'] }, 'too_many_reference_audios'],
    [{ duration: 5.5 }, 'unsupported_duration'],
  ])('rejects an invalid dola request before queueing: %s', async (overrides, error) => {
    const { validateGenerationRequest } = await vi.importActual<typeof import('@/lib/providers/validation')>('@/lib/providers/validation');
    mockGetProviderConfig.mockReturnValue({ kind: 'video', model: 'api_hmstudio_seedance_v2_0', supports: { durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ratios: ['9:16'], resolutions: ['720p'], referenceImages: 1, referenceVideos: 0, referenceAudios: 0 } });
    mockValidateGenerationRequest.mockImplementation(validateGenerationRequest);
    const response = await POST(request(baseBody({ provider: 'dola-sd2', count: 1, promptMode: 'manual', referenceAssetIds: ['image-1'], ...overrides })), params);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ success: false, error });
    expect(mockCreateProviderTasks).not.toHaveBeenCalled();
    expect(mockSubmitVideo).not.toHaveBeenCalled();
  });

  it('rejects manual naming without a task name', async () => {
    const response = await POST(request(baseBody({ taskNameMode: 'manual', taskName: '   ' })), params);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ success: false, error: 'task_name_required' });
    expect(mockCreateProviderTasks).not.toHaveBeenCalled();
  });

  it('rejects a batch that would exceed the operator’s remaining daily quota for a metered model', async () => {
    mockGetDailyQuotaUsage.mockReturnValue({ model: 'minimax-h3-max', limit: 50, used: 49, remaining: 1, date: '2026-09-08' });
    const response = await POST(request(baseBody({ modelId: 'minimax-h3-max', count: 2 })), params);
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'daily_model_quota_exceeded',
      data: { model: 'minimax-h3-max', limit: 50, used: 49, remaining: 1, requested: 2 },
    });
    expect(mockCreateProviderTasks).not.toHaveBeenCalled();
    expect(mockSubmitVideo).not.toHaveBeenCalled();
  });

  it('allows a batch that fits inside the remaining daily quota', async () => {
    mockGetDailyQuotaUsage.mockReturnValue({ model: 'minimax-h3-max', limit: 50, used: 48, remaining: 2, date: '2026-09-08' });
    const response = await POST(request(baseBody({ modelId: 'minimax-h3-max', count: 2 })), params);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ success: true });
  });

  it('returns immediately with prompting tasks and defers prompt-provider work', async () => {
    const response = await POST(request(baseBody()), params);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { count: 2, status: 'prompting', execution: 'pending' },
    });
    expect(queuedIds).toHaveLength(2);
    expect(mockGenerateBigSnakePrompt).not.toHaveBeenCalled();
    expect([...tasks.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'prompting', progress: 2, metadata: expect.objectContaining({ promptGenerationPending: true }) }),
    ]));
  });

  it('shares one generated child prompt across all tasks in a batch', async () => {
    mockGenerateBigSnakePrompt.mockResolvedValue({ mode: 'mock', text: 'generated child prompt', response: { ok: true } });
    await POST(request(baseBody()), params);
    await Promise.all(queuedIds.map((id) => executePersistedVideoTask(id)));

    expect(mockGenerateBigSnakePrompt).toHaveBeenCalledTimes(1);
    expect(mockSubmitVideo).toHaveBeenCalledTimes(2);
    expect(mockSubmitVideo.mock.calls.every((call) => call[0].prompt === 'generated child prompt')).toBe(true);
    expect([...tasks.values()].every((task) => task.metadata.childPrompt === 'generated child prompt')).toBe(true);
  });

  it('records a failed prompt stage so the scheduler can retry the task', async () => {
    mockGenerateBigSnakePrompt.mockRejectedValue(new Error('prompt_provider_failed'));
    await POST(request(baseBody({ count: 1 })), params);
    await executePersistedVideoTask(queuedIds[0]);

    expect(tasks.get('task-1')).toMatchObject({
      status: 'failed',
      progress: 100,
      metadata: { promptGenerationPending: false, promptGenerationFailed: true },
      providerResponse: { code: 'prompt_provider_failed' },
    });
    expect(mockSubmitVideo).not.toHaveBeenCalled();
  });

  it('falls back to the template and flags it when a live prompt provider returns blank text', async () => {
    mockGenerateBigSnakePrompt.mockResolvedValue({ mode: 'live', text: '   ', response: { ok: true } });
    await POST(request(baseBody({ count: 1 })), params);
    await executePersistedVideoTask(queuedIds[0]);

    expect(mockSubmitVideo).toHaveBeenCalledTimes(1);
    expect(tasks.get('task-1')).toMatchObject({
      status: 'queued',
      metadata: {
        promptGenerationPending: false,
        promptGenerationUsedTemplate: true,
      },
    });
  });
});
