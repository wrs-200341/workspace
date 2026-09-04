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

export function buildProductImagesUrl(accountId: string, query?: string): string {
  const params = new URLSearchParams();
  const normalized = query?.trim();
  if (normalized) params.set('query', normalized);
  const suffix = params.toString();
  return `/api/workspace/accounts/${encodeURIComponent(accountId)}/product-images${suffix ? `?${suffix}` : ''}`;
}

/** Parse PID values from a plain-text list (one per line, commas accepted). */
export function parsePidListText(input: string, max = 100): string[] {
  const values = input.split(/[\s,，、;；]+/).map(normalizePidToken);
  return [...new Set(values.filter((value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)))]
    .filter((value) => !['pid', '商品编号', '商品id', 'product id', '鍟嗗搧缂栧彿', '鍟嗗搧id'].includes(value.toLowerCase()))
    .slice(0, max);
}

function normalizePidToken(value: string): string {
  const token = value.trim().replace(/^\uFEFF+/, '').replace(/^['\"]|['\"]$/g, '');
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
  const imported = Array.isArray(record.imported) ? record.imported.filter(isImportedRecord) : [];
  const gallery = Array.isArray(record.gallery) ? record.gallery.filter(isGalleryItem) : [];
  return { imported, gallery };
}

function isImportedRecord(value: unknown): value is ProductImageRecordView {
  return Boolean(value && typeof value === 'object' && typeof (value as { pid?: unknown }).pid === 'string' && Array.isArray((value as { files?: unknown }).files));
}

function isGalleryItem(value: unknown): value is ProductGalleryItemView {
  return Boolean(value && typeof value === 'object' && typeof (value as { pid?: unknown }).pid === 'string');
}
