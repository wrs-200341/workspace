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
  normalizeProviderResponse: mockNormalizeProviderResponse,
  providerResponseSnapshot: mockProviderResponseSnapshot,
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

import { POST } from './route';

const params = { params: Promise.resolve({ id: 'account-1' }) };
let tasks = new Map<string, MockTask>();
let runs: Array<() => Promise<void>> = [];

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
    tasks = new Map();
    runs = [];
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
    mockSubmitVideo.mockReset().mockResolvedValue({ mode: 'mock', response: {} });
    mockNormalizeProviderResponse.mockReset().mockReturnValue({ status: 'queued', progress: 5, outputUrls: [], outputBase64: [] });
    mockProviderResponseSnapshot.mockImplementation((error: unknown) => ({ code: error instanceof Error ? error.message : 'provider_error' }));
    mockCacheVideoTaskOutputsBeforeCompletion.mockReset();
    mockProcessMockProviderTask.mockReset();
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
    mockEnqueueProviderTask.mockImplementation((input: { taskId: string; run: () => Promise<void> }) => {
      runs.push(input.run);
      return true;
    });
  });

  it('returns immediately with prompting tasks and defers prompt-provider work', async () => {
    const response = await POST(request(baseBody()), params);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { count: 2, status: 'prompting', execution: 'pending' },
    });
    expect(runs).toHaveLength(2);
    expect(mockGenerateBigSnakePrompt).not.toHaveBeenCalled();
    expect([...tasks.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'prompting', progress: 2, metadata: expect.objectContaining({ promptGenerationPending: true }) }),
    ]));
  });

  it('shares one generated child prompt across all tasks in a batch', async () => {
    mockGenerateBigSnakePrompt.mockResolvedValue({ mode: 'mock', text: 'generated child prompt', response: { ok: true } });
    await POST(request(baseBody()), params);
    await Promise.all(runs.map((run) => run()));

    expect(mockGenerateBigSnakePrompt).toHaveBeenCalledTimes(1);
    expect(mockSubmitVideo).toHaveBeenCalledTimes(2);
    expect(mockSubmitVideo.mock.calls.every((call) => call[0].prompt === 'generated child prompt')).toBe(true);
    expect([...tasks.values()].every((task) => task.metadata.childPrompt === 'generated child prompt')).toBe(true);
  });

  it('records a failed prompt stage so the scheduler can retry the task', async () => {
    mockGenerateBigSnakePrompt.mockRejectedValue(new Error('prompt_provider_failed'));
    await POST(request(baseBody({ count: 1 })), params);
    await expect(runs[0]()).rejects.toThrow('prompt_provider_failed');

    expect(tasks.get('task-1')).toMatchObject({
      status: 'failed',
      progress: 100,
      metadata: { promptGenerationPending: false, promptGenerationFailed: true },
      providerResponse: { code: 'prompt_provider_failed' },
    });
    expect(mockSubmitVideo).not.toHaveBeenCalled();
  });
});
