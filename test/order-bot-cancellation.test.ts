import { describe, expect, it } from 'vitest';
import { formatCancellationAlert } from '../src/order-bot';

describe('order bot cancellation alert', () => {
  it('matches the compact cancellation reference format', () => {
    const result = formatCancellationAlert({
      orderId: '585294842698564880', type: 'Hủy đơn', group: 'BUYER', reason: 'Không còn nhu cầu',
      sellerSkus: ['1 TTD'], province: 'Đồng Tháp',
      cancelledAt: Date.parse('2026-08-02T11:09:56Z'),
      orderHistory: {
        cancellationRequestedAt: Date.parse('2026-08-02T11:09:56Z'),
        cancellationApprovedAt: Date.parse('2026-08-02T11:09:56Z'),
        refundCompletedAt: Date.parse('2026-08-02T11:38:39Z'),
        readyToShipAt: Date.parse('2026-08-02T11:06:08Z'),
        paidAt: Date.parse('2026-08-02T11:03:10Z'),
        orderCreatedAt: Date.parse('2026-08-02T11:02:54Z')
      }
    }, 'Asia/Bangkok');
    expect(result.text).toBe([
      'Đơn hủy',
      'Mã đơn: 585294842698564880',
      'Loại sự cố: Hủy đơn',
      'Nhóm / Khởi tạo: BUYER',
      'Seller SKU: 1 TTD',
      'Địa chỉ: Đồng Tháp',
      'Lịch sử đơn hàng',
      '• Hoàn tất hoàn tiền',
      '  02/08/2026 18:38:39',
      '• Yêu cầu hủy được gửi bởi khách hàng',
      '  Không còn nhu cầu',
      '  02/08/2026 18:09:56',
      '• Được TikTok Shop tự động phê duyệt theo chính sách hiện hành',
      '  02/08/2026 18:09:56',
      '• Đơn hàng sẵn sàng vận chuyển',
      '  02/08/2026 18:06:08',
      '• Đơn hàng đã thanh toán',
      '  02/08/2026 18:03:10',
      '• Đơn hàng do khách hàng tạo',
      '  02/08/2026 18:02:54'
    ].join('\n'));
    expect(result.styles[0].st).toEqual(['f_15', 'u', 'i', 'c_db342e']);
    expect(result.styles[1]).toEqual({
      start: 'Đơn hủy\n'.length,
      len: result.text.length - 'Đơn hủy\n'.length,
      st: ['f_13']
    });
    expect(result.styles.some((style) => result.text.slice(style.start, style.start + style.len) === 'Lịch sử đơn hàng'
      && style.st.includes('b'))).toBe(true);
    expect(result.styles.some((style) => result.text.slice(style.start, style.start + style.len) === 'Địa chỉ:'
      && style.st.includes('b'))).toBe(true);
    expect(result.styles.some((style) => result.text.slice(style.start, style.start + style.len) === 'Đồng Tháp'
      && style.st.includes('b'))).toBe(false);
    const reasonStyle = result.styles.find((style) => result.text.slice(style.start, style.start + style.len) === '  Không còn nhu cầu'
      && style.st.includes('i') && style.st.includes('c_db342e'));
    expect(reasonStyle).toBeDefined();
    const dateStyles = result.styles.filter((style) => /^\s+02\/08\/2026/.test(result.text.slice(style.start, style.start + style.len)));
    expect(dateStyles).toHaveLength(6);
    expect(dateStyles.every((style) => style.st.includes('f_13') && style.st.includes('i') && !style.st.includes('b'))).toBe(true);
  });
});
