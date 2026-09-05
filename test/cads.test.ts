import { describe, expect, it } from 'vitest';
import { adsTrafficChartStartDate } from '../src/cads';

describe('TikTok Ads traffic chart range', () => {
  it('expands a one-day selection to seven days', () => {
    expect(adsTrafficChartStartDate('2026-09-05', '2026-09-05')).toBe('2026-08-30');
  });

  it('expands selections shorter than seven days', () => {
    expect(adsTrafficChartStartDate('2026-09-02', '2026-09-05')).toBe('2026-08-30');
  });

  it('keeps selections longer than seven days', () => {
    expect(adsTrafficChartStartDate('2026-08-20', '2026-09-05')).toBe('2026-08-20');
  });
});
