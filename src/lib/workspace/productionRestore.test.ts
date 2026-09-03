import { describe, expect, it } from 'vitest';
import { productionRestoreConfig, productionRestoreHref } from './productionRestore';

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task/1',
    accountId: 'account-1',
    mode: 'video',
    provider: 'quality-v4',
    model: 'quality-v4',
    prompt: 'final provider prompt',
    status: 'failed',
    progress: 100,
    outputUrls: [],
    outputBase64: [],
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  } as never;
}

describe('production task configuration restore', () => {
  it('restores durable form fields and excludes bridge tokens', () => {
    const restored = productionRestoreConfig(task({ metadata: {
      modelId: 'quality-v4', supplierId: 'quality-v4', promptMode: 'asset-template-child-prompt',
      promptModel: 'gpt-2999', templateId: 'template-1', originalPrompt: 'product context',
      childPrompt: 'child', finalPrompt: 'final', suffixEnabled: true, suffix: 'suffix', count: 2,
      duration: 10, aspectRatio: '9:16', resolution: '720p', pid: 'PID-1',
      referenceAssetIds: ['image-1', 'image-1'], referenceVideoAssetIds: ['video-1'],
      referenceAudioAssetIds: ['audio-1'], productImageAssetIds: ['product-1'],
      referenceAssetOrder: [{ id: 'product-1', kind: 'product-image' }, { id: 'image-1', kind: 'image' }],
      externalReferenceImages: ['https://example.com/a.jpg'], referenceTokens: ['secret-token'],
    } }));

    expect(restored).toMatchObject({
      prompt: 'product context', provider: 'quality-v4', modelId: 'quality-v4',
      promptMode: 'asset-template-child-prompt', count: 2, duration: 10,
      referenceAssetIds: ['image-1'], referenceVideoAssetIds: ['video-1'],
      referenceAudioAssetIds: ['audio-1'], productImageAssetIds: ['product-1'],
      referenceAssetOrder: [{ id: 'product-1', kind: 'product-image' }, { id: 'image-1', kind: 'image' }],
      externalReferenceImages: ['https://example.com/a.jpg'],
    });
    expect(restored).not.toHaveProperty('referenceTokens');
  });

  it('restores legacy assetIds and uses safe defaults for missing metadata', () => {
    const restored = productionRestoreConfig(task({ mode: 'image', metadata: { assetIds: ['image-1'] } }));
    expect(restored).toMatchObject({ prompt: 'final provider prompt', promptMode: 'manual', count: 1, referenceAssetIds: ['image-1'] });
  });

  it('builds an encoded account-scoped restore URL', () => {
    expect(productionRestoreHref('account/1', task())).toBe('/workspace/accounts/account%2F1/production?mode=video&restoreTaskId=task%2F1');
  });
});
