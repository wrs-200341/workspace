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
