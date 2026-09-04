import { describe, expect, it } from 'vitest';
import { buildProductImagesUrl, normalizeProductImagesPayload, parsePidListText, parsePidRows } from './productImageAssetsModel';

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

  it('parses PID lists from text while removing headers, duplicates, and invalid values', () => {
    expect(parsePidListText('pid\n173453212\n173453212, abc-2\n../bad')).toEqual(['173453212', 'abc-2']);
  });

  it('reads PID values from the first Excel column', () => {
    expect(parsePidRows([['商品编号', '标题'], ['A-1', 'x'], ['B-2', 'y'], ['A-1', 'z']])).toEqual(['A-1', 'B-2']);
  });
});
