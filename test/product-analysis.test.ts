import { describe, expect, it } from 'vitest';
import { summarizeProductPerformance } from '../src/product-analysis';

describe('product analysis aggregation', () => {
  it('sums product metrics before deriving ratios', () => {
    const result = summarizeProductPerformance([
      { id: 'p1', total_performance: { gmv: { amount: '200' }, orders: 2, sku_orders: 2, sold_items: 3,
        product_impressions: 100, product_clicks: 10, add_cart_count: 4, estimated_customers: 7 } },
      { id: 'p2', total_performance: { gmv: { amount: '300' }, orders: 3, sku_orders: 3, sold_items: 5,
        product_impressions: 300, product_clicks: 30, add_cart_count: 8, estimated_customers: 11 } }
    ]);
    expect(result.total.gmv).toBe(500);
    expect(result.total.estimatedCustomers).toBe(18);
    expect(result.total.ctr).toBe(.1);
    expect(result.total.ctor).toBe(.125);
    expect(result.total.aov).toBe(100);
  });

  it('aggregates each source independently and keeps product rows for drilldown', () => {
    const result = summarizeProductPerformance([{
      id: '1732', total_performance: { gmv: { amount: 1000 }, product_impressions: 100, product_clicks: 20, sku_orders: 4 },
      affiliate_total_performance: { attributed_gmv: { amount: 800 }, attributed_orders: 3,
        attributed_sku_orders: 3, attributed_sold_items: 4, product_impressions: 80, product_clicks: 16, add_cart_count: 8 },
      seller_video_performance: { attributed_gmv: { amount: 200 }, attributed_orders: 1,
        attributed_sku_orders: 1, product_impressions: 20, product_clicks: 4 }
    }], { '1732': { title: 'Trà lạc tiên', imageUrl: 'https://example.com/p.jpg' } });
    expect(result.channels.affiliate.gmv).toBe(800);
    expect(result.channels.affiliate.ctr).toBe(.2);
    expect(result.channels.sellerVideo.ctor).toBe(.25);
    expect(result.products[0]).toMatchObject({ id: '1732', title: 'Trà lạc tiên', imageUrl: 'https://example.com/p.jpg' });
  });
});
