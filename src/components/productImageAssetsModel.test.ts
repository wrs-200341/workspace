import { describe, expect, it } from 'vitest';
import { buildProductImagesUrl, groupProductImageFolders, normalizeProductGalleryItems, normalizeProductImagesPayload, parsePidListText, parsePidRows } from './productImageAssetsModel';

describe('product image asset view model', () => {
  it('builds an encoded account endpoint and optional query', () => {
    expect(buildProductImagesUrl('account/1')).toBe('/api/workspace/accounts/account%2F1/product-images');
    expect(buildProductImagesUrl('a-1', '  PID 42 ')).toBe('/api/workspace/accounts/a-1/product-images?query=PID+42');
  });

  it('normalizes only valid imported records and gallery items', () => {
    const result = normalizeProductImagesPayload({ data: { imported: [{ pid: 'P1', files: ['001.jpg'], importDate: '2026-09-01' }, { files: [] }], gallery: [{ pid: 'P2', title: '商品' }, null, { title: 'missing pid' }] } });
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].pid).toBe('P1');
    expect(result.gallery).toEqual([{ pid: 'P2', title: '商品' }]);
  });

  it('returns empty lists for malformed responses', () => {
    expect(normalizeProductImagesPayload({ success: false })).toEqual({ imported: [], gallery: [] });
  });

  it('deduplicates gallery items by pid and sorts them by pid', () => {
    expect(normalizeProductGalleryItems([
      { pid: 'P-10', title: 'ten' },
      { pid: 'P-2', title: 'two' },
      { pid: 'P-2', title: 'duplicate should win by last write' },
      { pid: 'p-1', title: 'lowercase pid' },
    ])).toEqual([
      { pid: 'p-1', title: 'lowercase pid' },
      { pid: 'P-2', title: 'duplicate should win by last write' },
      { pid: 'P-10', title: 'ten' },
    ]);
  });

  it('groups product image folders by account and shared scope', () => {
    expect(groupProductImageFolders([
      { id: 'a1', pid: 'P1', name: 'P1/001.jpg' },
      { id: 'a2', pid: 'P1', name: 'P1/002.jpg' },
      { id: 's1', pid: 'P1', name: 'shared/001.jpg', shared: true },
      { id: 'a3', pid: 'P2', name: 'P2/001.jpg' },
    ], 'account-1')).toEqual([
      {
        key: 'account-1:P1',
        pid: 'P1',
        shared: false,
        imageCount: 2,
        cover: { id: 'a1', pid: 'P1', name: 'P1/001.jpg' },
        images: [
          { id: 'a1', pid: 'P1', name: 'P1/001.jpg' },
          { id: 'a2', pid: 'P1', name: 'P1/002.jpg' },
        ],
      },
      {
        key: 'account-1:P2',
        pid: 'P2',
        shared: false,
        imageCount: 1,
        cover: { id: 'a3', pid: 'P2', name: 'P2/001.jpg' },
        images: [
          { id: 'a3', pid: 'P2', name: 'P2/001.jpg' },
        ],
      },
      {
        key: 'shared:P1',
        pid: 'P1',
        shared: true,
        imageCount: 1,
        cover: { id: 's1', pid: 'P1', name: 'shared/001.jpg', shared: true },
        images: [
          { id: 's1', pid: 'P1', name: 'shared/001.jpg', shared: true },
        ],
      },
    ]);
  });

  it('parses PID lists from text while removing headers, duplicates, and invalid values', () => {
    expect(parsePidListText('pid\n173453212\n173453212, abc-2\n../bad')).toEqual(['173453212', 'abc-2']);
  });

  it('reads PID values from the first Excel column', () => {
    expect(parsePidRows([['商品编号', '标题'], ['A-1', 'x'], ['B-2', 'y'], ['A-1', 'z']])).toEqual(['A-1', 'B-2']);
  });
});
