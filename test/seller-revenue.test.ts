import { describe, expect, it } from 'vitest';
import { reconcileRevenueAttribution } from '../src/seller';

describe('seller revenue reconciliation', () => {
  it('recomputes AOV whenever attributed GMV replaces source GMV', () => {
    const summary = { totals: { grossRevenue: 13_182_093, orders: 88, aov: 149_796.51 } };
    const quality = reconcileRevenueAttribution(summary, { attributedTotal: 14_098_198 });
    expect(quality.ready).toBe(true);
    expect(summary.totals).toMatchObject({ grossRevenue: 14_098_198, orders: 88 });
    expect(summary.totals.aov).toBeCloseTo(160_206.8, 1);
  });

  it('rejects a partial order snapshot instead of combining inconsistent sources', () => {
    const summary = { totals: { grossRevenue: 252_000, orders: 2, aov: 126_000 } };
    const quality = reconcileRevenueAttribution(summary, { attributedTotal: 14_098_198 });
    expect(quality.ready).toBe(false);
    expect(summary.totals).toEqual({ grossRevenue: 252_000, orders: 2, aov: 126_000 });
  });
});
