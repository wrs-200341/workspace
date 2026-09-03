import { createUploadedAsset, type WorkspaceAsset } from './assetStore';
import type { ProviderTask } from '@/lib/providers/taskStore';
import { downloadProviderVideoContent } from '@/lib/providers/client';

const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;

function decodeBase64(value: string): { bytes: Buffer; mimeType: string } | null {
  const match = value.match(/^data:([^;\s,]+);base64,([A-Za-z0-9+/=\r\n\t ]+)$/i);
  if (!match) return null;
  const compact = match[2].replace(/[\r\n\t ]+/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  const bytes = Buffer.from(compact, 'base64');
  if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES || bytes.toString('base64') !== compact) return null;
  return { bytes, mimeType: match[1].toLowerCase() || 'video/mp4' };
}

async function readUrl(value: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!/^https:\/\//i.test(value)) return null;
  const response = await fetch(value, { redirect: 'error' });
  if (!response.ok) return null;
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_OUTPUT_BYTES) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES) return null;
  const mimeType = (response.headers.get('content-type') || 'video/mp4').split(';', 1)[0].trim().toLowerCase();
  return { bytes, mimeType: mimeType.startsWith('video/') ? mimeType : 'video/mp4' };
}

/** Persist completed video outputs as account-scoped inventory-video assets. */
export async function saveVideoTaskOutputsToAssets(accountId: string, task: ProviderTask): Promise<WorkspaceAsset[]> {
  if (task.mode !== 'video' || task.status !== 'completed') return [];
  const existing = Array.isArray(task.metadata?.inventoryAssetIds)
    ? task.metadata.inventoryAssetIds.filter((value): value is string => typeof value === 'string')
    : [];
  if (existing.length) return [];

  const outputs: Array<{ bytes: Buffer; mimeType: string; index: number }> = [];
  for (let index = 0; index < task.outputBase64.length; index += 1) {
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

  for (let index = 0; !contentFetched && index < task.outputUrls.length; index += 1) {
    const output = await readUrl(task.outputUrls[index]).catch(() => null);
    if (output) outputs.push({ ...output, index: outputs.length });
  }

  const assets: WorkspaceAsset[] = [];
  for (const output of outputs) {
    const asset = createUploadedAsset(accountId, 'inventory-video', {
      name: `generated-${task.id}-${output.index}.mp4`,
      type: output.mimeType || 'video/mp4',
      size: output.bytes.length,
      arrayBuffer: Uint8Array.from(output.bytes).buffer,
    });
    assets.push(asset);
  }
  return assets;
}
