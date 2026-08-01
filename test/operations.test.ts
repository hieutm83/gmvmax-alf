import { describe, expect, it } from 'vitest';
import { calculateCancellationRate, returnReasonLabel } from '../src/operations';

describe('returnReasonLabel', () => {
  it('calculates cancellation rate against all orders created in the selected period', () => {
    expect(calculateCancellationRate(127, 1379)).toBeCloseTo(0.0920957);
    expect(calculateCancellationRate(5, 0)).toBe(0);
  });

  it('uses the documented reason code instead of an incorrect localized message', () => {
    expect(returnReasonLabel({
      return_reason: 'buyer_return_and_refund_suspected_counterfeit',
      return_reason_text: 'Chúc mừng bạn đã đáp ứng các tiêu chí đổi với mẫu có thể học'
    })).toBe('Nghi ngờ hàng giả');
  });

  it('maps common refund reason codes to Vietnamese labels', () => {
    expect(returnReasonLabel({ return_reason: 'ecom_order_delivered_refund_reason_wrong_product' }))
      .toBe('Gửi sai sản phẩm');
  });

  it('uses the documented top-level Search Returns fields', () => {
    expect(returnReasonLabel({
      return_reason: 'buyer_return_and_refund_suspected_counterfeit',
      return_reason_text: 'Chuỗi dịch không chính xác',
      return_line_items: [{ return_reason: 'ecom_order_delivered_refund_reason_wrong_product' }]
    })).toBe('Nghi ngờ hàng giả');
  });
});
