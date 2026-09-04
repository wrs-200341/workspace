import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireApiRole,
  mockCanAccessWorkspaceAccount,
  mockGenerateBigSnakePrompt,
  mockGenerateGPTPrompt,
  mockGenerateGeminiPrompt,
  mockGetProviderConfig,
  mockCreateProviderTask,
} = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockCanAccessWorkspaceAccount: vi.fn(),
  mockGenerateBigSnakePrompt: vi.fn(),
  mockGenerateGPTPrompt: vi.fn(),
  mockGenerateGeminiPrompt: vi.fn(),
  mockGetProviderConfig: vi.fn(),
  mockCreateProviderTask: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/access', () => ({ canAccessWorkspaceAccount: mockCanAccessWorkspaceAccount, workspaceOwnerIdForAccount: vi.fn(() => 'owner-1') }));
vi.mock('@/lib/providers/client', () => ({
  generateBigSnakePrompt: mockGenerateBigSnakePrompt,
  generateGPTPrompt: mockGenerateGPTPrompt,
  generateGeminiPrompt: mockGenerateGeminiPrompt,
  providerResponseSnapshot: vi.fn((error: unknown) => ({ code: error instanceof Error ? error.message : 'provider_request_failed' })),
}));
vi.mock('@/lib/providers/config', () => ({ getProviderConfig: mockGetProviderConfig }));
vi.mock('@/lib/providers/taskStore', () => ({ createProviderTask: mockCreateProviderTask }));
vi.mock('@/lib/workspace/assetStore', () => ({ readAssetFile: vi.fn() }));
vi.mock('@/lib/workspace/productImages', () => ({ getProductImageAbsolutePath: vi.fn(), listProductImageAssets: vi.fn(() => []) }));
vi.mock('@/lib/workspace/productSummary', () => ({ appendProductSummary: vi.fn((prompt: string) => prompt), lookupProductSummary: vi.fn(() => undefined), lookupProductSummaryForAccount: vi.fn(() => undefined) }));
vi.mock('@/lib/workspace/taskMetadata', () => ({ firstReferenceImageName: vi.fn(() => '') }));

import { POST } from './route';

const params = { params: Promise.resolve({ id: 'account-1' }) };

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/workspace/accounts/account-1/generate-prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('generate-prompt provider error mapping', () => {
  beforeEach(() => {
    mockRequireApiRole.mockResolvedValue({ role: 'admin', username: 'admin' });
    mockCanAccessWorkspaceAccount.mockReturnValue(true);
    mockGetProviderConfig.mockImplementation((id: string) => ({ model: id === 'bigsnake-prompt' ? 'gpt-5.5' : 'gemini-2.5-flash' }));
    mockCreateProviderTask.mockReturnValue({ id: 'prompt-task-1', provider: 'bigsnake-prompt', model: 'gpt-5.5', status: 'completed' });
    mockGenerateBigSnakePrompt.mockReset();
    mockGenerateGPTPrompt.mockReset();
    mockGenerateGeminiPrompt.mockReset();
  });

  it('identifies BigSnake when an unclassified provider error occurs', async () => {
    mockGenerateBigSnakePrompt.mockRejectedValue(new Error('socket hang up'));

    const response = await POST(request({ title: 'demo', promptModel: 'bigsnake' }), params);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'prompt_provider_failed',
      provider: 'bigsnake-prompt',
      providerName: 'BigSnake',
      model: 'gpt-5.5',
      requestedPromptModel: 'bigsnake',
      providerResponse: { code: 'socket hang up' },
    });
    expect(mockGenerateBigSnakePrompt).toHaveBeenCalledTimes(1);
    expect(mockGenerateGPTPrompt).not.toHaveBeenCalled();
  });

  it('preserves a stable provider error code and selected supplier context', async () => {
    mockGenerateBigSnakePrompt.mockRejectedValue(new Error('provider_401'));

    const response = await POST(request({ title: 'demo', promptModel: 'bigsnake' }), params);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'provider_401',
      provider: 'bigsnake-prompt',
      providerName: 'BigSnake',
      providerResponse: { code: 'provider_401' },
    });
  });

  it('keeps GPT-2999 context when that alias is selected', async () => {
    mockGenerateGPTPrompt.mockRejectedValue(new Error('socket hang up'));

    const response = await POST(request({ title: 'demo', promptModel: 'gpt-2999' }), params);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'prompt_provider_failed',
      provider: 'gpt-2999-prompt',
      providerName: 'GPT-2999',
      requestedPromptModel: 'gpt-2999',
    });
  });

  it('enforces auth before invoking a prompt provider', async () => {
    mockRequireApiRole.mockResolvedValue(NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 }));
    const response = await POST(request({ title: 'demo', promptModel: 'bigsnake' }), params);
    expect(response.status).toBe(403);
    expect(mockGenerateBigSnakePrompt).not.toHaveBeenCalled();
  });
});
