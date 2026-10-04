import type { WorkspaceAccount } from './data';

export const SHOWROOM_OPERATOR_NAMES = ['Debra', '王润生', '郭青青', '陈曦', '吴风燕', '自莉'] as const;

export type ShowroomOperatorName = (typeof SHOWROOM_OPERATOR_NAMES)[number];

export type EarningsVideoRow = {
  videoId: string;
  productId: string;
  productName: string;
  previewImage: string;
  creatorUsername: string;
  promotionLink: string;
  currency: string;
  orders: number;
  tcDuplicateOrders: number;
  gmv: number;
  commission: number;
  playCount: number | null;
  publishedAt: string;
};

export type ShowroomVideo = EarningsVideoRow & {
  ownerName: ShowroomOperatorName;
  workspaceAccountId: string;
  workspaceAccountName: string;
};

export type ShowroomAccountPerformance = {
  workspaceAccountId: string;
  workspaceAccountName: string;
  ownerName: ShowroomOperatorName;
  handle: string | null;
  videos: number;
  orders: number;
  tcDuplicateOrders: number;
  gmv: number;
  currency: string;
};

export type ShowroomOperatorPerformance = {
  name: ShowroomOperatorName;
  featuredAccounts: number;
  matchedAccounts: number;
  videos: number;
  orders: number;
  gmv: number;
  currency: string;
};

export type ShowroomPerformance = {
  totals: {
    featuredAccounts: number;
    matchableAccounts: number;
    matchedAccounts: number;
    videos: number;
    orders: number;
    gmv: number;
    currency: string;
  };
  operators: ShowroomOperatorPerformance[];
  accounts: ShowroomAccountPerformance[];
  videos: ShowroomVideo[];
};

function canonicalOwnerName(value: string): ShowroomOperatorName | null {
  const normalized = value.trim();
  if (normalized.toLowerCase() === 'debra') return 'Debra';
  if (normalized === '吴凤燕' || normalized === '吴风燕') return '吴风燕';
  return SHOWROOM_OPERATOR_NAMES.find((name) => name === normalized) ?? null;
}

/** Extract the TikTok username embedded at the front of existing account labels. */
export function extractFeaturedAccountHandle(name: string): string | null {
  const parts = name
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .split(/[-–—\s()[\]{}]+/)
    .filter(Boolean);
  return parts.find((part) => /^[a-z][a-z0-9._]{2,63}$/.test(part)) ?? null;
}

function finiteNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

function safeString(value: unknown, maxLength = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function safeExternalLink(value: unknown): string {
  const raw = safeString(value, 2_000);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function normalizeEarningsVideos(input: unknown): EarningsVideoRow[] {
  if (!Array.isArray(input)) return [];
  const unique = new Map<string, EarningsVideoRow>();
  for (const value of input.slice(0, 20_000)) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const videoId = safeString(row.video_id, 100);
    const creatorUsername = safeString(row.creator_username, 100).replace(/^@/, '').toLowerCase();
    if (!videoId || !creatorUsername) continue;
    unique.set(videoId, {
      videoId,
      productId: safeString(row.product_id, 100),
      productName: safeString(row.product_name, 1_000),
      previewImage: '',
      creatorUsername,
      promotionLink: safeExternalLink(row.promotion_link),
      currency: safeString(row.currency, 12).toUpperCase() || 'MXN',
      orders: Math.max(0, Math.round(finiteNumber(row.orders))),
      tcDuplicateOrders: Math.max(0, Math.round(finiteNumber(row.tc_duplicate_orders))),
      gmv: Math.max(0, finiteNumber(row.gmv)),
      commission: Math.max(0, finiteNumber(row.commission)),
      playCount: row.play_count === null || row.play_count === undefined ? null : Math.max(0, Math.round(finiteNumber(row.play_count))),
      publishedAt: safeString(row.publish_local, 80),
    });
  }
  return [...unique.values()];
}

export function mergeEarningsProductImages(
  videos: readonly EarningsVideoRow[],
  input: unknown,
): EarningsVideoRow[] {
  if (!Array.isArray(input)) return videos.map((video) => ({ ...video }));
  const imageByProductId = new Map<string, string>();
  for (const value of input.slice(0, 20_000)) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const productId = safeString(row.product_id, 100);
    const previewImage = safeExternalLink(row.product_image);
    if (productId && previewImage && !imageByProductId.has(productId)) {
      imageByProductId.set(productId, previewImage);
    }
  }
  return videos.map((video) => ({
    ...video,
    previewImage: imageByProductId.get(video.productId) ?? '',
  }));
}

function currencyFor(values: readonly string[]): string {
  const currencies = [...new Set(values.filter(Boolean))];
  return currencies.length === 1 ? currencies[0] : currencies.length ? 'MIXED' : 'MXN';
}

export function aggregateShowroomPerformance(
  workspaceAccounts: readonly WorkspaceAccount[],
  earningsVideos: readonly EarningsVideoRow[],
): ShowroomPerformance {
  const featured = workspaceAccounts.flatMap((account) => {
    const ownerName = canonicalOwnerName(account.ownerName);
    return account.category === 'featured' && ownerName ? [{ account, ownerName }] : [];
  });

  const accountsByKey = new Map<string, ShowroomAccountPerformance>();
  for (const { account, ownerName } of featured) {
    const handle = extractFeaturedAccountHandle(account.name);
    const key = handle ? `${ownerName}:${handle}` : `${ownerName}:${account.id}`;
    if (accountsByKey.has(key)) continue;
    accountsByKey.set(key, {
      workspaceAccountId: account.id,
      workspaceAccountName: account.name,
      ownerName,
      handle,
      videos: 0,
      orders: 0,
      tcDuplicateOrders: 0,
      gmv: 0,
      currency: 'MXN',
    });
  }

  const accountByHandle = new Map<string, ShowroomAccountPerformance>();
  for (const account of accountsByKey.values()) {
    if (account.handle && !accountByHandle.has(account.handle)) accountByHandle.set(account.handle, account);
  }

  const videos: ShowroomVideo[] = [];
  for (const row of earningsVideos) {
    const account = accountByHandle.get(row.creatorUsername);
    if (!account) continue;
    account.videos += 1;
    account.orders += row.orders;
    account.tcDuplicateOrders += row.tcDuplicateOrders;
    account.gmv += row.gmv;
    account.currency = account.videos === 1 ? row.currency : currencyFor([account.currency, row.currency]);
    videos.push({
      ...row,
      ownerName: account.ownerName,
      workspaceAccountId: account.workspaceAccountId,
      workspaceAccountName: account.workspaceAccountName,
    });
  }

  const accounts = [...accountsByKey.values()]
    .map((account) => ({ ...account, gmv: Number(account.gmv.toFixed(2)) }))
    .sort((a, b) => b.orders - a.orders || b.gmv - a.gmv || a.workspaceAccountName.localeCompare(b.workspaceAccountName));
  videos.sort((a, b) => b.orders - a.orders || b.gmv - a.gmv || b.publishedAt.localeCompare(a.publishedAt));

  const operators = SHOWROOM_OPERATOR_NAMES.map((name) => {
    const ownerAccounts = accounts.filter((account) => account.ownerName === name);
    const ownerVideos = videos.filter((video) => video.ownerName === name);
    return {
      name,
      featuredAccounts: ownerAccounts.length,
      matchedAccounts: ownerAccounts.filter((account) => account.videos > 0).length,
      videos: ownerVideos.length,
      orders: ownerVideos.reduce((sum, video) => sum + video.orders, 0),
      gmv: Number(ownerVideos.reduce((sum, video) => sum + video.gmv, 0).toFixed(2)),
      currency: currencyFor(ownerVideos.map((video) => video.currency)),
    };
  });
  const matchedAccounts = accounts.filter((account) => account.videos > 0);
  return {
    totals: {
      featuredAccounts: accounts.length,
      matchableAccounts: accounts.filter((account) => account.handle).length,
      matchedAccounts: matchedAccounts.length,
      videos: videos.length,
      orders: videos.reduce((sum, video) => sum + video.orders, 0),
      gmv: Number(videos.reduce((sum, video) => sum + video.gmv, 0).toFixed(2)),
      currency: currencyFor(videos.map((video) => video.currency)),
    },
    operators,
    accounts,
    videos,
  };
}
