import type { Env, McpRow, McpSession } from './types';
import { cacheGet, cachePut, numberValue, shiftDate, stableKey } from './utils';
import { callTool, createSession } from './mcp';
import { fetchShopVideos } from './content-koc';
import { loadAdsVideoMetrics } from './reports';

type CAdsMetrics = {
  spend:number; impressions:number; clicks:number; orders:number; videoPlays:number;
  watched2s:number; watched6s:number; watched100:number; ctr:number; cpm:number;
  rate2s:number; rate6s:number; costPerView:number;
};
type ProductRef = { id:string; name:string };

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
function pointKey(row:McpRow,dimension:string):string{const raw=rowId(row,dimension);if(dimension==='stat_time_day')return raw.slice(0,10);
  const match=raw.match(/(?:T|\s)(\d{1,2})(?::|$)/)||raw.match(/^(\d{1,2})(?::|$)/);return match?String(Number(match[1])).padStart(2,'0'):'';}

async function integratedRows(env:Env,session:McpSession,args:Record<string,unknown>):Promise<McpRow[]>{
  const rows:McpRow[]=[];let page=1,pages=1;
  do{const data=await callTool(env,session,'report_integrated_get',{...args,page,page_size:1000});rows.push(...(data.list||data.data_list||[]));pages=Number(data.page_info?.total_page)||1;page+=1;}while(page<=pages);
  return rows;
}

async function performanceRows(env:Env,session:McpSession,advertiserId:string,startDate:string,endDate:string):Promise<{rows:McpRow[];dimension:string}>{
  const dimension=startDate===endDate?'stat_time_hour':'stat_time_day';
  const base={advertiser_id:advertiserId,report_type:'BASIC',data_level:'AUCTION_AD',dimensions:['ad_id',dimension],start_date:startDate,end_date:endDate};
  try{return {rows:await integratedRows(env,session,{...base,metrics:['spend','impressions','clicks','conversion','video_play_actions','video_watched_2s','video_watched_6s','video_views_p100']}),dimension};}
  catch(error){if(!/metric|dimension|invalid|not supported/i.test(String(error)))throw error;
    return {rows:await integratedRows(env,session,{...base,metrics:['spend','impressions','clicks','conversion']}),dimension};}
}

async function adMetadata(env:Env,session:McpSession,advertiserId:string,ids:string[]):Promise<Record<string,any>>{
  const result:Record<string,any>={};const fields=['ad_id','ad_name','adgroup_id','operation_status','secondary_status','creative_type','identity_type','identity_id','tiktok_item_id','video_id','image_ids','landing_page_url','display_name','product_set_id','catalog_id'];
  for(let offset=0;offset<ids.length;offset+=100){const args={advertiser_id:advertiserId,filtering:{ad_ids:ids.slice(offset,offset+100)},page:1,page_size:100};
    let data:any;try{data=await callTool(env,session,'ad_get',{...args,fields});}catch{try{data=await callTool(env,session,'ad_get',args);}catch{continue;}}
    for(const ad of data.list||data.ads||[]){const id=String(ad.ad_id||ad.id||'');if(id)result[id]=ad;}}
  return result;
}

function videoId(ad:any):string{
  for(const key of ['tiktok_item_id','video_post_id','post_id','spark_ad_post_id','video_id','item_id']){const value=String(ad?.[key]||'');if(/^\d{15,24}$/.test(value))return value;}
  const stack:any[]=[ad];while(stack.length){const value=stack.pop();if(typeof value==='string'){const match=value.match(/(?:video\/|item_id[=:])([0-9]{15,24})/i);if(match)return match[1];}
    else if(Array.isArray(value))stack.push(...value);else if(value&&typeof value==='object')stack.push(...Object.values(value));}
  return '';
}
function adsProducts(ad:any):ProductRef[]{
  const products=new Map<string,ProductRef>();const addProduct=(id:any,name:any)=>{const code=String(id||'');if(!/^\d+$/.test(code))return;products.set(code,{id:code,name:String(name||`Sản phẩm ${code}`)});};
  const directIds=[ad?.product_id,ad?.shopping_ads_product_id,...(Array.isArray(ad?.product_ids)?ad.product_ids:[]),...(Array.isArray(ad?.item_group_ids)?ad.item_group_ids:[])];directIds.forEach((id)=>addProduct(id,''));
  for(const list of [ad?.products,ad?.product_list,ad?.product_info_list])for(const item of Array.isArray(list)?list:[])addProduct(item?.product_id||item?.item_id||item?.id,item?.product_name||item?.item_name||item?.name);
  return [...products.values()];
}
function shopProducts(video:any):ProductRef[]{return (Array.isArray(video?.products)?video.products:[]).map((product:any)=>({id:String(product.id||product.product_id||''),name:String(product.name||product.title||product.product_name||product.id||'')})).filter((product:ProductRef)=>product.id);}
function conciseName(ad:any,adId:string):string{const candidates=[ad?.ad_name,ad?.creative_name,ad?.display_name,ad?.name,ad?.video_name].map((value)=>String(value||'').trim()).filter(Boolean);
  const readable=candidates.find((value)=>!/^https?:\/\//i.test(value));if(readable)return readable.length>90?`${readable.slice(0,87)}…`:readable;return `Quảng cáo ${adId.slice(-8)}`;}
function embeddedVideoUrl(ad:any):string{const stack:any[]=[ad];while(stack.length){const value=stack.pop();if(typeof value==='string'){const match=value.match(/https?:\/\/(?:www\.)?tiktok\.com\/[^\s"']+\/video\/\d+/i);if(match)return match[0];}
  else if(Array.isArray(value))stack.push(...value);else if(value&&typeof value==='object')stack.push(...Object.values(value));}return '';}
function tiktokVideoUrl(ad:any,shopVideo:any,linkedVideoId:string):string{const embedded=embeddedVideoUrl(ad);if(embedded)return embedded;if(!linkedVideoId)return '';
  const username=String(shopVideo?.creator?.user_name||shopVideo?.username||'').replace(/^@/,'');return username?`https://www.tiktok.com/@${encodeURIComponent(username)}/video/${linkedVideoId}`:`https://www.tiktok.com/player/v1/${linkedVideoId}`;}
function adStartTime(value:any,fallback:string):string{const raw=String(value||'').trim();if(/^\d{10,13}$/.test(raw)){const milliseconds=raw.length===10?Number(raw)*1000:Number(raw);return new Date(milliseconds).toISOString();}return raw||fallback;}
function channel(ad:any,shopVideo:any):string{const value=String(shopVideo?._accountType||shopVideo?.creator?.author_type||ad?.identity_type||ad?.identity_authorized_bc_id||'').toUpperCase();return /AFFILIATE|AUTH|CREATOR|BC/.test(value)?'Liên kết':'Người bán';}
function running(status:string):boolean{return /ENABLE|ACTIVE|DELIVER/.test(status.toUpperCase())&&!/DISABLE|INACTIVE|NOT_DELIVER/.test(status.toUpperCase());}
function seriesPoints(startDate:string,endDate:string,dimension:string):Array<{key:string;label:string;metrics:CAdsMetrics}>{const points=[];
  if(dimension==='stat_time_hour'){for(let hour=0;hour<24;hour++){const key=String(hour).padStart(2,'0');points.push({key,label:`${key}:00`,metrics:emptyMetrics()});}}
  else for(let date=startDate;date<=endDate;date=shiftDate(date,1))points.push({key:date,label:`${date.slice(8,10)}/${date.slice(5,7)}`,metrics:emptyMetrics()});return points;}

export async function loadCAdsReport(env:Env,input:any):Promise<any>{
  const cacheKey=stableKey('cads-v4',{advertiserId:input.advertiserId,storeId:input.storeId,startDate:input.startDate,endDate:input.endDate});
  if(!input.forceRefresh){const hit=await cacheGet<any>(env,cacheKey);if(hit)return hit;}
  const session=await createSession(env);const performance=await performanceRows(env,session,input.advertiserId,input.startDate,input.endDate);
  const totals=emptyMetrics(),points=seriesPoints(input.startDate,input.endDate,performance.dimension),byPoint=new Map(points.map((point)=>[point.key,point.metrics]));const byAd=new Map<string,CAdsMetrics>();
  for(const row of performance.rows){const values=normalized(row.metrics||{});add(totals,values);const key=pointKey(row,performance.dimension);const point=byPoint.get(key);if(point)add(point,values);
    const id=rowId(row,'ad_id');if(id){if(!byAd.has(id))byAd.set(id,emptyMetrics());add(byAd.get(id)!,values);}}
  finish(totals);points.forEach((point)=>finish(point.metrics));const metadata=await adMetadata(env,session,input.advertiserId,[...byAd.keys()]);
  const metadataStart=input.startDate<shiftDate(input.endDate,-29)?input.startDate:shiftDate(input.endDate,-29);
  const [shopResult,gmvVideos]=await Promise.all([
    fetchShopVideos(env,metadataStart,input.endDate).catch(()=>({available:false,videos:[],latestAvailableDate:null})),
    loadAdsVideoMetrics(env,input,input.startDate,input.endDate).catch(()=>[])
  ]);
  const shopByVideoId=new Map((shopResult.videos||[]).map((video:any)=>[String(video.id||''),video]));
  const gmvByVideoId=new Map((gmvVideos||[]).map((video:any)=>[String(video.itemId||''),video]));
  const videos=[...byAd.entries()].map(([adId,metrics])=>{const ad=metadata[adId]||{};const linkedVideoId=videoId(ad);const shopVideo=shopByVideoId.get(linkedVideoId);const gmvVideo:any=gmvByVideoId.get(linkedVideoId);const shopProductList=shopProducts(shopVideo);const products=shopProductList.length?shopProductList:(adsProducts(ad).length?adsProducts(ad):(gmvVideo?.products||[]));const product=products[0]||null;
    const productLabel=product?.name||(shopVideo?'Không gắn giỏ':'Chưa xác định');const status=String(ad.operation_status||ad.secondary_status||ad.status||'');return {adId,videoId:linkedVideoId,name:String(shopVideo?.title||conciseName(ad,adId)),videoUrl:tiktokVideoUrl(ad,shopVideo,linkedVideoId),productName:productLabel,productCode:product?.id||'—',
      channel:channel(ad,shopVideo),startTime:adStartTime(ad.create_time||ad.create_time_utc,input.startDate),status,note:product?'':(shopVideo?'Video branding/reach':'Chưa tìm thấy liên kết sản phẩm trong Ads MCP hoặc TikTok Shop'),metrics:finish(metrics),gmvMax:{cost:numberValue(gmvVideo?.cost),orders:numberValue(gmvVideo?.orders),costPerOrder:numberValue(gmvVideo?.orders)?numberValue(gmvVideo?.cost)/numberValue(gmvVideo?.orders):null,grossRevenue:numberValue(gmvVideo?.grossRevenue),click:numberValue(gmvVideo?.productClicks),roi:numberValue(gmvVideo?.cost)?numberValue(gmvVideo?.grossRevenue)/numberValue(gmvVideo?.cost):null}};}).sort((a,b)=>b.metrics.spend-a.metrics.spend);
  const channels=['Người bán','Liên kết'].map((name)=>{const items=videos.filter((video)=>video.channel===name);const spend=items.reduce((sum,item)=>sum+item.metrics.spend,0);const impressions=items.reduce((sum,item)=>sum+item.metrics.impressions,0);
    return {channel:name,running:items.filter((item)=>running(item.status)).length,spend,cpm:impressions?spend*1000/impressions:0};});
  const grouped=new Map<string,any>();for(const video of videos){const key=`${video.productName}|${video.productCode}|${video.channel}`;if(!grouped.has(key))grouped.set(key,{productName:video.productName,productCode:video.productCode,channel:video.channel,totalVideos:0,eligibleVideos:0,runningVideos:0,remainingVideos:0,newThisWeek:0,priority:'',note:video.note});
    const item=grouped.get(key);item.totalVideos+=1;if(!/REJECT|DISABLE|DELETE/.test(video.status.toUpperCase()))item.eligibleVideos+=1;if(running(video.status))item.runningVideos+=1;}
  const inventory=[...grouped.values()].map((item)=>({...item,remainingVideos:Math.max(0,item.eligibleVideos-item.runningVideos)}));
  const result={advertiserId:input.advertiserId,startDate:input.startDate,endDate:input.endDate,generatedAt:new Date().toISOString(),totals,
    timeSeries:{granularity:performance.dimension==='stat_time_hour'?'hour':'day',points},channels,inventory,videos,
    diagnostics:{adsMetadataCount:Object.keys(metadata).length,shopAvailable:shopResult.available,shopVideoCount:shopResult.videos.length,shopMatchedCount:videos.filter((video)=>video.videoId&&shopByVideoId.has(video.videoId)).length}};
  await cachePut(env,cacheKey,result,240);return result;
}
