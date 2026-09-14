import dns from 'node:dns/promises';
import { createUploadedAsset, getAsset, getAssetFileInfo, listAssets, type WorkspaceAsset } from './assetStore';
import { getProviderTask, listProviderTasks, updateProviderTask, type ProviderTask } from '@/lib/providers/taskStore';
import { downloadProviderVideoContent } from '@/lib/providers/client';
import { readStoredVideoOutput, storeVideoOutput } from '@/lib/providers/outputStore';
import { countVideoOutputs, dedupeVideoOutputUrls } from '@/lib/providers/videoOutputUrls';
import { assertPublicTarget, type LookupAddress } from './externalImageImport';
import { inventoryFileName, taskNameForInventory } from './inventoryNaming';

const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUTS_PER_TASK = 4;
const MAX_TOTAL_OUTPUT_BYTES = 400 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const CACHE_RETRY_DELAY_MS = 5_000;
const MAX_CACHE_RETRIES = 5;

export type VideoInventoryDependencies = {
  fetcher?: typeof fetch;
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  excludeAssetIds?: ReadonlySet<string>;
  localOnly?: boolean;
};

export type VideoOutputCacheResult = {
  cached: number;
  expected: number;
  ready: boolean;
};

const outputCacheInFlight = new Map<string, Promise<number>>();

function decodeBase64(value: string): { bytes: Buffer; mimeType: string } | null {
  const match = value.match(/^data:([^;\s,]+);base64,([A-Za-z0-9+/=\r\n\t ]+)$/i);
  if (!match) return null;
  const compact = match[2].replace(/[\r\n\t ]+/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  const bytes = Buffer.from(compact, 'base64');
  if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES || bytes.toString('base64') !== compact) return null;
  return { bytes, mimeType: match[1].toLowerCase() || 'video/mp4' };
}

export function localVideoOutputUrls(accountId: string, taskId: string, count: number): string[] {
  const safeCount = Math.max(0, Math.min(64, Math.floor(count)));
  return Array.from({ length: safeCount }, (_, index) => `/api/workspace/accounts/${encodeURIComponent(accountId)}/video-tasks/${encodeURIComponent(taskId)}/outputs/${index}`);
}

async function readUrl(value: string, dependencies: VideoInventoryDependencies): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!/^https:\/\//i.test(value)) return null;
  if (dependencies.localOnly) return null;
  const lookup = dependencies.lookup ?? ((hostname: string) => dns.lookup(hostname, { all: true, verbatim: true }));
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== '443')) return null;
  const addresses = await lookup(parsed.hostname);
  const benchmarkMapping = addresses.length > 0 && addresses.every((item) => /^198\.(?:18|19)\./.test(item.address));
  // The LAN's DNS proxy remaps every provider CDN host into the RFC 2544
  // benchmark range (198.18/19); a resolution that lands entirely inside that
  // range is accepted regardless of hostname, so onboarding a new provider
  // never requires a manual allowlist edit. Any other private resolution
  // still fails the standard SSRF validator below.
  const target = benchmarkMapping ? parsed : await assertPublicTarget(value, async () => addresses);
  const response = await (dependencies.fetcher ?? fetch)(target.toString(), { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' });
  if (!response.ok) return null;
  const declaredType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const extensionHint = /\.(?:mp4|webm|mov|m4v|mkv)(?:[?#]|$)/i.test(value);
  if (!declaredType && !extensionHint) return null;
  const binaryHint = declaredType === 'application/octet-stream' || declaredType === 'binary/octet-stream';
  if (declaredType && !declaredType.startsWith('video/') && !binaryHint) return null;
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_OUTPUT_BYTES) return null;
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES) return null;
    const mimeType = declaredType.startsWith('video/') ? declaredType : 'video/mp4';
    if (!hasVideoSignature(bytes, mimeType)) return null;
    return { bytes, mimeType };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value?.byteLength) continue;
      total += next.value.byteLength;
      if (total > MAX_OUTPUT_BYTES) return null;
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, total);
  if (!bytes.length) return null;
  const mimeType = declaredType.startsWith('video/') ? declaredType : 'video/mp4';
  if (!hasVideoSignature(bytes, mimeType)) return null;
  return { bytes, mimeType };
}

/** Cache completed outputs locally so review never depends on a browser fetch
 * to a supplier CDN. The cache is task-scoped and safe to rebuild. */
export async function cacheVideoTaskOutputsLocally(accountId: string, task: ProviderTask, dependencies: VideoInventoryDependencies = {}): Promise<number> {
  if (task.mode !== 'video' || task.accountId !== accountId || task.status !== 'completed') return 0;
  let cached = 0;
  const urls = dedupeVideoOutputUrls(task.provider, task.outputUrls);

  // Authenticated content endpoints are more reliable than a public URL and
  // are the only output source for some Grok-compatible providers.
  const contentProvider = !dependencies.localOnly && !task.outputBase64.length && Boolean(task.providerTaskId) && ['grok-video', 'yuanai-grok-video', 'mgrouter-grok-video', 'oairegbox-omni', 'minimax-h3', 'miku-minimax', 'wan-3-nsfw'].includes(task.provider);
  if (contentProvider && urls.length === 0) {
    if (!readStoredVideoOutput(accountId, task.id, 0)) {
      try {
        const downloaded = await downloadProviderVideoContent(task.provider, task.providerTaskId!);
        if (storeVideoOutput(accountId, task.id, 0, Buffer.from(downloaded.bytes), downloaded.mimeType)) cached += 1;
      } catch { /* fall through to persisted output URLs */ }
    } else cached += 1;
  }

  for (let index = 0; index < urls.length && cached < MAX_OUTPUTS_PER_TASK; index += 1) {
    const targetIndex = index;
    if (readStoredVideoOutput(accountId, task.id, targetIndex)) { cached += 1; continue; }
    const output = await readUrl(urls[index], dependencies).catch(() => null);
    if (output && storeVideoOutput(accountId, task.id, targetIndex, output.bytes, output.mimeType)) cached += 1;
  }

  // If a content endpoint is available but the persisted URL was unusable,
  // use it as a last-resort cache for the first logical output.
  if (contentProvider && urls.length > 0 && !readStoredVideoOutput(accountId, task.id, 0)) {
    try {
      const downloaded = await downloadProviderVideoContent(task.provider, task.providerTaskId!);
      if (storeVideoOutput(accountId, task.id, 0, Buffer.from(downloaded.bytes), downloaded.mimeType)) cached += 1;
    } catch { /* keep the failed output unavailable */ }
  }

  const baseOffset = urls.length;
  for (let index = 0; index < task.outputBase64.length && cached < MAX_OUTPUTS_PER_TASK; index += 1) {
    if (readStoredVideoOutput(accountId, task.id, baseOffset + index)) { cached += 1; continue; }
    const decoded = decodeBase64(task.outputBase64[index]);
    if (decoded && storeVideoOutput(accountId, task.id, baseOffset + index, decoded.bytes, decoded.mimeType)) cached += 1;
  }
  return cached;
}

/**
 * A provider may report `completed` before its public URL or content endpoint
 * is actually readable.  Treat the local cache as the completion barrier:
 * callers should persist `completed` only when every logical output has been
 * downloaded and validated under data/generated.
 */
export async function cacheVideoTaskOutputsBeforeCompletion(accountId: string, task: ProviderTask, dependencies: VideoInventoryDependencies = {}): Promise<VideoOutputCacheResult> {
  if (task.mode !== 'video' || task.accountId !== accountId) return { cached: 0, expected: 0, ready: false };
  const completedTask: ProviderTask = task.status === 'completed' ? task : { ...task, status: 'completed' };
  const expected = countVideoOutputs(task.provider, task.outputUrls, task.outputBase64, Boolean(task.providerTaskId));
  const cached = await cacheVideoTaskOutputsLocally(accountId, completedTask, dependencies);
  // A live provider completion without any logical output is not ready for
  // review. Keep it processing so the next sync can obtain the output and
  // persist it locally before exposing completed to the operator.
  return { cached, expected, ready: expected > 0 && cached >= expected };
}

/**
 * Recover a video task that was left at processing/99 while its outputs were
 * still being cached locally. This mirrors the image cache recovery path so a
 * temporary provider or filesystem race does not strand the queue forever.
 */
export async function recoverPendingVideoTaskOutputCache(taskId: string, dependencies: VideoInventoryDependencies = {}): Promise<ProviderTask | null> {
  const task = getProviderTask(taskId);
  const recoverableCacheFailure = task?.status === 'failed' && task.error === 'video_output_cache_failed';
  if (!task || task.mode !== 'video' || (task.status !== 'processing' && !recoverableCacheFailure)) return task;
  // A terminal cache failure gets one immediate recovery pass, then remains
  // terminal so repeat reads do not keep hammering a permanently unavailable
  // provider URL.
  if (recoverableCacheFailure && task.metadata?.localCacheExhausted === true) return task;
  const expected = countVideoOutputs(task.provider, task.outputUrls, task.outputBase64, Boolean(task.providerTaskId));
  if (expected === 0 || task.metadata?.localOutputReady === true) return task;
  const lastAttempt = typeof task.metadata?.localCacheLastAttemptAt === 'string'
    ? Date.parse(task.metadata.localCacheLastAttemptAt)
    : 0;
  if (!recoverableCacheFailure && lastAttempt && Date.now() - lastAttempt < CACHE_RETRY_DELAY_MS) return task;
  const attempts = typeof task.metadata?.localCacheAttempts === 'number' && Number.isFinite(task.metadata.localCacheAttempts)
    ? Math.max(0, Math.floor(task.metadata.localCacheAttempts))
    : 0;
  const nextAttempts = attempts + 1;
  const cache = await cacheVideoTaskOutputsBeforeCompletion(task.accountId, { ...task, status: 'completed', progress: 100 }, dependencies);
  const latest = getProviderTask(task.id);
  if (!latest || latest.updatedAt !== task.updatedAt) return latest;
  const attemptMetadata = {
    ...(task.metadata ?? {}),
    localCacheAttempts: nextAttempts,
    localCacheLastAttemptAt: new Date().toISOString(),
    localOutputCount: cache.cached,
    localOutputExpected: cache.expected,
    localOutputReady: cache.ready,
  };
  if (cache.ready) {
    return updateProviderTask(task.id, {
      status: 'completed',
      progress: 100,
      outputUrls: localVideoOutputUrls(task.accountId, task.id, cache.expected),
      outputBase64: [],
      error: undefined,
      metadata: attemptMetadata,
    }, latest.updatedAt);
  }
  if (nextAttempts >= MAX_CACHE_RETRIES) {
    return updateProviderTask(task.id, {
      status: 'failed',
      progress: 100,
      error: 'video_output_cache_failed',
      metadata: { ...attemptMetadata, localCacheExhausted: true, schedulerState: 'terminal' },
    }, latest.updatedAt);
  }
  return updateProviderTask(task.id, { status: 'processing', progress: 99, metadata: attemptMetadata }, latest.updatedAt);
}

/** Cache only one logical output for the review proxy. Concurrent requests for
 * the same task/index share one provider download. */
export function cacheVideoTaskOutputLocally(accountId: string, task: ProviderTask, index: number, dependencies: VideoInventoryDependencies = {}): Promise<number> {
  if (task.mode !== 'video' || task.accountId !== accountId || task.status !== 'completed' || !Number.isInteger(index) || index < 0 || index > 63) return Promise.resolve(0);
  const key = `${accountId}:${task.id}:${index}`;
  const existing = outputCacheInFlight.get(key);
  if (existing) return existing;
  const run = (async () => {
    if (readStoredVideoOutput(accountId, task.id, index)) return 1;
    const urls = dedupeVideoOutputUrls(task.provider, task.outputUrls);
    const contentProvider = !dependencies.localOnly && !task.outputBase64.length && Boolean(task.providerTaskId) && ['grok-video', 'yuanai-grok-video', 'mgrouter-grok-video', 'oairegbox-omni', 'minimax-h3', 'miku-minimax', 'wan-3-nsfw'].includes(task.provider);
    if (contentProvider && urls.length === 0 && index === 0) {
      try {
        const downloaded = await downloadProviderVideoContent(task.provider, task.providerTaskId!);
        return storeVideoOutput(accountId, task.id, 0, Buffer.from(downloaded.bytes), downloaded.mimeType) ? 1 : 0;
      } catch { return 0; }
    }
    if (index < urls.length) {
      const output = await readUrl(urls[index], dependencies).catch(() => null);
      if (output && storeVideoOutput(accountId, task.id, index, output.bytes, output.mimeType)) return 1;
      if (contentProvider && index === 0) {
        try {
          const downloaded = await downloadProviderVideoContent(task.provider, task.providerTaskId!);
          return storeVideoOutput(accountId, task.id, 0, Buffer.from(downloaded.bytes), downloaded.mimeType) ? 1 : 0;
        } catch { return 0; }
      }
      return 0;
    }
    const base64Index = index - urls.length;
    const decoded = task.outputBase64[base64Index] ? decodeBase64(task.outputBase64[base64Index]) : null;
    return decoded && storeVideoOutput(accountId, task.id, index, decoded.bytes, decoded.mimeType) ? 1 : 0;
  })().finally(() => { outputCacheInFlight.delete(key); });
  outputCacheInFlight.set(key, run);
  return run;
}

function declaredInventoryAssetIds(task: ProviderTask): string[] {
  const values = Array.isArray(task.metadata?.inventoryAssetIds)
    ? task.metadata.inventoryAssetIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  return Array.from(new Set(values));
}

function extensionForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('quicktime')) return 'mov';
  if (normalized.includes('x-matroska')) return 'mkv';
  return 'mp4';
}

function hasVideoSignature(bytes: Buffer, mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('webm') || normalized.includes('matroska')) return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (normalized.includes('avi')) return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'AVI ';
  if (normalized.includes('mp4') || normalized.includes('quicktime') || normalized.includes('m4v')) return bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  return false;
}

function validInventoryAssets(accountId: string, task: ProviderTask): WorkspaceAsset[] {
  return declaredInventoryAssetIds(task)
    .map((id) => getAsset(accountId, id))
    .filter((asset): asset is WorkspaceAsset => Boolean(asset && asset.accountId === accountId && asset.kind === 'inventory-video'))
    .filter((asset) => {
      try { return Boolean(getAssetFileInfo(accountId, asset.id)); } catch { return false; }
    });
}

/** Return only persisted, readable inventory assets belonging to this task. */
export function listVideoTaskInventoryAssets(accountId: string, task: ProviderTask): WorkspaceAsset[] {
  if (task.accountId !== accountId || task.mode !== 'video') return [];
  // Only declared task-owned IDs are trusted. Filename matching can attach a
  // manually uploaded same-name video to the wrong production task.
  return validInventoryAssets(accountId, task);
}

/** Persist completed video outputs as account-scoped inventory-video assets. */
export async function saveVideoTaskOutputsToAssets(accountId: string, task: ProviderTask, dependencies: VideoInventoryDependencies = {}): Promise<WorkspaceAsset[]> {
  if (task.mode !== 'video' || task.status !== 'completed' || task.accountId !== accountId) return [];
  const existing = validInventoryAssets(accountId, task);
  const declaredIds = declaredInventoryAssetIds(task);
  const hasExcludedDeclaredId = declaredIds.some((assetId) => dependencies.excludeAssetIds?.has(assetId));
  if (!hasExcludedDeclaredId && declaredIds.length > 0 && existing.length === declaredIds.length) return [];

  await cacheVideoTaskOutputsLocally(accountId, task, dependencies);
  const outputs: Array<{ bytes: Buffer; mimeType: string; index: number }> = [];
  const urls = dedupeVideoOutputUrls(task.provider, task.outputUrls);
  const contentProvider = !task.outputBase64.length && urls.length === 0 && Boolean(task.providerTaskId) && ['grok-video', 'yuanai-grok-video', 'mgrouter-grok-video', 'oairegbox-omni', 'minimax-h3', 'miku-minimax', 'wan-3-nsfw'].includes(task.provider);
  const contentCached = contentProvider && Boolean(readStoredVideoOutput(accountId, task.id, 0));
  if (contentCached) {
    const local = readStoredVideoOutput(accountId, task.id, 0);
    if (local) outputs.push({ bytes: local.bytes, mimeType: local.mimeType, index: 0 });
  }
  for (let index = 0; index < urls.length && outputs.length < MAX_OUTPUTS_PER_TASK; index += 1) {
    const local = readStoredVideoOutput(accountId, task.id, index);
    if (local) outputs.push({ bytes: local.bytes, mimeType: local.mimeType, index: outputs.length });
  }
  const baseOffset = urls.length;
  for (let index = 0; index < task.outputBase64.length && outputs.length < MAX_OUTPUTS_PER_TASK; index += 1) {
    const local = readStoredVideoOutput(accountId, task.id, baseOffset + index);
    if (local) {
      outputs.push({ bytes: local.bytes, mimeType: local.mimeType, index: outputs.length });
      continue;
    }
    // Keep the historical tolerant behaviour for provider fixtures or legacy
    // records whose Base64 payload lacks a recognizable container signature.
    // Valid real videos are cached above and take the local-file path.
    const decoded = decodeBase64(task.outputBase64[index]);
    if (decoded) outputs.push({ bytes: decoded.bytes, mimeType: decoded.mimeType, index: outputs.length });
  }

  const existingByName = new Map(
    listAssets(accountId, 'inventory-video')
      .filter((asset) => {
        if (dependencies.excludeAssetIds?.has(asset.id)) return false;
        try { return Boolean(getAssetFileInfo(accountId, asset.id)); } catch { return false; }
      })
      .map((asset) => [asset.name, asset] as const),
  );
  const assets: WorkspaceAsset[] = [];
  let totalBytes = 0;
  for (const output of outputs) {
    if (totalBytes + output.bytes.length > MAX_TOTAL_OUTPUT_BYTES) break;
    const name = inventoryFileName(task, output.index, extensionForMime(output.mimeType));
    const existingAsset = existingByName.get(name);
    if (existingAsset) {
      assets.push(existingAsset);
      continue;
    }
    const asset = createUploadedAsset(accountId, 'inventory-video', {
      name,
      type: output.mimeType || 'video/mp4',
      size: output.bytes.length,
      arrayBuffer: Uint8Array.from(output.bytes).buffer,
    });
    existingByName.set(asset.name, asset);
    assets.push(asset);
    totalBytes += output.bytes.length;
  }
  return assets;
}

let repairInFlight: Promise<number> | null = null;

/** Repair completed video tasks that were marked as saved before their assets were persisted. */
export function repairSavedVideoTaskInventory(accountIds?: readonly string[], dependencies: VideoInventoryDependencies = {}): Promise<number> {
  // Multiple account pages can mount together (for example through browser
  // prefetch). Join the active pass instead of recursively scheduling another
  // full-store repair when it completes.
  if (repairInFlight) return repairInFlight;
  repairInFlight = (async () => {
    let repaired = 0;
    const assignedAssetIds = new Map<string, string>();
    const scope = accountIds ? new Set(accountIds) : null;
    for (const task of listProviderTasks({ mode: 'video' })) {
      if (scope && !scope.has(task.accountId)) continue;
      if (task.status !== 'completed' || !task.inventorySavedAt) continue;
      const declaredIds = declaredInventoryAssetIds(task);
      const hasCrossTaskReuse = declaredIds.some((assetId) => assignedAssetIds.has(assetId));
      const current = hasCrossTaskReuse ? [] : listVideoTaskInventoryAssets(task.accountId, task);
      if (!hasCrossTaskReuse && declaredIds.length > 0 && current.length === declaredIds.length) {
        declaredIds.forEach((assetId) => assignedAssetIds.set(assetId, task.id));
        continue;
      }
      const created = await saveVideoTaskOutputsToAssets(task.accountId, hasCrossTaskReuse
        ? { ...task, metadata: { ...(task.metadata ?? {}), inventoryAssetIds: [] } }
        : task, { ...dependencies, excludeAssetIds: new Set(assignedAssetIds.keys()) });
      const allAssets = [...current, ...created];
      const ids = Array.from(new Set(allAssets.map((asset) => asset.id)));
      if (ids.length > 0) {
        updateProviderTask(task.id, {
          inventorySavedAt: task.inventorySavedAt,
          metadata: { ...(task.metadata ?? {}), inventoryAssetIds: ids },
        });
        ids.forEach((assetId) => assignedAssetIds.set(assetId, task.id));
        repaired += 1;
        continue;
      }
      // Keep the saved marker when an upstream download is temporarily
      // unavailable. Clearing it makes the queue disagree with the user's
      // action and prevents a later repair pass from retrying the task.
    }
    return repaired;
  })().finally(() => { repairInFlight = null; });
  return repairInFlight;
}
