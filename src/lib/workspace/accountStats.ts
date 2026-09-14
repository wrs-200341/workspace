import { countAssetsByAccount, listAssets, type AssetKind } from './assetStore';
import { listProviderTaskSummaries } from '@/lib/providers/taskStore';
import type { WorkspaceAccount } from './data';

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

/** Compute counters from live asset and provider-task data for one account. */
export function getLiveAccountStats(accountId: string): LiveAccountStats {
  const assets = listAssets(accountId);
  const assetCounts: Record<AssetKind, number> = { ...EMPTY_ASSET_COUNTS };
  for (const asset of assets) assetCounts[asset.kind] += 1;

  const videoTasks = listProviderTaskSummaries({ accountId, mode: 'video', status: 'completed' });
  const successful = videoTasks
    .map((task) => ({ task, outputs: task.outputCount }))
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
  const accountAssetCounts = countAssetsByAccount(accounts.map((account) => account.id));
  return accounts.map((account) => {
    const assetCounts = accountAssetCounts[account.id] ?? EMPTY_ASSET_COUNTS;
    return {
      ...account,
      promptCount: assetCounts.prompt,
      fileCount: assetCounts.image,
      videoCount: assetCounts['inventory-video'],
      publishedCount: 0,
    };
  });
}
