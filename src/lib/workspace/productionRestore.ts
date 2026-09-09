import type { ProviderId } from '@/lib/providers/config';
import type { ProviderTask, ProviderTaskMode } from '@/lib/providers/taskStore';
import type { TaskNameMode } from './taskNaming';

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
  taskNameMode?: TaskNameMode;
  taskName?: string;
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
  const explicitReferenceAssetIds = stringList(metadata.referenceAssetIds);
  const explicitReferenceVideoAssetIds = stringList(metadata.referenceVideoAssetIds);
  const explicitReferenceAudioAssetIds = stringList(metadata.referenceAudioAssetIds);
  const explicitProductImageAssetIds = stringList(metadata.productImageAssetIds);
  const legacyAssetIds = stringList(metadata.assetIds);
  const referenceAssetOrder = assetOrder(metadata.referenceAssetOrder);
  // Some pre-order task records only persisted the ordered selection. Recover
  // those IDs by kind before falling back to the older generic assetIds field.
  const orderedReferenceAssetIds = referenceAssetOrder.filter((item) => item.kind === 'image').map((item) => item.id);
  const orderedReferenceVideoAssetIds = referenceAssetOrder.filter((item) => item.kind === 'inventory-video').map((item) => item.id);
  const orderedReferenceAudioAssetIds = referenceAssetOrder.filter((item) => item.kind === 'audio').map((item) => item.id);
  const orderedProductImageAssetIds = referenceAssetOrder.filter((item) => item.kind === 'product-image').map((item) => item.id);

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
    ...(metadata.taskNameMode === 'auto' || metadata.taskNameMode === 'manual' ? { taskNameMode: metadata.taskNameMode } : {}),
    ...(text(metadata.taskName) ? { taskName: text(metadata.taskName) } : {}),
    // Older image tasks only persisted `assetIds`; retain them as image
    // references while preferring the newer kind-specific fields.
    referenceAssetIds: unique(explicitReferenceAssetIds.length ? explicitReferenceAssetIds : orderedReferenceAssetIds.length ? orderedReferenceAssetIds : legacyAssetIds),
    referenceVideoAssetIds: unique(explicitReferenceVideoAssetIds.length ? explicitReferenceVideoAssetIds : orderedReferenceVideoAssetIds),
    referenceAudioAssetIds: unique(explicitReferenceAudioAssetIds.length ? explicitReferenceAudioAssetIds : orderedReferenceAudioAssetIds),
    productImageAssetIds: unique(explicitProductImageAssetIds.length ? explicitProductImageAssetIds : orderedProductImageAssetIds),
    referenceAssetOrder,
    externalReferenceImages: unique(stringList(metadata.externalReferenceImages)),
    externalReferenceVideos: unique(stringList(metadata.externalReferenceVideos)),
    externalReferenceAudios: unique(stringList(metadata.externalReferenceAudios)),
  };
}

export function productionRestoreHref(accountId: string, task: Pick<ProviderTask, 'id' | 'mode'>): string {
  return `/workspace/accounts/${encodeURIComponent(accountId)}/production?mode=${encodeURIComponent(task.mode)}&restoreTaskId=${encodeURIComponent(task.id)}`;
}
