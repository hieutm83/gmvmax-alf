import { describe, expect, it } from 'vitest';
import { aggregateStatementTransactions, unsettledReasonLabel } from '../src/finance';

describe('finance aggregation', () => {
  it('aggregates statement fields and removes zero fee fields', () => {
    const result = aggregateStatementTransactions([{
      order_id: 'order-1', settlement_amount: '80', revenue_amount: '120', shipping_cost_amount: '-10', fee_tax_amount: '-30',
      revenue_breakdown: { subtotal_before_discount_amount: '150', seller_discount_amount: '-30' },
      shipping_cost_breakdown: { actual_shipping_fee_amount: '-10', unused_amount: '0' },
      fee_tax_breakdown: { fee: { platform_commission_amount: '-20', affiliate_commission_amount: '-10', unused_amount: '0' }, tax: {} }
    }]);
    expect(result.revenue.netRevenue).toBe(120);
    expect(result.shipping.breakdown).toEqual({ actual_shipping_fee_amount: -10 });
    expect(result.fees.platform).toEqual({ platform_commission_amount: -20 });
    expect(result.fees.koc).toEqual({ affiliate_commission_amount: -10 });
    expect(result.orderCount).toBe(1);
  });

  it('maps observed unsettled reason families', () => {
    expect(unsettledReasonLabel('waiting for delivery')).toBe('Đang chờ giao kiện hàng');
    expect(unsettledReasonLabel('waiting for return/refund completion')).toBe('Đang chờ hoàn tất trả hàng/hoàn tiền');
    expect(unsettledReasonLabel('settlement processing')).toBe('Đang tiến hành quyết toán');
  });

  it('keeps shipping details in the statement aggregation', () => {
    const result = aggregateStatementTransactions([{
      order_id: 'order-2', shipping_cost_amount: '-12',
      shipping_cost_breakdown: { actual_shipping_fee_amount: '-20', shipping_fee_discount_amount: '8' }
    }]);
    expect(result.shipping.total).toBe(-12);
    expect(result.shipping.breakdown).toEqual({ actual_shipping_fee_amount: -20, shipping_fee_discount_amount: 8 });
  });
});
