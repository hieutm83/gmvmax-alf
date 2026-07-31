import type { Env } from './types';
import { authorizedShop, shopRequest } from './seller';
import { loadAdsVideoMetrics } from './reports';
import { cacheGet, cachePut, dateInTimezone, numberValue, shiftDate, stableKey } from './utils';

export type CreatorType = 'SELLER' | 'KOC' | 'UNKNOWN';
type GroupTotals = { videoCount:number;gmv:number;adsSpend:number;views:number;clicks:number;impressions:number;adClicks:number;orders:number };
const SELLER_USERNAMES=new Set(['anlanhfarmvn','tracagaileoalf','anlanhherbs']);

function emptyTotals():GroupTotals{return{videoCount:0,gmv:0,adsSpend:0,views:0,clicks:0,impressions:0,adClicks:0,orders:0};}
function money(value:any):number{return numberValue(value?.amount??value);}
export function classifyCreatorType(value:any):CreatorType{
  const type=String(value||'').toUpperCase();
  if(type.includes('AFFILIATE'))return'KOC';
  if(type.includes('OFFICIAL')||type.includes('CHANNEL')||type.includes('MARKETING')||type.includes('SHOP'))return'SELLER';
  return'UNKNOWN';
}
function shopVideoCreatorType(video:any):CreatorType{
  const username=String(video?.creator?.user_name||video?.username||'').trim().toLowerCase().replace(/^@/,'');
  if(SELLER_USERNAMES.has(username))return'SELLER';
  const declared=classifyCreatorType(video?.creator?.author_type);
  return declared==='UNKNOWN'?classifyCreatorType(video?._accountType):declared;
}
function postDate(value:any):string|null{
  if(value==null||value==='')return null;
  if(/^\d{10,13}$/.test(String(value))){const milliseconds=String(value).length===10?Number(value)*1000:Number(value);return new Date(milliseconds).toISOString().slice(0,10);}
  const match=String(value).match(/^(\d{4}-\d{2}-\d{2})/);return match?match[1]:null;
}
function postDateFromItemId(itemId:any,timezone:string):string|null{
  try{const timestamp=Number(BigInt(String(itemId))>>32n);if(timestamp<1_500_000_000||timestamp>4_000_000_000)return null;return dateInTimezone(new Date(timestamp*1000),timezone);}catch{return null;}
}
function addTotals(target:GroupTotals,video:any):void{
  if(video.isPostedInRange)target.videoCount+=1;target.gmv+=numberValue(video.ads?.grossRevenue);target.adsSpend+=numberValue(video.ads?.cost);
  target.views+=numberValue(video.shop?.views);target.clicks+=numberValue(video.shop?.clicks)+numberValue(video.ads?.productClicks);
  target.impressions+=numberValue(video.ads?.productImpressions);target.adClicks+=numberValue(video.ads?.productClicks);
  target.orders+=numberValue(video.shop?.skuOrders||video.ads?.orders);
}
function adsCreatorType(metadata:any,ads:any):CreatorType{
  const username=String(metadata?.creator?.user_name||metadata?.username||ads?.accountUsername||'').trim().toLowerCase().replace(/^@/,'');
  if(SELLER_USERNAMES.has(username))return'SELLER';
  if(metadata)return shopVideoCreatorType(metadata);
  return classifyCreatorType(ads?.authorizationType);
}
export function calculateContentKocTotals(videos:any[]):{all:GroupTotals;seller:GroupTotals;koc:GroupTotals;unknown:GroupTotals}{
  const totals={all:emptyTotals(),seller:emptyTotals(),koc:emptyTotals(),unknown:emptyTotals()};
  for(const video of videos){addTotals(totals.all,video);addTotals(totals[video.creatorType==='SELLER'?'seller':video.creatorType==='KOC'?'koc':'unknown'],video);}
  return totals;
}

async function fetchShopVideos(env:Env,startDate:string,endDate:string):Promise<{available:boolean;videos:any[];latestAvailableDate:string|null} >{
  const shop=await authorizedShop(env);const cipher=String(shop?.cipher||shop?.shop_cipher||shop?.id||'');
  if(!cipher)return{available:false,videos:[],latestAvailableDate:null};
  const videoMap=new Map<string,any>();let latestAvailableDate:string|null=null;
  // Although the API reference documents ALL, this shop currently returns an empty
  // list for it. Explicit account types return the expected records.
  for(const accountType of ['OFFICIAL_ACCOUNTS','MARKETING_ACCOUNTS','AFFILIATE_ACCOUNTS']){
    let pageToken='';let pages=0;
    do{
      const data=await shopRequest(env,'/analytics/202605/shop_videos/performance','GET',{shop_cipher:cipher,start_date_ge:startDate,
        end_date_lt:shiftDate(endDate,1),page_size:100,sort_field:'gmv',sort_order:'DESC',currency:'LOCAL',account_type:accountType,page_token:pageToken||undefined});
      for(const video of Array.isArray(data.videos)?data.videos:[])if(video?.id)videoMap.set(String(video.id),{...video,_accountType:accountType});
      latestAvailableDate=String(data.latest_available_date||latestAvailableDate||'')||null;
      pageToken=String(data.next_page_token||'');pages+=1;
    }while(pageToken&&pages<100);
  }
  return{available:true,videos:Array.from(videoMap.values()),latestAvailableDate};
}

export async function loadContentKocAnalysis(env:Env,input:{advertiserId:string;storeId:string;startDate:string;endDate:string;forceRefresh?:boolean}):Promise<any>{
  const key=stableKey('content-koc-v15',{advertiserId:input.advertiserId,storeId:input.storeId,startDate:input.startDate,endDate:input.endDate});
  if(!input.forceRefresh){const cached=await cacheGet<any>(env,key);if(cached)return{...cached,cacheStatus:'HIT'};}
  const [shopResult,adsVideos]=await Promise.all([
    fetchShopVideos(env,input.startDate,input.endDate).catch(()=>({available:false,videos:[],latestAvailableDate:null})),
    loadAdsVideoMetrics(env,input,input.startDate,input.endDate)
  ]);
  // Shop Analytics is commonly delayed for the current day. Use a wider window only
  // as creator/product metadata so current-period Ads videos can still be classified;
  // never copy GMV/views from that historical window into the selected period.
  let metadataVideos:any[]=shopResult.videos;
  if(adsVideos.length&&input.startDate>shiftDate(input.endDate,-29)){
    const metadata=await fetchShopVideos(env,shiftDate(input.endDate,-29),input.endDate).catch(()=>null);
    if(metadata?.videos?.length)metadataVideos=metadata.videos;
  }
  const shopMetadataById=new Map(metadataVideos.map((video:any)=>[String(video.id||''),video]));
  const metadataMatchedAdsCount=adsVideos.filter((video:any)=>shopMetadataById.has(String(video.itemId))).length;
  const adsById=new Map(adsVideos.map((video:any)=>[String(video.itemId),video]));const videos:any[]=[];
  for(const raw of shopResult.videos){
    const itemId=String(raw.id||'');if(!itemId)continue;const ads:any=adsById.get(itemId);adsById.delete(itemId);
    const ctr=raw.click_through_rate==null?null:numberValue(raw.click_through_rate);const views=numberValue(raw.views);
    const products=(raw.products||[]).map((product:any)=>({id:String(product.id),name:String(product.name||product.id),imageUrl:''}));
    for(const product of ads?.products||[]){const existing=products.find((item:any)=>item.id===product.id);if(!existing)products.push(product);else if(!existing.imageUrl)existing.imageUrl=product.imageUrl||'';}
    const type=adsCreatorType(raw,ads);
    const postedDate=postDate(raw.video_post_time)||postDateFromItemId(itemId,env.TIMEZONE);videos.push({itemId,title:String(raw.title||ads?.title||`Video ${itemId}`),videoUrl:`https://www.tiktok.com/@${encodeURIComponent(String(raw.username||raw.creator?.user_name||ads?.accountUsername||''))}/video/${itemId}`,
      accountName:String(raw.creator?.nick_name||raw.username||ads?.accountName||''),accountUsername:String(raw.creator?.user_name||raw.username||ads?.accountUsername||''),creatorType:type,
      postTime:raw.video_post_time||null,isPostedInRange:Boolean(postedDate&&postedDate>=input.startDate&&postedDate<=input.endDate),products,shop:{gmv:money(raw.gmv),views,clicks:Math.round(views*(ctr||0)),ctr,skuOrders:numberValue(raw.sku_orders),itemsSold:numberValue(raw.items_sold)},
      ads:ads?{cost:ads.cost,orders:ads.orders,grossRevenue:ads.grossRevenue,productClicks:ads.productClicks,productImpressions:ads.productImpressions,
        viewRate2s:ads.viewRate2s,viewRate6s:ads.viewRate6s,viewRate25:ads.viewRate25,viewRate50:ads.viewRate50,viewRate75:ads.viewRate75,viewRate100:ads.viewRate100,
        timeline:ads.timeline||{},campaignId:ads.campaigns?.[0]?.campaignId||'',campaignName:ads.campaigns?.[0]?.campaignName||''}:null,
      roi:numberValue(ads?.cost)?numberValue(ads.grossRevenue)/numberValue(ads.cost):null});
  }
  for(const ads of adsById.values() as Iterable<any>){const metadata:any=shopMetadataById.get(String(ads.itemId));const adsProducts=ads.products||[];const metadataProducts=(metadata?.products||[]).map((product:any)=>{const adsProduct=adsProducts.find((item:any)=>String(item.id)===String(product.id));return{id:String(product.id),name:String(product.name||adsProduct?.name||product.id),imageUrl:adsProduct?.imageUrl||''};});
    const products=metadataProducts.length?metadataProducts:adsProducts;const postedDate=postDate(metadata?.video_post_time)||postDateFromItemId(ads.itemId,env.TIMEZONE);videos.push({itemId:String(ads.itemId),title:ads.title||metadata?.title,videoUrl:`https://www.tiktok.com/player/v1/${ads.itemId}`,
    accountName:metadata?.creator?.nick_name||metadata?.username||ads.accountName||ads.accountUsername||'',accountUsername:metadata?.creator?.user_name||metadata?.username||ads.accountUsername||'',creatorType:adsCreatorType(metadata,ads),postTime:metadata?.video_post_time||null,isPostedInRange:Boolean(postedDate&&postedDate>=input.startDate&&postedDate<=input.endDate),products,shop:null,
    ads:{cost:ads.cost,orders:ads.orders,grossRevenue:ads.grossRevenue,productClicks:ads.productClicks,productImpressions:ads.productImpressions,
      viewRate2s:ads.viewRate2s,viewRate6s:ads.viewRate6s,viewRate25:ads.viewRate25,viewRate50:ads.viewRate50,viewRate75:ads.viewRate75,viewRate100:ads.viewRate100,
      timeline:ads.timeline||{},campaignId:ads.campaigns?.[0]?.campaignId||'',campaignName:ads.campaigns?.[0]?.campaignName||''},roi:numberValue(ads.cost)?numberValue(ads.grossRevenue)/numberValue(ads.cost):null});
  }

  const totals=calculateContentKocTotals(videos);
  const productMap=new Map<string,any>();
  for(const video of videos.filter(video=>video.creatorType!=='UNKNOWN')){
    const product=video.products[0];if(!product)continue;const row=productMap.get(product.id)||{productId:product.id,productName:product.name,productImageUrl:product.imageUrl||'',seller:emptyTotals(),koc:emptyTotals()};
    if(!row.productImageUrl&&product.imageUrl)row.productImageUrl=product.imageUrl;
    addTotals(row[video.creatorType==='SELLER'?'seller':'koc'],video);productMap.set(product.id,row);
  }
  const hasProductMetrics=(group:GroupTotals)=>numberValue(group.videoCount)||numberValue(group.gmv)||numberValue(group.adsSpend)||numberValue(group.impressions)||numberValue(group.adClicks);
  const byProduct=Array.from(productMap.values()).filter(row=>hasProductMetrics(row.seller)||hasProductMetrics(row.koc))
    .sort((a,b)=>(b.seller.gmv+b.koc.gmv)-(a.seller.gmv+a.koc.gmv));
  const granularity=input.startDate===input.endDate?'hour':'day';const points=new Map<string,any>();
  const ensurePoint=(key:string)=>{const normalized=granularity==='hour'?key.padStart(2,'0'):key;let point=points.get(normalized);
    if(!point){point={key:normalized,label:granularity==='hour'?`${normalized}:00`:`${normalized.slice(8,10)}/${normalized.slice(5,7)}`,seller:{gmv:0,clicks:0},koc:{gmv:0,clicks:0}};points.set(normalized,point);}return point;};
  if(granularity==='hour')for(let hour=0;hour<24;hour++)ensurePoint(String(hour));
  else for(let date=input.startDate;date<=input.endDate;date=shiftDate(date,1))ensurePoint(date);
  for(const video of videos){if(video.creatorType==='UNKNOWN')continue;const group=video.creatorType==='SELLER'?'seller':'koc';
    for(const [key,metric] of Object.entries<any>(video.ads?.timeline||{})){const point=ensurePoint(key);point[group].gmv+=numberValue(metric.grossRevenue);point[group].clicks+=numberValue(metric.productClicks);}}
  const timelineValues=Array.from(points.values());const hasDetailedTimeline=timelineValues.some(point=>point.seller.gmv||point.koc.gmv||point.seller.clicks||point.koc.clicks);
  if(!hasDetailedTimeline){const knownGmv=totals.seller.gmv+totals.koc.gmv,knownClicks=totals.seller.adClicks+totals.koc.adClicks;
    const sellerGmvShare=knownGmv?totals.seller.gmv/knownGmv:0,sellerClickShare=knownClicks?totals.seller.adClicks/knownClicks:0;
    let fallbackTimeline:any[]=((adsVideos as any).overallTimeline||[]).filter((metric:any)=>numberValue(metric.grossRevenue)||numberValue(metric.productClicks));
    if(granularity==='hour'&&!fallbackTimeline.length){const rows=await env.DB.prepare('SELECT report_hour,metrics_json FROM hourly_metrics WHERE advertiser_id=? AND store_id=? AND report_date=? ORDER BY report_hour')
      .bind(input.advertiserId,input.storeId,input.startDate).all<any>();const snapshots=(rows.results||[]).map(row=>({key:String(Math.max(0,numberValue(row.report_hour)-1)).padStart(2,'0'),...JSON.parse(String(row.metrics_json||'{}'))}));
      const snapshotCost=snapshots.reduce((sum,row)=>sum+numberValue(row.cost),0),snapshotGmv=snapshots.reduce((sum,row)=>sum+numberValue(row.grossRevenue),0);
      fallbackTimeline=snapshots.map(row=>({...row,grossRevenue:snapshotGmv?knownGmv*numberValue(row.grossRevenue)/snapshotGmv:0,productClicks:snapshotCost?knownClicks*numberValue(row.cost)/snapshotCost:0}));}
    for(const metric of fallbackTimeline){const point=ensurePoint(String(metric.key));point.seller.gmv=numberValue(metric.grossRevenue)*sellerGmvShare;point.koc.gmv=numberValue(metric.grossRevenue)-point.seller.gmv;
      point.seller.clicks=numberValue(metric.productClicks)*sellerClickShare;point.koc.clicks=numberValue(metric.productClicks)-point.seller.clicks;}}
  const timeSeries={granularity,points:Array.from(points.values()).sort((a,b)=>a.key.localeCompare(b.key))};
  const orderVideos=videos.filter(video=>numberValue(video.ads?.orders)>0);
  const result={advertiserId:input.advertiserId,storeId:input.storeId,startDate:input.startDate,endDate:input.endDate,generatedAt:new Date().toISOString(),
    totals,byProduct,videos:orderVideos,timeSeries,shopAnalyticsAvailable:shopResult.available,shopLatestAvailableDate:shopResult.latestAvailableDate,
    diagnostics:{shopPeriodVideos:shopResult.videos.length,shopMetadataVideos:metadataVideos.length,metadataMatchedAdsCount,
      adsAuthorizationTypes:Array.from(new Set(adsVideos.map((video:any)=>String(video.authorizationType||'')).filter(Boolean))),
      shopAuthorTypes:Array.from(new Set(metadataVideos.map((video:any)=>String(video.creator?.author_type||'')).filter(Boolean))),
      shopAccountTypes:Array.from(new Set(metadataVideos.map((video:any)=>String(video._accountType||'')).filter(Boolean)))},cacheStatus:'REFRESHED'};
  await cachePut(env,key,result,300).catch(()=>undefined);return result;
}
