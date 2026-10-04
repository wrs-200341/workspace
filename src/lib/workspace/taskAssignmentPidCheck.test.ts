import { describe, expect, it } from 'vitest';
import { normalizeCapPidCheck, normalizeTapPidCheck } from './taskAssignmentPidCheck';

describe('task assignment PID mount checks', () => {
  it('normalizes CAP commission details returned by the 8003 product lookup', () => {
    expect(normalizeCapPidCheck({
      items: [{
        product_id: '1736425284474734060',
        product_name: 'Jeans',
        price: 372.5,
        currency: 'USD',
        commission_rate: 8,
        earn_amount: 'Earn $29.80',
        sales_text: '541 sold',
      }],
    }, '1736425284474734060')).toEqual({
      pid: '1736425284474734060',
      source: 'cap',
      canMount: true,
      reason: 'CAP 可挂车',
      title: 'Jeans',
      price: '$372.50',
      salesText: '541 sold',
      commissionRate: 8,
      commissionAmount: '$29.80',
    });
  });

  it('calculates CAP commission when the upstream omits earn_amount', () => {
    const result = normalizeCapPidCheck({
      items: [{ product_id: '1731', price: 100, currency: 'USD', commission_rate: 12.5 }],
    }, '1731');
    expect(result.commissionAmount).toBe('$12.50');
  });

  it('marks a TAP PID as mountable after a completed check without a failure reason', () => {
    expect(normalizeTapPidCheck([
      { type: 'progress', pid: '1731', action: '已在选品池' },
      { type: 'sheet_done', status: 'checked', failed_reasons: {}, message: '仅检测通过 1 个' },
    ], '1731')).toMatchObject({ source: 'tap', canMount: true, reason: 'TAP 可挂车' });
  });

  it('keeps the concrete TAP rejection reason for operators', () => {
    expect(normalizeTapPidCheck([
      { type: 'sheet_done', status: 'failed', failed_reasons: { '1731': '联盟商品不支持建列表' } },
    ], '1731')).toMatchObject({ source: 'tap', canMount: false, reason: '联盟商品不支持建列表' });
  });
});
