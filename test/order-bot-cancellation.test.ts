import { describe, expect, it } from 'vitest';
import { formatCancellationAlert } from '../src/order-bot';

describe('order bot cancellation alert', () => {
  it('matches the compact cancellation reference format', () => {
    const result = formatCancellationAlert({
      orderId: '585294842698564880', type: 'Hủy đơn', group: 'BUYER', reason: 'Không còn nhu cầu',
      cancelledAt: Date.parse('2026-07-31T03:16:00Z')
    }, 'Asia/Bangkok');
    expect(result.text).toBe([
      'Đơn hủy',
      'Mã đơn: 585294842698564880',
      'Loại sự cố: Hủy đơn',
      'Nhóm / Khởi tạo: BUYER',
      'Lý do chi tiết: Không còn nhu cầu',
      'Thời gian hủy: 10:16 31/7/26'
    ].join('\n'));
    expect(result.styles[0].st).toEqual(['f_15', 'u', 'i', 'c_db342e']);
    expect(result.styles[1]).toEqual({
      start: 'Đơn hủy\n'.length,
      len: result.text.length - 'Đơn hủy\n'.length,
      st: ['f_13']
    });
  });
});
