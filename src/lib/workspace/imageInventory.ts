import dns from 'node:dns/promises';
import { createUploadedAsset, getAsset, readAssetFile, type WorkspaceAsset } from './assetStore';
import { readStoredOutput } from '@/lib/providers/outputStore';
import type { ProviderTask } from '@/lib/providers/taskStore';
import { assertPublicTarget, type LookupAddress } from './externalImageImport';
import { inventoryFileName } from './inventoryNaming';

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export type ImageInventoryDependencies = {
  fetcher?: typeof fetch;
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
};

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
  const local = value.match(/\/image-tasks\/[^/]+\/outputs\/(\d+)$/);
  if (local) {
    const stored = readStoredOutput(accountId, task.id, Number(local[1]));
    return stored ? { bytes: stored.bytes, mimeType: stored.mimeType } : null;
  }
  if (!/^https?:\/\//i.test(value)) return null;
  const lookup = dependencies.lookup ?? ((hostname: string) => dns.lookup(hostname, { all: true, verbatim: true }));
  const target = await assertPublicTarget(value, lookup);
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
      try { return Boolean(readAssetFile(accountId, asset.id)); } catch { return false; }
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
    if (decoded) outputs.push({ ...decoded, index });
  }
  // Keep URL outputs in a separate deterministic slot range. Using the count
  // of successfully decoded Base64 values can collide when an earlier Base64
  // slot is malformed.
  const urlOffset = task.outputBase64.length;
  for (let index = 0; index < task.outputUrls.length; index += 1) {
    const output = await readOutput(accountId, task, task.outputUrls[index], index, dependencies);
    if (output) outputs.push({ ...output, index: urlOffset + index });
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
