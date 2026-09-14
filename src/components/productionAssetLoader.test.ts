import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionAssetLoader, type ProductionMediaAsset } from './productionAssetLoader';

const image: ProductionMediaAsset = { id: 'asset-image', name: 'P001-main.png', kind: 'image' };
const video: ProductionMediaAsset = { id: 'asset-video', name: 'clip.mp4', kind: 'inventory-video' };
const product: ProductionMediaAsset = { id: 'product-image:shared:2026-09-14:P001:main.png', name: 'P001-main.png', kind: 'product-image', pid: 'P001' };
const fetchMock = vi.fn<typeof fetch>();

function success(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), { headers: { 'content-type': 'application/json' } });
}

describe('production asset lazy loading', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not request any collection before a picker is opened', async () => {
    const loader = createProductionAssetLoader('account-1');
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(success({ assets: [image] }));
    expect(await loader.loadPicker('image')).toEqual([image]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/workspace/accounts/account-1/files?kind=image', { cache: 'no-store' });
  });

  it('keeps material types separate and preserves server ordering', async () => {
    const secondImage = { ...image, id: 'second-image' };
    const loader = createProductionAssetLoader('account-1');
    fetchMock.mockResolvedValueOnce(success({ assets: [secondImage, image] })).mockResolvedValueOnce(success({ assets: [video] }));

    expect(await loader.loadPicker('image')).toEqual([secondImage, image]);
    expect(await loader.loadPicker('inventory-video')).toEqual([video]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/workspace/accounts/account-1/files?kind=image',
      '/api/workspace/accounts/account-1/files?kind=inventory-video',
    ]);
  });

  it('loads product summaries and folder contents independently', async () => {
    const loader = createProductionAssetLoader('account-1');
    fetchMock.mockResolvedValueOnce(success({ folders: [{ pid: 'P001', imageCount: 2, coverUrl: '/thumbnail' }] }))
      .mockResolvedValueOnce(success({ folder: { images: [product] } }));

    expect(await loader.loadPicker('product-image')).toEqual([{
      id: 'product-folder:P001', name: 'P001', kind: 'product-image', pid: 'P001', imageCount: 2, coverUrl: '/thumbnail', shared: true,
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await loader.loadProductFolder('P001')).toEqual([{ ...product, shared: true }]);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/workspace/product-images?accountId=account-1&pid=P001');
  });

  it('deduplicates concurrent requests and reuses a recently opened picker', async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const loader = createProductionAssetLoader('account-1');
    const first = loader.loadPicker('image');
    const second = loader.loadPicker('image');

    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(success({ assets: [image] }));
    expect(await first).toEqual([image]);
    expect(await loader.loadPicker('image')).toEqual([image]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('expires cached lists and does not share data between form/account owners', async () => {
    vi.useFakeTimers();
    const loader = createProductionAssetLoader('account-1');
    fetchMock.mockImplementation(async () => success({ assets: [image] }));
    await loader.loadPicker('image');
    vi.advanceTimersByTime(30_001);
    await loader.loadPicker('image');
    await createProductionAssetLoader('account-2').loadPicker('image');
    await createProductionAssetLoader('account-1').loadPicker('image');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2][0]).toContain('/account-2/');
  });

  it('invalidates uploaded materials and imported product folders', async () => {
    const loader = createProductionAssetLoader('account-1');
    fetchMock.mockImplementation(async () => success({ assets: [image], folders: [], folder: { images: [product] } }));
    await loader.loadPicker('image');
    await loader.loadPicker('audio');
    await loader.loadPicker('product-image');
    await loader.loadProductFolder('P001');

    loader.invalidate('image');
    loader.invalidate('product-image');
    await loader.loadPicker('image');
    await loader.loadPicker('audio');
    await loader.loadPicker('product-image');
    await loader.loadProductFolder('P001');
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('does not restore an invalidated in-flight response into the cache', async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValueOnce(success({ assets: [{ ...image, name: 'new.png' }] }));
    const loader = createProductionAssetLoader('account-1');
    const oldRequest = loader.loadPicker('image');
    loader.invalidate('image');
    const refreshed = await loader.loadPicker('image');
    resolve(success({ assets: [image] }));
    await oldRequest;

    expect(await loader.loadPicker('image')).toBe(refreshed);
    expect(refreshed[0].name).toBe('new.png');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures, allowing retry after a denied or failed request', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: 'forbidden' }), { status: 403 }))
      .mockResolvedValueOnce(success({ assets: [image] }));
    const loader = createProductionAssetLoader('account-1');

    await expect(loader.loadPicker('image')).rejects.toThrow('forbidden');
    expect(await loader.loadPicker('image')).toEqual([image]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds retained folder caches while keeping the most recent folder', async () => {
    fetchMock.mockImplementation(async () => success({ folder: { images: [] } }));
    const loader = createProductionAssetLoader('account-1');
    for (let index = 0; index < 17; index += 1) await loader.loadProductFolder(`P${index}`);
    await loader.loadProductFolder('P16');
    expect(fetchMock).toHaveBeenCalledTimes(17);
    await loader.loadProductFolder('P0');
    expect(fetchMock).toHaveBeenCalledTimes(18);
  });

  it('restores selected IDs in their original order without fetching material lists or product summaries', async () => {
    const otherProduct = { ...product, id: 'product-image:shared:2026-09-14:P001:detail.png', name: 'P001-detail.png' };
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes('&pid=')) return success({ folder: { images: [otherProduct, product] } });
      if (String(url).includes(video.id)) return success({ asset: video });
      return success({ asset: image });
    });
    const loader = createProductionAssetLoader('account-1');
    const assets = await loader.loadSelected([product.id, video.id, image.id, otherProduct.id, product.id]);

    expect(assets.map((asset) => asset.id)).toEqual([product.id, video.id, image.id, otherProduct.id]);
    expect(assets[0].name).toBe('P001-main.png');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('?metadata=1') || String(url).includes('&pid=P001'))).toBe(true);
  });

  it('keeps resolvable references when one selected asset no longer exists', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 404 }))
      .mockResolvedValueOnce(success({ asset: image }));

    expect(await createProductionAssetLoader('account-1').loadSelected(['missing', image.id])).toEqual([image]);
  });
});
