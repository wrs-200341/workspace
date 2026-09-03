import { listAssets, type AssetKind } from './assetStore';
import { listProviderTasks, type ProviderTask } from '@/lib/providers/taskStore';
import type { WorkspaceAccount } from './data';
import { countVideoOutputs } from '@/lib/providers/videoOutputUrls';

/**
 * Counters derived from the current workspace stores.
 *
 * `WorkspaceAccount` still carries counter fields for backwards-compatible
 * JSON records, but those fields are historical metadata and are deliberately
 * not used here. This module is the single source for account card counters.
 */
export type LiveAccountStats = {
  promptCount: number;
  fileCount: number;
  videoCount: number;
  publishedCount: number;
  assetCounts: Record<AssetKind, number>;
  successfulVideoTaskCount: number;
  successfulVideoOutputCount: number;
};

const EMPTY_ASSET_COUNTS: Record<AssetKind, number> = {
  prompt: 0,
  image: 0,
  'inventory-video': 0,
  audio: 0,
};

function outputCount(task: ProviderTask): number {
  const inventoryIds = Array.isArray(task.metadata?.inventoryAssetIds)
    ? task.metadata.inventoryAssetIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  if (task.inventorySavedAt && inventoryIds.length > 0) return inventoryIds.length;
  // Provider task storage already normalizes these arrays, but counting only
  // non-empty strings keeps the statistic correct for legacy records.
  return countVideoOutputs(task.provider, task.outputUrls, task.outputBase64, Boolean(task.providerTaskId));
}

/** Compute counters from live asset and provider-task data for one account. */
export function getLiveAccountStats(accountId: string): LiveAccountStats {
  const assets = listAssets(accountId);
  const assetCounts: Record<AssetKind, number> = { ...EMPTY_ASSET_COUNTS };
  for (const asset of assets) assetCounts[asset.kind] += 1;

  const videoTasks = listProviderTasks({ accountId, mode: 'video' });
  const successful = videoTasks
    .map((task) => ({ task, outputs: outputCount(task) }))
    .filter(({ task, outputs }) => task.status === 'completed' && outputs > 0);
  // The account card's "视频" counter is the inventory-video asset branch,
  // not a count of transient provider outputs. Published content has no
  // trusted downstream source in this standalone workspace, so it remains
  // truthful zero until a publishing integration records it.
  const videoCount = assetCounts['inventory-video'];
  const publishedCount = 0;
  const successfulVideoOutputCount = successful.reduce((sum, item) => sum + item.outputs, 0);

  return {
    promptCount: assetCounts.prompt,
    fileCount: assetCounts.image,
    videoCount,
    publishedCount,
    assetCounts,
    successfulVideoTaskCount: successful.length,
    successfulVideoOutputCount,
  };
}

/**
 * Add live counters without mutating the stored account object. The legacy
 * counter fields are intentionally overwritten in the returned copy only.
 */
export function withLiveAccountStats(account: WorkspaceAccount): WorkspaceAccount {
  const stats = getLiveAccountStats(account.id);
  return {
    ...account,
    promptCount: stats.promptCount,
    fileCount: stats.fileCount,
    videoCount: stats.videoCount,
    publishedCount: stats.publishedCount,
  };
}

export function withLiveAccountStatsList(accounts: readonly WorkspaceAccount[]): WorkspaceAccount[] {
  // Read the provider task store once for an account list. Admin workspaces
  // can contain many accounts, and rereading the same JSON file per card adds
  // avoidable latency while producing the same result.
  const videoTasksByAccount = new Map<string, ProviderTask[]>();
  for (const task of listProviderTasks({ mode: 'video' })) {
    const current = videoTasksByAccount.get(task.accountId) ?? [];
    videoTasksByAccount.set(task.accountId, [...current, task]);
  }
  return accounts.map((account) => {
    const assets = listAssets(account.id);
    const assetCounts: Record<AssetKind, number> = { ...EMPTY_ASSET_COUNTS };
    for (const asset of assets) assetCounts[asset.kind] += 1;
    const successful = (videoTasksByAccount.get(account.id) ?? [])
      .map((task) => ({ task, outputs: outputCount(task) }))
      .filter(({ task, outputs }) => task.status === 'completed' && outputs > 0);
    const videoCount = assetCounts['inventory-video'];
    const publishedCount = 0;
    const successfulVideoOutputCount = successful.reduce((sum, item) => sum + item.outputs, 0);
    return {
      ...account,
      promptCount: assetCounts.prompt,
      fileCount: assetCounts.image,
      videoCount,
      publishedCount,
    };
  });
}
