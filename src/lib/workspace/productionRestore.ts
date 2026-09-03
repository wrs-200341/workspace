import type { ProviderId } from '@/lib/providers/config';
import type { ProviderTask, ProviderTaskMode } from '@/lib/providers/taskStore';

export type ProductionRestoreConfig = {
  taskId: string;
  mode: ProviderTaskMode;
  provider: ProviderId;
  model?: string;
  modelId?: string;
  supplierId?: string;
  prompt: string;
  originalPrompt: string;
  childPrompt?: string;
  finalPrompt?: string;
  promptMode: 'manual' | 'asset-template-child-prompt';
  promptModel?: string;
  templateId?: string;
  suffixEnabled: boolean;
  suffix?: string;
  count: number;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  pid?: string;
  referenceAssetIds: string[];
  referenceVideoAssetIds: string[];
  referenceAudioAssetIds: string[];
  productImageAssetIds: string[];
  referenceAssetOrder: Array<{ id: string; kind: 'image' | 'product-image' | 'inventory-video' | 'audio' }>;
  externalReferenceImages: string[];
  externalReferenceVideos: string[];
  externalReferenceAudios: string[];
};

const MAX_RESTORED_REFERENCES = 16;
const MAX_TEXT_LENGTH = 32_000;

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, MAX_TEXT_LENGTH) : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, MAX_TEXT_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_RESTORED_REFERENCES);
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function assetOrder(value: unknown): Array<{ id: string; kind: 'image' | 'product-image' | 'inventory-video' | 'audio' }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { id: unknown; kind: unknown } => Boolean(item && typeof item === 'object'))
    .map((item) => ({ id: text(item.id), kind: item.kind }))
    .filter((item): item is { id: string; kind: 'image' | 'product-image' | 'inventory-video' | 'audio' } => Boolean(item.id) && ['image', 'product-image', 'inventory-video', 'audio'].includes(String(item.kind)))
    .map((item) => ({ id: item.id, kind: item.kind as 'image' | 'product-image' | 'inventory-video' | 'audio' }))
    .slice(0, MAX_RESTORED_REFERENCES);
}

/**
 * Convert a persisted task into form state. Ephemeral reference bridge tokens
 * and provider response data are intentionally excluded from the result.
 */
export function productionRestoreConfig(task: ProviderTask): ProductionRestoreConfig {
  const metadata = task.metadata ?? {};
  const originalPrompt = text(metadata.originalPrompt) ?? text(task.prompt) ?? '';
  const referenceAssetIds = stringList(metadata.referenceAssetIds);
  const referenceVideoAssetIds = stringList(metadata.referenceVideoAssetIds);
  const referenceAudioAssetIds = stringList(metadata.referenceAudioAssetIds);
  const productImageAssetIds = stringList(metadata.productImageAssetIds);
  const legacyAssetIds = stringList(metadata.assetIds);
  const referenceAssetOrder = assetOrder(metadata.referenceAssetOrder);

  return {
    taskId: task.id,
    mode: task.mode,
    provider: task.provider,
    ...(text(task.model) ? { model: text(task.model) } : {}),
    ...(text(metadata.modelId) || text(task.model) ? { modelId: text(metadata.modelId) ?? text(task.model) } : {}),
    ...(text(metadata.supplierId) || task.provider ? { supplierId: text(metadata.supplierId) ?? task.provider } : {}),
    prompt: originalPrompt,
    originalPrompt,
    ...(text(metadata.childPrompt) ? { childPrompt: text(metadata.childPrompt) } : {}),
    ...(text(metadata.finalPrompt) ? { finalPrompt: text(metadata.finalPrompt) } : {}),
    promptMode: metadata.promptMode === 'asset-template-child-prompt' ? 'asset-template-child-prompt' : 'manual',
    ...(text(metadata.promptModel) ? { promptModel: text(metadata.promptModel) } : {}),
    ...(text(metadata.templateId) ? { templateId: text(metadata.templateId) } : {}),
    suffixEnabled: metadata.suffixEnabled === true,
    ...(text(metadata.suffix) ? { suffix: text(metadata.suffix) } : {}),
    count: Math.min(4, Math.max(1, Math.round(positiveNumber(metadata.count) ?? 1))),
    ...(positiveNumber(metadata.duration) ? { duration: Math.round(positiveNumber(metadata.duration)!) } : {}),
    ...(text(metadata.aspectRatio) ? { aspectRatio: text(metadata.aspectRatio) } : {}),
    ...(text(metadata.resolution) ? { resolution: text(metadata.resolution) } : {}),
    ...(text(metadata.pid) ? { pid: text(metadata.pid) } : {}),
    // Older image tasks only persisted `assetIds`; retain them as image
    // references while preferring the newer kind-specific fields.
    referenceAssetIds: unique(referenceAssetIds.length ? referenceAssetIds : legacyAssetIds),
    referenceVideoAssetIds: unique(referenceVideoAssetIds),
    referenceAudioAssetIds: unique(referenceAudioAssetIds),
    productImageAssetIds: unique(productImageAssetIds),
    referenceAssetOrder,
    externalReferenceImages: unique(stringList(metadata.externalReferenceImages)),
    externalReferenceVideos: unique(stringList(metadata.externalReferenceVideos)),
    externalReferenceAudios: unique(stringList(metadata.externalReferenceAudios)),
  };
}

export function productionRestoreHref(accountId: string, task: Pick<ProviderTask, 'id' | 'mode'>): string {
  return `/workspace/accounts/${encodeURIComponent(accountId)}/production?mode=${encodeURIComponent(task.mode)}&restoreTaskId=${encodeURIComponent(task.id)}`;
}
