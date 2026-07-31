import { describe, expect, it } from 'vitest';
import { calculateContentKocTotals, classifyCreatorType } from '../src/content-koc';

describe('Content & KOC analysis', () => {
  it('classifies TikTok Shop author types without guessing Ads-only videos', () => {
    expect(classifyCreatorType('OFFICIAL')).toBe('SELLER');
    expect(classifyCreatorType('channel')).toBe('SELLER');
    expect(classifyCreatorType('AFFILIATE')).toBe('KOC');
    expect(classifyCreatorType(undefined)).toBe('UNKNOWN');
  });

  it('keeps seller, KOC and Ads-only totals separate', () => {
    const totals = calculateContentKocTotals([
      { creatorType:'SELLER', shop:{gmv:1_000,views:100,clicks:5,skuOrders:2}, ads:{cost:200,productClicks:3} },
      { creatorType:'KOC', shop:{gmv:2_000,views:300,clicks:12,skuOrders:4}, ads:null },
      { creatorType:'UNKNOWN', shop:null, ads:{cost:50,orders:1,productClicks:2} }
    ]);
    expect(totals.seller).toMatchObject({videoCount:1,gmv:1_000,adsSpend:200,views:100,clicks:8,orders:2});
    expect(totals.koc).toMatchObject({videoCount:1,gmv:2_000,adsSpend:0,views:300,clicks:12,orders:4});
    expect(totals.unknown).toMatchObject({videoCount:1,gmv:0,adsSpend:50,views:0,clicks:2,orders:1});
    expect(totals.all).toMatchObject({videoCount:3,gmv:3_000,adsSpend:250,views:400,clicks:22,orders:7});
  });
});
