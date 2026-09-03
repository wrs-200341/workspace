import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireApiRole, mockCanAccessWorkspaceAccount, mockGetProviderTask, mockUpdateProviderTask, mockSaveImageTaskOutputsToAssets, mockListImageTaskInventoryAssets } = vi.hoisted(() => ({
  mockRequireApiRole: vi.fn(),
  mockCanAccessWorkspaceAccount: vi.fn(),
  mockGetProviderTask: vi.fn(),
  mockUpdateProviderTask: vi.fn(),
  mockSaveImageTaskOutputsToAssets: vi.fn(),
  mockListImageTaskInventoryAssets: vi.fn(),
}));

vi.mock('@/lib/auth/server', () => ({ requireApiRole: mockRequireApiRole }));
vi.mock('@/lib/workspace/access', () => ({ canAccessWorkspaceAccount: mockCanAccessWorkspaceAccount }));
vi.mock('@/lib/providers/taskStore', () => ({ getProviderTask: mockGetProviderTask, updateProviderTask: mockUpdateProviderTask, deleteProviderTask: vi.fn() }));
vi.mock('@/lib/workspace/taskActions', () => ({ applyTaskAction: vi.fn() }));
vi.mock('@/lib/workspace/serverTasks', () => ({ getServerWorkspaceTasks: vi.fn(() => []) }));
vi.mock('@/lib/workspace/productionRestore', () => ({ productionRestoreConfig: vi.fn() }));
vi.mock('@/lib/workspace/imageInventory', () => ({ saveImageTaskOutputsToAssets: mockSaveImageTaskOutputsToAssets, listImageTaskInventoryAssets: mockListImageTaskInventoryAssets }));

import { POST } from './route';

const task = {
  id: 'image-task-1', accountId: 'account-1', mode: 'image', provider: 'mgrouter-grok-image',
  model: 'grok-image', prompt: 'product', status: 'completed', progress: 100,
  outputUrls: ['https://example.com/output.png'], outputBase64: [],
  metadata: {}, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
};
const params = { params: Promise.resolve({ id: 'account-1', taskId: 'image-task-1' }) };

describe('image task inventory API', () => {
  beforeEach(() => {
    mockRequireApiRole.mockResolvedValue({ role: 'operator', username: 'operator' });
    mockCanAccessWorkspaceAccount.mockReturnValue(true);
    mockGetProviderTask.mockReset().mockReturnValue({ ...task });
    mockUpdateProviderTask.mockReset().mockReturnValue({ ...task, inventorySavedAt: '2026-09-03T00:00:00.000Z', metadata: { inventoryAssetIds: ['asset-1'] } });
    mockSaveImageTaskOutputsToAssets.mockReset().mockResolvedValue([{ id: 'asset-1', kind: 'image' }]);
    mockListImageTaskInventoryAssets.mockReset().mockReturnValue([]);
  });

  it('persists generated image assets and links them from the task metadata', async () => {
    const response = await POST(new NextRequest('http://localhost/api/workspace/accounts/account-1/image-tasks/image-task-1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save-inventory' }),
    }), params);
    expect(response.status).toBe(200);
    expect(mockSaveImageTaskOutputsToAssets).toHaveBeenCalledWith('account-1', expect.objectContaining({ id: 'image-task-1', status: 'completed' }));
    expect(mockUpdateProviderTask).toHaveBeenCalledWith('image-task-1', expect.objectContaining({ inventorySavedAt: expect.any(String), metadata: { inventoryAssetIds: ['asset-1'] } }));
  });

  it('keeps the task unmarked when no output asset could be saved', async () => {
    mockSaveImageTaskOutputsToAssets.mockResolvedValue([]);
    const response = await POST(new NextRequest('http://localhost/api/workspace/accounts/account-1/image-tasks/image-task-1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save-inventory' }),
    }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: 'image_outputs_unavailable' });
    expect(mockUpdateProviderTask).not.toHaveBeenCalled();
  });

  it('checks authorization before opening task or writing assets', async () => {
    mockRequireApiRole.mockResolvedValue(NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 }));
    const response = await POST(new NextRequest('http://localhost/api/workspace/accounts/account-1/image-tasks/image-task-1', { method: 'POST', body: JSON.stringify({ action: 'save-inventory' }) }), params);
    expect(response.status).toBe(403);
    expect(mockGetProviderTask).not.toHaveBeenCalled();
    expect(mockSaveImageTaskOutputsToAssets).not.toHaveBeenCalled();
  });
});
