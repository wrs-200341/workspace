import dns from 'node:dns/promises';
import { createUploadedAsset, getAsset, listAssets, readAssetFile, type WorkspaceAsset } from './assetStore';
import { listProviderTasks, updateProviderTask, type ProviderTask } from '@/lib/providers/taskStore';
import { downloadProviderVideoContent } from '@/lib/providers/client';
import { assertPublicTarget, type LookupAddress } from './externalImageImport';
import { inventoryFileName, taskNameForInventory } from './inventoryNaming';

const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUTS_PER_TASK = 4;
const MAX_TOTAL_OUTPUT_BYTES = 400 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export type VideoInventoryDependencies = {
  fetcher?: typeof fetch;
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
};

function decodeBase64(value: string): { bytes: Buffer; mimeType: string } | null {
  const match = value.match(/^data:([^;\s,]+);base64,([A-Za-z0-9+/=\r\n\t ]+)$/i);
  if (!match) return null;
  const compact = match[2].replace(/[\r\n\t ]+/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  const bytes = Buffer.from(compact, 'base64');
  if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES || bytes.toString('base64') !== compact) return null;
  return { bytes, mimeType: match[1].toLowerCase() || 'video/mp4' };
}

async function readUrl(value: string, dependencies: VideoInventoryDependencies): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!/^https:\/\//i.test(value)) return null;
  const lookup = dependencies.lookup ?? ((hostname: string) => dns.lookup(hostname, { all: true, verbatim: true }));
  const target = await assertPublicTarget(value, lookup);
  const response = await (dependencies.fetcher ?? fetch)(target.toString(), { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' });
  if (!response.ok) return null;
  const declaredType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const extensionHint = /\.(?:mp4|webm|mov|m4v|mkv)(?:[?#]|$)/i.test(value);
  if (!declaredType && !extensionHint) return null;
  if (declaredType && !declaredType.startsWith('video/')) return null;
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_OUTPUT_BYTES) return null;
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES) return null;
    if (!hasVideoSignature(bytes, declaredType || 'video/mp4')) return null;
    return { bytes, mimeType: declaredType || 'video/mp4' };
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
  if (!hasVideoSignature(bytes, declaredType || 'video/mp4')) return null;
  return { bytes, mimeType: declaredType || 'video/mp4' };
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
      try { return Boolean(readAssetFile(accountId, asset.id)); } catch { return false; }
    });
}

/** Return only persisted, readable inventory assets belonging to this task. */
export function listVideoTaskInventoryAssets(accountId: string, task: ProviderTask): WorkspaceAsset[] {
  if (task.accountId !== accountId || task.mode !== 'video') return [];
  const byId = validInventoryAssets(accountId, task);
  if (byId.length > 0 || !task.inventorySavedAt) return byId;
  const base = taskNameForInventory(task).toLowerCase();
  return listAssets(accountId, 'inventory-video').filter((asset) => {
    const stem = asset.name.replace(/\.[^.]+$/, '').toLowerCase();
    if (stem !== base && !stem.startsWith(`${base}_`)) return false;
    try { return Boolean(readAssetFile(accountId, asset.id)); } catch { return false; }
  });
}

/** Persist completed video outputs as account-scoped inventory-video assets. */
export async function saveVideoTaskOutputsToAssets(accountId: string, task: ProviderTask, dependencies: VideoInventoryDependencies = {}): Promise<WorkspaceAsset[]> {
  if (task.mode !== 'video' || task.status !== 'completed' || task.accountId !== accountId) return [];
  const existing = validInventoryAssets(accountId, task);
  const declaredIds = declaredInventoryAssetIds(task);
  if (declaredIds.length > 0 && existing.length === declaredIds.length) return [];

  const outputs: Array<{ bytes: Buffer; mimeType: string; index: number }> = [];
  for (let index = 0; index < task.outputBase64.length && outputs.length < MAX_OUTPUTS_PER_TASK; index += 1) {
    const decoded = decodeBase64(task.outputBase64[index]);
    if (decoded) outputs.push({ ...decoded, index });
  }

  // Provider content endpoints require server-side credentials. Prefer this
  // path for suppliers that expose /videos/{id}/content, then fall back to
  // persisted/public output URLs for other providers.
  let contentFetched = false;
  if (outputs.length === 0 && task.providerTaskId && ['grok-video', 'mgrouter-grok-video', 'oairegbox-omni'].includes(task.provider)) {
    try {
      const downloaded = await downloadProviderVideoContent(task.provider, task.providerTaskId);
      outputs.push({ bytes: Buffer.from(downloaded.bytes), mimeType: downloaded.mimeType.startsWith('video/') ? downloaded.mimeType : 'video/mp4', index: 0 });
      contentFetched = true;
    } catch { /* try persisted URLs below */ }
  }

  const seenUrls = new Set<string>();
  for (let index = 0; !contentFetched && index < task.outputUrls.length && outputs.length < MAX_OUTPUTS_PER_TASK; index += 1) {
    const url = task.outputUrls[index].trim();
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const output = await readUrl(url, dependencies).catch(() => null);
    if (output) outputs.push({ ...output, index: outputs.length });
  }

  const existingByName = new Map(
    listAssets(accountId, 'inventory-video')
      .filter((asset) => {
        try { return Boolean(readAssetFile(accountId, asset.id)); } catch { return false; }
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
  if (repairInFlight) return repairInFlight.then(() => repairSavedVideoTaskInventory(accountIds, dependencies));
  repairInFlight = (async () => {
    let repaired = 0;
    const scope = accountIds ? new Set(accountIds) : null;
    for (const task of listProviderTasks({ mode: 'video' })) {
      if (scope && !scope.has(task.accountId)) continue;
      if (task.status !== 'completed' || !task.inventorySavedAt) continue;
      const current = listVideoTaskInventoryAssets(task.accountId, task);
      const declaredIds = declaredInventoryAssetIds(task);
      if (declaredIds.length > 0 && current.length === declaredIds.length) continue;
      const created = await saveVideoTaskOutputsToAssets(task.accountId, task, dependencies);
      const allAssets = [...current, ...created];
      const ids = Array.from(new Set(allAssets.map((asset) => asset.id)));
      if (ids.length > 0) {
        updateProviderTask(task.id, {
          inventorySavedAt: task.inventorySavedAt,
          metadata: { ...(task.metadata ?? {}), inventoryAssetIds: ids },
        });
        repaired += 1;
        continue;
      }
      // A stale saved marker must not hide an unavailable output forever.
      const { inventoryAssetIds: _ignored, ...metadata } = task.metadata ?? {};
      updateProviderTask(task.id, { inventorySavedAt: undefined, metadata });
    }
    return repaired;
  })().finally(() => { repairInFlight = null; });
  return repairInFlight;
}
