import { describe, expect, it } from 'vitest';
import { returnReasonLabel } from '../src/operations';

describe('returnReasonLabel', () => {
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
});
