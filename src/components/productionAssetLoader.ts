export type ProductionMediaAsset = {
  id: string;
  name: string;
  kind: 'image' | 'product-image' | 'inventory-video' | 'audio';
  mimeType?: string;
  pid?: string;
  shared?: boolean;
  coverUrl?: string;
  thumbnailUrl?: string;
  url?: string;
  relativePath?: string;
  imageCount?: number;
};

export type ProductionPickerKind = 'image' | 'inventory-video' | 'audio' | 'product-image';

type AssetPayload = {
  success?: boolean;
  error?: string;
  data?: {
    assets?: ProductionMediaAsset[];
    asset?: ProductionMediaAsset;
    folders?: Array<{ pid: string; coverUrl?: string; imageCount?: number; shared?: boolean }>;
    folder?: { images?: ProductionMediaAsset[] };
  };
};

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 16;

/** Each form owns a loader: cached account data never survives its owner. */
export function createProductionAssetLoader(accountId: string) {
  const accountPath = `/api/workspace/accounts/${encodeURIComponent(accountId)}/files`;
  const productPath = `/api/workspace/product-images?accountId=${encodeURIComponent(accountId)}`;
  const cache = new Map<string, { expiresAt: number; promise: Promise<ProductionMediaAsset[]> }>();

  async function request(url: string): Promise<AssetPayload['data']> {
    const response = await fetch(url, { cache: 'no-store' });
    const payload = await response.json() as AssetPayload;
    if (!response.ok || !payload.success) throw new Error(payload.error || 'asset_list_failed');
    return payload.data;
  }

  function cached(key: string, load: () => Promise<ProductionMediaAsset[]>): Promise<ProductionMediaAsset[]> {
    const existing = cache.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      cache.delete(key);
      cache.set(key, existing);
      return existing.promise;
    }
    const entry = { expiresAt: Infinity, promise: Promise.resolve([] as ProductionMediaAsset[]) };
    entry.promise = load().then((assets) => {
      entry.expiresAt = Date.now() + CACHE_TTL_MS;
      return assets;
    }).catch((error) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    return entry.promise;
  }

  function loadPicker(kind: ProductionPickerKind): Promise<ProductionMediaAsset[]> {
    return cached(`picker:${kind}`, async () => {
      if (kind !== 'product-image') return (await request(`${accountPath}?kind=${kind}`))?.assets ?? [];
      const data = await request(productPath);
      return (data?.folders ?? []).map((folder) => ({
        id: `product-folder:${folder.pid}`,
        name: folder.pid,
        kind: 'product-image',
        pid: folder.pid,
        shared: folder.shared !== false,
        coverUrl: folder.coverUrl,
        imageCount: folder.imageCount ?? 0,
      }));
    });
  }

  function loadProductFolder(pid: string): Promise<ProductionMediaAsset[]> {
    return cached(`folder:${pid}`, async () => {
      const data = await request(`${productPath}&pid=${encodeURIComponent(pid)}`);
      return (data?.folder?.images ?? []).map((asset) => ({ ...asset, kind: 'product-image', shared: true }));
    });
  }

  async function loadSelected(ids: readonly string[]): Promise<ProductionMediaAsset[]> {
    const assets = await Promise.all([...new Set(ids)].map(async (id) => {
      try {
        const parts = id.split(':');
        if (parts[0] === 'product-image' && parts.length >= 5 && parts[3]) {
          return (await loadProductFolder(parts[3])).find((asset) => asset.id === id);
        }
        const data = await request(`${accountPath}/${encodeURIComponent(id)}?metadata=1`);
        return data?.asset;
      } catch {
        return undefined;
      }
    }));
    return assets.filter((asset): asset is ProductionMediaAsset => Boolean(asset));
  }

  function invalidate(kind: ProductionPickerKind) {
    cache.delete(`picker:${kind}`);
    if (kind === 'product-image') {
      for (const key of cache.keys()) if (key.startsWith('folder:')) cache.delete(key);
    }
  }

  return { loadPicker, loadProductFolder, loadSelected, invalidate };
}
