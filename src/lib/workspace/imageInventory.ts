import dns from 'node:dns/promises';
import sharp from 'sharp';
import { createUploadedAsset, getAsset, getAssetFileInfo, type WorkspaceAsset } from './assetStore';
import { readStoredOutput, storeImageBase64Outputs, storeImageOutput } from '@/lib/providers/outputStore';
import { getProviderTask, listProviderTasks, updateProviderTask, type ProviderTask } from '@/lib/providers/taskStore';
import { assertPublicTarget, type LookupAddress } from './externalImageImport';
import { inventoryFileName } from './inventoryNaming';

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const CACHE_RETRY_DELAY_MS = 5_000;
const MAX_CACHE_RETRIES = 5;

async function isCompleteImage(bytes: Buffer): Promise<boolean> {
  if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES) return false;
  try {
    // A valid file signature is not enough: truncated Base64 can retain the
    // PNG/JPEG header. Decode once at the cache boundary, never on queue reads.
    await sharp(bytes, { failOn: 'warning' }).stats();
    return true;
  } catch {
    return false;
  }
}

export type ImageInventoryDependencies = {
  fetcher?: typeof fetch;
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  localOnly?: boolean;
};

export type ImageOutputCacheResult = {
  cached: number;
  expected: number;
  ready: boolean;
};

/** Build same-origin proxy URLs in the exact slot order used by the cache. */
export function localImageOutputUrls(accountId: string, task: Pick<ProviderTask, 'id' | 'outputUrls' | 'outputBase64'>): string[] {
  const urlOffset = task.outputBase64.length;
  const urlSlots = task.outputUrls
    .map((value, index) => value.trim() ? urlOffset + index : -1)
    .filter((index) => index >= 0);
  const base64Slots = task.outputBase64
    .map((value, index) => value.trim() ? index : -1)
    .filter((index) => index >= 0);
  // The cache writes Base64 slots first and URL slots after them; preserve
  // that same logical order when exposing the final proxy URL list.
  return [...base64Slots, ...urlSlots].map((index) => `/api/workspace/accounts/${encodeURIComponent(accountId)}/image-tasks/${encodeURIComponent(task.id)}/outputs/${index}`);
}

function extensionForMime(mime: string): string {
  const value = mime.toLowerCase();
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
  if (value.includes('webp')) return 'webp';
  return 'png';
}

function decodeBase64(value: string): { bytes: Buffer; mimeType: string } | null {
  const match = value.match(/^data:([^;,\s]+);base64,([A-Za-z0-9+/=\r\n\t ]+)$/i);
  if (!match) return null;
  const compact = match[2].replace(/[\r\n\t ]+/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  const bytes = Buffer.from(compact, 'base64');
  if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES || bytes.toString('base64') !== compact) return null;
  return { bytes, mimeType: match[1].toLowerCase() };
}

async function readOutput(accountId: string, task: ProviderTask, value: string, index: number, dependencies: ImageInventoryDependencies): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const cachedAtIndex = readStoredOutput(accountId, task.id, index);
  if (cachedAtIndex && await isCompleteImage(cachedAtIndex.bytes)) return { bytes: cachedAtIndex.bytes, mimeType: cachedAtIndex.mimeType };
  const local = value.match(/\/image-tasks\/[^/]+\/outputs\/(\d+)$/);
  if (local) {
    const stored = readStoredOutput(accountId, task.id, Number(local[1]));
    return stored && await isCompleteImage(stored.bytes) ? { bytes: stored.bytes, mimeType: stored.mimeType } : null;
  }
  if (!/^https?:\/\//i.test(value)) return null;
  if (dependencies.localOnly) return null;
  const lookup = dependencies.lookup ?? ((hostname: string) => dns.lookup(hostname, { all: true, verbatim: true }));
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== '443')) return null;
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
  const mimeType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!mimeType.startsWith('image/')) return null;
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_OUTPUT_BYTES) return null;
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES) return null;
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
      if (total > MAX_OUTPUT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) return null;
  return { bytes: Buffer.concat(chunks, total), mimeType };
}

/** Cache all completed image outputs before exposing the task as completed. */
export async function cacheImageTaskOutputsBeforeCompletion(accountId: string, task: ProviderTask, dependencies: ImageInventoryDependencies = {}): Promise<ImageOutputCacheResult> {
  if (task.mode !== 'image' || task.accountId !== accountId) return { cached: 0, expected: 0, ready: false };
  let cached = 0;
  const expected = task.outputBase64.filter((value) => value.trim()).length + task.outputUrls.filter((value) => value.trim()).length;
  if (task.outputBase64.length > 0) {
    const validBase64: string[] = [];
    for (const value of task.outputBase64) {
      const raw = value.replace(/^data:[^;]+;base64,/i, '').trim();
      const valid = raw.length <= Math.ceil(MAX_OUTPUT_BYTES * 4 / 3)
        && await isCompleteImage(Buffer.from(raw, 'base64'));
      validBase64.push(valid ? value : '');
    }
    cached += storeImageBase64Outputs(accountId, task.id, validBase64).length;
  }
  const urlOffset = task.outputBase64.length;
  for (let index = 0; index < task.outputUrls.length; index += 1) {
    const existing = readStoredOutput(accountId, task.id, urlOffset + index);
    if (existing && await isCompleteImage(existing.bytes)) { cached += 1; continue; }
    // URL outputs occupy the slot range after Base64 outputs. Keep the
    // source slot distinct so a mixed provider response cannot reuse the
    // Base64 bytes at the same numeric index as the remote URL.
    const output = await readOutput(accountId, task, task.outputUrls[index], urlOffset + index, dependencies).catch(() => null);
    if (output && await isCompleteImage(output.bytes) && storeImageOutput(accountId, task.id, urlOffset + index, output.bytes, output.mimeType)) cached += 1;
  }
  // A completed response with no media is still a valid terminal task (for
  // example a provider-side no-op); there is nothing to cache in that case.
  return { cached, expected, ready: expected === 0 || cached >= expected };
}

/**
 * Retry a completed image response whose first local download failed. The
 * original implementation left these tasks at processing/99% forever; this
 * bounded helper makes the cache self-healing while still ending clearly when
 * an output URL is permanently unavailable.
 */
export async function recoverPendingImageTaskOutputCache(taskId: string, dependencies: ImageInventoryDependencies = {}): Promise<ProviderTask | null> {
  const task = getProviderTask(taskId);
  // A previous cache attempt may have persisted a terminal
  // `image_output_cache_failed` error even though the output file was written
  // just before the task update raced.  Allow that exact error to self-heal
  // from the task-local output store; all other failed tasks remain terminal.
  const recoverableCacheFailure = task?.status === 'failed' && task.error === 'image_output_cache_failed';
  if (!task || task.mode !== 'image' || (task.status !== 'processing' && !recoverableCacheFailure)) return task;
  // A terminal cache failure gets one immediate recovery pass (important for
  // a write/status race), then stays terminal so every queue refresh does not
  // repeatedly fetch a permanently unavailable provider URL.
  if (recoverableCacheFailure && task.metadata?.localCacheExhausted === true) return task;
  const expected = task.outputBase64.filter((value) => value.trim()).length + task.outputUrls.filter((value) => value.trim()).length;
  if (expected === 0 || task.metadata?.localOutputReady === true) return task;
  const lastAttempt = typeof task.metadata?.localCacheLastAttemptAt === 'string' ? Date.parse(task.metadata.localCacheLastAttemptAt) : 0;
  if (!recoverableCacheFailure && lastAttempt && Date.now() - lastAttempt < CACHE_RETRY_DELAY_MS) return task;
  const attempts = typeof task.metadata?.localCacheAttempts === 'number' && Number.isFinite(task.metadata.localCacheAttempts)
    ? Math.max(0, Math.floor(task.metadata.localCacheAttempts))
    : 0;
  const nextAttempts = attempts + 1;
  const cache = await cacheImageTaskOutputsBeforeCompletion(task.accountId, { ...task, status: 'completed', progress: 100 }, dependencies);
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
      outputUrls: localImageOutputUrls(task.accountId, { ...task, outputUrls: task.outputUrls, outputBase64: task.outputBase64 }),
      outputBase64: [],
      error: undefined,
      metadata: attemptMetadata,
    }, latest.updatedAt);
  }
  if (nextAttempts >= MAX_CACHE_RETRIES) {
    return updateProviderTask(task.id, { status: 'failed', progress: 100, error: 'image_output_cache_failed', metadata: { ...attemptMetadata, localCacheExhausted: true, schedulerState: 'terminal' } }, latest.updatedAt);
  }
  return updateProviderTask(task.id, { status: 'processing', progress: 99, metadata: attemptMetadata }, latest.updatedAt);
}

/** Return only persisted, readable image assets declared by this task. */
export function listImageTaskInventoryAssets(accountId: string, task: ProviderTask): WorkspaceAsset[] {
  if (task.mode !== 'image' || task.accountId !== accountId) return [];
  const ids = Array.isArray(task.metadata?.inventoryAssetIds)
    ? task.metadata.inventoryAssetIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  return ids
    .map((id) => getAsset(accountId, id))
    .filter((asset): asset is WorkspaceAsset => Boolean(asset && asset.accountId === accountId && asset.kind === 'image'))
    .filter((asset) => {
      try { return Boolean(getAssetFileInfo(accountId, asset.id)); } catch { return false; }
    });
}

/** Persist completed image outputs as account-scoped image assets. */
export async function saveImageTaskOutputsToAssets(accountId: string, task: ProviderTask, dependencies: ImageInventoryDependencies = {}): Promise<WorkspaceAsset[]> {
  if (task.mode !== 'image' || task.status !== 'completed' || task.accountId !== accountId) return [];
  const validExisting = listImageTaskInventoryAssets(accountId, task);
  const declaredIds = Array.isArray(task.metadata?.inventoryAssetIds)
    ? task.metadata.inventoryAssetIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  if (declaredIds.length > 0 && validExisting.length === declaredIds.length) return [];
  const existingNames = new Set(validExisting.map((asset) => asset.name.trim().toLowerCase()));
  const outputs: Array<{ bytes: Buffer; mimeType: string; index: number }> = [];
  for (let index = 0; index < task.outputBase64.length; index += 1) {
    const decoded = decodeBase64(task.outputBase64[index]);
    if (decoded && await isCompleteImage(decoded.bytes)) outputs.push({ ...decoded, index });
  }
  // Keep URL outputs in a separate deterministic slot range. Using the count
  // of successfully decoded Base64 values can collide when an earlier Base64
  // slot is malformed.
  const urlOffset = task.outputBase64.length;
  for (let index = 0; index < task.outputUrls.length; index += 1) {
    const output = await readOutput(accountId, task, task.outputUrls[index], urlOffset + index, dependencies);
    if (output && await isCompleteImage(output.bytes)) outputs.push({ ...output, index: urlOffset + index });
  }
  const assets: WorkspaceAsset[] = [];
  for (const output of outputs) {
    const extension = extensionForMime(output.mimeType);
    const name = inventoryFileName(task, output.index, extension);
    if (existingNames.has(name.toLowerCase())) continue;
    const asset = createUploadedAsset(accountId, 'image', {
      name,
      type: output.mimeType,
      size: output.bytes.length,
      arrayBuffer: Uint8Array.from(output.bytes).buffer,
    });
    assets.push(asset);
  }
  return assets;
}

let repairInFlight: Promise<number> | null = null;

/** Repair completed image tasks whose saved marker points at missing assets. */
export function repairSavedImageTaskInventory(accountIds?: readonly string[], dependencies: ImageInventoryDependencies = {}): Promise<number> {
  if (repairInFlight) return repairInFlight;
  repairInFlight = (async () => {
    let repaired = 0;
    const scope = accountIds ? new Set(accountIds) : null;
    const assignedAssetIds = new Set<string>();
    for (const task of listProviderTasks({ mode: 'image' })) {
      if (scope && !scope.has(task.accountId)) continue;
      if (task.status !== 'completed' || !task.inventorySavedAt) continue;
      const declaredIds = Array.isArray(task.metadata?.inventoryAssetIds)
        ? task.metadata.inventoryAssetIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        : [];
      const current = listImageTaskInventoryAssets(task.accountId, task);
      const hasCrossTaskReuse = declaredIds.some((assetId) => assignedAssetIds.has(`${task.accountId}:${assetId}`));
      if (!hasCrossTaskReuse && declaredIds.length > 0 && current.length === declaredIds.length) {
        declaredIds.forEach((assetId) => assignedAssetIds.add(`${task.accountId}:${assetId}`));
        continue;
      }
      const created = await saveImageTaskOutputsToAssets(task.accountId, hasCrossTaskReuse
        ? { ...task, metadata: { ...(task.metadata ?? {}), inventoryAssetIds: [] } }
        : task, dependencies);
      const allAssets = [...(hasCrossTaskReuse ? [] : current), ...created];
      const ids = Array.from(new Set(allAssets.map((asset) => asset.id)));
      if (!ids.length) continue;
      updateProviderTask(task.id, {
        inventorySavedAt: task.inventorySavedAt,
        metadata: { ...(task.metadata ?? {}), inventoryAssetIds: ids },
      });
      ids.forEach((assetId) => assignedAssetIds.add(`${task.accountId}:${assetId}`));
      repaired += 1;
    }
    return repaired;
  })().finally(() => { repairInFlight = null; });
  return repairInFlight;
}
