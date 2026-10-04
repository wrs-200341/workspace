import { describe, expect, it } from 'vitest';
import { normalizeEarningsVideos } from './showroomPerformance';
import { aggregatePublishedPerformance, normalizePublishedVideos } from './publishedPerformance';

describe('published performance', () => {
  it('keeps successful publishes without revenue or a captured video id', () => {
    const published = normalizePublishedVideos({ items: [
      { target_id: 't1', job_id: 'j1', product_pid: '1731', video_id: 'v1', video_url: 'https://www.tiktok.com/@shop/video/v1', account_username: 'shop', account_owner: '吴凤燕', published_at: '2026-09-25T10:00:00Z' },
      { target_id: 't2', job_id: 'j2', product_pid: '1731', video_id: '', account_username: 'shop2', account_owner: '吴凤燕', published_at: '2026-09-25T09:00:00Z' },
    ] });
    const earnings = normalizeEarningsVideos([
      { video_id: 'v1', creator_username: 'shop', product_id: '1731', product_name: '商品', orders: 8, tc_duplicate_orders: 2, gmv: 99, currency: 'MXN' },
    ]);
    const result = aggregatePublishedPerformance(published, earnings, [{ product_id: '1731', product_image: 'https://cdn.example.com/1731.jpg' }]);

    expect(result.totals).toMatchObject({ pids: 1, videos: 2, linkedVideos: 1, attributedVideos: 1, orders: 8, tcDuplicateOrders: 2, gmv: 99 });
    expect(result.pids[0]).toMatchObject({ productPid: '1731', videos: 2, attributedVideos: 1, orders: 8 });
    expect(result.videos[1]).toMatchObject({ targetId: 't2', earningsMatched: false, orders: 0 });
  });

  it('joins earnings strictly by video id instead of account or pid', () => {
    const published = normalizePublishedVideos([
      { target_id: 't1', product_pid: 'same-pid', video_id: 'published-video', account_username: 'same-account' },
    ]);
    const earnings = normalizeEarningsVideos([
      { video_id: 'different-video', creator_username: 'same-account', product_id: 'same-pid', orders: 30, gmv: 300 },
    ]);
    const result = aggregatePublishedPerformance(published, earnings, []);
    expect(result.totals).toMatchObject({ videos: 1, attributedVideos: 0, orders: 0, gmv: 0 });
  });
});
