import type { ProviderId } from '@/lib/providers/config';
import { validateGenerationRequest } from '@/lib/providers/validation';
import type { VideoCapability } from '@/lib/workspace/production/video-capabilities';
import { validateVideoCapability } from '@/lib/workspace/production/video-capabilities';

export type PromptMode = 'manual' | 'asset-template-child-prompt';

export type ProductionFormValues = {
  prompt: string;
  provider?: ProviderId | string;
  model?: string;
  modelId?: string;
  supplierId?: string;
  promptMode?: PromptMode;
  promptModel?: string;
  templateId?: string;
  childPrompt?: string;
  finalPrompt?: string;
  originalPrompt?: string;
  suffixEnabled?: boolean;
  suffix?: string;
  count?: number;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  referenceImages?: readonly string[];
  referenceVideos?: readonly string[];
  referenceAudios?: readonly string[];
  assetIds?: readonly string[];
  referenceAssetIds?: readonly string[];
  referenceVideoAssetIds?: readonly string[];
  referenceAudioAssetIds?: readonly string[];
  productImageAssetIds?: readonly string[];
  referenceImageCount?: number;
  referenceVideoCount?: number;
  referenceAudioCount?: number;
  pid?: string;
};

export function normalizeReferenceList(value: string): string[] {
  return value.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean);
}

export function validateProductionInput(
  mode: 'image' | 'prompt' | 'video',
  values: Pick<ProductionFormValues, 'prompt' | 'provider' | 'referenceImages' | 'referenceVideos' | 'referenceAudios' | 'duration' | 'aspectRatio' | 'resolution'> & Pick<ProductionFormValues, 'referenceImageCount' | 'referenceVideoCount' | 'referenceAudioCount'>,
  capability?: VideoCapability,
): Error | null {
  if (!values.prompt.trim()) return new Error(mode === 'prompt' ? '请输入商品上下文或提示词' : '请输入提示词');
  const images = values.referenceImages ?? [];
  const videos = values.referenceVideos ?? [];
  const audios = values.referenceAudios ?? [];
  const imageCount = values.referenceImageCount ?? images.length;
  const videoCount = values.referenceVideoCount ?? videos.length;
  const audioCount = values.referenceAudioCount ?? audios.length;
  if (mode === 'video' && capability) {
    try {
      validateVideoCapability(capability, {
        duration: values.duration ?? 0,
        aspectRatio: values.aspectRatio ?? '',
        resolution: values.resolution ?? '',
        referenceCount: imageCount,
        referenceVideoCount: videoCount,
        referenceAudioCount: audioCount,
      });
    } catch (error) {
      return error instanceof Error ? error : new Error('视频参数不符合模型能力');
    }
    return null;
  }
  try {
    if (mode !== 'prompt' && values.provider) {
      validateGenerationRequest({
        provider: values.provider as ProviderId,
        duration: values.duration,
        aspectRatio: values.aspectRatio,
        resolution: values.resolution,
        referenceImages: images,
        referenceVideos: videos,
        referenceAudios: audios,
      });
    }
  } catch (error) {
    return error instanceof Error ? error : new Error('生产参数无效');
  }
  return null;
}

export function buildGenerationPayload(mode: 'image' | 'prompt' | 'video', values: ProductionFormValues): Record<string, unknown> {
  if (mode === 'prompt') return { title: values.prompt, prompt: values.prompt, promptMode: values.promptMode ?? 'manual', templateId: values.templateId, promptModel: values.promptModel };
  const prompt = (values.finalPrompt || values.childPrompt || values.prompt).trim();
  return {
    prompt,
    originalPrompt: values.originalPrompt ?? values.prompt,
    finalPrompt: values.finalPrompt ?? prompt,
    provider: values.provider,
    model: values.model,
    modelId: values.modelId,
    supplierId: values.supplierId ?? values.provider,
    promptMode: values.promptMode ?? 'manual',
    promptModel: values.promptModel,
    templateId: values.templateId,
    childPrompt: values.childPrompt,
    suffixEnabled: values.suffixEnabled ?? false,
    suffix: values.suffix,
    count: Math.min(4, Math.max(1, Math.round(values.count ?? 1))),
    duration: values.duration,
    aspectRatio: values.aspectRatio,
    resolution: values.resolution,
    referenceImages: [...(values.referenceImages ?? [])],
    referenceVideos: [...(values.referenceVideos ?? [])],
    referenceAudios: [...(values.referenceAudios ?? [])],
    assetIds: [...(values.assetIds ?? [])],
    referenceAssetIds: [...(values.referenceAssetIds ?? [])],
    referenceVideoAssetIds: [...(values.referenceVideoAssetIds ?? [])],
    referenceAudioAssetIds: [...(values.referenceAudioAssetIds ?? [])],
    productImageAssetIds: [...(values.productImageAssetIds ?? [])],
    ...(values.pid?.trim() ? { pid: values.pid.trim() } : {}),
  };
}
