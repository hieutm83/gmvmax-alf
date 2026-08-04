import { describe, expect, it } from 'vitest';
import { attachKocVideos, summarizeKocOrders } from '../src/koc-analysis';

describe('KOC affiliate analysis', () => {
  it('counts unique orders while keeping cancellation rate at SKU-order level', () => {
    const current = [{ id:'order-1', create_time:1, skus:[
      { creator_username:'creator_a', product_id:'p1', content_type:'VIDEO', quantity:1,
        estimated_commission_base:{ amount:'143900' }, fully_return:'No' },
      { creator_username:'creator_a', product_id:'p2', content_type:'SHOP', quantity:1,
        estimated_commission_base:{ amount:'100000' }, fully_return:'Yes' }
    ] }, { id:'order-2', create_time:2, skus:[
      { creator_username:'creator_b', product_id:'p1', content_type:'LIVE', quantity:2,
        estimated_commission_base:{ amount:'287800' }, fully_return:'No' }
    ] }];
    const result = summarizeKocOrders(current, [], { p1:'Sản phẩm A', p2:'Sản phẩm B' });
    expect(result.totals).toMatchObject({ creators:2, orders:2, revenue:531700 });
    const creatorA = result.creators.find((item:any) => item.creatorUsername === 'creator_a');
    expect(creatorA.total.orders).toBe(1);
    expect(creatorA.total.skuOrders).toBe(2);
    expect(creatorA.total.cancellationRate).toBe(.5);
    expect(result.products.find((item:any) => item.productId === 'p1').productName).toBe('Sản phẩm A');
  });

  it('groups all documented content types into the four dashboard sources', () => {
    const result = summarizeKocOrders([{ id:'order-1', skus:[
      { creator_username:'creator', product_id:'p', content_type:'VIDEO', estimated_commission_base:{amount:'1'} },
      { creator_username:'creator', product_id:'p', content_type:'SHOP', estimated_commission_base:{amount:'1'} },
      { creator_username:'creator', product_id:'p', content_type:'PROMOTION_PAGE', estimated_commission_base:{amount:'1'} },
      { creator_username:'creator', product_id:'p', content_type:'LIVE', estimated_commission_base:{amount:'1'} },
      { creator_username:'creator', product_id:'p', content_type:'PRE_LIVE', estimated_commission_base:{amount:'1'} },
      { creator_username:'creator', product_id:'p', content_type:'LINKSHARE', estimated_commission_base:{amount:'1'} }
    ] }], [], {});
    expect(result.creators[0].sources.video.skuOrders).toBe(1);
    expect(result.creators[0].sources.showcase.skuOrders).toBe(2);
    expect(result.creators[0].sources.live.skuOrders).toBe(2);
    expect(result.creators[0].sources.linkshare.skuOrders).toBe(1);
  });

  it('compares product creator order counts with the immediately preceding period', () => {
    const sku = { creator_username:'creator', product_id:'p', content_type:'VIDEO', estimated_commission_base:{amount:'10'} };
    const result = summarizeKocOrders([{id:'a',skus:[sku]},{id:'b',skus:[sku]}],[{id:'old',skus:[sku]}],{});
    expect(result.products[0].creators[0].comparison).toMatchObject({ current:2, previous:1, delta:1, rate:1 });
  });

  it('joins ordered affiliate videos with Ads creative metrics', () => {
    const result = summarizeKocOrders([{ id:'order-1', skus:[
      { creator_username:'creator_a', product_id:'p1', content_type:'VIDEO', content_id:'video-1',
        estimated_commission_base:{ amount:'143900' }, fully_return:'No' }
    ] }], [], { p1:'Sản phẩm A' });
    attachKocVideos(result, [{ itemId:'video-1', title:'Tiêu đề video', accountUsername:'creator_a',
      cost:50000, orders:2, grossRevenue:287800, productImpressions:1000, productClicks:20,
      viewRate2s:30, viewRate6s:10, viewRate25:5, viewRate50:3, viewRate75:2, viewRate100:1 }]);
    expect(result.products[0].creators[0].videos[0]).toMatchObject({
      itemId:'video-1', title:'Tiêu đề video', affiliateOrders:1, affiliateGmv:143900,
      cost:50000, orders:2, grossRevenue:287800, roi:5.756, impressions:1000, clicks:20, ctr:.02, cvr:.1
    });
  });
});
