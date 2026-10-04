import { describe, expect, it } from 'vitest';
import type { WorkspaceAccount } from './data';
import { aggregateShowroomPerformance, extractFeaturedAccountHandle, mergeEarningsProductImages, normalizeEarningsVideos } from './showroomPerformance';

function account(overrides: Partial<WorkspaceAccount>): WorkspaceAccount {
  return {
    id: 'account-1', ownerId: 'owner-1', ownerName: '郭青青', name: 'sctdvz7', category: 'featured',
    strategy: '', promptCount: 0, fileCount: 0, videoCount: 0, publishedCount: 0,
    updatedAt: '2026-09-23 10:00', planStatus: 'planned', ...overrides,
  };
}

describe('showroom earnings matching', () => {
  it.each([
    ['sctdvz7', 'sctdvz7'],
    ['ppfxil8-（5）1842卧室-精品-女装tap', 'ppfxil8'],
    ['1-ewpz4j7-1835-正脸', 'ewpz4j7'],
    ['@SofiRecomienda6', 'sofirecomienda6'],
    ['厨房自然', null],
  ])('extracts a TikTok handle from %s', (input, expected) => {
    expect(extractFeaturedAccountHandle(input)).toBe(expected);
  });

  it('matches only featured accounts owned by the six showroom operators', () => {
    const rows = normalizeEarningsVideos([
      { video_id: 'v1', creator_username: 'SCTDVZ7', product_id: 'p1', product_name: 'Product', promotion_link: 'https://www.tiktok.com/v1', currency: 'MXN', orders: 3, gmv: 120.5, commission: 9, play_count: 200, publish_local: '2026-09-23T10:00+08:00' },
      { video_id: 'v2', creator_username: 'gn8ajzcur7', currency: 'MXN', orders: 2, gmv: 80 },
      { video_id: 'v3', creator_username: 'ignored', currency: 'MXN', orders: 99, gmv: 9999 },
    ]);
    const result = aggregateShowroomPerformance([
      account({ id: 'qingqing', ownerName: '郭青青', name: 'sctdvz7' }),
      account({ id: 'wrs', ownerName: '王润生', name: 'gn8ajzcur7' }),
      account({ id: 'remix', ownerName: '郭青青', name: 'ignored', category: 'remix' }),
      account({ id: 'other', ownerName: '其他人', name: 'ignored' }),
    ], rows);
    expect(result.totals).toMatchObject({ featuredAccounts: 2, matchedAccounts: 2, videos: 2, orders: 5, gmv: 200.5, currency: 'MXN' });
    expect(result.videos.map((video) => video.ownerName)).toEqual(['郭青青', '王润生']);
  });

  it('matches safe product preview images by exact PID without changing video totals', () => {
    const rows = normalizeEarningsVideos([
      { video_id: 'v1', creator_username: 'sctdvz7', product_id: 'p1', orders: 3, gmv: 120.5 },
      { video_id: 'v2', creator_username: 'sctdvz7', product_id: 'p2', orders: 2, gmv: 80 },
      { video_id: 'v3', creator_username: 'sctdvz7', product_id: 'p3', orders: 1, gmv: 20 },
    ]);
    const merged = mergeEarningsProductImages(rows, [
      { product_id: 'p1', product_image: 'https://cdn.example.com/p1.jpg' },
      { product_id: 'p2', product_image: 'javascript:alert(1)' },
      { product_id: 'unrelated', product_image: 'https://cdn.example.com/other.jpg' },
    ]);
    expect(merged.map((video) => video.previewImage)).toEqual([
      'https://cdn.example.com/p1.jpg',
      '',
      '',
    ]);

    const result = aggregateShowroomPerformance([account({})], merged);
    expect(result.totals).toMatchObject({ videos: 3, orders: 6, gmv: 220.5 });
  });

  it('sums TAP/CAP duplicate order counts into the matched account', () => {
    const rows = normalizeEarningsVideos([
      { video_id: 'v1', creator_username: 'sctdvz7', orders: 7, tc_duplicate_orders: 2, gmv: 70 },
      { video_id: 'v2', creator_username: 'sctdvz7', orders: 14, tc_duplicate_orders: 3, gmv: 140 },
    ]);
    const result = aggregateShowroomPerformance([account({})], rows);
    expect(result.accounts[0]).toMatchObject({ orders: 21, tcDuplicateOrders: 5 });
  });
});
