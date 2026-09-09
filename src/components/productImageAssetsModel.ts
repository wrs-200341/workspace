export type ProductImageRecordView = {
  accountId: string;
  pid: string;
  importedAt: string;
  importDate: string;
  relativePath: string;
  files: string[];
};

export type ProductGalleryItemView = {
  pid: string;
  title?: string;
  description?: string;
  coverUrl?: string;
  [key: string]: unknown;
};

export type ProductImageFolderAssetLike = {
  id: string;
  pid?: string;
  name: string;
  shared?: boolean;
  coverUrl?: string;
  url?: string;
};

export type ProductImageFolderView<T extends ProductImageFolderAssetLike = ProductImageFolderAssetLike> = {
  key: string;
  pid: string;
  shared: boolean;
  imageCount: number;
  cover?: T;
  images?: T[];
};

const PID_SPLIT_RE = /[\s,，、;；]+/;
const PID_HEADER_VALUES = new Set(['pid', '商品编号', '商品id', 'product id', 'productid']);

export function buildProductImagesUrl(accountId: string, query?: string): string {
  const params = new URLSearchParams();
  const normalized = query?.trim();
  if (normalized) params.set('query', normalized);
  const suffix = params.toString();
  return `/api/workspace/accounts/${encodeURIComponent(accountId)}/product-images${suffix ? `?${suffix}` : ''}`;
}

/** Parse PID values from a plain-text list (one per line, commas accepted). */
export function parsePidListText(input: string, max = 100): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const token of input.split(PID_SPLIT_RE)) {
    const value = normalizePidToken(token);
    if (!value) continue;
    const normalized = value.toLowerCase();
    if (PID_HEADER_VALUES.has(normalized)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= max) break;
  }
  return result;
}

function normalizePidToken(value: string): string {
  const token = value.trim().replace(/^\uFEFF+/, '').replace(/^['"]|['"]$/g, '');
  if (!token) return '';
  const scientific = token.match(/^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!scientific) return token;
  const [, integerPart, fractionPart = '', exponentText] = scientific;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || exponent < 0 || fractionPart.replace(/0+$/, '').length > 0) return token;
  return `${integerPart}${fractionPart}${'0'.repeat(Math.max(0, exponent - fractionPart.length))}`.replace(/^0+(?=\d)/, '');
}

/** Parse PID values from the first column of a worksheet represented as rows. */
export function parsePidRows(rows: unknown[][], max = 100): string[] {
  return parsePidListText(rows.map((row) => String(Array.isArray(row) ? row[0] ?? '' : '')).join('\n'), max);
}

export function normalizeProductImagesPayload(payload: unknown): {
  imported: ProductImageRecordView[];
  gallery: ProductGalleryItemView[];
} {
  if (!payload || typeof payload !== 'object') return { imported: [], gallery: [] };
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return { imported: [], gallery: [] };
  const record = data as { imported?: unknown; gallery?: unknown };
  return {
    imported: Array.isArray(record.imported) ? record.imported.filter(isImportedRecord) : [],
    gallery: Array.isArray(record.gallery) ? record.gallery.filter(isGalleryItem) : [],
  };
}

export function normalizeProductGalleryItems(items: readonly ProductGalleryItemView[]): ProductGalleryItemView[] {
  const deduped = new Map<string, ProductGalleryItemView>();
  for (const item of items) {
    if (!isGalleryItem(item)) continue;
    deduped.set(item.pid, { ...item });
  }
  return [...deduped.values()].sort((left, right) => left.pid.localeCompare(right.pid, undefined, { numeric: true, sensitivity: 'base' }));
}

export function groupProductImageFolders<T extends ProductImageFolderAssetLike>(assets: readonly T[], accountId: string): ProductImageFolderView<T>[] {
  const grouped = new Map<string, T[]>();
  for (const asset of assets) {
    if (!asset.pid) continue;
    const key = `${asset.shared ? 'shared' : accountId}:${asset.pid}`;
    grouped.set(key, [...(grouped.get(key) ?? []), asset]);
  }
  return [...grouped.entries()]
    .map(([key, images]) => {
      const [scope, pid] = key.split(':', 2);
      return {
        key,
        pid,
        shared: scope === 'shared',
        imageCount: images.length,
        cover: images[0],
        images: [...images],
      } satisfies ProductImageFolderView<T>;
    })
    .sort((left, right) => {
      if (left.shared !== right.shared) return left.shared ? 1 : -1;
      const pidOrder = left.pid.localeCompare(right.pid, undefined, { numeric: true, sensitivity: 'base' });
      if (pidOrder !== 0) return pidOrder;
      return left.key.localeCompare(right.key);
    });
}

function isImportedRecord(value: unknown): value is ProductImageRecordView {
  return Boolean(value && typeof value === 'object' && typeof (value as { pid?: unknown }).pid === 'string' && Array.isArray((value as { files?: unknown }).files));
}

function isGalleryItem(value: unknown): value is ProductGalleryItemView {
  return Boolean(value && typeof value === 'object' && typeof (value as { pid?: unknown }).pid === 'string');
}
