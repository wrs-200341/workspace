import { describe, expect, it } from 'vitest';
import { aggregateLocalOrdersByPid, normalizeCapProducts, normalizeTapProducts, normalizeTapSales } from './taskAssignmentMetrics';

describe('task assignment metrics', () => {
  it('reads TAP sales_volume by PID and keeps missing values distinct from zero', () => {
    const result = normalizeTapSales({
      '1731': { sales_volume: 1250, rating: 4.8 },
      '1732': { sales_volume: '0' },
      ignored: { sales_volume: 999 },
    }, ['1731', '1732', '1733']);

    expect(Object.fromEntries(result)).toEqual({ '1731': 1250, '1732': 0, '1733': null });
  });

  it('sums local orders for requested PIDs without mixing products', () => {
    const result = aggregateLocalOrdersByPid([
      { productId: '1731', orders: 3 },
      { productId: '1731', orders: 4 },
      { productId: '1732', orders: 8 },
      { productId: 'other', orders: 99 },
    ], ['1731', '1732', '1733']);

    expect(Object.fromEntries(result)).toEqual({ '1731': 7, '1732': 8, '1733': 0 });
  });

  it('combines current TAP stats with product-pool display fields', () => {
    const result = normalizeTapProducts(
      { '1731': {
        product_name: 'Current Jacket', product_image_url: 'https://example.com/current.jpg',
        price: 526.8, currency: 'USD', commission_rate: 13, commission_amount: null,
        sales_volume: 696, stock: 4509, rating: 4.4,
      } },
      [{ items: [{
        product_id: '1731', product_name: 'Jacket', product_image_url: 'https://example.com/1.jpg',
        price: 556.48, currency: 'USD', commission_rate: 13, commission_amount: null,
        sales_volume: 657, stock: 4956, rating: 4.2,
      }] }],
      ['1731'],
    );
    expect(result.get('1731')).toEqual({
      tapSales: 696,
      productName: 'Current Jacket',
      productPreviewUrl: 'https://example.com/current.jpg',
      productRating: 4.4,
      commissionAmount: '$68.48',
      productStock: 4509,
    });
  });

  it('normalizes CAP earnings and stock status without a live backfill request', () => {
    const result = normalizeCapProducts([{ items: [{
      product_id: '1732', product_name: 'Jeans', product_image_url: 'https://example.com/2.jpg',
      sales_volume: 541, rating: 4.5, earn_amount: 'Earn $29.80', stock_status: 1,
    }] }], ['1732']);
    expect(result.get('1732')).toMatchObject({
      tapSales: 541,
      productRating: 4.5,
      commissionAmount: '$29.80',
      productStock: '有库存',
    });
  });
});
