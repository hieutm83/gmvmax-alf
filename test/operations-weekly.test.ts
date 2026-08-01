import { describe, expect, it } from 'vitest';
import { formatWeeklyOperationsReport, monthlyRanges } from '../src/operations-bot';

describe('weekly operations report', () => {
  it('uses complete calendar months for a monthly report', () => {
    expect(monthlyRanges('2026-08-01')).toEqual({
      startDate: '2026-07-01', endDate: '2026-07-31',
      previousStartDate: '2026-06-01', previousEndDate: '2026-06-30'
    });
  });

  it('formats the Saturday-to-Friday report using Zalo text styles', () => {
    const formatted = formatWeeklyOperationsReport({
      startDate: '2026-07-25', endDate: '2026-07-31',
      metrics: [
        { label: '1. GMV:', value: '46,05M', change: { text: '↑ 27,15%', direction: 'up' } },
        { label: '2. ĐƠN HÀNG:', value: '297', change: { text: '↑ 24,79%', direction: 'up' } },
        { label: '3. AOV:', value: '152,53K', change: { text: '↓ 2,5%', direction: 'down' } },
        { label: '4. CHI TIÊU ADS:', value: '26,22M', change: { text: '↑ 40,3%', direction: 'up' }, badWhenUp: true },
        { label: '5. Tổng phí sàn:', value: '9,84M', change: { text: '↑ 16,01%', direction: 'up' }, badWhenUp: true },
        { label: '6. Hoa hồng KOC:', value: '2,41M', change: { text: '↑ 31,11%', direction: 'up' }, badWhenUp: true },
        { label: '7. Hoàn tiền:', value: '2,1M', change: { text: '↓ 26,14%', direction: 'down' }, badWhenUp: true },
        { label: '8. Tỷ lệ hủy:', value: '6,94%' }
      ],
      sources: {
        affiliate: { total: 40_860_000, live: 138_150, video: 39_738_150, productCard: 983_700,
          previousTotal: 28_874_000, videoCount: 133, videoRoi: 1.71 },
        seller: { total: 5_190_000, live: 0, video: 396_030, productCard: 4_793_970,
          previousTotal: 7_342_000, videoCount: 0, videoRoi: 0 }
      }
    });
    expect(formatted.text).toContain('Báo cáo chỉ số vận hành Tiktok shop tuần 25/07-31/07/2026');
    expect(formatted.text).toContain('4. CHI TIÊU ADS: 26,22M (↑ 40,3%)');
    expect(formatted.text).toContain('› Video (Đóng góp 86,29%) : 133 Video - Roi 1.71');
    expect(formatted.text).toContain('Tổng quan\n1. GMV:');
    expect(formatted.text).toContain('Nguồn\nLiên kết');
    expect(formatted.text).not.toContain('Tổng quan\n\n1. GMV:');
    expect(formatted.text).not.toContain('Nguồn\n\nLiên kết');
    expect(formatted.text).not.toContain('<font');
    expect(formatted.styles.some((style) => formatted.text.slice(style.start, style.start + style.len) === 'Tổng quan'
      && style.st.includes('u') && style.st.includes('c_15a85f'))).toBe(true);
    expect(formatted.styles.some((style) => formatted.text.slice(style.start, style.start + style.len) === '↑ 40,3%'
      && style.st.includes('c_db342e'))).toBe(true);
    expect(formatted.styles.some((style) => formatted.text.slice(style.start, style.start + style.len) === '133 Video - Roi 1.71'
      && style.st.includes('b'))).toBe(true);
    expect(formatted.styles.some((style) => style.start === formatted.text.indexOf('\n') + 1
      && style.st.includes('f_13') && style.len === formatted.text.length - formatted.text.indexOf('\n') - 1)).toBe(true);
  });
});
