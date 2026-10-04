import type { EarningsVideoRow } from './showroomPerformance';

export type PublishedSourceVideo = {
  targetId: string;
  jobId: string;
  productPid: string;
  productTitle: string;
  publishTitle: string;
  videoId: string;
  videoUrl: string;
  publishedAt: string;
  accountName: string;
  accountUsername: string;
  accountOwner: string;
  publishingOperator: string;
};

export type PublishedVideoPerformance = PublishedSourceVideo & {
  productName: string;
  previewImage: string;
  orders: number;
  tcDuplicateOrders: number;
  gmv: number;
  commission: number;
  playCount: number | null;
  currency: string;
  earningsMatched: boolean;
};

export type PublishedPidPerformance = {
  productPid: string;
  productName: string;
  previewImage: string;
  videos: number;
  linkedVideos: number;
  attributedVideos: number;
  orders: number;
  tcDuplicateOrders: number;
  gmv: number;
  currency: string;
  latestPublishedAt: string;
};

export type PublishedPerformance = {
  totals: {
    pids: number;
    videos: number;
    linkedVideos: number;
    attributedVideos: number;
    orders: number;
    tcDuplicateOrders: number;
    gmv: number;
    currency: string;
  };
  pids: PublishedPidPerformance[];
  videos: PublishedVideoPerformance[];
};

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

function rowsFrom(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object' && Array.isArray((input as { items?: unknown }).items)) {
    return (input as { items: unknown[] }).items;
  }
  return [];
}

export function normalizePublishedVideos(input: unknown): PublishedSourceVideo[] {
  const unique = new Map<string, PublishedSourceVideo>();
  for (const value of rowsFrom(input).slice(0, 50_000)) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const targetId = safeString(row.target_id, 120);
    if (!targetId) continue;
    unique.set(targetId, {
      targetId,
      jobId: safeString(row.job_id, 120),
      productPid: safeString(row.product_pid, 120),
      productTitle: safeString(row.product_title, 1_000),
      publishTitle: safeString(row.title, 2_000),
      videoId: safeString(row.video_id, 100),
      videoUrl: safeExternalLink(row.video_url),
      publishedAt: safeString(row.published_at, 80),
      accountName: safeString(row.account_name, 200),
      accountUsername: safeString(row.account_username, 100).replace(/^@/, '').toLowerCase(),
      accountOwner: safeString(row.account_owner, 120),
      publishingOperator: safeString(row.publishing_operator, 120),
    });
  }
  return [...unique.values()];
}

function productCatalog(input: unknown): Map<string, { image: string; name: string }> {
  const result = new Map<string, { image: string; name: string }>();
  if (!Array.isArray(input)) return result;
  for (const value of input.slice(0, 20_000)) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const pid = safeString(row.product_id, 120);
    const image = safeExternalLink(row.product_image);
    const name = safeString(row.product_name, 1_000);
    if (pid && !result.has(pid)) result.set(pid, { image, name });
  }
  return result;
}

function currencyFor(values: readonly string[]): string {
  const currencies = [...new Set(values.filter(Boolean))];
  return currencies.length === 1 ? currencies[0] : currencies.length ? 'MIXED' : 'MXN';
}

export function aggregatePublishedPerformance(
  publishedRows: readonly PublishedSourceVideo[],
  earningsRows: readonly EarningsVideoRow[],
  productRows: unknown,
): PublishedPerformance {
  const earningsByVideoId = new Map(earningsRows.map((row) => [row.videoId, row]));
  const products = productCatalog(productRows);
  const videos = publishedRows.map<PublishedVideoPerformance>((row) => {
    const earnings = row.videoId ? earningsByVideoId.get(row.videoId) : undefined;
    const productPid = row.productPid || earnings?.productId || '';
    const product = products.get(productPid);
    return {
      ...row,
      productPid,
      productName: row.productTitle || earnings?.productName || product?.name || '',
      previewImage: product?.image || earnings?.previewImage || '',
      videoUrl: row.videoUrl || earnings?.promotionLink || '',
      orders: earnings?.orders ?? 0,
      tcDuplicateOrders: earnings?.tcDuplicateOrders ?? 0,
      gmv: earnings?.gmv ?? 0,
      commission: earnings?.commission ?? 0,
      playCount: earnings?.playCount ?? null,
      currency: earnings?.currency || 'MXN',
      earningsMatched: Boolean(earnings),
    };
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.targetId.localeCompare(a.targetId));

  const pidMap = new Map<string, PublishedPidPerformance>();
  for (const video of videos) {
    const pid = video.productPid || '未识别 PID';
    const current = pidMap.get(pid) ?? {
      productPid: pid,
      productName: '',
      previewImage: '',
      videos: 0,
      linkedVideos: 0,
      attributedVideos: 0,
      orders: 0,
      tcDuplicateOrders: 0,
      gmv: 0,
      currency: 'MXN',
      latestPublishedAt: '',
    };
    current.productName ||= video.productName;
    current.previewImage ||= video.previewImage;
    current.videos += 1;
    current.linkedVideos += video.videoId ? 1 : 0;
    current.attributedVideos += video.earningsMatched ? 1 : 0;
    current.orders += video.orders;
    current.tcDuplicateOrders += video.tcDuplicateOrders;
    current.gmv += video.gmv;
    current.currency = current.videos === 1 ? video.currency : currencyFor([current.currency, video.currency]);
    if (video.publishedAt > current.latestPublishedAt) current.latestPublishedAt = video.publishedAt;
    pidMap.set(pid, current);
  }

  const pids = [...pidMap.values()]
    .map((row) => ({ ...row, gmv: Number(row.gmv.toFixed(2)) }))
    .sort((a, b) => b.latestPublishedAt.localeCompare(a.latestPublishedAt) || b.videos - a.videos || a.productPid.localeCompare(b.productPid));
  return {
    totals: {
      pids: pids.length,
      videos: videos.length,
      linkedVideos: videos.filter((video) => video.videoId).length,
      attributedVideos: videos.filter((video) => video.earningsMatched).length,
      orders: videos.reduce((sum, video) => sum + video.orders, 0),
      tcDuplicateOrders: videos.reduce((sum, video) => sum + video.tcDuplicateOrders, 0),
      gmv: Number(videos.reduce((sum, video) => sum + video.gmv, 0).toFixed(2)),
      currency: currencyFor(videos.map((video) => video.currency)),
    },
    pids,
    videos,
  };
}
