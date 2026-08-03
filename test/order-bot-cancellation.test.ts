import { describe, expect, it } from 'vitest';
import { formatCancellationAlert } from '../src/order-bot';

describe('order bot cancellation alert', () => {
  it('matches the compact cancellation reference format', () => {
    const result = formatCancellationAlert({
      orderId: '585294842698564880', type: 'Hủy đơn', group: 'BUYER', reason: 'Không còn nhu cầu',
      cancelledAt: Date.parse('2026-08-02T11:09:56Z'),
      orderHistory: {
        cancellationRequestedAt: Date.parse('2026-08-02T11:09:56Z'),
        cancellationApprovedAt: Date.parse('2026-08-02T11:09:56Z'),
        orderCreatedAt: Date.parse('2026-08-02T11:02:54Z')
      }
    }, 'Asia/Bangkok');
    expect(result.text).toBe([
      'Đơn hủy',
      'Mã đơn: 585294842698564880',
      'Loại sự cố: Hủy đơn',
      'Nhóm / Khởi tạo: BUYER',
      'Lý do chi tiết: Không còn nhu cầu',
      'Lịch sử đơn hàng',
      '• Yêu cầu hủy được gửi bởi khách hàng',
      '  Không còn nhu cầu',
      '  02/08/2026 18:09:56',
      '• Được TikTok Shop tự động phê duyệt theo chính sách hiện hành',
      '  02/08/2026 18:09:56',
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
  });
});
