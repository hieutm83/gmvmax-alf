import { describe, expect, it } from 'vitest';
import { buildOrderBotStyles, formatOrderBotReport, isOrderBotReportDay, ORDER_BOT_SLOTS, summarizeOrderStatus, zonedDateTimeEpoch } from '../src/order-bot';

describe('order bot', () => {
  it('sends Monday through Saturday and skips Sunday', () => {
    expect(isOrderBotReportDay('2026-08-01')).toBe(true);
    expect(isOrderBotReportDay('2026-08-02')).toBe(false);
    expect(isOrderBotReportDay('2026-08-03')).toBe(true);
  });

  it('uses the requested :56 report schedule for both cutoffs', () => {
    expect(Object.keys(ORDER_BOT_SLOTS)).toEqual([
      '07:56', '08:56', '09:56', '10:56', '11:56',
      '14:56', '15:56', '16:56', '17:56', '18:56'
    ]);
    expect(ORDER_BOT_SLOTS['11:56'].oldLabel).toBe('Đơn cần gửi trước 12h');
    expect(ORDER_BOT_SLOTS['14:56'].oldLabel).toBe('Đơn cần gửi trước 19h');
  });

  it('uses the report date in env timezone for both cutoffs', () => {
    expect(new Date(zonedDateTimeEpoch('2026-07-31', '00:01', 'Asia/Bangkok')).toISOString()).toBe('2026-07-30T17:01:00.000Z');
    expect(new Date(zonedDateTimeEpoch('2026-07-31', '18:00', 'Asia/Bangkok')).toISOString()).toBe('2026-07-31T11:00:00.000Z');
  });

  it('splits every order into exactly old or new and sorts SKU then qty', () => {
    const cutoff = zonedDateTimeEpoch('2026-07-31', '00:01', 'Asia/Bangkok');
    const summary = summarizeOrderStatus('Số đơn chờ vận chuyển', [
      { id: '1', create_time: cutoff / 1000 - 1, line_items: [{ seller_sku: 'TTD', quantity: 2 }] },
      { id: '2', create_time: cutoff / 1000, line_items: [{ seller_sku: 'TKA', quantity: 1 }] },
      { id: '3', create_time: cutoff / 1000 + 1, line_items: [{ seller_sku: 'TKA', quantity: 2 }] }
    ], cutoff);
    expect(summary.oldTotal + summary.newTotal).toBe(summary.total);
    expect(summary.oldBreakdown).toEqual([{ sellerSku: 'TTD', qty: 2, orders: 1 }]);
    expect(summary.newBreakdown.map((row) => [row.sellerSku, row.qty])).toEqual([['TKA', 1], ['TKA', 2]]);
  });

  it('always prints both fixed groups for a non-empty status', () => {
    const text = formatOrderBotReport('2026-07-31', ORDER_BOT_SLOTS['10:56'], [{
      label: 'Số đơn chờ vận chuyển', total: 1, oldTotal: 0, newTotal: 1,
      oldBreakdown: [], newBreakdown: [{ sellerSku: 'TTD', qty: 1, orders: 1 }]
    }], new Date('2026-07-31T03:30:00Z'), 'Asia/Bangkok');
    expect(text).toContain('Đơn cần gửi trước 12h: 0 đơn');
    expect(text).toContain('Đơn mới: 1 đơn\n- TTD: 1 đơn');
    expect(text).not.toContain('\n\nĐơn mới:');
    expect(text).toContain('Cập nhật: 10:30:00');
    expect(text).toContain('Cập nhật: 10:30:00\n-----------------------------------');
    expect(text.endsWith('-----------------------------------')).toBe(true);
    expect(text.endsWith('\n\n-----------------------------------')).toBe(false);
  });

  it('does not insert a blank line before the separator between statuses', () => {
    const summaries = [
      {
        label: 'Số đơn chờ vận chuyển', total: 1, oldTotal: 0, newTotal: 1,
        oldBreakdown: [], newBreakdown: [{ sellerSku: '1 TTD', qty: 1, orders: 1 }]
      },
      {
        label: 'Số đơn chờ thu gom', total: 1, oldTotal: 1, newTotal: 0,
        oldBreakdown: [{ sellerSku: '1 TTD', qty: 1, orders: 1 }], newBreakdown: []
      }
    ];
    const text = formatOrderBotReport('2026-08-01', ORDER_BOT_SLOTS['08:56'], summaries,
      new Date('2026-08-01T01:30:59Z'), 'Asia/Bangkok');
    expect(text).toContain('- 1 TTD: 1 đơn\n-----------------------------------\nSố đơn chờ thu gom');
  });

  it('summarizes overflow only when a Zalo-size fallback is requested', () => {
    const rows = Array.from({ length: 22 }, (_, index) => ({ sellerSku: `SKU-${index}`, qty: 1, orders: 1 }));
    const text = formatOrderBotReport('2026-07-31', ORDER_BOT_SLOTS['16:56'], [{
      label: 'Số đơn chờ thu gom', total: 22, oldTotal: 22, newTotal: 0,
      oldBreakdown: rows, newBreakdown: []
    }], new Date('2026-07-31T09:30:00Z'), 'Asia/Bangkok', 20);
    expect(text).toContain('... và 2 SKU khác');
  });

  it('does not prefix item quantity when the SKU name already contains it', () => {
    const text = formatOrderBotReport('2026-08-01', ORDER_BOT_SLOTS['08:56'], [{
      label: 'Số đơn chờ thu gom', total: 2, oldTotal: 2, newTotal: 0,
      oldBreakdown: [{ sellerSku: '1 TTD', qty: 1, orders: 2 }], newBreakdown: []
    }], new Date('2026-08-01T01:30:59Z'), 'Asia/Bangkok');
    expect(text).toContain('- 1 TTD: 2 đơn');
    expect(text).not.toContain('- 1 1 TTD');
  });

  it('styles totals, group labels and compact SKU rows like the reference message', () => {
    const text = [
      'Số đơn chờ thu gom: 12 đơn',
      'Đơn cần gửi trước 19h: 12 đơn',
      '- 1 TTD: 12 đơn',
      '- 1 TKA: 2 đơn',
      '- 1 TAH: 2 đơn',
      '',
      'Đơn mới: 0 đơn'
    ].join('\n');
    const styles = buildOrderBotStyles(text);
    const title = 'Báo cáo vận đơn TikTok Shop 03/08/2026';
    const fullReport = `${title}\n${text}`;
    const fullStyles = buildOrderBotStyles(fullReport);
    expect(fullStyles).toContainEqual({ start: title.length + 1, len: text.length, st: ['f_13'] });
    expect(styles.some((style) => text.slice(style.start, style.start + style.len) === 'Đơn cần gửi trước 19h:'
      && style.st.includes('u') && style.st.includes('c_15a85f'))).toBe(true);
    expect(styles.some((style) => text.slice(style.start, style.start + style.len) === 'Đơn cần gửi trước 19h: 12 đơn'
      && style.st.includes('f_13') && style.st.includes('i'))).toBe(true);
    expect(styles.some((style) => text.slice(style.start, style.start + style.len) === '12 đơn' && style.st.includes('c_db342e') && style.st.includes('b'))).toBe(true);
    expect(styles.some((style) => text.slice(style.start, style.start + style.len) === '- 1 TKA: 2 đơn' && style.st.includes('f_13'))).toBe(true);
    expect(styles.some((style) => text.slice(style.start, style.start + style.len) === '2 đơn' && style.st.includes('b'))).toBe(true);
    expect(styles.some((style) => text.slice(style.start, style.start + style.len) === 'Đơn mới: 0 đơn' && style.st.includes('i') && !style.st.includes('c_db342e'))).toBe(true);
    expect(styles.some((style) => text.slice(style.start, style.start + style.len) === 'Đơn mới:'
      && style.st.includes('u') && style.st.includes('c_15a85f'))).toBe(true);
    expect(styles.some((style) => text.slice(style.start, style.start + style.len) === '0 đơn' && style.st.includes('c_db342e'))).toBe(true);
  });
});
