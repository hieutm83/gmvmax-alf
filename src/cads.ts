import type { Env, McpRow, McpSession } from './types';
import { cacheGet, cachePut, numberValue, stableKey } from './utils';
import { callTool, createSession } from './mcp';

type CAdsMetrics = {
  spend:number; impressions:number; clicks:number; orders:number; videoPlays:number;
  watched2s:number; watched6s:number; watched100:number; ctr:number; cpm:number;
  rate2s:number; rate6s:number; costPerView:number;
};

function emptyMetrics():CAdsMetrics{return {spend:0,impressions:0,clicks:0,orders:0,videoPlays:0,
  watched2s:0,watched6s:0,watched100:0,ctr:0,cpm:0,rate2s:0,rate6s:0,costPerView:0};}
function normalized(raw:Record<string,unknown>):CAdsMetrics{return {...emptyMetrics(),spend:numberValue(raw.spend),
  impressions:numberValue(raw.impressions),clicks:numberValue(raw.clicks),orders:numberValue(raw.conversion??raw.conversions),
  videoPlays:numberValue(raw.video_play_actions),watched2s:numberValue(raw.video_watched_2s),
  watched6s:numberValue(raw.video_watched_6s),watched100:numberValue(raw.video_views_p100??raw.video_watched_p100)};}
function add(target:CAdsMetrics,value:CAdsMetrics):void{for(const key of ['spend','impressions','clicks','orders','videoPlays','watched2s','watched6s','watched100'] as const)target[key]+=value[key];}
function finish(value:CAdsMetrics):CAdsMetrics{value.ctr=value.impressions?value.clicks/value.impressions:0;
  value.cpm=value.impressions?value.spend*1000/value.impressions:0;value.rate2s=value.impressions?value.watched2s/value.impressions:0;
  value.rate6s=value.impressions?value.watched6s/value.impressions:0;value.costPerView=value.videoPlays?value.spend/value.videoPlays:0;return value;}
function rowId(row:McpRow,key:string):string{return String(row.dimensions?.[key]??row.metrics?.[key]??'');}
function reportHour(row:McpRow):number|null{const value=rowId(row,'stat_time_hour');const match=value.match(/(?:T|\s)(\d{1,2})(?::|$)/)||value.match(/^(\d{1,2})(?::|$)/);if(!match)return null;const hour=Number(match[1]);return hour>=0&&hour<24?hour:null;}

async function integratedRows(env:Env,session:McpSession,args:Record<string,unknown>):Promise<McpRow[]>{
  const rows:McpRow[]=[];let page=1,pages=1;
  do{const data=await callTool(env,session,'report_integrated_get',{...args,page,page_size:1000});rows.push(...(data.list||data.data_list||[]));pages=Number(data.page_info?.total_page)||1;page+=1;}while(page<=pages);
  return rows;
}

async function performanceRows(env:Env,session:McpSession,advertiserId:string,startDate:string,endDate:string):Promise<McpRow[]>{
  const base={advertiser_id:advertiserId,report_type:'BASIC',data_level:'AUCTION_AD',dimensions:['ad_id','stat_time_hour'],start_date:startDate,end_date:endDate};
  try{return await integratedRows(env,session,{...base,metrics:['spend','impressions','clicks','conversion','video_play_actions','video_watched_2s','video_watched_6s','video_views_p100']});}
  catch(error){if(!/metric|dimension|invalid|not supported/i.test(String(error)))throw error;
    return integratedRows(env,session,{...base,metrics:['spend','impressions','clicks','conversion']});}
}

async function adMetadata(env:Env,session:McpSession,advertiserId:string,ids:string[]):Promise<Record<string,any>>{
  const result:Record<string,any>={};
  for(let offset=0;offset<ids.length;offset+=100){try{const data=await callTool(env,session,'ad_get',{advertiser_id:advertiserId,filtering:{ad_ids:ids.slice(offset,offset+100)},page:1,page_size:100});
    for(const ad of data.list||data.ads||[]){const id=String(ad.ad_id||ad.id||'');if(id)result[id]=ad;}}catch{/* Performance data remains usable when ad metadata is unavailable. */}}
  return result;
}
function productName(ad:any):string{if(!ad||!Object.keys(ad).length)return 'Chưa xác định';const name=ad.product_name||ad.item_name||ad.catalog_name;if(name)return String(name);
  const id=ad.product_id||ad.item_id||(Array.isArray(ad.product_ids)?ad.product_ids[0]:null);return id?`Sản phẩm ${id}`:'Không gắn giỏ';}
function productCode(ad:any):string{return String(ad?.product_id||ad?.item_id||(Array.isArray(ad?.product_ids)?ad.product_ids[0]:null)||'—');}
function channel(ad:any):string{return /AUTH|CREATOR|BC/.test(String(ad?.identity_type||ad?.identity_authorized_bc_id||'').toUpperCase())?'Liên kết':'Người bán';}
function running(status:string):boolean{return /ENABLE|ACTIVE|DELIVER/.test(status.toUpperCase())&&!/DISABLE|INACTIVE|NOT_DELIVER/.test(status.toUpperCase());}

export async function loadCAdsReport(env:Env,input:any):Promise<any>{
  const cacheKey=stableKey('cads-v1',{advertiserId:input.advertiserId,startDate:input.startDate,endDate:input.endDate});
  if(!input.forceRefresh){const hit=await cacheGet<any>(env,cacheKey);if(hit)return hit;}
  const session=await createSession(env);const rows=await performanceRows(env,session,input.advertiserId,input.startDate,input.endDate);
  const totals=emptyMetrics(),hourly=Array.from({length:24},(_,hour)=>({hour,metrics:emptyMetrics()}));const byAd=new Map<string,CAdsMetrics>();
  for(const row of rows){const values=normalized(row.metrics||{});add(totals,values);const hour=reportHour(row);if(hour!==null)add(hourly[hour].metrics,values);
    const id=rowId(row,'ad_id');if(id){if(!byAd.has(id))byAd.set(id,emptyMetrics());add(byAd.get(id)!,values);}}
  finish(totals);hourly.forEach((point)=>finish(point.metrics));const metadata=await adMetadata(env,session,input.advertiserId,[...byAd.keys()]);
  const videos=[...byAd.entries()].map(([adId,metrics])=>{const ad=metadata[adId]||{};const product=productName(ad);const status=String(ad.operation_status||ad.secondary_status||ad.status||'');return {adId,
    name:String(ad.ad_name||ad.name||`Ad ${adId}`),productName:product,productCode:productCode(ad),channel:channel(ad),startDate:String(ad.create_time||ad.create_time_utc||input.startDate).slice(0,10),
    status,note:product==='Không gắn giỏ'?'Video branding/reach':'',metrics:finish(metrics)};}).sort((a,b)=>b.metrics.spend-a.metrics.spend);
  const channels=['Người bán','Liên kết'].map((name)=>{const items=videos.filter((video)=>video.channel===name);const spend=items.reduce((sum,item)=>sum+item.metrics.spend,0);const impressions=items.reduce((sum,item)=>sum+item.metrics.impressions,0);
    return {channel:name,running:items.filter((item)=>running(item.status)).length,spend,cpm:impressions?spend*1000/impressions:0};});
  const grouped=new Map<string,any>();for(const video of videos){const key=`${video.productName}|${video.productCode}|${video.channel}`;if(!grouped.has(key))grouped.set(key,{productName:video.productName,productCode:video.productCode,channel:video.channel,totalVideos:0,eligibleVideos:0,runningVideos:0,remainingVideos:0,newThisWeek:0,priority:'',note:video.productName==='Không gắn giỏ'?'Video nhận diện, không thúc bán trực tiếp':''});
    const item=grouped.get(key);item.totalVideos+=1;if(!/REJECT|DISABLE|DELETE/.test(video.status.toUpperCase()))item.eligibleVideos+=1;if(running(video.status))item.runningVideos+=1;}
  const inventory=[...grouped.values()].map((item)=>({...item,remainingVideos:Math.max(0,item.eligibleVideos-item.runningVideos)}));
  const result={advertiserId:input.advertiserId,startDate:input.startDate,endDate:input.endDate,generatedAt:new Date().toISOString(),totals,hourly,channels,inventory,videos};
  await cachePut(env,cacheKey,result,240);return result;
}
