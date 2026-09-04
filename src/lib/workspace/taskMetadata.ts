import path from 'node:path';
import { readAssetFile } from './assetStore';
import { readProductImageAsset } from './productImages';

function nameFromUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const pathname = new URL(value).pathname;
    const name = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '').trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Resolves the first selected image name for stable queue titles. */
export function firstReferenceImageName(input: {
  accountId: string;
  referenceAssetIds?: readonly string[];
  assetIds?: readonly string[];
  productImageAssetIds?: readonly string[];
  rawReferenceImages?: readonly string[];
}): string | undefined {
  const accountAssetIds = [...(input.referenceAssetIds ?? []), ...(input.assetIds ?? [])];
  for (const assetId of accountAssetIds) {
    const record = readAssetFile(input.accountId, assetId);
    if (record?.asset.kind === 'image' && record.asset.name.trim()) return record.asset.name.trim();
  }
  for (const assetId of input.productImageAssetIds ?? []) {
    const product = readProductImageAsset(assetId);
    const fileName = product ? path.basename(product.relativePath).trim() : '';
    // Imported 8765 images live inside a PID folder and their physical file
    // names are usually generic (001.jpg). Prefix the PID so Excel matching
    // can resolve the same `pid_...` convention used by uploaded references.
    if (product?.pid && fileName) return `${product.pid}_${fileName}`;
  }
  return nameFromUrl(input.rawReferenceImages?.[0]);
}
