import type { Env } from './types';
import type { McpRow } from './types';
import { createSession, pagedReport } from './mcp';
import { cacheGet, cachePut, numberValue, shiftDate, stableKey } from './utils';
import { loadAdsTrafficTimeline } from './cads';

type Action = { action_type?: string; value?: string | number };
type FacebookMetrics = {
  spend:number;impressions:number;reach:number;clicks:number;postEngagement:number;messages:number;
  orders:number;revenue:number;landingPageViews:number;cpm:number;cpc:number;ctr:number;cpo:number|null;roas:number|null;
};

const PURCHASE_ACTIONS=['omni_purchase','purchase','offsite_conversion.fb_pixel_purchase','onsite_conversion.purchase','onsite_web_purchase','onsite_app_purchase'];
const MESSAGE_ACTIONS=['onsite_conversion.messaging_conversation_started_7d','messaging_conversation_started_7d','onsite_conversion.total_messaging_connection'];
const ENGAGEMENT_ACTIONS=['post_engagement','post_interaction_gross','page_engagement'];
const LANDING_ACTIONS=['landing_page_view','omni_landing_page_view'];

function emptyMetrics():FacebookMetrics{return{spend:0,impressions:0,reach:0,clicks:0,postEngagement:0,messages:0,orders:0,revenue:0,landingPageViews:0,cpm:0,cpc:0,ctr:0,cpo:null,roas:null};}
function actionValue(actions:Action[]|undefined,priorities:string[]):number{const values=new Map((actions||[]).map(action=>[String(action.action_type||''),numberValue(action.value)]));
  for(const name of priorities)if(values.has(name))return values.get(name)||0;return 0;}
function normalizeRow(row:any):FacebookMetrics{return{...emptyMetrics(),spend:numberValue(row.spend),impressions:numberValue(row.impressions),reach:numberValue(row.reach),clicks:numberValue(row.clicks),
  postEngagement:actionValue(row.actions,ENGAGEMENT_ACTIONS),messages:actionValue(row.actions,MESSAGE_ACTIONS),orders:actionValue(row.actions,PURCHASE_ACTIONS),
  revenue:actionValue(row.action_values,PURCHASE_ACTIONS),landingPageViews:actionValue(row.actions,LANDING_ACTIONS)};}
function finish(metrics:FacebookMetrics):FacebookMetrics{metrics.cpm=metrics.impressions?metrics.spend*1000/metrics.impressions:0;metrics.cpc=metrics.clicks?metrics.spend/metrics.clicks:0;
  metrics.ctr=metrics.impressions?metrics.clicks/metrics.impressions:0;metrics.cpo=metrics.orders?metrics.spend/metrics.orders:null;metrics.roas=metrics.spend?metrics.revenue/metrics.spend:null;return metrics;}
function add(target:FacebookMetrics,source:FacebookMetrics):void{for(const key of ['spend','impressions','reach','clicks','postEngagement','messages','orders','revenue','landingPageViews'] as const)target[key]+=source[key];finish(target);}
function resultCategory(name:string,metrics:FacebookMetrics):string{const normalized=name.toLowerCase();
  if(metrics.messages||/mess|tin nhắn|inbox/.test(normalized))return'Cuộc trò chuyện mới';
  if(/reach|nhận diện|awareness/.test(normalized))return'Người tiếp cận';
  if(metrics.landingPageViews||/ctw|traffic|website|landing/.test(normalized))return'Lượt xem trang đích';
  return'Lượt tương tác';}

async function insights(env:Env,startDate:string,endDate:string):Promise<any[]>{
  if(!env.FB_ACCESS_TOKEN||!env.FB_ACT_ID)throw new Error('Chưa cấu hình Facebook Ads API.');
  const version=String(env.FB_API_VERSION||'v19.0').replace(/^\/?/,'');const account=String(env.FB_ACT_ID).startsWith('act_')?String(env.FB_ACT_ID):`act_${env.FB_ACT_ID}`;
  const params=new URLSearchParams({access_token:env.FB_ACCESS_TOKEN,level:'campaign',time_increment:'1',limit:'500',
    fields:'campaign_id,campaign_name,spend,impressions,reach,clicks,cpc,cpm,ctr,actions,action_values',time_range:JSON.stringify({since:startDate,until:endDate})});
  let next=`https://graph.facebook.com/${version}/${account}/insights?${params}`,pages=0;const rows:any[]=[];
  while(next&&pages<50){const response=await fetch(next);const payload=await response.json<any>().catch(()=>({}));
    if(!response.ok||payload.error)throw new Error(`Facebook Ads API: ${payload.error?.message||`HTTP ${response.status}`}`);
    rows.push(...(Array.isArray(payload.data)?payload.data:[]));const candidate=String(payload.paging?.next||'');
    next=candidate.startsWith('https://graph.facebook.com/')?candidate:'';pages+=1;
  }
  return rows;
}

export function summarizeFacebookRows(rows:any[]):{totals:FacebookMetrics;daily:any[];campaigns:any[];resultCosts:any[]}{
  const totals=emptyMetrics(),dailyMap=new Map<string,any>(),campaignMap=new Map<string,any>();
  for(const row of rows){const metrics=normalizeRow(row);add(totals,metrics);const date=String(row.date_start||'');
    const day=dailyMap.get(date)||{date,label:date?`${date.slice(8,10)}/${date.slice(5,7)}`:'',metrics:emptyMetrics()};add(day.metrics,metrics);dailyMap.set(date,day);
    const id=String(row.campaign_id||'');const campaign=campaignMap.get(id)||{campaignId:id,campaignName:String(row.campaign_name||id),metrics:emptyMetrics()};
    add(campaign.metrics,metrics);campaignMap.set(id,campaign);
  }
  const campaigns=[...campaignMap.values()].map(campaign=>({...campaign,resultCategory:resultCategory(campaign.campaignName,campaign.metrics)})).sort((a,b)=>b.metrics.spend-a.metrics.spend);
  const resultMap=new Map<string,number>();for(const campaign of campaigns)resultMap.set(campaign.resultCategory,(resultMap.get(campaign.resultCategory)||0)+campaign.metrics.spend);
  return{totals:finish(totals),daily:[...dailyMap.values()].sort((a,b)=>a.date.localeCompare(b.date)),campaigns,
    resultCosts:[...resultMap].map(([label,cost])=>({label,cost})).sort((a,b)=>b.cost-a.cost)};
}

export function minimumChartStartDate(startDate:string,endDate:string,minimumDays=7):string{
  const minimumStart=shiftDate(endDate,-Math.max(1,minimumDays)+1);
  return startDate<minimumStart?startDate:minimumStart;
}

function facebookDaily(rows:any[],startDate:string,endDate:string):any[]{
  const byDate=new Map(summarizeFacebookRows(rows).daily.map((day:any)=>[day.date,day]));const daily:any[]=[];
  for(let date=startDate;date<=endDate;date=shiftDate(date,1))daily.push(byDate.get(date)||{date,label:`${date.slice(8,10)}/${date.slice(5,7)}`,metrics:emptyMetrics()});
  return daily;
}

function comparisonDates(startDate:string,endDate:string):{startDate:string;endDate:string}{const days=Math.max(1,Math.round((Date.parse(`${endDate}T00:00:00Z`)-Date.parse(`${startDate}T00:00:00Z`))/86400000)+1);
  const previousEnd=shiftDate(startDate,-1);return{startDate:shiftDate(previousEnd,-days+1),endDate:previousEnd};}

export async function loadFacebookAdsReport(env:Env,input:{startDate:string;endDate:string;forceRefresh?:boolean}):Promise<any>{
  const key=stableKey('facebook-ads-v2',{startDate:input.startDate,endDate:input.endDate});if(!input.forceRefresh){const cached=await cacheGet<any>(env,key);if(cached)return cached;}
  const previous=comparisonDates(input.startDate,input.endDate),chartStartDate=minimumChartStartDate(input.startDate,input.endDate);
  const currentPromise=insights(env,input.startDate,input.endDate);const chartPromise=chartStartDate===input.startDate?currentPromise:insights(env,chartStartDate,input.endDate);
  const [currentRows,previousRows,chartRows]=await Promise.all([currentPromise,insights(env,previous.startDate,previous.endDate),chartPromise]);
  const current=summarizeFacebookRows(currentRows),previousReport=summarizeFacebookRows(previousRows);const result={...current,daily:facebookDaily(chartRows,chartStartDate,input.endDate),
    previousTotals:previousReport.totals,startDate:input.startDate,endDate:input.endDate,chartStartDate,generatedAt:new Date().toISOString()};
  await cachePut(env,key,result,input.endDate<new Date().toISOString().slice(0,10)?86400:300).catch(()=>undefined);return result;
}

function platformMetrics(source:any):any{const cost=numberValue(source.cost??source.spend),orders=numberValue(source.orders),revenue=numberValue(source.grossRevenue??source.revenue),impressions=numberValue(source.impressions),clicks=numberValue(source.clicks??source.traffic);
  return{cost,revenue,impressions,clicks,orders,ctr:impressions?clicks/impressions:0,cr:clicks?orders/clicks:0,cpc:clicks?cost/clicks:0,cpm:impressions?cost*1000/impressions:0,cpo:orders?cost/orders:null,roas:cost?revenue/cost:null};}
function totalPlatforms(facebook:any,tiktok:any):any{return platformMetrics({cost:facebook.cost+tiktok.cost,revenue:facebook.revenue+tiktok.revenue,impressions:facebook.impressions+tiktok.impressions,clicks:facebook.clicks+tiktok.clicks,orders:facebook.orders+tiktok.orders});}

type TikTokOverview = {
  current:any; previous:any; daily:any[];
  costSources:{total:number;productCard:number;seller:number;affiliate:number;unclassified:number};
  diagnostics:{currentRows:number;previousRows:number;dailyQueries:number};
};

function rowMetric(row:McpRow,key:string):number{return numberValue(row.metrics?.[key]);}
function addTikTok(target:any,row:McpRow):void{
  target.cost+=rowMetric(row,'cost');target.revenue+=rowMetric(row,'gross_revenue');target.orders+=rowMetric(row,'orders');
  target.clicks+=rowMetric(row,'product_clicks');target.impressions+=rowMetric(row,'product_impressions');
}

async function loadTikTokOverview(env:Env,input:any,previousDates:{startDate:string;endDate:string},chartStartDate:string):Promise<TikTokOverview>{
  const session=await createSession(env);
  const loadRows=async(startDate:string,endDate:string,dimensions:string[],metrics:string[]):Promise<McpRow[]>=>{
    const base={advertiser_id:input.advertiserId,store_ids:[input.storeId],dimensions,start_date:startDate,end_date:endDate};
    return pagedReport(env,session,{...base,metrics});
  };
  const summaryMetrics=['cost','orders','cost_per_order','gross_revenue','roi'];
  const currentRows=await loadRows(input.startDate,input.endDate,['campaign_id'],summaryMetrics);
  const previousRows=await loadRows(previousDates.startDate,previousDates.endDate,['campaign_id'],summaryMetrics);
  const current={cost:0,revenue:0,orders:0,clicks:0,impressions:0};
  const previous={cost:0,revenue:0,orders:0,clicks:0,impressions:0};
  for(const row of currentRows)addTikTok(current,row);
  for(const row of previousRows)addTikTok(previous,row);
  const dayCount=Math.max(1,Math.round((Date.parse(`${input.endDate}T00:00:00Z`)-Date.parse(`${chartStartDate}T00:00:00Z`))/86400000)+1);
  const bucketSize=Math.max(1,Math.ceil(dayCount/20));const daily:any[]=[];
  for(let start=chartStartDate;start<=input.endDate;){const candidateEnd=shiftDate(start,bucketSize-1),end=candidateEnd>input.endDate?input.endDate:candidateEnd;
    const metrics={cost:0,revenue:0,orders:0,clicks:0,impressions:0};
    const rows=await loadRows(start,end,['campaign_id'],summaryMetrics);for(const row of rows)addTikTok(metrics,row);
    daily.push({date:start,endDate:end,label:start===end?`${start.slice(8,10)}/${start.slice(5,7)}`:`${start.slice(8,10)}/${start.slice(5,7)}–${end.slice(8,10)}/${end.slice(5,7)}`,metrics});start=shiftDate(end,1);}
  const costSources={total:0,productCard:0,seller:0,affiliate:0,unclassified:0};
  costSources.unclassified=current.cost;costSources.total=current.cost;
  return{current:platformMetrics(current),previous:platformMetrics(previous),daily,costSources,
    diagnostics:{currentRows:currentRows.length,previousRows:previousRows.length,dailyQueries:daily.length}};
}

export async function loadAdsOverview(env:Env,input:any):Promise<any>{
  const key=stableKey('ads-overview-v9',{advertiserId:input.advertiserId,storeId:input.storeId,startDate:input.startDate,endDate:input.endDate});if(!input.forceRefresh){const cached=await cacheGet<any>(env,key);if(cached)return cached;}
  const previousDates=comparisonDates(input.startDate,input.endDate),chartStartDate=minimumChartStartDate(input.startDate,input.endDate);
  const [facebook,tiktok,tiktokTraffic]=await Promise.all([loadFacebookAdsReport(env,input),loadTikTokOverview(env,input,previousDates,chartStartDate),
    loadAdsTrafficTimeline(env,{...input,startDate:chartStartDate})]);
  const currentTraffic=(tiktokTraffic.points||[]).filter((point:any)=>point.key>=input.startDate&&point.key<=input.endDate)
    .reduce((sum:any,point:any)=>({clicks:sum.clicks+numberValue(point.metrics?.clicks),impressions:sum.impressions+numberValue(point.metrics?.impressions)}),{clicks:0,impressions:0});
  const facebookPlatform=platformMetrics(facebook.totals),tiktokPlatform=platformMetrics({...tiktok.current,...currentTraffic});
  const previousFacebook=platformMetrics(facebook.previousTotals),previousTiktok=tiktok.previous;
  const daily=tiktok.daily.map((day:any)=>({date:day.date,endDate:day.endDate,label:day.label,facebook:{cost:0,clicks:0,orders:0},
    tiktok:{cost:numberValue(day.metrics?.cost),clicks:0,orders:numberValue(day.metrics?.orders)}}));
  for(const point of tiktokTraffic.points||[]){const target=daily.find((day:any)=>point.key>=day.date&&point.key<=day.endDate);if(target)target.tiktok.clicks+=numberValue(point.metrics?.clicks);}
  for(const day of facebook.daily){const target=daily.find((point:any)=>day.date>=point.date&&day.date<=point.endDate);if(target){target.facebook.cost+=day.metrics.spend;target.facebook.clicks+=day.metrics.clicks;target.facebook.orders+=day.metrics.orders;}}
  const result={startDate:input.startDate,endDate:input.endDate,chartStartDate,generatedAt:new Date().toISOString(),totals:totalPlatforms(facebookPlatform,tiktokPlatform),
    previousTotals:totalPlatforms(previousFacebook,previousTiktok),platforms:{facebook:facebookPlatform,tiktok:tiktokPlatform},daily,
    tiktokCostSources:tiktok.costSources,tiktokDiagnostics:tiktok.diagnostics,facebookResultCosts:facebook.resultCosts};
  await cachePut(env,key,result,input.endDate<new Date().toISOString().slice(0,10)?86400:300).catch(()=>undefined);return result;
}
