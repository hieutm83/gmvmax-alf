import { describe, expect, it } from 'vitest';
import { aggregateStatementTransactions, calculateFinanceSummary, estimatedVoucherXtraFee, parseSkuProductFactor, unsettledReasonLabel } from '../src/finance';

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

  it('calculates the six finance cards without double counting affiliate ads before PIT', () => {
    const detail = aggregateStatementTransactions([{
      order_id: 'order-3', revenue_amount: '120', shipping_cost_amount: '-5', fee_tax_amount: '-28',
      revenue_breakdown: {
        subtotal_before_discount_amount: '200', seller_discount_amount: '-50',
        refund_subtotal_before_discount_amount: '-30', seller_discount_refund_amount: '10'
      },
      fee_tax_breakdown: { fee: {
        platform_commission_amount: '-10', transaction_fee_amount: '-4',
        affiliate_commission_amount: '-8', affiliate_commission_before_pit_amount: '-6',
        affiliate_ads_commission_amount: '-5', voucher_xtra_service_fee_amount: '-3'
      }, tax: { local_vat_amount: '-2' } }
    }]);
    const summary = calculateFinanceSummary(detail, 25);
    expect(summary.sellerSubtotal).toBe(150);
    expect(summary.feeTax).toBe(24);
    expect(summary.affiliate).toBe(13);
    expect(summary.refunds).toBe(20);
    expect(summary.grossProfit).toBe(68);
  });
});

describe('SKU product factor', () => {
  const examples: Array<[string, number]> = [
    ['1 TTD',1],['2 TTD',2],['3 TTD',3],['1 TAH',1],['2 TAH',2],['3 TAH',3],
    ['1 TKA',1],['2 TKA',2],['3 TKA',3],['4 TKA',4],['1 TKA + 1 TTD',2],
    ['1 TKA + 1 TAH',2],['1 TTD + 1 TAH',2],['1 TTD + 1 TKA + 1 TAH',3],['1 TAH + 1 TKA',2]
  ];
  it.each(examples)('parses %s as %i products per order', (name, expected) => {
    expect(parseSkuProductFactor(name)).toBe(expected);
  });
});

describe('finance estimates', () => {
  it('calculates Voucher Xtra as 5% of the discounted order value', () => {
    expect(estimatedVoucherXtraFee(3_414_700)).toBe(-170_735);
  });
});
