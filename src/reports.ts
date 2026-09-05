import type { Env, McpRow, McpSession, ProductContext } from './types';
import { callTool, createSession, forEachReportPage, pagedReport, resolveTool } from './mcp';
import { cacheGet, cachePut, dateInTimezone, hourInTimezone, numberValue, shiftDate, stableKey, unique } from './utils';
import { evaluateVideos } from './evaluator';
import { sellerOwnedVideoIds } from './seller';

const SELLER_TIKTOK_USERNAMES = ['anlanh.farm', 'anlanhfarmvn', 'tracagaileoalf', 'anlanhherbs'];

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
      campaign_ids: unique(contexts.map((c) => c.campaignId)), item_group_ids: unique(contexts.map((c) => c.itemGroupId)),
      ...(dimensions.includes('item_id') ? { creative_types: ['ADS_AND_ORGANIC'] } : {})
    } });
}

export async function loadMainReport(env: Env, input: any, force = false): Promise<any> {
  const key = stableKey('main-v6', input); if (!force) { const hit = await cacheGet<any>(env, key); if (hit) return hit; }
  const { advertiserId, storeId, startDate, endDate } = input;
  const multiDay = startDate !== endDate;
  const session = await createSession(env);
  const campaignRows = (await pagedReport(env, session, { advertiser_id: advertiserId, store_ids: [storeId],
    dimensions: ['campaign_id'], metrics: ['cost','orders','cost_per_order','gross_revenue','roi'], start_date: startDate, end_date: endDate }))
    .filter((row) => numberValue(row.metrics?.cost) > 0);
  const totals = empty(); campaignRows.forEach((row) => add(totals, metric(row.metrics || {})));
  const products: any[] = [];
  let hourlyRows: McpRow[] = multiDay ? [] : await pagedReport(env, session, {
    advertiser_id: advertiserId, store_ids: [storeId], dimensions: ['stat_time_hour'],
    metrics: ['cost','orders','gross_revenue'], start_date: startDate, end_date: endDate
  });
  for (const campaignRow of campaignRows) {
    const campaignId = rowId(campaignRow, 'campaign_id'); if (!campaignId) continue;
    const [info, productRows] = await Promise.all([
      campaignInfo(env, session, advertiserId, campaignId).catch(() => ({})),
      pagedReport(env, session, { advertiser_id: advertiserId, store_ids: [storeId], dimensions: ['item_group_id'],
        metrics: ['product_name','product_image_url','product_status','cost','orders','cost_per_order','gross_revenue','roi'],
        start_date: startDate, end_date: endDate, filtering: { campaign_ids: [campaignId] }, sort_field: 'cost', sort_type: 'DESC' })
    ]);
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
  if (!multiDay && !hourlyRows.length && contexts.length) {
    for (let offset = 0; offset < contexts.length; offset += 4) {
      const chunk = contexts.slice(offset, offset + 4);
      const values = await Promise.all(chunk.map((context) => contextsRows(env, session, advertiserId, storeId,
        [context], startDate, endDate, ['item_id','stat_time_hour'], ['cost','orders','gross_revenue'])));
      values.forEach((rows) => hourlyRows.push(...rows));
    }
  }
  const hourly = Array.from({ length: 24 }, (_, index) => ({ hour: index + 1, label: `${index + 1}:00`, metrics: empty(), observed: false }));
  for (const row of hourlyRows) {
    const value = String(row.dimensions?.stat_time_hour || row.metrics?.stat_time_hour || '');
    const match = value.match(/(?:T|\s)(\d{1,2})(?::|$)/) || value.match(/^(\d{1,2})(?::|$)/); if (!match) continue;
    const index = Number(match[1]); if (index >= 0 && index < 24) {
      add(hourly[index].metrics, metric(row.metrics || {}));
      hourly[index].observed = true;
    }
  }
  let hourlyMode: 'hourly' | 'snapshots' | 'cumulative' = 'hourly';
  const hasDirectHourlyData = hourly.some((point) => point.observed);
  // Stored snapshots are only a fallback for accounts whose MCP report does
  // not return hourly rows. Mixing them into valid hourly rows shifts delayed
  // hours into the next successful bot message.
  if (!multiDay && !hasDirectHourlyData) {
    const stored = await env.DB.prepare(`SELECT report_hour,metrics_json FROM hourly_metrics
      WHERE advertiser_id=? AND store_id=? AND report_date=? ORDER BY report_hour`)
      .bind(advertiserId, storeId, startDate).all<{ report_hour: number; metrics_json: string }>();
    let baseline = { cost: 0, orders: 0, grossRevenue: 0 };
    let restored = 0;
    for (const row of stored.results || []) {
      const value = JSON.parse(row.metrics_json || '{}');
      const index = Number(row.report_hour) - 1;
      if (index < 0 || index >= 24) continue;
      let metrics = value;
      if (value.snapshotMode === 'cumulative') {
        metrics = {
          ...value,
          cost: Math.max(0, numberValue(value.cost) - baseline.cost),
          orders: Math.max(0, numberValue(value.orders) - baseline.orders),
          grossRevenue: Math.max(0, numberValue(value.grossRevenue) - baseline.grossRevenue)
        };
        metrics.costPerOrder = metrics.orders ? metrics.cost / metrics.orders : null;
        metrics.roi = metrics.cost ? metrics.grossRevenue / metrics.cost : null;
        baseline = { cost: numberValue(value.cost), orders: numberValue(value.orders), grossRevenue: numberValue(value.grossRevenue) };
      } else {
        baseline.cost += numberValue(value.cost); baseline.orders += numberValue(value.orders);
        baseline.grossRevenue += numberValue(value.grossRevenue);
      }
      if (numberValue(metrics.cost) || numberValue(metrics.grossRevenue) || numberValue(metrics.orders)) {
        hourly[index].metrics = { ...empty(), ...metrics };
        hourly[index].observed = true;
        restored += 1;
      }
    }
    if (restored) {
      hourlyMode = 'snapshots';
      const now = new Date();
      if (endDate === dateInTimezone(now, env.TIMEZONE)) {
        const index = Math.max(0, Math.min(23, hourInTimezone(now, env.TIMEZONE) - 1));
        const remainder = {
          cost: Math.max(0, totals.cost - baseline.cost), orders: Math.max(0, totals.orders - baseline.orders),
          grossRevenue: Math.max(0, totals.grossRevenue - baseline.grossRevenue)
        };
        if (remainder.cost || remainder.orders || remainder.grossRevenue) hourly[index].metrics = {
          ...empty(), ...remainder,
          costPerOrder: remainder.orders ? remainder.cost / remainder.orders : null,
          roi: remainder.cost ? remainder.grossRevenue / remainder.cost : null
        };
        if (remainder.cost || remainder.orders || remainder.grossRevenue) hourly[index].observed = true;
      }
    }
  }
  if (!multiDay && hourlyMode === 'hourly' && !hourly.some((point) => point.metrics.cost || point.metrics.grossRevenue) && (totals.cost || totals.grossRevenue)) {
    const now = new Date();
    const isToday = endDate === dateInTimezone(now, env.TIMEZONE);
    const fallbackIndex = isToday ? Math.max(0, Math.min(23, hourInTimezone(now, env.TIMEZONE) - 1)) : 23;
    hourly[fallbackIndex].metrics = { ...totals };
    hourly[fallbackIndex].observed = true;
    hourlyMode = 'cumulative';
  }
  const daily: any[] = [];
  if (multiDay) {
    const dailyRows = await pagedReport(env, session, { advertiser_id: advertiserId, store_ids: [storeId],
      dimensions: ['campaign_id','stat_time_day'], metrics: ['cost','orders','gross_revenue','product_clicks'],
      start_date: startDate, end_date: endDate });
    const dailyByDate = new Map<string, any>();
    for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) {
      const point = { date, label: `${date.slice(8,10)}/${date.slice(5,7)}`, metrics: empty() };
      daily.push(point); dailyByDate.set(date, point);
    }
    for (const row of dailyRows) {
      const date = String(row.dimensions?.stat_time_day || row.metrics?.stat_time_day || '').slice(0, 10);
      const point = dailyByDate.get(date); if (point) add(point.metrics, metric(row.metrics || {}));
    }
  }
  const result = { advertiserId, store: { storeId }, startDate, endDate, generatedAt: new Date().toISOString(), totals,
    products: products.filter((p) => (p.campaignActive && p.status === 'AVAILABLE') || p.metrics.cost > 0).sort((a,b) => b.metrics.cost-a.metrics.cost),
    availableProductCount: products.filter((p) => p.campaignActive && p.status === 'AVAILABLE').length,
    creativeContexts: contexts, hourly, hourlyMode, daily };
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
  const key=stableKey('summary-v3-source-orders',{...input,forceRefresh:undefined}); if(!input.forceRefresh){const hit=await cacheGet<any>(env,key);if(hit)return {...hit,cacheStatus:'HIT'};}
  const session=await createSession(env); const contexts=input.allContexts||input.products||[];
  const rows:McpRow[]=[];
  const exactContexts=Array.from(new Map<string,ProductContext>(contexts.map((context:ProductContext)=>[`${context.campaignId}:${context.itemGroupId}`,context])).values());
  for(let offset=0;offset<exactContexts.length;offset+=4){
    const chunk=exactContexts.slice(offset,offset+4);
    const chunkRows=await Promise.all(chunk.map(async context=>{
      const values=await pagedReport(env,session,{advertiser_id:input.advertiserId,store_ids:[input.storeId],
        dimensions:['item_id'],metrics:creativeMetrics,start_date:input.startDate,end_date:input.endDate,
        filtering:{campaign_ids:[context.campaignId],item_group_ids:[context.itemGroupId],creative_types:['ADS_AND_ORGANIC']}});
      values.forEach(row=>{row.dimensions={...(row.dimensions||{}),campaign_id:context.campaignId,item_group_id:context.itemGroupId};});
      return values;
    }));
    chunkRows.forEach(values=>rows.push(...values));
  }
  const sellerVideoIds = await sellerOwnedVideoIds(env, shiftDate(input.startDate, -29), input.endDate, SELLER_TIKTOK_USERNAMES)
    .catch(() => new Set<string>());
  const ids=new Set<string>();let traffic=0,impressions=0;const map=new Map<string,any>();
  const costAttribution:any={total:0,productCard:0,seller:0,affiliate:0,metrics:{
    productCard:{cost:0,grossRevenue:0,impressions:0,clicks:0,orders:0},seller:{cost:0,grossRevenue:0,impressions:0,clicks:0,orders:0},affiliate:{cost:0,grossRevenue:0,impressions:0,clicks:0,orders:0}
  }};
  for(const row of rows){const m=row.metrics||{},id=rowId(row,'item_id'),k=`${rowId(row,'campaign_id')}:${rowId(row,'item_group_id')}`;
    const cost=numberValue(m.cost);
    const title=String(m.title||row.dimensions?.title||'').trim().toLowerCase();
    const isProductCard=id==='-1'||title.includes('product card')||title.includes('thẻ sản phẩm');
    costAttribution.total+=cost;
    const source=isProductCard?'productCard':sellerVideoIds.has(id)?'seller':'affiliate';
    costAttribution[source]+=cost;
    costAttribution.metrics[source].cost+=cost;
    costAttribution.metrics[source].grossRevenue+=numberValue(m.gross_revenue);
    costAttribution.metrics[source].impressions+=numberValue(m.product_impressions);
    costAttribution.metrics[source].clicks+=numberValue(m.product_clicks);
    costAttribution.metrics[source].orders+=numberValue(m.orders);
    const entry=map.get(k)||{creativeCount:0,traffic:0,itemIds:[]}; impressions+=numberValue(m.product_impressions);traffic+=numberValue(m.product_clicks);
    if(numberValue(m.cost)||numberValue(m.orders)||numberValue(m.product_impressions)){if(id){ids.add(id);if(!entry.itemIds.includes(id))entry.itemIds.push(id);}entry.creativeCount++;entry.traffic+=numberValue(m.product_clicks);}map.set(k,entry);}
  for(const source of Object.values<any>(costAttribution.metrics))source.roi=source.cost?source.grossRevenue/source.cost:0;
  const result={generatedAt:new Date().toISOString(),summaries:(input.products||[]).map((p:any)=>({campaignId:p.campaignId,itemGroupId:p.itemGroupId,...(map.get(`${p.campaignId}:${p.itemGroupId}`)||{creativeCount:0,traffic:0,itemIds:[]})})),
    totalCreatives:ids.size,impressions,traffic,costAttribution,videoEvaluation:evaluateVideos(rows),hourlyTraffic:[],cacheStatus:'REFRESHED'};
  await cachePut(env,key,result,300);return result;
}

export async function discoverVideoContexts(env:Env,input:any,startDate:string,endDate:string,existingSession?:McpSession):Promise<ProductContext[]>{
  const session=existingSession||await createSession(env);let contexts:ProductContext[]=input.metadataContexts||[];
  const contextKey=stableKey('video-contexts-v2',{advertiserId:input.advertiserId,storeId:input.storeId,startDate,endDate});
  const cachedContexts=await cacheGet<ProductContext[]>(env,contextKey);
  if(cachedContexts?.length)contexts=cachedContexts;
  else {
    const campaignRows=await pagedReport(env,session,{advertiser_id:input.advertiserId,store_ids:[input.storeId],
      dimensions:['campaign_id'],metrics:['cost'],start_date:startDate,end_date:endDate});
    const campaignIds=unique(campaignRows.filter(row=>numberValue(row.metrics?.cost)>0)
      .map(row=>rowId(row,'campaign_id')).filter(Boolean));
    if(campaignIds.length){
      const seen=new Set<string>();const discovered:ProductContext[]=[];
      for(let offset=0;offset<campaignIds.length;offset+=20){
        const campaignChunk=campaignIds.slice(offset,offset+20);
        await forEachReportPage(env,session,{advertiser_id:input.advertiserId,store_ids:[input.storeId],
          dimensions:['campaign_id','item_group_id'],metrics:['cost'],start_date:startDate,end_date:endDate,
          filtering:{campaign_ids:campaignChunk}},rows=>{for(const row of rows){
          const campaignId=rowId(row,'campaign_id'),itemGroupId=rowId(row,'item_group_id');const pair=`${campaignId}:${itemGroupId}`;
          if(campaignId&&itemGroupId&&numberValue(row.metrics?.cost)>0&&!seen.has(pair)){
            seen.add(pair);discovered.push({campaignId,itemGroupId});
          }
        }});
      }
      if(discovered.length)contexts=discovered;
    }
    if(contexts.length)await cachePut(env,contextKey,contexts,3600);
  }
  return contexts;
}

export async function loadAdsVideoMetrics(env:Env,input:any,startDate:string,endDate:string):Promise<any[]>{
  const session=await createSession(env);
  const contexts=await discoverVideoContexts(env,input,startDate,endDate,session);
  const main=await loadMainReport(env,{advertiserId:input.advertiserId,storeId:input.storeId,startDate,endDate});
  const products=new Map<string,any>((main.products||[]).map((product:any)=>[String(product.itemGroupId),product]));
  const byId=new Map<string,any>();
  const timeDimension=startDate===endDate?'stat_time_hour':'stat_time_day';
  for(let offset=0;offset<contexts.length;offset+=4){
    const chunk=contexts.slice(offset,offset+4);
    const values=await Promise.all(chunk.map(async context=>{
      const [rows,timeRows]=await Promise.all([
        contextsRows(env,session,input.advertiserId,input.storeId,[context],startDate,endDate,['item_id'],creativeMetrics),
        contextsRows(env,session,input.advertiserId,input.storeId,[context],startDate,endDate,['item_id',timeDimension],['cost','orders','gross_revenue','product_impressions','product_clicks'])
      ]);
      return{rows:rows.map(row=>({row,context})),timeRows:timeRows.map(row=>({row,context}))};
    }));
    for(const {row,context} of values.flatMap(value=>value.rows)){
      const itemId=rowId(row,'item_id');if(!itemId||itemId==='-1')continue;
      const video=normalizeVideo(row);const product=products.get(String(context.itemGroupId));
      const current=byId.get(itemId)||{itemId,title:video.name,accountName:video.accountName,accountUsername:video.accountUserName,
        authorizationType:video.authorizationType,cost:0,orders:0,grossRevenue:0,productClicks:0,productImpressions:0,
        viewRate2s:video.viewRate2s,viewRate6s:video.viewRate6s,viewRate25:video.viewRate25,viewRate50:video.viewRate50,viewRate75:video.viewRate75,viewRate100:video.viewRate100,campaigns:[],products:[],timeline:{}};
      current.cost+=numberValue(video.cost);current.orders+=numberValue(video.orders);current.grossRevenue+=numberValue(video.grossRevenue);
      current.productClicks+=numberValue(video.productClicks);current.productImpressions+=numberValue(video.productImpressions);
      for(const key of ['viewRate2s','viewRate6s','viewRate25','viewRate50','viewRate75','viewRate100'])if(current[key]==null&&video[key]!=null)current[key]=video[key];
      if(!current.campaigns.some((item:any)=>item.campaignId===context.campaignId))current.campaigns.push({campaignId:context.campaignId,campaignName:product?.campaignName||`GMV Max ${context.campaignId}`});
      if(!current.products.some((item:any)=>item.id===String(context.itemGroupId)))current.products.push({id:String(context.itemGroupId),name:product?.productName||`Sản phẩm ${context.itemGroupId}`,imageUrl:product?.productImageUrl||''});
      byId.set(itemId,current);
    }
    for(const {row} of values.flatMap(value=>value.timeRows)){
      const itemId=rowId(row,'item_id'),current=byId.get(itemId);if(!current)continue;const metrics=row.metrics||{};
      const rawTime=String(row.dimensions?.[timeDimension]||metrics[timeDimension]||'');
      const timeKey=timeDimension==='stat_time_day'?rawTime.slice(0,10):String((rawTime.match(/(?:T|\s)(\d{1,2}):/)||rawTime.match(/^(\d{1,2})$/)||[])[1]||'').padStart(2,'0');
      if(!timeKey)continue;const point=current.timeline[timeKey]||{cost:0,orders:0,grossRevenue:0,productClicks:0,productImpressions:0};
      point.cost+=numberValue(metrics.cost);point.orders+=numberValue(metrics.orders);point.grossRevenue+=numberValue(metrics.gross_revenue);
      point.productClicks+=numberValue(metrics.product_clicks);point.productImpressions+=numberValue(metrics.product_impressions);current.timeline[timeKey]=point;
    }
  }
  const result=Array.from(byId.values());
  (result as any).overallTimeline=(startDate===endDate?main.hourly:main.daily).map((point:any)=>({key:startDate===endDate?String(Math.max(0,Number(point.hour||1)-1)).padStart(2,'0'):point.date,
    grossRevenue:numberValue(point.metrics?.grossRevenue),productClicks:numberValue(point.metrics?.traffic)}));
  return result;
}

export async function loadAdsCreatorPeriodMetrics(env:Env,input:any,startDate:string,endDate:string):Promise<any[]>{
  const session=await createSession(env);
  const main=await loadMainReport(env,{advertiserId:input.advertiserId,storeId:input.storeId,startDate,endDate});
  const rows:McpRow[]=[];
  const contexts:ProductContext[]=main.creativeContexts||[];
  const campaignIds=unique(contexts.map((context)=>context.campaignId));
  for(const campaignId of campaignIds){const campaignContexts=contexts.filter((context)=>context.campaignId===campaignId);
    rows.push(...await contextsRows(env,session,input.advertiserId,input.storeId,campaignContexts,startDate,endDate,['item_id'],creativeMetrics));}
  const byId=new Map<string,any>();
  for(const row of rows){const itemId=rowId(row,'item_id');if(!itemId||itemId==='-1')continue;const video=normalizeVideo(row);
    const current=byId.get(itemId)||{itemId,accountUsername:video.accountUserName,authorizationType:video.authorizationType,cost:0,grossRevenue:0};
    current.cost+=numberValue(video.cost);current.grossRevenue+=numberValue(video.grossRevenue);
    if(!current.accountUsername&&video.accountUserName)current.accountUsername=video.accountUserName;
    if(!current.authorizationType&&video.authorizationType)current.authorizationType=video.authorizationType;byId.set(itemId,current);}
  return Array.from(byId.values());
}

export async function loadVideoDayStats(env:Env,input:any,contexts:ProductContext[],reportDate:string):Promise<any>{
  const session=await createSession(env);const point={date:reportDate,cost:0,orders:0,grossRevenue:0};
  const campaignIds=unique(contexts.map(context=>context.campaignId));
  for(let offset=0;offset<campaignIds.length;offset+=20){
    const campaignChunk=campaignIds.slice(offset,offset+20),chunkSet=new Set(campaignChunk);
    const itemGroupIds=unique(contexts.filter(context=>chunkSet.has(context.campaignId)).map(context=>context.itemGroupId));
    await forEachReportPage(env,session,{advertiser_id:input.advertiserId,store_ids:[input.storeId],dimensions:['item_id'],
      metrics:['cost','orders','gross_revenue'],start_date:reportDate,end_date:reportDate,
      filtering:{campaign_ids:campaignChunk,item_group_ids:itemGroupIds}},rows=>{for(const row of rows){
      if(rowId(row,'item_id')!==String(input.itemId))continue;
      point.cost+=numberValue(row.metrics?.cost);point.orders+=numberValue(row.metrics?.orders);point.grossRevenue+=numberValue(row.metrics?.gross_revenue);
    }});
  }
  return point;
}

export async function loadVideoStats(env:Env,input:any):Promise<any>{
  const endDate=input.endDate;const start=new Date(`${endDate}T00:00:00Z`);start.setUTCDate(start.getUTCDate()-29);const startDate=start.toISOString().slice(0,10);
  const key=stableKey('video30-v2',{advertiserId:input.advertiserId,storeId:input.storeId,itemId:input.itemId,endDate});if(!input.forceRefresh){const hit=await cacheGet<any>(env,key);if(hit)return {...hit,cacheStatus:'HIT'};}
  const session=await createSession(env);const contexts=await discoverVideoContexts(env,input,startDate,endDate,session);
  const dates=Array.from({length:30},(_,i)=>{const d=new Date(`${startDate}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+i);return d.toISOString().slice(0,10)});
  const daily=dates.map(date=>({date,cost:0,orders:0,grossRevenue:0}));const dailyByDate=new Map(daily.map(point=>[point.date,point]));
  const contextCampaignIds=unique(contexts.map(context=>context.campaignId));
  for(let offset=0;offset<contextCampaignIds.length;offset+=20){
    const campaignChunk=contextCampaignIds.slice(offset,offset+20);const chunkSet=new Set(campaignChunk);
    const itemGroupIds=unique(contexts.filter(context=>chunkSet.has(context.campaignId)).map(context=>context.itemGroupId));
    await forEachReportPage(env,session,{advertiser_id:input.advertiserId,store_ids:[input.storeId],
      dimensions:['item_id','stat_time_day'],metrics:['cost','orders','gross_revenue'],start_date:startDate,end_date:endDate,
      filtering:{campaign_ids:campaignChunk,item_group_ids:itemGroupIds}},rows=>{for(const row of rows){
      if(rowId(row,'item_id')!==String(input.itemId))continue;
      const date=String(row.dimensions?.stat_time_day||row.metrics?.stat_time_day||'').slice(0,10);const point=dailyByDate.get(date);
      if(point){point.cost+=numberValue(row.metrics?.cost);point.orders+=numberValue(row.metrics?.orders);point.grossRevenue+=numberValue(row.metrics?.gross_revenue);}
    }});
  }
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
  const currentStart = input.startDate || input.endDate;
  const dayCount = Math.max(1, Math.round((Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${currentStart}T00:00:00Z`)) / 86400000) + 1);
  const comparisonEndDate = shiftDate(currentStart, -1);
  const comparisonStartDate = shiftDate(comparisonEndDate, -(dayCount - 1));
  const previous = await loadMainReport(env, { advertiserId: input.advertiserId, storeId: input.storeId,
    startDate: comparisonStartDate, endDate: comparisonEndDate });
  let totalCreatives = 0, impressions = 0, traffic = 0;
  let costAttribution: any = { total: 0, productCard: 0, seller: 0, affiliate: 0, metrics: {} };
  try {
    const summary = await loadCreativeSummaries(env, { advertiserId: input.advertiserId, storeId: input.storeId,
      startDate: comparisonStartDate, endDate: comparisonEndDate, products: previous.products,
      allContexts: previous.creativeContexts, availableProducts: previous.availableProductCount });
    totalCreatives = summary.totalCreatives; impressions = summary.impressions; traffic = summary.traffic;
    costAttribution = summary.costAttribution || costAttribution;
  } catch { /* Comparison cards can still use the main metrics. */ }
  return { comparisonDate: comparisonEndDate, comparisonStartDate, comparisonEndDate, throughHour: 24, metrics: previous.totals,
    availableProducts: previous.availableProductCount, totalCreatives, impressions, traffic, costAttribution,
    summaryComparisonPeriod: dayCount > 1 ? 'previous_period' : 'previous_day',
    impressionsComparisonPeriod: dayCount > 1 ? 'previous_period' : 'previous_day' };
}
