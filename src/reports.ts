import type { Env, McpRow, McpSession, ProductContext } from './types';
import { callTool, createSession, pagedReport, resolveTool } from './mcp';
import { cacheGet, cachePut, numberValue, stableKey, unique } from './utils';
import { evaluateVideos } from './evaluator';

function metric(m: Record<string, unknown>): any {
  const cost = numberValue(m.cost), orders = numberValue(m.orders), grossRevenue = numberValue(m.gross_revenue);
  return { cost, orders, grossRevenue, traffic: numberValue(m.product_clicks ?? m.product_ad_clicks ?? m.clicks),
    trafficAvailable: m.product_clicks != null || m.product_ad_clicks != null || m.clicks != null,
    costPerOrder: m.cost_per_order != null ? numberValue(m.cost_per_order) : (orders ? cost / orders : null),
    roi: m.roi != null ? numberValue(m.roi) : (cost ? grossRevenue / cost : null) };
}
function add(target: any, source: any): void {
  target.cost += source.cost; target.orders += source.orders; target.grossRevenue += source.grossRevenue;
  target.traffic += source.traffic; target.trafficAvailable ||= source.trafficAvailable;
  target.costPerOrder = target.orders ? target.cost / target.orders : null;
  target.roi = target.cost ? target.grossRevenue / target.cost : null;
}
function empty(): any { return { cost: 0, orders: 0, grossRevenue: 0, traffic: 0, trafficAvailable: false, costPerOrder: null, roi: null }; }
function rowId(row: McpRow, key: string): string { return String(row.dimensions?.[key] || row.metrics?.[key] || ''); }
function campaignActive(info: any): boolean {
  const enabled = info.is_enabled ?? info.is_active;
  if (enabled !== undefined) return /TRUE|1|ENABLE|ACTIVE/.test(String(enabled).toUpperCase());
  const status = [info.operation_status, info.campaign_status, info.status, info.delivery_status].join(' ').toUpperCase();
  return !/DISABLE|INACTIVE|PAUSE|OFF|END|DELETE|TERMINAT|NOT_DELIVERY/.test(status);
}

async function campaignInfo(env: Env, session: McpSession, advertiserId: string, campaignId: string): Promise<any> {
  const key = `campaign:${campaignId}`;
  const cached = await cacheGet<any>(env, key); if (cached) return cached;
  const tool = await resolveTool(env, session, ['campaign_gmv_max_info', 'campaign_gmv_max_info_get', 'gmv_max_campaign_info']);
  const data = await callTool(env, session, tool, { advertiser_id: advertiserId, campaign_id: campaignId });
  const info = data.campaign_info || data.campaign || data; await cachePut(env, key, info, 300); return info;
}

async function contextsRows(env: Env, session: McpSession, advertiserId: string, storeId: string,
  contexts: ProductContext[], startDate: string, endDate: string, dimensions: string[], metrics: string[]): Promise<McpRow[]> {
  if (!contexts.length) return [];
  return pagedReport(env, session, { advertiser_id: advertiserId, store_ids: [storeId], dimensions, metrics,
    start_date: startDate, end_date: endDate, filtering: {
      campaign_ids: unique(contexts.map((c) => c.campaignId)), item_group_ids: unique(contexts.map((c) => c.itemGroupId))
    } });
}

export async function loadMainReport(env: Env, input: any, force = false): Promise<any> {
  const key = stableKey('main', input); if (!force) { const hit = await cacheGet<any>(env, key); if (hit) return hit; }
  const { advertiserId, storeId, startDate, endDate } = input;
  const session = await createSession(env);
  const campaignRows = (await pagedReport(env, session, { advertiser_id: advertiserId, store_ids: [storeId],
    dimensions: ['campaign_id'], metrics: ['cost','orders','cost_per_order','gross_revenue','roi'], start_date: startDate, end_date: endDate }))
    .filter((row) => numberValue(row.metrics?.cost) > 0);
  const totals = empty(); campaignRows.forEach((row) => add(totals, metric(row.metrics || {})));
  const products: any[] = []; const hourlyRows: McpRow[] = [];
  for (const campaignRow of campaignRows) {
    const campaignId = rowId(campaignRow, 'campaign_id'); if (!campaignId) continue;
    const [info, productRows, hours] = await Promise.all([
      campaignInfo(env, session, advertiserId, campaignId).catch(() => ({})),
      pagedReport(env, session, { advertiser_id: advertiserId, store_ids: [storeId], dimensions: ['item_group_id'],
        metrics: ['product_name','product_image_url','product_status','cost','orders','cost_per_order','gross_revenue','roi'],
        start_date: startDate, end_date: endDate, filtering: { campaign_ids: [campaignId] }, sort_field: 'cost', sort_type: 'DESC' }),
      pagedReport(env, session, { advertiser_id: advertiserId, store_ids: [storeId], dimensions: ['item_group_id','stat_time_hour'],
        metrics: ['cost','orders','gross_revenue'], start_date: startDate, end_date: endDate, filtering: { campaign_ids: [campaignId] } })
    ]);
    hourlyRows.push(...hours);
    for (const row of productRows) {
      const raw = row.metrics || {}; const d = row.dimensions || {}; const itemGroupId = rowId(row, 'item_group_id');
      const active = campaignActive(info);
      products.push({ campaignId, campaignName: info.campaign_name || `GMV Max ${campaignId}`, campaignActive: active,
        itemGroupId, productName: raw.product_name || d.product_name || `Product ${itemGroupId}`,
        productImageUrl: raw.product_image_url || d.product_image_url || '', status: String(raw.product_status || d.product_status || '').toUpperCase(),
        displayStatus: active ? String(raw.product_status || d.product_status || 'AVAILABLE').toUpperCase() : 'INACTIVE',
        optimizationMode: info.deep_bid_type === 'VO_MIN_ROAS' ? 'Target ROI' : 'Max delivery', targetRoi: info.roas_bid ?? null,
        metrics: metric(raw) });
    }
  }
  const contexts = products.filter((p) => p.itemGroupId).map((p) => ({ campaignId: p.campaignId, itemGroupId: p.itemGroupId, campaignActive: p.campaignActive }));
  const hourly = Array.from({ length: 24 }, (_, index) => ({ hour: index + 1, label: `${index + 1}:00`, metrics: empty() }));
  for (const row of hourlyRows) {
    const value = String(row.dimensions?.stat_time_hour || row.metrics?.stat_time_hour || '');
    const match = value.match(/(?:T|\s)(\d{1,2}):/) || value.match(/^(\d{1,2})$/); if (!match) continue;
    const index = Number(match[1]); if (index >= 0 && index < 24) add(hourly[index].metrics, metric(row.metrics || {}));
  }
  const result = { advertiserId, store: { storeId }, startDate, endDate, generatedAt: new Date().toISOString(), totals,
    products: products.filter((p) => (p.campaignActive && p.status === 'AVAILABLE') || p.metrics.cost > 0).sort((a,b) => b.metrics.cost-a.metrics.cost),
    availableProductCount: products.filter((p) => p.campaignActive && p.status === 'AVAILABLE').length,
    creativeContexts: contexts, hourly };
  await cachePut(env, key, result, endDate === new Date().toISOString().slice(0,10) ? 240 : 86400);
  return result;
}

function normalizeVideo(row: McpRow): any {
  const d = row.dimensions || {}, m = row.metrics || {}, itemId = rowId(row, 'item_id'), values = metric(m);
  const user = String(m.tt_account_name || d.tt_account_name || '').replace(/^@/, '');
  return { itemId, isProductCard: itemId === '-1', name: itemId === '-1' ? 'Product card' : String(m.title || d.title || `Video ${itemId}`),
    accountName: itemId === '-1' ? 'N/A' : String(m.tt_account_name || d.tt_account_name || ''), accountUserName: user,
    accountProfileImageUrl: m.tt_account_profile_image_url || '', videoUrl: itemId !== '-1' ?
      (user ? `https://www.tiktok.com/@${encodeURIComponent(user)}/video/${itemId}` : `https://www.tiktok.com/player/v1/${itemId}`) : '',
    authorizationType: m.tt_account_authorization_type || '', status: m.creative_delivery_status || d.creative_delivery_status || '',
    ...values, productImpressions: m.product_impressions == null ? null : numberValue(m.product_impressions),
    productClicks: m.product_clicks == null ? null : numberValue(m.product_clicks), productClickRate: m.product_click_rate ?? null,
    adClickRate: m.ad_click_rate ?? null, adConversionRate: m.ad_conversion_rate ?? null,
    viewRate2s: m.ad_video_view_rate_2s ?? null, viewRate6s: m.ad_video_view_rate_6s ?? null,
    viewRate25: m.ad_video_view_rate_p25 ?? null, viewRate50: m.ad_video_view_rate_p50 ?? null,
    viewRate75: m.ad_video_view_rate_p75 ?? null, viewRate100: m.ad_video_view_rate_p100 ?? null };
}

const creativeMetrics = ['title','tt_account_name','tt_account_profile_image_url','tt_account_authorization_type','cost','orders',
  'cost_per_order','gross_revenue','roi','creative_delivery_status','product_impressions','product_clicks','product_click_rate',
  'ad_click_rate','ad_conversion_rate','ad_video_view_rate_2s','ad_video_view_rate_6s','ad_video_view_rate_p25',
  'ad_video_view_rate_p50','ad_video_view_rate_p75','ad_video_view_rate_p100'];

export async function loadProductVideos(env: Env, input: any): Promise<any> {
  const key = stableKey('videos', input); if (!input.forceRefresh) { const hit = await cacheGet<any>(env,key); if(hit) return {...hit,cacheStatus:'HIT'}; }
  const session = await createSession(env);
  const rows = await pagedReport(env, session, { advertiser_id: input.advertiserId, store_ids:[input.storeId], dimensions:['item_id'],
    metrics: creativeMetrics, start_date:input.startDate,end_date:input.endDate, filtering:{campaign_ids:[input.campaignId],item_group_ids:[input.itemGroupId],creative_types:['ADS_AND_ORGANIC']},sort_field:'cost',sort_type:'DESC' });
  const result={campaignId:input.campaignId,campaignName:`GMV Max ${input.campaignId}`,itemGroupId:input.itemGroupId,
    videos:rows.map(normalizeVideo).filter((v)=>v.cost||v.orders||v.productImpressions),cacheStatus:'REFRESHED'};
  await cachePut(env,key,result,300); return result;
}

export async function loadCreativeSummaries(env: Env, input: any): Promise<any> {
  const key=stableKey('summary',{...input,forceRefresh:undefined}); if(!input.forceRefresh){const hit=await cacheGet<any>(env,key);if(hit)return {...hit,cacheStatus:'HIT'};}
  const session=await createSession(env); const contexts=input.allContexts||input.products||[];
  const rows=await contextsRows(env,session,input.advertiserId,input.storeId,contexts,input.startDate,input.endDate,
    ['campaign_id','item_group_id','item_id'],['cost','orders','gross_revenue','creative_delivery_status','product_impressions','product_clicks']);
  const ids=new Set<string>();let traffic=0,impressions=0;const map=new Map<string,any>();
  for(const row of rows){const m=row.metrics||{},id=rowId(row,'item_id'),k=`${rowId(row,'campaign_id')}:${rowId(row,'item_group_id')}`;
    const entry=map.get(k)||{creativeCount:0,traffic:0,itemIds:[]}; impressions+=numberValue(m.product_impressions);traffic+=numberValue(m.product_clicks);
    if(numberValue(m.cost)||numberValue(m.orders)||numberValue(m.product_impressions)){if(id){ids.add(id);if(!entry.itemIds.includes(id))entry.itemIds.push(id);}entry.creativeCount++;entry.traffic+=numberValue(m.product_clicks);}map.set(k,entry);}
  const result={generatedAt:new Date().toISOString(),summaries:(input.products||[]).map((p:any)=>({campaignId:p.campaignId,itemGroupId:p.itemGroupId,...(map.get(`${p.campaignId}:${p.itemGroupId}`)||{creativeCount:0,traffic:0,itemIds:[]})})),
    totalCreatives:ids.size,impressions,traffic,videoEvaluation:evaluateVideos(rows),hourlyTraffic:[],cacheStatus:'REFRESHED'};
  await cachePut(env,key,result,300);return result;
}

export async function loadVideoStats(env:Env,input:any):Promise<any>{
  const endDate=input.endDate;const start=new Date(`${endDate}T00:00:00Z`);start.setUTCDate(start.getUTCDate()-29);const startDate=start.toISOString().slice(0,10);
  const key=stableKey('video30',{advertiserId:input.advertiserId,storeId:input.storeId,itemId:input.itemId,endDate});if(!input.forceRefresh){const hit=await cacheGet<any>(env,key);if(hit)return {...hit,cacheStatus:'HIT'};}
  const session=await createSession(env);let contexts:ProductContext[]=input.metadataContexts||[];
  const campaigns=await pagedReport(env,session,{advertiser_id:input.advertiserId,store_ids:[input.storeId],dimensions:['campaign_id'],metrics:['cost'],start_date:startDate,end_date:endDate});
  const campaignIds=unique(campaigns.filter(row=>numberValue(row.metrics?.cost)>0).map(row=>rowId(row,'campaign_id')).filter(Boolean));
  if(campaignIds.length){const groups=await pagedReport(env,session,{advertiser_id:input.advertiserId,store_ids:[input.storeId],dimensions:['item_group_id'],metrics:['cost'],start_date:startDate,end_date:endDate,filtering:{campaign_ids:campaignIds}});
    const groupIds=unique(groups.filter(row=>numberValue(row.metrics?.cost)>0).map(row=>rowId(row,'item_group_id')).filter(Boolean));
    if(groupIds.length){const count=Math.max(campaignIds.length,groupIds.length);contexts=Array.from({length:count},(_,i)=>({campaignId:campaignIds[i%campaignIds.length],itemGroupId:groupIds[i%groupIds.length]}));}}
  const rows=await contextsRows(env,session,input.advertiserId,input.storeId,contexts,startDate,endDate,['item_id','stat_time_day'],['cost','orders','gross_revenue']);
  const dates=Array.from({length:30},(_,i)=>{const d=new Date(`${startDate}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+i);return d.toISOString().slice(0,10)});
  const daily=dates.map(date=>({date,cost:0,orders:0,grossRevenue:0}));for(const row of rows){if(rowId(row,'item_id')!==String(input.itemId))continue;const date=String(row.dimensions?.stat_time_day||row.metrics?.stat_time_day||'').slice(0,10);const point=daily.find(p=>p.date===date);if(point){point.cost+=numberValue(row.metrics?.cost);point.orders+=numberValue(row.metrics?.orders);point.grossRevenue+=numberValue(row.metrics?.gross_revenue);}}
  const metadata=normalizeVideo({dimensions:{item_id:String(input.itemId)},metrics:{}});
  const cost=daily.reduce((s,p)=>s+p.cost,0),orders=daily.reduce((s,p)=>s+p.orders,0),grossRevenue=daily.reduce((s,p)=>s+p.grossRevenue,0);const result={itemId:String(input.itemId),startDate,endDate,generatedAt:new Date().toISOString(),source:'GMV_MAX_CREATIVES',contexts,daily,video:{...metadata,cost,orders,grossRevenue,costPerOrder:orders?cost/orders:null,roi:cost?grossRevenue/cost:null},cacheStatus:'REFRESHED'};
  await cachePut(env,key,result,3600);return result;
}

export async function loadVideoMetadata(env:Env,input:any):Promise<any>{
  const key=stableKey('video-meta',{advertiserId:input.advertiserId,storeId:input.storeId,itemId:input.itemId,contexts:input.metadataContexts});
  const hit=await cacheGet<any>(env,key);if(hit)return hit;
  const endDate=input.endDate;const start=new Date(`${endDate}T00:00:00Z`);start.setUTCDate(start.getUTCDate()-29);const startDate=start.toISOString().slice(0,10);
  const session=await createSession(env);let video:any=null;
  for(const context of (input.metadataContexts||[]).slice(0,20)){try{const rows=await contextsRows(env,session,input.advertiserId,input.storeId,[context],startDate,endDate,['item_id'],creativeMetrics);
    const found=rows.find(row=>rowId(row,'item_id')===String(input.itemId));if(found){video=normalizeVideo(found);break;}}catch{/* Continue with the next exact campaign/product pair. */}}
  const result={itemId:String(input.itemId),video};await cachePut(env,key,result,86400);return result;
}

export async function loadComparison(env: Env, input: any): Promise<any> {
  const date = new Date(`${input.endDate}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 1);
  const comparisonDate = date.toISOString().slice(0, 10);
  const previous = await loadMainReport(env, { advertiserId: input.advertiserId, storeId: input.storeId,
    startDate: comparisonDate, endDate: comparisonDate });
  let totalCreatives = 0, impressions = 0, traffic = 0;
  try {
    const summary = await loadCreativeSummaries(env, { advertiserId: input.advertiserId, storeId: input.storeId,
      startDate: comparisonDate, endDate: comparisonDate, products: previous.products,
      allContexts: previous.creativeContexts, availableProducts: previous.availableProductCount });
    totalCreatives = summary.totalCreatives; impressions = summary.impressions; traffic = summary.traffic;
  } catch { /* Comparison cards can still use the main metrics. */ }
  return { comparisonDate, throughHour: 24, metrics: previous.totals,
    availableProducts: previous.availableProductCount, totalCreatives, impressions, traffic,
    summaryComparisonPeriod: 'previous_day', impressionsComparisonPeriod: 'previous_day' };
}
