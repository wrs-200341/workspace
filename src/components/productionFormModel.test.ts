import { describe, expect, it } from 'vitest';
import { getVideoCapability } from '@/lib/workspace/production/video-capabilities';
import { buildGenerationPayload, normalizeReferenceList, validateProductionInput } from './productionFormModel';
import { modelIdForVideoProvider, providerOptionsForVideoModel, providersForVideoModel, VIDEO_MODELS, videoModelsForProvider } from './ProductionForm';

describe('production form historical fields', () => {
  it('lists Quality V4 independently and routes sd-mini through snumom Grok', () => {
    expect(VIDEO_MODELS).toEqual(expect.arrayContaining([{ id: 'quality-v4', label: 'Quality V4' }]));
    const providers = providersForVideoModel([
      { id: 'grok-video', name: 'Grok / snumom', kind: 'video', model: 'grok', baseUrl: 'https://snumom.com/v1', liveEnv: 'GROK_VIDEO_API_KEY', supports: { referenceImages: 7, referenceAudios: 0, ratios: [], resolutions: [] } },
      { id: 'mgrouter-grok-video', name: 'MGRouter', kind: 'video', model: 'grok', baseUrl: 'https://raw.mgrouter.com/v1', liveEnv: 'MGROUTER_API_KEY', supports: { referenceImages: 7, referenceAudios: 2, ratios: [], resolutions: [] } },
      { id: 'quality-v4', name: 'Quality V4', kind: 'video', model: 'quality-v4', baseUrl: 'https://video2.crack.cc.cd', liveEnv: 'QUALITY_V4_API_KEY', supports: { referenceImages: 9, referenceVideos: 3, referenceAudios: 3, ratios: [], resolutions: [] } },
    ], 'quality-v4');
    expect(providers.map((item) => item.id)).toEqual(['quality-v4']);
    expect(videoModelsForProvider('quality-v4').map((item) => item.id)).toEqual(['quality-v4']);
    expect(providersForVideoModel([
      { id: 'grok-video', name: 'Grok / snumom', kind: 'video', model: 'grok', baseUrl: 'https://snumom.com/v1', liveEnv: 'GROK_VIDEO_API_KEY', supports: { referenceImages: 7, referenceAudios: 0, ratios: [], resolutions: [] } },
    ], 'sd-mini').map((item) => item.id)).toEqual(['grok-video']);
    expect(modelIdForVideoProvider('grok-video', 'sd-mini')).toBe('sd-mini');
  });

  it('keeps supplier-specific Grok model ids isolated', () => {
    expect(videoModelsForProvider('grok-video').map((item) => item.id)).toEqual([
      'grok-imagine-video-1.5（按次）',
      'grok-video-1.5（按秒）',
    ]);
    expect(videoModelsForProvider('mgrouter-grok-video').map((item) => item.id)).toEqual([
      'grok-imagine-video-1.5',
      'grok-imagine-video-1.5-preview',
    ]);
    expect(modelIdForVideoProvider('mgrouter-grok-video', 'grok-imagine-video-1.5（按次）')).toBe('grok-imagine-video-1.5');
    expect(modelIdForVideoProvider('grok-video', 'grok-video-1.5（按秒）')).toBe('grok-video-1.5（按秒）');
    const catalog = [
      { id: 'grok-video', name: 'Grok / snumom', kind: 'video', model: 'grok', baseUrl: 'https://snumom.com/v1', liveEnv: 'GROK_VIDEO_API_KEY', supports: { referenceImages: 7, referenceAudios: 0, ratios: [], resolutions: [] } },
      { id: 'mgrouter-grok-video', name: 'Grok / MGRouter', kind: 'video', model: 'grok-imagine-video-1.5', baseUrl: 'https://raw.mgrouter.com/v1', liveEnv: 'MGROUTER_API_KEY', supports: { referenceImages: 7, referenceAudios: 2, ratios: [], resolutions: [] } },
    ] as const;
    expect(providerOptionsForVideoModel(catalog, 'grok-imagine-video-1.5').map((item) => item.id)).toEqual(['grok-video', 'mgrouter-grok-video']);
  });

  it('uses the secure-skill MiniMax H3 model id for new video requests', () => {
    expect(modelIdForVideoProvider('minimax-h3')).toBe('minimax-h3');
    expect(videoModelsForProvider('minimax-h3').map((item) => item.id)).toEqual(['minimax-h3']);
    expect(providersForVideoModel([
      { id: 'minimax-h3', name: 'MiniMax H3', kind: 'video', model: 'minimax-h3', baseUrl: 'https://token.secure-skill.com', liveEnv: 'MINIMAX_API_KEY', supports: { referenceImages: 5, referenceAudios: 3, ratios: [], resolutions: [] } },
    ], 'minimax-h3').map((item) => item.id)).toEqual(['minimax-h3']);
  });

  it('lists Omni and routes the model only to its OAIRegBox supplier', () => {
    expect(VIDEO_MODELS).toEqual(expect.arrayContaining([{ id: 'omni-fast-no-water', label: 'Omni Fast No Water' }]));
    const providers = providersForVideoModel([
      { id: 'oairegbox-omni', name: 'OAIRegBox Omni', kind: 'video', model: 'omni-fast-no-water', baseUrl: 'https://newapi-2.oairegbox.cc/v1', liveEnv: 'OAIREGBOX_API_KEY', supports: { referenceImages: 1, referenceAudios: 0, ratios: ['9:16', '16:9'], resolutions: ['720p'] } },
      { id: 'grok-video', name: 'Grok / snumom', kind: 'video', model: 'grok', baseUrl: 'https://snumom.com/v1', liveEnv: 'GROK_VIDEO_API_KEY', supports: { referenceImages: 7, referenceAudios: 0, ratios: [], resolutions: [] } },
    ], 'omni-fast-no-water');
    expect(providers.map((item) => item.id)).toEqual(['oairegbox-omni']);
  });
  it('normalizes URL or pasted asset lists without mutating input', () => {
    const source = ' https://assets.example/a.jpg,\nhttps://assets.example/b.jpg  ';
    expect(normalizeReferenceList(source)).toEqual(['https://assets.example/a.jpg', 'https://assets.example/b.jpg']);
    expect(source).toBe(' https://assets.example/a.jpg,\nhttps://assets.example/b.jpg  ');
  });

  it('builds the recovered supplier/model and prompt automation payload', () => {
    const payload = buildGenerationPayload('video', {
      prompt: 'hero product',
      provider: 'grok-video',
      model: 'grok-imagine-video-1.5（按次）',
      modelId: 'grok',
      supplierId: 'grok-video',
      promptMode: 'asset-template-child-prompt',
      promptModel: 'gpt-2999',
      templateId: 'tpl-1',
      childPrompt: 'camera movement',
      finalPrompt: 'hero product camera movement',
      originalPrompt: 'hero product',
      suffixEnabled: true,
      suffix: '统一后缀',
      count: 3,
      duration: 10,
      aspectRatio: '9:16',
      resolution: '720p',
      referenceImages: ['https://assets.example/a.jpg'],
      referenceVideos: [],
      referenceAudios: ['https://assets.example/voice.wav'],
      assetIds: ['asset-1'],
      productImageAssetIds: ['product-image:account-1:2026-09-02:P1:001.jpg'],
      pid: 'PID-1',
    });
    expect(payload).toEqual(expect.objectContaining({
      provider: 'grok-video',
      model: 'grok-imagine-video-1.5（按次）',
      modelId: 'grok',
      supplierId: 'grok-video',
      promptMode: 'asset-template-child-prompt',
      promptModel: 'gpt-2999',
      templateId: 'tpl-1',
      suffixEnabled: true,
      count: 3,
      referenceImages: ['https://assets.example/a.jpg'],
      referenceAudios: ['https://assets.example/voice.wav'],
    }));
  });

  it('keeps the picker order for interleaved material and product images', () => {
    const payload = buildGenerationPayload('image', {
      prompt: 'combine image 1 and image 2',
      provider: 'yuanai-image',
      model: 'gpt-image-2',
      referenceAssetOrder: [
        { id: 'product-1', kind: 'product-image' },
        { id: 'material-1', kind: 'image' },
      ],
      referenceAssetIds: ['material-1'],
      productImageAssetIds: ['product-1'],
    });
    expect(payload.referenceAssetOrder).toEqual([
      { id: 'product-1', kind: 'product-image' },
      { id: 'material-1', kind: 'image' },
    ]);
  });

  it('validates references against the selected model capability', () => {
    const capability = getVideoCapability('wan3-video', 'wan3.0-prime-r2v');
    expect(validateProductionInput('video', {
      prompt: 'demo',
      referenceImages: Array.from({ length: 11 }, (_, index) => `https://assets.example/${index}.jpg`),
      referenceVideos: [],
      referenceAudios: [],
      duration: 10,
      aspectRatio: '9:16',
      resolution: '720P',
    }, capability)).toMatchObject({ code: 'VIDEO_CAPABILITY_INVALID' });
  });
});
