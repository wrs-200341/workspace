import { generateBigSnakePrompt, generateGeminiPrompt, generateGPTPrompt, generateOAIRegboxGPTPrompt, generatePromptWithFallback, normalizeProviderResponse, providerErrorInfo, providerResponseSnapshot, sanitizeProviderError, submitVideoWithFallback } from '@/lib/providers/client';
import { getProviderConfig, isProviderLiveEnabled, type ProviderId } from '@/lib/providers/config';
import { flushProviderTaskStore, getProviderTask, updateProviderTask, type ProviderTask, type ProviderTaskPatch } from '@/lib/providers/taskStore';
import { publishAssetReferences } from '@/lib/workspace/referenceBridge';
import { processMockProviderTask } from '@/lib/providers/taskProcessor';
import { getDefaultProductionAspectRatio, getDefaultProductionDuration, getDefaultVideoResolution } from '@/lib/workspace/production/defaults';
import { publishProductImageReferences } from '@/lib/workspace/productImages';
import { getProductImageAbsolutePath, listProductImageAssets } from '@/lib/workspace/productImages';
import { listAssets, readAssetFile } from '@/lib/workspace/assetStore';
import fs from 'node:fs';
import { appendProductSummary, lookupProductSummary } from '@/lib/workspace/productSummary';
import { cacheVideoTaskOutputsBeforeCompletion } from '@/lib/workspace/videoInventory';
import { canonicalTaskProgress } from '@/lib/providers/taskProgress';
import type { GPTPromptAttachment } from '@/lib/providers/payloads';

type VideoProvider = 'grok-video' | 'yuanai-grok-video' | 'mgrouter-grok-video' | 'wan3-video' | 'wan-3-nsfw' | 'minimax-h3' | 'miku-minimax' | 'pro666-video' | 'quality-v4' | 'oairegbox-omni';
const VIDEO_PROVIDERS: readonly VideoProvider[] = ['grok-video', 'yuanai-grok-video', 'mgrouter-grok-video', 'wan3-video', 'wan-3-nsfw', 'minimax-h3', 'miku-minimax', 'pro666-video', 'quality-v4', 'oairegbox-omni'];

function updateCurrentVideoTask(taskId: string, patchFor: (task: ProviderTask) => ProviderTaskPatch | null): ProviderTask | null {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const task = getProviderTask(taskId);
    if (!task) return null;
    const patch = patchFor(task);
    if (!patch) return null;
    const updated = updateProviderTask(taskId, patch, task.updatedAt);
    if (updated) return updated;
  }
  throw new Error('provider_task_update_conflict');
}

function metadataStrings(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function metadataText(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && Number.isFinite(Number(value)) ? Number(value) : undefined;
}

/**
 * Rebuild a scheduler callback from a persisted task after a process restart.
 * Only the safe-recovery API calls this function, and only for tasks that have
 * no upstream provider id. The original task id is retained so the queue does
 * not show a duplicate logical task.
 */
export async function executePersistedVideoTask(taskId: string): Promise<void> {
  const task = getProviderTask(taskId);
  if (!task || task.mode !== 'video' || ['completed', 'cancelled', 'paused'].includes(task.status) || task.providerTaskId || task.metadata?.providerAcceptedAt || task.outputUrls.length || task.outputBase64.length) return;
  if (task.metadata?.providerSubmissionStartedAt || task.metadata?.providerSubmissionUncertain) {
    updateProviderTask(taskId, { status: 'failed', progress: 100, error: 'provider_submission_uncertain', metadata: { ...(task.metadata ?? {}), providerSubmissionUncertain: true, schedulerRetryExhausted: true } });
    await flushProviderTaskStore();
    return;
  }
  if (!VIDEO_PROVIDERS.includes(task.provider as VideoProvider)) throw new Error('unsupported_provider');
  const metadata = task.metadata ?? {};
  const schedulerWorkerId = metadataText(metadata, 'schedulerWorkerId');
  const provider = task.provider as VideoProvider;
  const config = getProviderConfig(provider);
  const model = task.model || metadataText(metadata, 'modelId') || config.model;
  const referenceAssetIds = metadataStrings(metadata, 'referenceAssetIds').length ? metadataStrings(metadata, 'referenceAssetIds') : metadataStrings(metadata, 'assetIds');
  const referenceVideoAssetIds = metadataStrings(metadata, 'referenceVideoAssetIds');
  const referenceAudioAssetIds = metadataStrings(metadata, 'referenceAudioAssetIds');
  const productImageAssetIds = metadataStrings(metadata, 'productImageAssetIds');
  const referenceAssetOrder = parseAssetOrder(metadata.referenceAssetOrder);
  const orderedImages = (referenceAssetOrder.length
    ? referenceAssetOrder.filter((item) => item.kind === 'image' || item.kind === 'product-image')
    : [...referenceAssetIds.map((id) => ({ id, kind: 'image' as const })), ...productImageAssetIds.map((id) => ({ id, kind: 'product-image' as const }))])
    .filter((item) => referenceAssetIds.includes(item.id) || productImageAssetIds.includes(item.id));
  const orderedReferenceAssetIds = orderedImages.filter((item) => item.kind === 'image').map((item) => item.id);
  const orderedProductImageAssetIds = orderedImages.filter((item) => item.kind === 'product-image').map((item) => item.id);
  const externalImages = metadataStrings(metadata, 'externalReferenceImages');
  const externalVideos = metadataStrings(metadata, 'externalReferenceVideos');
  const externalAudios = metadataStrings(metadata, 'externalReferenceAudios');
  const live = isProviderLiveEnabled(provider);
  try {
    const publishedMedia = live ? publishAssetReferences([
      ...orderedReferenceAssetIds.map((assetId) => ({ accountId: task.accountId, assetId, allowedKinds: ['image'] as const })),
      ...referenceVideoAssetIds.map((assetId) => ({ accountId: task.accountId, assetId, allowedKinds: ['inventory-video'] as const })),
      ...referenceAudioAssetIds.map((assetId) => ({ accountId: task.accountId, assetId, allowedKinds: ['audio'] as const })),
    ]) : [];
    const publishedImages = publishedMedia.slice(0, orderedReferenceAssetIds.length);
    const publishedVideos = publishedMedia.slice(orderedReferenceAssetIds.length, orderedReferenceAssetIds.length + referenceVideoAssetIds.length);
    const publishedAudios = publishedMedia.slice(orderedReferenceAssetIds.length + referenceVideoAssetIds.length);
    const publishedProducts = live ? publishProductImageReferences(orderedProductImageAssetIds, task.accountId) : [];
    const imageById = new Map<string, string>();
    orderedReferenceAssetIds.forEach((id, index) => { if (publishedImages[index]) imageById.set(id, publishedImages[index].url); });
    orderedProductImageAssetIds.forEach((id, index) => { if (publishedProducts[index]) imageById.set(id, publishedProducts[index].url); });
    const referenceImages = [...externalImages, ...orderedImages.map((item) => imageById.get(item.id)).filter((value): value is string => Boolean(value))];
    const referenceVideos = [...externalVideos, ...publishedVideos.map((item) => item.url)];
    const referenceAudios = [...externalAudios, ...publishedAudios.map((item) => item.url)];
    const referenceFiles = provider === 'oairegbox-omni'
      ? orderedImages.map((item) => {
        if (item.kind === 'image') {
          const record = readAssetFile(task.accountId, item.id);
          if (!record) throw new Error('reference_asset_not_found');
          return { bytes: new Uint8Array(record.bytes), mimeType: record.asset.mimeType || 'application/octet-stream', fileName: record.asset.name };
        }
        const product = listProductImageAssets().find((candidate) => candidate.id === item.id);
        if (!product) throw new Error('reference_asset_not_found');
        return { bytes: new Uint8Array(fs.readFileSync(getProductImageAbsolutePath(item.id))), mimeType: product.mimeType, fileName: product.name };
      })
      : undefined;
    const duration = metadataNumber(metadata, 'duration') ?? getDefaultProductionDuration(config.supports.durations);
    const aspectRatio = metadataText(metadata, 'aspectRatio') ?? getDefaultProductionAspectRatio(config.supports.ratios);
    const resolution = metadataText(metadata, 'resolution') ?? getDefaultVideoResolution(config.supports.resolutions);
    const automaticPrompt = metadata.promptMode === 'asset-template-child-prompt' && (metadata.promptGenerationPending === true || metadata.promptGenerationFailed === true || !task.prompt);
    const originalPrompt = metadataText(metadata, 'originalPrompt') || task.prompt || '';
    const savedPromptModel = metadataText(metadata, 'promptModel');
    const savedPromptProvider = metadataText(metadata, 'promptProvider');
    const legacyPromptSelection = savedPromptProvider === 'bigsnake-prompt' ? savedPromptModel ? `bigsnake:${savedPromptModel}` : 'bigsnake'
      : savedPromptProvider === 'pomoai-gpt-prompt' ? savedPromptModel ? `pomoai:${savedPromptModel}` : 'pomoai-gpt'
        : savedPromptProvider === 'oairegbox-gpt-prompt' ? 'oairegbox-gpt'
          : savedPromptModel;
    const promptModel = metadataText(metadata, 'promptModelSelection') || legacyPromptSelection || 'pomoai-gpt';
    const title = metadataText(metadata, 'promptTitle') || originalPrompt;
    const templateContent = metadataText(metadata, 'promptTemplateContent') || '';
    const savedSummary = metadata.productSummary && typeof metadata.productSummary === 'object' ? metadata.productSummary as Record<string, unknown> : null;
    const productSummary = savedSummary && typeof savedSummary.pid === 'string' && typeof savedSummary.title === 'string' && typeof savedSummary.description === 'string'
      ? { pid: savedSummary.pid, title: savedSummary.title, description: savedSummary.description }
      : lookupProductSummary(metadataText(metadata, 'referenceImageName'));
    const run = async () => {
      const beforePrompt = getProviderTask(task.id);
      if (!beforePrompt || ['completed', 'cancelled', 'paused'].includes(beforePrompt.status) || beforePrompt.providerTaskId || beforePrompt.metadata?.providerAcceptedAt || beforePrompt.metadata?.schedulerWorkerId !== schedulerWorkerId) return;
      let finalPrompt = task.prompt || metadataText(metadata, 'finalPrompt') || originalPrompt;
      if (automaticPrompt) {
        const prompting = updateProviderTask(task.id, { status: 'prompting', progress: 2, metadata: { ...(beforePrompt.metadata ?? metadata), promptGenerationPending: true } }, beforePrompt.updatedAt);
        if (!prompting) return;
        const generated = await sharedChildPrompt(metadataText(metadata, 'promptBatchId') || task.id, { accountId: task.accountId, title, templateContent, productSummary, promptModel, referenceAssetIds: orderedReferenceAssetIds, productImageAssetIds: orderedProductImageAssetIds });
        const afterPrompt = getProviderTask(task.id);
        if (!afterPrompt || ['completed', 'cancelled', 'paused'].includes(afterPrompt.status) || afterPrompt.providerTaskId || afterPrompt.metadata?.providerAcceptedAt || afterPrompt.metadata?.schedulerWorkerId !== schedulerWorkerId) return;
        finalPrompt = generated.text;
        const promptCheckpoint = updateProviderTask(task.id, { prompt: finalPrompt, status: 'submitting', progress: 30, metadata: { ...(afterPrompt.metadata ?? metadata), promptGenerationPending: false, promptGenerationFailed: false, childPrompt: finalPrompt, finalPrompt, promptProvider: generated.provider, promptModel: generated.model, promptGenerationSource: generated.mode, promptGenerationUsedTemplate: generated.usedTemplateFallback === true, ...(generated.incompleteReason ? { promptGenerationIncompleteReason: generated.incompleteReason } : {}) } }, afterPrompt.updatedAt);
        if (!promptCheckpoint) return;
      }
      await submitVideoTask({ taskId: task.id, schedulerWorkerId, provider, model, prompt: finalPrompt, duration, aspectRatio, resolution, referenceImages, referenceFiles, referenceAudios, referenceVideos });
    };
    await run();
  } catch (error) {
    const latest = getProviderTask(task.id);
    if (!latest || ['completed', 'cancelled', 'paused'].includes(latest.status) || latest.providerTaskId || latest.metadata?.providerAcceptedAt || latest.metadata?.schedulerWorkerId !== schedulerWorkerId) return;
    updateCurrentVideoTask(task.id, (current) => ['completed', 'cancelled', 'paused'].includes(current.status) || current.providerTaskId || current.metadata?.providerAcceptedAt || current.metadata?.schedulerWorkerId !== schedulerWorkerId ? null : {
      error: sanitizeProviderError(error instanceof Error ? error.message : 'reference_asset_not_found'), providerResponse: providerResponseSnapshot(error), status: 'failed', progress: 100,
      metadata: { ...(current.metadata ?? {}), ...(metadata.promptMode === 'asset-template-child-prompt' ? { promptGenerationPending: false, promptGenerationFailed: true } : {}) },
    });
    await flushProviderTaskStore();
  }
}

async function submitVideoTask(input: { taskId: string; schedulerWorkerId?: string; provider: VideoProvider; model: string; prompt: string; duration: number; aspectRatio: string; resolution: string; referenceImages: string[]; referenceFiles?: Array<{ bytes: Uint8Array; mimeType: string; fileName: string }>; referenceAudios: string[]; referenceVideos: string[] }): Promise<void> {
  let providerResponse: unknown;
  let submissionStarted = false;
  try {
    const beforeSubmit = getProviderTask(input.taskId);
    if (!beforeSubmit || ['completed', 'paused', 'cancelled'].includes(beforeSubmit.status) || beforeSubmit.providerTaskId || beforeSubmit.metadata?.providerAcceptedAt || beforeSubmit.metadata?.schedulerWorkerId !== input.schedulerWorkerId) return;
    const started = updateProviderTask(input.taskId, { status: 'submitting', metadata: { ...(beforeSubmit.metadata ?? {}), providerSubmissionStartedAt: new Date().toISOString(), lastProviderStatus: undefined } }, beforeSubmit.updatedAt);
    if (!started) return;
    await flushProviderTaskStore();
    const afterCheckpoint = getProviderTask(input.taskId);
    if (!afterCheckpoint || afterCheckpoint.metadata?.schedulerWorkerId !== input.schedulerWorkerId) return;
    if (afterCheckpoint.providerTaskId || afterCheckpoint.metadata?.providerAcceptedAt) return;
    if (['completed', 'paused', 'cancelled'].includes(afterCheckpoint.status)) {
      updateProviderTask(input.taskId, { metadata: { ...(afterCheckpoint.metadata ?? {}), providerSubmissionStartedAt: undefined } }, afterCheckpoint.updatedAt);
      await flushProviderTaskStore();
      return;
    }
    const previousProvider = afterCheckpoint.metadata?.lastProviderFailure;
    const skipProviders = typeof previousProvider === 'string' && VIDEO_PROVIDERS.includes(previousProvider as VideoProvider) ? [previousProvider as ProviderId] : undefined;
    submissionStarted = true;
    const submitted = await submitVideoWithFallback({
      provider: input.provider, model: input.model, prompt: input.prompt, duration: input.duration, aspectRatio: input.aspectRatio, resolution: input.resolution,
      referenceImages: input.referenceImages, referenceFiles: input.referenceFiles, referenceAudios: input.referenceAudios, referenceVideos: input.referenceVideos,
      media: [...input.referenceImages.map((url) => ({ type: 'reference_image' as const, url })), ...input.referenceVideos.map((url) => ({ type: 'reference_video' as const, url })), ...input.referenceAudios.map((url) => ({ type: 'audio' as const, url }))],
    }, { preventAmbiguousResubmission: true, skipProviders });
    providerResponse = submitted.response;
    const status = normalizeProviderResponse(submitted.provider, submitted.response);
    const accepted = Boolean(status.providerTaskId || status.outputUrls.length || status.outputBase64.length);
    const confirmedFailure = status.status === 'failed';
    const unresumable = !accepted && !confirmedFailure && submitted.mode !== 'mock';
    const checkpoint = updateCurrentVideoTask(input.taskId, (latest) => {
      const stopped = latest.status === 'cancelled' || latest.status === 'paused';
      const checkpointStatus = stopped ? latest.status : confirmedFailure || unresumable ? 'failed' : status.status === 'completed' ? 'processing' : status.status === 'unknown' ? 'submitted' : status.status;
      return {
        provider: submitted.provider, model: submitted.model,
        providerTaskId: status.providerTaskId ?? latest.providerTaskId,
        outputUrls: status.outputUrls, outputBase64: status.outputBase64,
        status: checkpointStatus,
        progress: stopped ? latest.progress : confirmedFailure || unresumable ? 100 : canonicalTaskProgress({ mode: 'video', status: checkpointStatus, progress: status.progress, providerTaskId: status.providerTaskId }),
        error: unresumable ? 'provider_submission_uncertain' : status.error,
        providerResponse: providerResponseSnapshot(undefined, { body: submitted.response, method: 'POST' }),
        metadata: {
          ...(latest.metadata ?? {}), execution: submitted.mode, lastProviderStatus: status.status,
          providerSubmissionUncertain: unresumable,
          schedulerRetryExhausted: confirmedFailure ? false : unresumable || latest.metadata?.schedulerRetryExhausted === true,
          ...(accepted ? { providerAcceptedAt: new Date().toISOString(), providerTaskAcceptedAt: new Date().toISOString(), schedulerState: 'provider-active' } : {}),
          ...(confirmedFailure && !accepted ? { providerSubmissionStartedAt: undefined, providerSubmissionRejectedAt: new Date().toISOString() } : {}),
          ...(submitted.fallbackFrom ? { fallbackFrom: submitted.fallbackFrom, fallbackProviders: submitted.fallbackProviders, fallbackParameters: submitted.fallbackParameters } : {}),
          ...(status.status === 'completed' && accepted ? { localOutputReady: false, localOutputExpected: status.outputUrls.length + status.outputBase64.length, localCacheCheckpointAt: new Date().toISOString() } : {}),
        },
      };
    });
    // Acceptance and synchronous outputs must be durable before cache work can suspend execution.
    await flushProviderTaskStore();
    const afterAcceptance = getProviderTask(input.taskId);
    if (!checkpoint || !afterAcceptance || ['cancelled', 'paused'].includes(afterAcceptance.status) || afterAcceptance.metadata?.schedulerWorkerId !== input.schedulerWorkerId || confirmedFailure || unresumable) return;
    if (status.status === 'completed') {
      const cache = await cacheVideoTaskOutputsBeforeCompletion(checkpoint.accountId, { ...checkpoint, status: 'completed', progress: 100 });
      const noOutput = cache.expected === 0;
      const cachePending = !noOutput && !cache.ready;
      updateCurrentVideoTask(input.taskId, (current) => {
        if (current.metadata?.schedulerWorkerId !== input.schedulerWorkerId) return null;
        const stoppedDuringCache = current.status === 'cancelled' || current.status === 'paused';
        const finalStatus = stoppedDuringCache ? current.status : noOutput ? 'failed' : cachePending ? 'processing' : 'completed';
        return {
          status: finalStatus,
          progress: stoppedDuringCache ? current.progress : canonicalTaskProgress({ mode: 'video', status: finalStatus, progress: status.progress, providerTaskId: status.providerTaskId, schedulerState: cachePending ? 'provider-active' : undefined, localOutputReady: cache.ready, localOutputPending: cachePending }),
          error: noOutput ? 'provider_upstream_failed' : status.error,
          metadata: { ...(current.metadata ?? {}), localOutputCount: cache.cached, localOutputExpected: cache.expected, localOutputReady: cache.ready, ...(noOutput ? { schedulerRetryExhausted: true } : {}) },
        };
      });
      await flushProviderTaskStore();
    }
    const beforeMock = getProviderTask(input.taskId);
    if (submitted.mode === 'mock' && beforeMock && !['cancelled', 'paused'].includes(beforeMock.status) && beforeMock.metadata?.schedulerWorkerId === input.schedulerWorkerId) await processMockProviderTask(input.taskId);
  } catch (error) {
    const latest = getProviderTask(input.taskId);
    if (!latest || latest.metadata?.schedulerWorkerId !== input.schedulerWorkerId) return;
    if (latest.providerTaskId || latest.metadata?.providerAcceptedAt || latest.outputUrls.length || latest.outputBase64.length) {
      updateProviderTask(input.taskId, { metadata: { ...(latest.metadata ?? {}), localCacheError: sanitizeProviderError(error instanceof Error ? error.message : '') } });
      await flushProviderTaskStore();
      return;
    }
    const info = providerErrorInfo(error);
    const rejected = typeof info.status === 'number' && info.status >= 400 && info.status < 500 && info.status !== 408;
    const preflight = ['provider_not_configured', 'provider_invalid_request', 'unsupported_model'].includes(info.code);
    const uncertain = submissionStarted && !rejected && !preflight;
    updateCurrentVideoTask(input.taskId, (current) => {
      if (current.metadata?.schedulerWorkerId !== input.schedulerWorkerId || current.providerTaskId || current.metadata?.providerAcceptedAt) return null;
      const stopped = current.status === 'cancelled' || current.status === 'paused';
      return {
        status: stopped ? current.status : 'failed', progress: stopped ? current.progress : 100,
        error: uncertain ? 'provider_submission_uncertain' : sanitizeProviderError(error instanceof Error ? error.message : ''),
        providerResponse: providerResponseSnapshot(error, providerResponse === undefined ? undefined : { body: providerResponse, method: 'POST' }),
        metadata: { ...(current.metadata ?? {}), execution: 'failed', providerSubmissionUncertain: uncertain, ...(uncertain ? { schedulerRetryExhausted: true } : { providerSubmissionStartedAt: undefined }) },
      };
    });
    await flushProviderTaskStore();
  }
}

export function promptProviderHint(requested: string): ProviderId | undefined {
  const normalized = requested.trim().toLowerCase();
  if (normalized === 'pomoai-gpt' || normalized === 'pomoai-gpt-prompt' || normalized.startsWith('pomoai:')) return 'pomoai-gpt-prompt';
  if (normalized === 'oairegbox-gpt' || normalized === 'oairegbox-gpt-prompt') return 'oairegbox-gpt-prompt';
  if (normalized === 'bigsnake' || normalized.startsWith('bigsnake:')) return 'bigsnake-prompt';
  if (normalized === 'gpt-2999' || /^gpt[-_]/i.test(normalized)) return 'gpt-2999-prompt';
  if (/^gemini[-_]/i.test(normalized)) return 'yuanai-gemini-prompt';
  return undefined;
}

export function promptModelHintFor(requested: string): string | undefined {
  const normalized = requested.trim();
  if (!normalized) return undefined;
  if (normalized === 'pomoai-gpt' || normalized === 'pomoai-gpt-prompt') return getProviderConfig('pomoai-gpt-prompt').model;
  if (normalized.startsWith('pomoai:')) return normalized.slice('pomoai:'.length).trim() || getProviderConfig('pomoai-gpt-prompt').model;
  if (normalized === 'oairegbox-gpt' || normalized === 'oairegbox-gpt-prompt') return getProviderConfig('oairegbox-gpt-prompt').model;
  if (normalized === 'bigsnake') return getProviderConfig('bigsnake-prompt').model;
  if (normalized.startsWith('bigsnake:')) return normalized.slice('bigsnake:'.length).trim() || getProviderConfig('bigsnake-prompt').model;
  if (normalized === 'gpt-2999') return getProviderConfig('gpt-2999-prompt').model;
  return normalized;
}

type GeneratedChildPrompt = { provider: ProviderId; model: string; mode: 'live' | 'mock'; text: string; response: unknown; fallbackFrom?: ProviderId; fallbackProviders?: ProviderId[]; fallbackModels?: string[]; usedTemplateFallback?: boolean; incompleteReason?: string };

const promptBatches = new Map<string, Promise<GeneratedChildPrompt>>();
function sharedChildPrompt(batchId: string, input: Parameters<typeof generateChildPrompt>[0]): Promise<GeneratedChildPrompt> {
  const existing = promptBatches.get(batchId);
  if (existing) return existing;
  while (promptBatches.size >= 128) promptBatches.delete(promptBatches.keys().next().value!);
  const pending = generateChildPrompt(input).catch((error) => { promptBatches.delete(batchId); throw error; });
  promptBatches.set(batchId, pending);
  return pending;
}

const MAX_PROMPT_REFERENCE_BYTES = 40 * 1024 * 1024;
/** Upper bound instructed to the child-prompt model so its visible reply reliably fits the raised max_output_tokens budget. */
const CHILD_PROMPT_MAX_CHARS = 4_096;

/**
 * A provider call can "succeed" (no thrown error) while still returning
 * blank text (empty upstream response, reasoning-token exhaustion, content
 * filtering, etc). Failing the task in that case would just force a retry
 * that is likely to hit the same upstream behaviour again, so the task keeps
 * moving using the raw template/wrapper prompt as the submitted text — but
 * callers must be told this happened so it can be surfaced as "used the
 * template, no child prompt was generated" instead of implying a real
 * AI-generated sub-prompt was produced.
 */
function resolveGeneratedPromptText(text: string, generationPrompt: string): { text: string; usedTemplateFallback: boolean } {
  const trimmed = text.trim();
  if (trimmed) return { text: trimmed, usedTemplateFallback: false };
  return { text: generationPrompt, usedTemplateFallback: true };
}

/** Generate a child prompt inside the scheduler instead of blocking task creation. */
async function generateChildPrompt(input: {
  accountId: string;
  title: string;
  templateContent: string;
  productSummary: ReturnType<typeof lookupProductSummary>;
  promptModel: string;
  referenceAssetIds: readonly string[];
  productImageAssetIds: readonly string[];
}): Promise<GeneratedChildPrompt> {
  const references = readPromptReferences(input.accountId, input.referenceAssetIds, input.productImageAssetIds);
  const generationPrompt = appendProductSummary(
    `请为商品“${input.title.trim()}”生成适合 TikTok 带货视频的子提示词。${input.templateContent.trim()}\n\n重要：生成的子提示词正文必须控制在 ${CHILD_PROMPT_MAX_CHARS} 个字符以内。`.trim(),
    input.productSummary,
  );
  const requested = input.promptModel.trim() || 'pomoai-gpt';
  const isPomoFallback = requested === 'pomoai-gpt' || requested === 'pomoai-gpt-prompt' || requested.startsWith('pomoai:');
  const isOAIRegbox = requested === 'oairegbox-gpt' || requested === 'oairegbox-gpt-prompt';
  const isBigSnake = requested === 'bigsnake' || requested.startsWith('bigsnake:');
  const isGpt = requested === 'gpt-2999' || /^gpt[-_]/i.test(requested);
  const isGemini = /^gemini[-_]/i.test(requested);
  if (!isPomoFallback && !isOAIRegbox && !isBigSnake && !isGpt && !isGemini) throw new Error('prompt_model_invalid');

  if (isPomoFallback) {
    const selectedPomoModel = requested.startsWith('pomoai:') ? requested.slice('pomoai:'.length).trim() : undefined;
    const result = await generatePromptWithFallback({ model: selectedPomoModel || undefined, prompt: generationPrompt, attachments: references });
    const resolved = resolveGeneratedPromptText(result.text, generationPrompt);
    return { ...result, text: resolved.text, usedTemplateFallback: resolved.usedTemplateFallback, incompleteReason: result.incompleteReason };
  }
  if (isOAIRegbox) {
    const result = await generateOAIRegboxGPTPrompt({ prompt: generationPrompt, attachments: references });
    const resolved = resolveGeneratedPromptText(result.text, generationPrompt);
    return { ...result, text: resolved.text, usedTemplateFallback: resolved.usedTemplateFallback, incompleteReason: result.incompleteReason };
  }

  if (isBigSnake) {
    const provider: ProviderId = 'bigsnake-prompt';
    const config = getProviderConfig(provider);
    const model = requested.startsWith('bigsnake:') ? requested.slice('bigsnake:'.length).trim() || config.model : config.model;
    const result = await generateBigSnakePrompt({ model, prompt: generationPrompt, attachments: references });
    const resolved = resolveGeneratedPromptText(result.text, generationPrompt);
    return { provider, model, mode: result.mode, text: resolved.text, usedTemplateFallback: resolved.usedTemplateFallback, incompleteReason: result.incompleteReason, response: result.response };
  }
  if (isGpt) {
    const provider: ProviderId = 'gpt-2999-prompt';
    const config = getProviderConfig(provider);
    const model = /^gpt[-_]/i.test(requested) && requested !== 'gpt-2999' ? requested : config.model;
    const result = await generateGPTPrompt({ model, messages: [{ role: 'user', content: generationPrompt }], attachments: references });
    const resolved = resolveGeneratedPromptText(result.text, generationPrompt);
    return { provider, model, mode: result.mode, text: resolved.text, usedTemplateFallback: resolved.usedTemplateFallback, incompleteReason: result.incompleteReason, response: result.response };
  }
  const provider: ProviderId = 'yuanai-gemini-prompt';
  const config = getProviderConfig(provider);
  const model = isGemini ? requested : config.model;
  const result = await generateGeminiPrompt({ model, prompt: generationPrompt, references });
  const resolved = resolveGeneratedPromptText(result.text, generationPrompt);
  return { provider, model, mode: result.mode, text: resolved.text, usedTemplateFallback: resolved.usedTemplateFallback, response: result.response };
}

function readPromptReferences(accountId: string, referenceAssetIds: readonly string[], productImageAssetIds: readonly string[]): GPTPromptAttachment[] {
  const references: GPTPromptAttachment[] = [];
  let totalBytes = 0;
  for (const assetId of referenceAssetIds) {
    const stored = readAssetFile(accountId, assetId);
    if (!stored || stored.asset.kind !== 'image') throw new Error('reference_asset_not_found');
    totalBytes += stored.bytes.byteLength;
    if (totalBytes > MAX_PROMPT_REFERENCE_BYTES) throw new Error('reference_images_too_large');
    references.push({ name: stored.asset.name, mimeType: stored.asset.mimeType || 'image/png', dataBase64: Buffer.from(stored.bytes).toString('base64') });
  }
  const products = listProductImageAssets();
  for (const assetId of productImageAssetIds) {
    const product = products.find((candidate) => candidate.id === assetId);
    if (!product) throw new Error('reference_asset_not_found');
    // Product-image assets are shared across operator workspaces.  The source
    // file is already validated under the workspace root by productImages.ts;
    // no per-account ownership check should be applied here.
    let bytes: Buffer;
    try { bytes = fs.readFileSync(getProductImageAbsolutePath(assetId)); } catch { throw new Error('reference_asset_not_found'); }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PROMPT_REFERENCE_BYTES) throw new Error('reference_images_too_large');
    references.push({ name: product.name, mimeType: product.mimeType || 'image/png', dataBase64: bytes.toString('base64') });
  }
  return references;
}

export function parseAssetOrder(value: unknown): Array<{ id: string; kind: 'image' | 'product-image' | 'inventory-video' | 'audio' }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { id?: unknown; kind?: unknown } => Boolean(item && typeof item === 'object'))
    .map((item) => ({ id: typeof item.id === 'string' ? item.id.trim() : '', kind: item.kind }))
    .filter((item): item is { id: string; kind: 'image' | 'product-image' | 'inventory-video' | 'audio' } => Boolean(item.id) && ['image', 'product-image', 'inventory-video', 'audio'].includes(String(item.kind)))
    .map((item) => ({ id: item.id, kind: item.kind as 'image' | 'product-image' | 'inventory-video' | 'audio' }))
    .slice(0, 16);
}
