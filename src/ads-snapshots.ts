import type { Env } from './types';
import { numberValue } from './utils';

function safe(value: unknown): string { return String(value ?? '').slice(0, 4000); }
function metric(value: any, key: string): number { return numberValue(value?.[key]); }

/** Persist the compact TikTok report used by the dashboard and Zalo jobs. */
export async function saveTikTokAdsSnapshot(env: Env, input: any, report: any): Promise<void> {
  const points = Array.isArray(report.daily) && report.daily.length ? report.daily : [{ date: input.endDate, metrics: report.totals || {} }];
  for (const point of points) {
    const m = point.metrics || {};
    await env.DB.prepare(`INSERT INTO tiktok_ads_daily
      (advertiser_id,store_id,report_date,cost,gross_revenue,cost_per_order,sku_orders,aov,impressions,clicks,ctr,cr,source,payload_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(advertiser_id,store_id,report_date) DO UPDATE SET
      cost=excluded.cost,gross_revenue=excluded.gross_revenue,cost_per_order=excluded.cost_per_order,
      sku_orders=excluded.sku_orders,aov=excluded.aov,impressions=excluded.impressions,clicks=excluded.clicks,
      ctr=excluded.ctr,cr=excluded.cr,source=excluded.source,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP`)
      .bind(input.advertiserId,input.storeId,point.date,metric(m,'cost'),metric(m,'grossRevenue'),m.costPerOrder==null?null:numberValue(m.costPerOrder),metric(m,'orders'),metric(m,'orders')?metric(m,'grossRevenue')/metric(m,'orders'):null,metric(m,'impressions'),metric(m,'traffic'),metric(m,'impressions')?metric(m,'traffic')/metric(m,'impressions'):0,metric(m,'traffic')?metric(m,'orders')/metric(m,'traffic'):0,'mcp-report',JSON.stringify(point)).run();
  }
  const campaignRows = new Map<string, any>();
  for (const product of Array.isArray(report.products) ? report.products : []) {
    const id=safe(product.campaignId); if(!id)continue; const old=campaignRows.get(id)||{campaignId:id,campaignName:product.campaignName,metrics:{}};
    old.metrics.cost=(old.metrics.cost||0)+metric(product.metrics,'cost');old.metrics.orders=(old.metrics.orders||0)+metric(product.metrics,'orders');old.metrics.grossRevenue=(old.metrics.grossRevenue||0)+metric(product.metrics,'grossRevenue');campaignRows.set(id,old);
  }
  for (const row of campaignRows.values()) { const m=row.metrics; await env.DB.prepare(`INSERT INTO tiktok_ads_campaigns
    (advertiser_id,store_id,report_date,campaign_id,campaign_name,result,spend,gross_revenue,roas,payload_json,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(advertiser_id,store_id,report_date,campaign_id) DO UPDATE SET campaign_name=excluded.campaign_name,result=excluded.result,spend=excluded.spend,gross_revenue=excluded.gross_revenue,roas=excluded.roas,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP`)
    .bind(input.advertiserId,input.storeId,input.endDate,row.campaignId,row.campaignName||'',metric(m,'orders'),metric(m,'cost'),metric(m,'grossRevenue'),metric(m,'cost')?metric(m,'grossRevenue')/metric(m,'cost'):null,JSON.stringify(row)).run(); }
}

export async function saveTikTokTrafficSnapshot(env: Env, input: any, timeline: any): Promise<void> {
  for (const point of Array.isArray(timeline?.points) ? timeline.points : []) {
    const m=point.metrics||{}; await env.DB.prepare(`INSERT INTO tiktok_ads_daily
      (advertiser_id,store_id,report_date,impressions,clicks,ctr,source,payload_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(advertiser_id,store_id,report_date) DO UPDATE SET impressions=excluded.impressions,clicks=excluded.clicks,ctr=excluded.ctr,source=excluded.source,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP`)
      .bind(input.advertiserId,input.storeId,point.key,metric(m,'impressions'),metric(m,'clicks'),metric(m,'impressions')?metric(m,'clicks')/metric(m,'impressions'):0,'tiktok-ads-api',JSON.stringify(point)).run();
  }
}

/** Persist Facebook daily/campaign aggregates for fast history and backup. */
export async function saveFacebookAdsSnapshot(env: Env, accountId: string, report: any): Promise<void> {
  for (const point of Array.isArray(report.daily) ? report.daily : []) {
    const m=point.metrics||{}; await env.DB.prepare(`INSERT INTO facebook_ads_daily
      (ad_account_id,report_date,spend,gross_revenue,orders,impressions,clicks,ctr,cpm,cpc,messages,landing_page_views,roas,payload_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(ad_account_id,report_date) DO UPDATE SET spend=excluded.spend,gross_revenue=excluded.gross_revenue,orders=excluded.orders,impressions=excluded.impressions,clicks=excluded.clicks,ctr=excluded.ctr,cpm=excluded.cpm,cpc=excluded.cpc,messages=excluded.messages,landing_page_views=excluded.landing_page_views,roas=excluded.roas,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP`)
      .bind(accountId,point.date,metric(m,'spend'),metric(m,'revenue'),metric(m,'orders'),metric(m,'impressions'),metric(m,'clicks'),metric(m,'ctr'),metric(m,'cpm'),metric(m,'cpc'),metric(m,'messages'),metric(m,'landingPageViews'),metric(m,'spend')?metric(m,'revenue')/metric(m,'spend'):null,JSON.stringify(point)).run();
  }
  for (const row of Array.isArray(report.campaigns)?report.campaigns:[]) { const m=row.metrics||{}; await env.DB.prepare(`INSERT INTO facebook_ads_campaigns
    (ad_account_id,report_date,campaign_id,campaign_name,result,result_type,cost_per_result,spend,reach,impressions,cpm,clicks,messages,purchases,gross_revenue,roas,payload_json,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(ad_account_id,report_date,campaign_id) DO UPDATE SET campaign_name=excluded.campaign_name,result=excluded.result,result_type=excluded.result_type,cost_per_result=excluded.cost_per_result,spend=excluded.spend,reach=excluded.reach,impressions=excluded.impressions,cpm=excluded.cpm,clicks=excluded.clicks,messages=excluded.messages,purchases=excluded.purchases,gross_revenue=excluded.gross_revenue,roas=excluded.roas,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP`)
    .bind(accountId,report.endDate,row.campaignId,row.campaignName||'',metric(m,'messages')||metric(m,'orders'),row.resultCategory||'',metric(m,'messages')?metric(m,'spend')/metric(m,'messages'):null,metric(m,'spend'),metric(m,'reach'),metric(m,'impressions'),metric(m,'cpm'),metric(m,'clicks'),metric(m,'messages'),metric(m,'orders'),metric(m,'revenue'),metric(m,'spend')?metric(m,'revenue')/metric(m,'spend'):null,JSON.stringify(row)).run(); }
}
