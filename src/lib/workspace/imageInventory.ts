import { createUploadedAsset, type WorkspaceAsset } from './assetStore';
import { readStoredOutput } from '@/lib/providers/outputStore';
import type { ProviderTask } from '@/lib/providers/taskStore';

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

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

async function readOutput(accountId: string, task: ProviderTask, value: string, index: number): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const local = value.match(/\/image-tasks\/[^/]+\/outputs\/(\d+)$/);
  if (local) {
    const stored = readStoredOutput(accountId, task.id, Number(local[1]));
    return stored ? { bytes: stored.bytes, mimeType: stored.mimeType } : null;
  }
  if (!/^https?:\/\//i.test(value)) return null;
  const response = await fetch(value, { redirect: 'error' });
  if (!response.ok) return null;
  const mimeType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!mimeType.startsWith('image/')) return null;
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_OUTPUT_BYTES) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES) return null;
  return { bytes, mimeType };
}

/** Persist completed image outputs as account-scoped image assets. */
export async function saveImageTaskOutputsToAssets(accountId: string, task: ProviderTask): Promise<WorkspaceAsset[]> {
  if (task.mode !== 'image' || task.status !== 'completed') return [];
  const existing = Array.isArray(task.metadata?.inventoryAssetIds)
    ? task.metadata.inventoryAssetIds.filter((value): value is string => typeof value === 'string')
    : [];
  if (existing.length) return [];
  const outputs: Array<{ bytes: Buffer; mimeType: string; index: number }> = [];
  for (let index = 0; index < task.outputBase64.length; index += 1) {
    const decoded = decodeBase64(task.outputBase64[index]);
    if (decoded) outputs.push({ ...decoded, index });
  }
  const urlOffset = outputs.length;
  for (let index = 0; index < task.outputUrls.length; index += 1) {
    const output = await readOutput(accountId, task, task.outputUrls[index], index);
    if (output) outputs.push({ ...output, index: urlOffset + index });
  }
  const assets: WorkspaceAsset[] = [];
  for (const output of outputs) {
    const extension = extensionForMime(output.mimeType);
    const asset = createUploadedAsset(accountId, 'image', {
      name: `generated-${task.id}-${output.index}.${extension}`,
      type: output.mimeType,
      size: output.bytes.length,
      arrayBuffer: Uint8Array.from(output.bytes).buffer,
    });
    assets.push(asset);
  }
  return assets;
}
