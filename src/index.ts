import type { Env, TaskMessage } from './types';
import { OAuthCoordinator, createAuthorizationUrl, disconnect, getAccessToken, handleOAuthCallback, keepAccessTokenFresh,
  oauthConnectionState, readTokens, refreshAccessToken } from './oauth';
import { createSession, listAdvertisers, listStores, resolveDefaultStoreId } from './mcp';
import { loadComparison, loadCreativeSummaries, loadMainReport, loadProductVideos, loadVideoMetadata, loadVideoStats, refreshTikTokDailySnapshot } from './reports';
import { backupDate } from './sheets';
import { createSellerAuthorizationUrl, disconnectSeller, handleSellerOAuthCallback, loadSellerRevenueAnalysis, loadShopSourceRows, sellerOAuthState } from './seller';
import { loadOperationsAnalysis, syncTrackingOrder } from './operations';
import { loadFinanceAnalysis, loadFinancePeriodSummary, loadSkuUnitCosts, saveSkuUnitCost } from './finance';
import { loadContentKocAnalysis } from './content-koc';
import { loadProductAnalysis } from './product-analysis';
import { loadKocAnalysis } from './koc-analysis';
import { loadCustomerServiceAnalysis } from './customer-service';
import { loadCAdsReport } from './cads';
import { loadTikTokAdsTraffic } from './tiktok-ads-api';
import { loadAdsOverview, loadFacebookAdsReport } from './facebook';
import { syncSupabaseBackup } from './supabase-backup';
import { extractDirectVideoId, extractZaloUpdates, finalizeZaloVideo, normalizeZaloEvent, processZaloVideo, processZaloVideoDay, recoverZaloVideoJobs, sendMessage, sendScheduledReport } from './zalo';
import { pollOperationsBot, prepareDailyOperationsReport, prepareMonthlyOperationsReport, prepareWeeklyOperationsReport, sendOperationsReport, sendWeeklyOperationsReport } from './operations-bot';
import { dueOrderBotSlots, monitorOrderBot, sendOrderBotReport } from './order-bot';
import { cacheGet, dateInTimezone, hourInTimezone, HttpError, json, numberValue, readJson, shiftDate, validateDate, validateId } from './utils';
import { assertDashboardApiAccess, assertDashboardLoginAllowed, clearDashboardLoginFailures, clearDashboardSessionCookie,
  createDashboardSession, dashboardRoleForPassword, dashboardSessionCookie, dashboardSessionFromRequest,
  recordDashboardLoginFailure, type DashboardRole, type DashboardSession } from './dashboard-auth';
import { bridgeRequest, gatewayRequest, realtimeProxyRequest, runtimeProviderEnv } from './realtime-bridge';

function ok(data: unknown): Response { return json({ ok: true, data }); }
function validateScope(input: any): any {
  return { ...input, advertiserId: validateId(input?.advertiserId, 'Advertiser ID'),
    storeId: String(input?.storeId || '').trim(), startDate: validateDate(input?.startDate, 'startDate'),
    endDate: validateDate(input?.endDate, 'endDate') };
}

async function validateAdsScope(env: Env, input: any): Promise<any> {
  const scope = validateScope(input);
  // The dashboard exposes the human-readable shop code, while GMV Max report
  // tools require the numeric store_id. Resolve the configured code at the API
  // boundary so every ads/product/video endpoint uses the same canonical ID.
  if (!scope.storeId || scope.storeId === env.DEFAULT_STORE_CODE) {
    scope.storeId = await resolveDefaultStoreId(env);
  }
  return scope;
}

function validateSellerScope(input: any): any {
  return {
    startDate: validateDate(input?.startDate, 'startDate'),
    endDate: validateDate(input?.endDate, 'endDate'),
    forceRefresh: input?.forceRefresh === true,
  };
}

async function routeApi(request: Request, env: Env, url: URL, session: DashboardSession): Promise<Response> {
  assertDashboardApiAccess(session.role, url.pathname, request.method);
  if (request.method === 'GET' && url.pathname === '/api/state') {
    const tokens=await readTokens(env);let advertisers:any[]=[];let connectionError:string|undefined;
    if(tokens){try{advertisers=await listAdvertisers(env,await createSession(env));}catch(error){connectionError=error instanceof Error?error.message:String(error);}}
    const today=dateInTimezone(new Date(),env.TIMEZONE);const startDate=session.role==='content'||session.role==='ads'?shiftDate(today,-6):today;
    return ok({connected:Boolean(tokens),startDate,endDate:today,
      adsOAuth:oauthConnectionState(tokens,env.MCP_SCOPE),
      sellerOAuth:await sellerOAuthState(env),
      dashboardRole:session.role,
      defaultAdvertiserId:env.DEFAULT_ADVERTISER_ID,defaultStoreCode:env.DEFAULT_STORE_CODE,advertisers,connectionError});
  }
  if(request.method==='GET'&&url.pathname==='/api/oauth/connect')return ok(await createAuthorizationUrl(env,url.origin));
  if(request.method==='GET'&&url.pathname==='/api/finance-sku-cost')return ok(await loadSkuUnitCosts(env));
  if(request.method==='GET'&&url.pathname==='/api/admin/supabase-sync'){const row=await env.DB.prepare("SELECT value,updated_at FROM app_settings WHERE key='SUPABASE_MANUAL_SYNC_STATUS'").first<any>();return ok({...(row?.value?JSON.parse(row.value):{status:'IDLE',progress:0}),updatedAt:row?.updated_at||null});}
  if(request.method==='POST'&&url.pathname==='/api/oauth/refresh')return ok(await refreshAccessToken(env));
  if(request.method==='POST'&&url.pathname==='/api/oauth/disconnect'){await disconnect(env);return ok(true);}
  if(request.method==='POST'&&url.pathname==='/api/seller/disconnect'){await disconnectSeller(env);return ok(true);}
  if(request.method==='POST'&&url.pathname==='/api/admin/verify'){const value=await readJson<any>(request);return ok(String(value||'')===env.ADMIN_PASSWORD);}
  if(request.method==='POST'&&url.pathname==='/api/admin/supabase-sync'){const value=await readJson<any>(request);const start=validateDate(value.startDate,'startDate'),end=validateDate(value.endDate,'endDate');if(start>end)throw new HttpError(400,'Khoảng ngày không hợp lệ.');const tables=Array.isArray(value.tables)?value.tables.map(String):['all'];await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({status:'QUEUED',startDate:start,endDate:end,progress:0,tables})).run();await env.TASK_QUEUE.send({type:'supabase-manual-sync',startDate:start,endDate:end,tables});return ok({queued:true});}
  if(request.method==='POST'&&url.pathname==='/api/stores'){const advertiserId=validateId(await readJson<any>(request),'Advertiser ID');return ok(await listStores(env,await createSession(env),advertiserId));}
  if(request.method!=='POST')throw new HttpError(405,'Method not allowed.');
  const rawInput=await readJson<any>(request);
  const contentEndDate=dateInTimezone(new Date(),env.TIMEZONE);
  const input=session.role==='content'?{...rawInput,startDate:shiftDate(contentEndDate,-6),endDate:contentEndDate}:rawInput;
  if(url.pathname==='/api/report'){
    const scope=await validateAdsScope(env,input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngay bat dau phai truoc ngay ket thuc.');
    const report=await loadMainReport(env,scope,input.forceRefresh===true);
    const today=dateInTimezone(new Date(),env.TIMEZONE);if(scope.startDate===scope.endDate&&scope.endDate<today){
      await env.DB.prepare(`INSERT INTO daily_metrics(advertiser_id,store_id,report_date,summary_json,products_json) VALUES(?,?,?,?,?)
        ON CONFLICT(advertiser_id,store_id,report_date) DO NOTHING`).bind(scope.advertiserId,scope.storeId,scope.endDate,JSON.stringify(report.totals),JSON.stringify(report.products)).run();
    }return ok(report);
  }
  if(url.pathname==='/api/revenue-analysis'){
    const scope=validateSellerScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngay bat dau phai truoc ngay ket thuc.');
    return ok(await loadSellerRevenueAnalysis(env,scope));
  }
  if(url.pathname==='/api/cads-report'){
    const scope=await validateAdsScope(env,input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadCAdsReport(env,{...scope,forceRefresh:input.forceRefresh===true}));
  }
  if(url.pathname==='/api/ads-traffic-timeline'){
    const scope=await validateAdsScope(env,input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadTikTokAdsTraffic(env,{...scope,forceRefresh:input.forceRefresh===true}));
  }
  if(url.pathname==='/api/facebook-ads'){
    const scope=validateSellerScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadFacebookAdsReport(env,scope));
  }
  if(url.pathname==='/api/ads-overview'){
    const scope=await validateAdsScope(env,input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadAdsOverview(env,{...scope,forceRefresh:input.forceRefresh===true}));
  }
  if(url.pathname==='/api/content-koc-analysis'){
    const scope=validateScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadContentKocAnalysis(env,{...scope,forceRefresh:input.forceRefresh===true}));
  }
  if(url.pathname==='/api/koc-analysis'){
    const scope=validateScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadKocAnalysis(env,scope));
  }
  if(url.pathname==='/api/product-analysis'){
    const scope=validateSellerScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadProductAnalysis(env,scope));
  }
  if(url.pathname==='/api/operations-analysis'){
    const scope=validateSellerScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadOperationsAnalysis(env,scope));
  }
  if(url.pathname==='/api/customer-service-analysis'){
    const scope=validateSellerScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadCustomerServiceAnalysis(env,scope));
  }
  if(url.pathname==='/api/finance-analysis'){
    const scope=validateSellerScope(input);if(scope.startDate>scope.endDate)throw new HttpError(400,'Ngày bắt đầu phải trước ngày kết thúc.');
    return ok(await loadFinanceAnalysis(env,scope));
  }
  if(url.pathname==='/api/finance-period-summary'){
    const baseScope=validateSellerScope(input);if(baseScope.startDate>baseScope.endDate)throw new HttpError(400,'NgÃ y báº¯t Ä‘áº§u pháº£i trÆ°á»›c ngÃ y káº¿t thÃºc.');
    const scope={...baseScope,
      statementStartDate:input.statementStartDate?validateDate(input.statementStartDate,'statementStartDate'):undefined,
      statementEndDate:input.statementEndDate?validateDate(input.statementEndDate,'statementEndDate'):undefined,
      includeUnsettled:input.includeUnsettled!==false};
    return ok(await loadFinancePeriodSummary(env,scope));
  }
  if(url.pathname==='/api/finance-sku-cost')return ok(await saveSkuUnitCost(env,input));
  if(url.pathname==='/api/product-videos')return ok(await loadProductVideos(env,await validateAdsScope(env,input)));
  if(url.pathname==='/api/creative-summaries')return ok(await loadCreativeSummaries(env,await validateAdsScope(env,input)));
  if(url.pathname==='/api/comparison')return ok(await loadComparison(env,await validateAdsScope(env,{...input,startDate:input.startDate||input.endDate})));
  if(url.pathname==='/api/video-stats'){const scope=await validateAdsScope(env,{...input,startDate:input.startDate||input.endDate});return ok(await loadVideoStats(env,{...scope,itemId:validateId(input.itemId,'Post ID')}));}
  if(url.pathname==='/api/video-metadata'){const scope=await validateAdsScope(env,{...input,startDate:input.startDate||input.endDate});return ok(await loadVideoMetadata(env,{...scope,itemId:validateId(input.itemId,'Post ID')}));}
  throw new HttpError(404,'API route not found.');
}

function zaloRuntime(env:Env):Env{return {...env,
  DEFAULT_ADVERTISER_ID:env.ZALO_ADVERTISER_ID||env.DEFAULT_ADVERTISER_ID,
  DEFAULT_STORE_CODE:env.ZALO_STORE_ID||env.ZALO_STORE_CODE||env.DEFAULT_STORE_CODE} as Env;}

async function processManualSupabaseSync(env:Env,message:Extract<TaskMessage,{type:'supabase-manual-sync'}>):Promise<void>{
 try{
  // Keep each queue invocation comfortably below the free-plan subrequest
  // ceiling; Shop Analytics may return multiple pages for a busy day.
  let chunkEnd=message.startDate;for(let i=1;i<7&&chunkEnd<message.endDate;i+=1)chunkEnd=shiftDate(chunkEnd,1);
  const total=Math.max(1,Math.round((Date.parse(message.endDate)-Date.parse(message.startDate))/86400000)+1),done=Math.max(0,Math.round((Date.parse(chunkEnd)-Date.parse(message.startDate)+86400000)/86400000));
  await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({status:'RUNNING',startDate:message.startDate,endDate:message.endDate,progress:Math.min(95,Math.round(done/total*95)),tables:message.tables})).run();
  // Keep a complete calendar in the daily replicas. Provider reports omit
  // zero-activity days, but the dashboard and Supabase history must retain
  // those dates so charts do not have gaps.
  await Promise.all([
   env.DB.prepare(`WITH RECURSIVE dates(d) AS (SELECT ? UNION ALL SELECT date(d,'+1 day') FROM dates WHERE d<?)
    INSERT OR IGNORE INTO tiktok_ads_daily(advertiser_id,store_id,report_date,payload_json,source)
    SELECT advertiser_id,store_id,d,'{}','backfill-missing' FROM (SELECT DISTINCT advertiser_id,store_id FROM tiktok_ads_daily) accounts CROSS JOIN dates`).bind(message.startDate,chunkEnd).run(),
   env.DB.prepare(`WITH RECURSIVE dates(d) AS (SELECT ? UNION ALL SELECT date(d,'+1 day') FROM dates WHERE d<?)
    INSERT OR IGNORE INTO facebook_ads_daily(ad_account_id,report_date,payload_json)
    SELECT ad_account_id,d,'{}' FROM (SELECT DISTINCT ad_account_id FROM facebook_ads_daily) accounts CROSS JOIN dates`).bind(message.startDate,chunkEnd).run()
  ]);
  const tiktokDailyRows = await refreshTikTokDailySnapshot(zaloRuntime(env), {
    advertiserId: env.DEFAULT_ADVERTISER_ID,
    storeId: env.ZALO_STORE_ID || env.DEFAULT_STORE_CODE,
    startDate: message.startDate, endDate: chunkEnd
  }).catch((error) => { console.warn('TikTok daily refresh skipped', String(error)); return 0; });
  const facebookDailyRows = await loadFacebookAdsReport(env, {
    startDate: message.startDate, endDate: chunkEnd, forceRefresh: true
  }).then((report) => Array.isArray(report?.daily) ? report.daily.length : 0)
    .catch((error) => { console.warn('Facebook daily refresh skipped', String(error)); return 0; });
  const sourceRows=await loadShopSourceRows(zaloRuntime(env),message.startDate,chunkEnd);
  for(const row of sourceRows)await env.DB.prepare(`INSERT INTO tiktok_ads_source_daily(advertiser_id,store_id,report_date,source,product_id,title,cost,gross_revenue,sku_orders,impressions,clicks,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(advertiser_id,store_id,report_date,source,product_id) DO UPDATE SET title=excluded.title,cost=excluded.cost,gross_revenue=excluded.gross_revenue,sku_orders=excluded.sku_orders,impressions=excluded.impressions,clicks=excluded.clicks,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP`).bind(row.advertiserId,row.storeId,String(row.reportDate).slice(0,10),row.source,row.productId,row.title,row.cost,row.grossRevenue,row.skuOrders,row.impressions,row.clicks,JSON.stringify(row.payload||{})).run();
  // Keep the Ads/BASIC impression and click values used by the Google Sheet.
  // Shop source traffic is only a fallback for rows where Ads returned zero.
  await env.DB.prepare(`UPDATE tiktok_ads_daily SET impressions=CASE WHEN COALESCE(impressions,0)=0 THEN (SELECT COALESCE(SUM(impressions),0) FROM tiktok_ads_source_daily s WHERE s.advertiser_id=tiktok_ads_daily.advertiser_id AND s.store_id=tiktok_ads_daily.store_id AND s.report_date=tiktok_ads_daily.report_date) ELSE impressions END, clicks=CASE WHEN COALESCE(clicks,0)=0 THEN (SELECT COALESCE(SUM(clicks),0) FROM tiktok_ads_source_daily s WHERE s.advertiser_id=tiktok_ads_daily.advertiser_id AND s.store_id=tiktok_ads_daily.store_id AND s.report_date=tiktok_ads_daily.report_date) ELSE clicks END, ctr=CASE WHEN impressions>0 THEN CAST(clicks AS REAL)/impressions ELSE 0 END, cr=CASE WHEN clicks>0 THEN CAST(sku_orders AS REAL)/clicks ELSE 0 END WHERE report_date BETWEEN ? AND ? AND EXISTS(SELECT 1 FROM tiktok_ads_source_daily s WHERE s.advertiser_id=tiktok_ads_daily.advertiser_id AND s.store_id=tiktok_ads_daily.store_id AND s.report_date=tiktok_ads_daily.report_date)`).bind(message.startDate,chunkEnd).run();
  // SQLite evaluates all SET expressions against the old row. Recompute
  // ratios in a second pass after impressions/clicks have been propagated.
  await env.DB.prepare(`UPDATE tiktok_ads_daily SET ctr=CASE WHEN impressions>0 THEN CAST(clicks AS REAL)/impressions ELSE 0 END, cr=CASE WHEN clicks>0 THEN CAST(sku_orders AS REAL)/clicks ELSE 0 END WHERE report_date BETWEEN ? AND ?`).bind(message.startDate,chunkEnd).run();
  const next=shiftDate(chunkEnd,1);if(next<=message.endDate){await env.TASK_QUEUE.send({type:'supabase-manual-sync',startDate:next,endDate:message.endDate,tables:message.tables});return;}
  await syncSupabaseBackup(env,message.endDate);const backup=await env.DB.prepare("SELECT value FROM app_settings WHERE key='SUPABASE_BACKUP_STATUS'").first<any>();const state=backup?.value?JSON.parse(backup.value):{};if(state.status!=='SUCCESS'||(state.tableErrors||[]).length)throw new Error('Supabase backup '+String(state.status||'FAILED')+': '+JSON.stringify(state.tableErrors||[]));
  await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({status:'SUCCESS',startDate:message.startDate,endDate:message.endDate,progress:100,tables:message.tables,sourceRows:sourceRows.length,tiktokDailyRows,facebookDailyRows})).run();
 }catch(error){
  await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({status:'FAILED',startDate:message.startDate,endDate:message.endDate,progress:100,tables:message.tables,error:String(error)})).run();
  throw error;
 }
}

async function webhook(request: Request, env: Env, url: URL, ctx:ExecutionContext): Promise<Response> {
  const storedSecret=await env.DB.prepare("SELECT value FROM app_settings WHERE key='ZALO_WEBHOOK_SECRET'").first<{value:string}>();
  const expectedSecret=storedSecret?.value||env.ZALO_WEBHOOK_SECRET;
  if(expectedSecret){const supplied=request.headers.get('x-webhook-secret')||url.searchParams.get('secret');
    const zaloSecret=request.headers.get('x-bot-api-secret-token');
    if(supplied!==expectedSecret&&zaloSecret!==expectedSecret)throw new HttpError(401,'Invalid webhook secret.');}
  const payload=await request.json<any>();const updates=extractZaloUpdates(payload);const event=normalizeZaloEvent(updates.at(-1)||payload);
  const result=await env.DB.prepare(`INSERT OR IGNORE INTO webhook_events(provider,external_id,received_at,payload,status) VALUES('zalo',?,?,?,'PENDING')`)
    .bind(event.id||null,Date.now(),JSON.stringify(payload)).run();
  if(result.meta.changes){const row=await env.DB.prepare('SELECT id FROM webhook_events WHERE provider=? AND external_id IS ? ORDER BY id DESC LIMIT 1').bind('zalo',event.id||null).first<{id:number}>();
    if(row)ctx.waitUntil((async()=>{
      const itemId=extractDirectVideoId(event.text);
      if(itemId&&!event.senderIsBot&&(!env.ZALO_GROUP_CHAT_ID||event.chatId===env.ZALO_GROUP_CHAT_ID)){
        try{
          await sendMessage(env,`Đang xử lý dữ liệu 30 ngày cho video ${itemId}...`,event.chatId);
          await env.DB.prepare("UPDATE webhook_events SET result_json=? WHERE id=? AND status='PENDING'")
            .bind(JSON.stringify({acknowledged:true,itemId}),row.id).run();
        }catch(error){console.error('Immediate Zalo acknowledgement failed',error instanceof Error?error.message:String(error));}
      }
      await env.ZALO_INBOX_QUEUE.send({type:'zalo-video',eventId:row.id},{delaySeconds:2});
      await env.DB.prepare("UPDATE webhook_events SET status='QUEUED' WHERE id=? AND status='PENDING'").bind(row.id).run();
    })());}
  return json({ok:true});
}

async function tiktokShopWebhook(request: Request, env: Env): Promise<Response> {
  if(request.method==='GET'||request.method==='HEAD'||request.method==='OPTIONS')return new Response(request.method==='HEAD'?null:'OK',{status:200});
  if(request.method!=='POST')throw new HttpError(405,'Method not allowed.');
  const payload=await request.json<any>().catch(()=>null);
  if(!payload)return new Response('OK',{status:200});
  if(payload.challenge)return json({challenge:payload.challenge});
  const externalId=String(payload.event_id||payload.id||payload.request_id||'').trim()||null;
  await env.DB.prepare(`INSERT OR IGNORE INTO webhook_events(provider,external_id,received_at,payload,status)
    VALUES('tiktok-shop',?,?,?,'RECEIVED')`).bind(externalId,Date.now(),JSON.stringify(payload)).run();
  return json({ok:true});
}

async function resolveDefaultStore(env:Env):Promise<string>{
  return resolveDefaultStoreId(env);
}

async function pollOperationsInbox(env:Env):Promise<void>{
  if(!env.ZALO_OPERATIONS_BOT_TOKEN||!env.ZALO_OPERATIONS_GROUP_CHAT_ID)return;
  const updates=await pollOperationsBot(env,25);
  const candidates=updates.filter((update)=>!update.senderIsBot&&update.chatId===env.ZALO_OPERATIONS_GROUP_CHAT_ID&&/\bcheck\b/i.test(update.text));
  const latest=candidates.sort((a,b)=>(a.timestamp-b.timestamp)||a.id.localeCompare(b.id)).at(-1);
  if(!latest)return;
  const inserted=await env.DB.prepare(`INSERT OR IGNORE INTO operations_bot_events(external_id,chat_id,received_at,status)
    VALUES(?,?,?,'QUEUED')`).bind(latest.id,latest.chatId,Date.now()).run();
  if(inserted.meta.changes)await env.TASK_QUEUE.send({type:'operations-daily-report',reportDate:dateInTimezone(new Date(),env.TIMEZONE),mode:'REALTIME',chatId:latest.chatId,eventId:latest.id});
}

async function consume(message: TaskMessage, env: Env): Promise<void> {
  const runtime=zaloRuntime(env);
  if(message.type==='tracking-sync')return syncTrackingOrder(env,message.orderId,message.shopCipher);
  if(message.type==='supabase-backup')return syncSupabaseBackup(env,message.reportDate);
  // Manual history sync is processed in bounded queue chunks.  Keeping this
  // dispatch before the legacy inline implementation avoids exceeding the
  // Worker subrequest limit on long date ranges.
  if(String(message.type)==='supabase-manual-sync')return processManualSupabaseSync(env,message as Extract<TaskMessage,{type:'supabase-manual-sync'}>);
  if(message.type==='supabase-manual-sync'){await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({status:'RUNNING',startDate:message.startDate,endDate:message.endDate,progress:10,tables:message.tables})).run();try{const sourceRows=await loadShopSourceRows(runtime,message.startDate,message.endDate);for(const row of sourceRows)await env.DB.prepare(`INSERT INTO tiktok_ads_source_daily(advertiser_id,store_id,report_date,source,product_id,title,cost,gross_revenue,sku_orders,impressions,clicks,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(advertiser_id,store_id,report_date,source,product_id) DO UPDATE SET title=excluded.title,cost=excluded.cost,gross_revenue=excluded.gross_revenue,sku_orders=excluded.sku_orders,impressions=excluded.impressions,clicks=excluded.clicks,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP`).bind(row.advertiserId,row.storeId,String(row.reportDate).slice(0,10),row.source,row.productId,row.title,row.cost,row.grossRevenue,row.skuOrders,row.impressions,row.clicks,JSON.stringify(row.payload||{})).run();await syncSupabaseBackup(env,message.endDate);const backup=await env.DB.prepare("SELECT value FROM app_settings WHERE key='SUPABASE_BACKUP_STATUS'").first<any>();const backupStatus=backup?.value?JSON.parse(backup.value):{};if(backupStatus.status!=='SUCCESS'||(backupStatus.tableErrors||[]).length)throw new Error('Supabase backup '+String(backupStatus.status||'FAILED')+': '+JSON.stringify(backupStatus.tableErrors||[]));await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({status:'SUCCESS',startDate:message.startDate,endDate:message.endDate,progress:100,tables:message.tables,sourceRows:sourceRows.length})).run();}catch(error){await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({status:'FAILED',startDate:message.startDate,endDate:message.endDate,progress:100,tables:message.tables,error:String(error)})).run();throw error;}return;}
  if(message.type==='ads-snapshot'){
    const storeId=await resolveDefaultStore(runtime);
    const input={advertiserId:runtime.DEFAULT_ADVERTISER_ID,storeId,startDate:message.reportDate,endDate:message.reportDate};
    const results=await Promise.allSettled([
      refreshTikTokDailySnapshot(runtime,input),
      loadFacebookAdsReport(runtime,{...input,forceRefresh:true}),
      // Pre-warm the Product ID -> creative report in the queue every five
      // minutes. Dashboard requests then read the fresh cache/source replica
      // instead of spending their own Worker subrequest budget.
      loadCreativeSummaries(runtime,{...input,products:[],allContexts:[],availableProducts:0,forceRefresh:true})
    ]);
    results.forEach((result,index)=>{
      if(result.status==='rejected')console.error(index===0?'TikTok snapshot failed':index===1?'Facebook snapshot failed':'TikTok creative snapshot failed',result.reason);
    });
    // Product discovery has its own queue invocation. It uses campaign and
    // item_group dimensions, while creative discovery uses item_id; keeping
    // them separate prevents videos from leaking into the Available table and
    // keeps each invocation below the provider subrequest ceiling.
    await runtime.TASK_QUEUE.send({type:'ads-products-snapshot',reportDate:message.reportDate});
    const currentHour=hourInTimezone(new Date(),runtime.TIMEZONE||'Asia/Bangkok');
    const row=await runtime.DB.prepare(`SELECT cost,gross_revenue,sku_orders FROM tiktok_ads_daily
      WHERE advertiser_id=? AND store_id=? AND report_date=?`).bind(runtime.DEFAULT_ADVERTISER_ID,storeId,message.reportDate).first<any>();
    if(row)await runtime.DB.prepare(`INSERT INTO hourly_metrics(advertiser_id,store_id,report_date,report_hour,metrics_json)
      VALUES(?,?,?,?,?) ON CONFLICT(advertiser_id,store_id,report_date,report_hour) DO UPDATE SET
      metrics_json=excluded.metrics_json`).bind(runtime.DEFAULT_ADVERTISER_ID,storeId,message.reportDate,currentHour,
      JSON.stringify({cost:numberValue(row.cost),orders:numberValue(row.sku_orders),grossRevenue:numberValue(row.gross_revenue),snapshotMode:'cumulative'})).run();
    return;
  }
  if(message.type==='ads-products-snapshot'){
    const storeId=await resolveDefaultStore(runtime);
    await loadMainReport(runtime,{advertiserId:runtime.DEFAULT_ADVERTISER_ID,storeId,startDate:message.reportDate,endDate:message.reportDate},true);
    return;
  }
  if(message.type==='ads-backfill'){
    const row=await env.DB.prepare("SELECT value FROM app_settings WHERE key='ADS_BACKFILL_NEXT_DATE'").first<{value:string}>();
    const next=String(row?.value||'2026-01-01'); const today=dateInTimezone(new Date(),env.TIMEZONE); const yesterday=shiftDate(today,-1);
    if(next>yesterday){
      await env.DB.prepare(`WITH RECURSIVE dates(d) AS (SELECT '2026-01-01' UNION ALL SELECT date(d,'+1 day') FROM dates WHERE d<'${yesterday}')
        INSERT OR IGNORE INTO tiktok_ads_daily(advertiser_id,store_id,report_date,payload_json,source)
        SELECT ?,?,d, '{}','backfill-missing' FROM dates`).bind(runtime.DEFAULT_ADVERTISER_ID,await resolveDefaultStore(runtime)).run().catch(()=>undefined);
      await env.DB.prepare(`WITH RECURSIVE dates(d) AS (SELECT '2026-01-01' UNION ALL SELECT date(d,'+1 day') FROM dates WHERE d<'${yesterday}')
        INSERT OR IGNORE INTO facebook_ads_daily(ad_account_id,report_date,payload_json)
        SELECT ad_account_id,d,'{}' FROM (SELECT DISTINCT ad_account_id FROM facebook_ads_daily) accounts CROSS JOIN dates`).run().catch(()=>undefined);
      // Backfill only repairs the legacy D1. Supabase is published by the
      // three scheduled backup windows (or an explicit admin manual sync),
      // never from this per-minute cursor check.
      return;
    }
    await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('ADS_BACKFILL_RUNNING',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(next).run();
    try{
      const storeId=await resolveDefaultStore(runtime); const date=next;
      // Refresh a bounded range with the same BASIC + GMV MAX layers used by
      // the Google Sheet, then hydrate Shop Analytics source traffic. This
      // repairs dates that were previously advanced after a provider error.
      const chunkEnd=(()=>{let value=date;for(let count=1;count<8&&value<yesterday;count+=1)value=shiftDate(value,1);return value;})();
      const input={advertiserId:runtime.DEFAULT_ADVERTISER_ID,storeId,startDate:date,endDate:chunkEnd};
      const results=await Promise.allSettled([
        refreshTikTokDailySnapshot(runtime,input),
        loadFacebookAdsReport(env,{startDate:date,endDate:chunkEnd,forceRefresh:true}),
        loadShopSourceRows(runtime,date,chunkEnd)
      ]);
      const sourceResult=results[2];
      if(sourceResult.status==='fulfilled'){
        for(const row of sourceResult.value)await env.DB.prepare(`INSERT INTO tiktok_ads_source_daily(advertiser_id,store_id,report_date,source,product_id,title,cost,gross_revenue,sku_orders,impressions,clicks,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(advertiser_id,store_id,report_date,source,product_id) DO UPDATE SET title=excluded.title,cost=excluded.cost,gross_revenue=excluded.gross_revenue,sku_orders=excluded.sku_orders,impressions=excluded.impressions,clicks=excluded.clicks,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP`).bind(row.advertiserId,row.storeId,String(row.reportDate).slice(0,10),row.source,row.productId,row.title,row.cost,row.grossRevenue,row.skuOrders,row.impressions,row.clicks,JSON.stringify(row.payload||{})).run();
        await env.DB.prepare(`UPDATE tiktok_ads_daily SET impressions=CASE WHEN COALESCE(impressions,0)=0 THEN (SELECT COALESCE(SUM(impressions),0) FROM tiktok_ads_source_daily s WHERE s.advertiser_id=tiktok_ads_daily.advertiser_id AND s.store_id=tiktok_ads_daily.store_id AND s.report_date=tiktok_ads_daily.report_date) ELSE impressions END, clicks=CASE WHEN COALESCE(clicks,0)=0 THEN (SELECT COALESCE(SUM(clicks),0) FROM tiktok_ads_source_daily s WHERE s.advertiser_id=tiktok_ads_daily.advertiser_id AND s.store_id=tiktok_ads_daily.store_id AND s.report_date=tiktok_ads_daily.report_date) ELSE clicks END, ctr=CASE WHEN impressions>0 THEN CAST(clicks AS REAL)/impressions ELSE 0 END, cr=CASE WHEN clicks>0 THEN CAST(sku_orders AS REAL)/clicks ELSE 0 END WHERE report_date BETWEEN ? AND ?`).bind(date,chunkEnd).run();
        await env.DB.prepare(`UPDATE tiktok_ads_daily SET ctr=CASE WHEN impressions>0 THEN CAST(clicks AS REAL)/impressions ELSE 0 END, cr=CASE WHEN clicks>0 THEN CAST(sku_orders AS REAL)/clicks ELSE 0 END WHERE report_date BETWEEN ? AND ?`).bind(date,chunkEnd).run();
      }
      const failures=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
      if(failures.length)console.warn('ADS_BACKFILL_PARTIAL',date,failures.map((failure)=>String(failure.reason)).join(' | '));
      await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('ADS_BACKFILL_NEXT_DATE',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(shiftDate(chunkEnd,1)).run();
    } finally { await env.DB.prepare("DELETE FROM app_settings WHERE key='ADS_BACKFILL_RUNNING'").run(); }
    return;
  }
  if(message.type==='zalo-poll'||message.type==='zalo-webhook-ensure')return;
  if(message.type==='zalo-video'||message.type==='zalo-video-day'||message.type==='zalo-video-finalize'||message.type==='zalo-video-recover')return;
  if(message.type==='hourly-dispatch'){
    try{await getAccessToken(runtime);}catch(error){
      console.error('TikTok OAuth refresh failed',error instanceof Error?error.message:String(error));
      throw error;
    }
    const tasks:Promise<unknown>[]=[];
    if(message.backupDate&&env.GOOGLE_BACKUP_SPREADSHEET_ID)tasks.push(env.TASK_QUEUE.send({type:'sheet-backup',reportDate:message.backupDate}));
    if(env.ZALO_BOT_TOKEN&&env.ZALO_GROUP_CHAT_ID){
      tasks.push(env.TASK_QUEUE.send(
        {type:'scheduled-report',reportDate:message.reportDate,reportHour:message.reportHour},
        // TikTok's hourly bucket is eventually consistent. Sending at HH:01
        // produced partial cost/orders; wait for the bucket to settle first.
        {delaySeconds:600}));
      // Recover one missed daytime slot on every five-minute dispatch. A
      // failed/missing 09:00 slot must not remain lost when the clock advances
      // to 10:00, otherwise the next successful message becomes a misleading
      // multi-hour cumulative report. One recovery per invocation keeps Queue
      // subrequests bounded and drains a backlog without provider bursts.
      if(message.reportHour>6){
        const missed=await env.DB.prepare(`WITH RECURSIVE hours(report_hour) AS (
          SELECT 6 UNION ALL SELECT report_hour+1 FROM hours WHERE report_hour<?
        ) SELECT hours.report_hour FROM hours LEFT JOIN scheduled_reports reports
          ON reports.report_date=? AND reports.report_hour=hours.report_hour
          WHERE hours.report_hour<? AND (reports.status IS NULL OR reports.status<>'SENT')
          ORDER BY hours.report_hour LIMIT 1`).bind(message.reportHour-1,message.reportDate,message.reportHour).first<{report_hour:number}>();
        if(missed?.report_hour)tasks.push(env.TASK_QUEUE.send({type:'scheduled-report',reportDate:message.reportDate,reportHour:Number(missed.report_hour)}));
      }
    }
    await Promise.all(tasks);return;
  }
  if(message.type==='operations-daily-report'){
    const storeId=env.ZALO_STORE_ID||await resolveDefaultStore(runtime);
    await sendOperationsReport({...runtime,DEFAULT_STORE_CODE:storeId},message.reportDate,message.mode,message.chatId,message.operationsDate||message.reportDate);
    if(message.eventId)await env.DB.prepare("UPDATE operations_bot_events SET status='DONE',processed_at=? WHERE external_id=?")
      .bind(Date.now(),message.eventId).run();
    return;
  }
  if(message.type==='operations-daily-prepare')return prepareDailyOperationsReport(runtime,message.reportDate,message.operationsDate,message.stage);
  if(message.type==='operations-weekly-report')return sendWeeklyOperationsReport(env,message.saturdayDate);
  if(message.type==='operations-weekly-prepare')return prepareWeeklyOperationsReport(zaloRuntime(env),message.saturdayDate,message.stage);
  if(message.type==='operations-monthly-prepare')return prepareMonthlyOperationsReport(zaloRuntime(env),message.firstDayOfMonth,message.stage);
  if(message.type==='order-bot-report')return sendOrderBotReport(env,message.reportDate,message.reportTime,message.force===true);
  if(message.type==='order-bot-monitor')return monitorOrderBot(env,message.reportDate);
  if(message.type==='sheet-backup'){
    const storeId=await resolveDefaultStore(runtime);const report=await loadMainReport(runtime,{advertiserId:runtime.DEFAULT_ADVERTISER_ID,storeId,startDate:message.reportDate,endDate:message.reportDate},true);
    const summary=await loadCreativeSummaries(runtime,{advertiserId:runtime.DEFAULT_ADVERTISER_ID,storeId,startDate:message.reportDate,endDate:message.reportDate,products:report.products,allContexts:report.creativeContexts,availableProducts:report.availableProductCount,forceRefresh:true});
    await env.DB.prepare(`INSERT INTO daily_metrics(advertiser_id,store_id,report_date,summary_json,products_json,creatives_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(advertiser_id,store_id,report_date) DO NOTHING`).bind(runtime.DEFAULT_ADVERTISER_ID,storeId,message.reportDate,JSON.stringify(report.totals),JSON.stringify(report.products),JSON.stringify(summary)).run();
    return backupDate(env,message.reportDate);
  }
  const storeId=await resolveDefaultStore(runtime);
  await sendScheduledReport({...runtime,DEFAULT_STORE_CODE:storeId},message.reportDate,message.reportHour);
}

async function assetResponse(request:Request,env:Env):Promise<Response>{
  const assetUrl=new URL(request.url);
  const isLogin=assetUrl.pathname==='/login';
  if(isLogin)assetUrl.pathname='/login-page.txt';
  const reportPaths=new Set(['/doanh-thu','/quang-cao','/hoan-huy-logistics','/tai-chinh','/content-koc']);
  if(reportPaths.has(assetUrl.pathname)){assetUrl.pathname='/';return Response.redirect(assetUrl.toString(),302);}
  const isHtml=isLogin||assetUrl.pathname==='/'||assetUrl.pathname.endsWith('.html');
  if(isHtml)assetUrl.searchParams.set('__asset_version','20260729-utf8');
  const response=await env.ASSETS.fetch(new Request(assetUrl.toString(),request));
  const headers=new Headers(response.headers);
  if(isHtml){headers.set('Content-Type','text/html; charset=UTF-8');headers.set('Cache-Control','no-store');}
  if(assetUrl.pathname.endsWith('.js'))headers.set('Content-Type','application/javascript; charset=UTF-8');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

async function enqueueMissingOrderReports(env:Env,localDate:string,localHour:number,localMinute:number):Promise<void>{
  const due=dueOrderBotSlots(localDate,localHour,localMinute);if(!due.length)return;
  const dates=[...new Set(due.map((slot)=>slot.reportDate))];
  const sent=new Set<string>();
  for(const date of dates){
    const rows=await env.DB.prepare("SELECT report_time FROM order_bot_reports WHERE report_date=? AND status='SENT'")
      .bind(date).all<{report_time:string}>();
    for(const row of rows.results||[])sent.add(`${date}:${row.report_time}`);
  }
  const missing=due.filter((slot)=>!sent.has(`${slot.reportDate}:${slot.reportTime}`));if(!missing.length)return;
  const latest=missing[missing.length-1];
  const prioritized=[latest,...missing].filter((slot,index,list)=>list.findIndex((item)=>item.reportDate===slot.reportDate&&item.reportTime===slot.reportTime)===index).slice(0,3);
  await env.TASK_QUEUE.sendBatch(prioritized.map((slot)=>({body:{type:'order-bot-report' as const,...slot}})));
}

async function dashboardLogin(request:Request,env:Env):Promise<Response>{
  if(request.method!=='POST')throw new HttpError(405,'Method not allowed.');
  const fingerprint=await assertDashboardLoginAllowed(request,env);
  const input=await readJson<{password?:string}>(request);
  const role=await dashboardRoleForPassword(env,String(input?.password||''));
  // Handle invalid credentials with an explicit response. This avoids an
  // opaque edge 500 when a bundled Worker loses the custom Error prototype.
  if(!role){await recordDashboardLoginFailure(env,fingerprint);return json({ok:false,error:'Mật khẩu không đúng.'},401);}
  if(!role){await recordDashboardLoginFailure(env,fingerprint);throw new HttpError(401,'Mã khóa không đúng.');}
  await clearDashboardLoginFailures(env,fingerprint);
  const token=await createDashboardSession(env,role);
  return new Response(JSON.stringify({ok:true,data:{role}}),{status:200,headers:{
    'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Set-Cookie':dashboardSessionCookie(token)
  }});
}

function dashboardLogout():Response{
  return new Response(JSON.stringify({ok:true}),{status:200,headers:{
    'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Set-Cookie':clearDashboardSessionCookie()
  }});
}

function dashboardLoginRedirect(url:URL):Response{
  const login=new URL('/login',url.origin);
  login.searchParams.set('next',`${url.pathname}${url.search}`);
  return Response.redirect(login.toString(),302);
}

function requireAdminRole(role:DashboardRole):void{
  if(role!=='admin')throw new HttpError(403,'Chỉ quản trị viên được thực hiện thao tác này.');
}

async function operationsBotWebhook(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  const supplied=request.headers.get('x-bot-api-secret-token')||request.headers.get('x-webhook-secret');
  if(env.ZALO_OPERATIONS_WEBHOOK_SECRET&&supplied!==env.ZALO_OPERATIONS_WEBHOOK_SECRET)throw new HttpError(401,'Invalid operations bot webhook secret.');
  const payload=await request.json<any>();
  const event=normalizeZaloEvent(payload);
  if(event.senderIsBot||event.chatId!==env.ZALO_OPERATIONS_GROUP_CHAT_ID||!/\bcheck\b/i.test(event.text))return json({ok:true,ignored:true});
  const rawId=event.id||Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)))))
    .map((value)=>value.toString(16).padStart(2,'0')).join('');
  const result=await env.DB.prepare("INSERT OR IGNORE INTO operations_bot_events(external_id,chat_id,received_at,status) VALUES(?,?,?,'QUEUED')")
    .bind(rawId,event.chatId,Date.now()).run();
  if(result.meta.changes)ctx.waitUntil(env.TASK_QUEUE.send({type:'operations-daily-report',reportDate:dateInTimezone(new Date(),env.TIMEZONE),mode:'REALTIME',chatId:event.chatId,eventId:rawId}));
  return json({ok:true,queued:Boolean(result.meta.changes)});
}

async function chartImage(env:Env,id:string):Promise<Response>{
  if(!/^\d+$/.test(id))throw new HttpError(400,'Invalid chart ID.');
  const chart=await cacheGet<any>(env,`zalo-chart:${id}`);
  if(!chart)throw new HttpError(404,'Chart expired.');
  const response=await fetch('https://quickchart.io/chart',{
    method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},
    body:JSON.stringify({chart,width:1000,height:520,format:'png',backgroundColor:'white',version:'4'})
  });
  if(!response.ok)throw new HttpError(502,'Chart service failed.');
  return new Response(response.body,{headers:{'Content-Type':'image/png','Cache-Control':'public, max-age=3600','Content-Disposition':`inline; filename="video-${id}.png"`}});
}

export { OAuthCoordinator };

export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    const url=new URL(request.url);
    try{
      if(env.REALTIME_GATEWAY === '1') {
        if(url.pathname==='/tiktok/webhook')return await tiktokShopWebhook(request,await runtimeProviderEnv(env));
        if(url.pathname==='/webhooks/zalo-operations'&&request.method==='POST')return operationsBotWebhook(request,await runtimeProviderEnv(env),ctx);
        if(url.pathname==='/webhooks/zalo'&&request.method==='POST')return webhook(request,await runtimeProviderEnv(env),url,ctx);
        const runtimeChartMatch=url.pathname.match(/^\/charts\/(\d+)\.png$/);
        if(runtimeChartMatch&&request.method==='GET')return chartImage(await runtimeProviderEnv(env),runtimeChartMatch[1]);
        if(url.pathname.startsWith('/api/') || url.pathname === '/internal/zalo-send' || url.pathname === '/internal/runtime-export' || url.pathname.startsWith('/auth/') || url.pathname === '/oauth/callback' || url.pathname.startsWith('/seller/')) return await gatewayRequest(request,env,url);
        return assetResponse(request,env);
      }
      if(url.pathname==='/internal/realtime'&&request.method==='POST')return await bridgeRequest(request,env);
      // Keep the legacy custom domain as the browser URL. API reads are
      // proxied to the realtime account (one bounded subrequest), while
      // cron, queues, webhooks and all data writes stay on this Worker.
      const realtimeOwnedPath=url.pathname.startsWith('/api/')||url.pathname==='/auth/connect'||url.pathname==='/auth/callback'||
        url.pathname==='/oauth/callback'||url.pathname==='/seller/auth/connect'||url.pathname==='/seller/auth/callback'||
        url.pathname==='/tiktok/webhook'||url.pathname==='/webhooks/zalo-operations'||url.pathname==='/webhooks/zalo'||
        url.pathname.startsWith('/charts/');
      if(env.REALTIME_GATEWAY_URL&&realtimeOwnedPath)return await realtimeProxyRequest(request,env,url);
      if(url.pathname==='/tiktok/webhook')return await tiktokShopWebhook(request,env);
      if(url.pathname==='/webhooks/zalo-operations'&&request.method==='POST')return operationsBotWebhook(request,env,ctx);
      if(url.pathname==='/webhooks/zalo'&&request.method==='POST')return json({ok:false,error:'Zalo interactive messages are disabled.'},410);
      const chartMatch=url.pathname.match(/^\/charts\/(\d+)\.png$/);
      if(chartMatch&&request.method==='GET')return chartImage(env,chartMatch[1]);
      if(url.pathname==='/auth/login')return await dashboardLogin(request,env);
      if(url.pathname==='/login'&&request.method==='GET')return assetResponse(request,env);
      if(url.pathname==='/FAVICON.png'&&request.method==='GET')return assetResponse(request,env);
      // The legacy custom domain is the public dashboard URL. It does not
      // require a dashboard session for the read-only realtime shell; admin
      // mutations still require the password bridge in the UI.
      if((url.pathname==='/'||url.pathname==='/index.html')&&request.method==='GET')return assetResponse(request,env);
      if(url.pathname==='/auth/logout'&&request.method==='POST')return dashboardLogout();
      if(url.pathname==='/auth/connect'&&request.method==='GET')return Response.redirect(await createAuthorizationUrl(env,url.origin),302);
      if(url.pathname==='/seller/auth/connect'&&request.method==='GET')return Response.redirect(await createSellerAuthorizationUrl(env),302);
      if(url.pathname==='/auth/callback'&&request.method==='GET')return url.searchParams.has('app_key')?handleSellerOAuthCallback(env,url):handleOAuthCallback(env,url);
      if(url.pathname==='/oauth/callback'&&request.method==='GET')return handleOAuthCallback(env,url);
      if(url.pathname==='/seller/auth/callback'&&request.method==='GET')return handleSellerOAuthCallback(env,url);

      const session=await dashboardSessionFromRequest(request,env);
      if(!session){
        if(url.pathname.startsWith('/api/')||request.method!=='GET')throw new HttpError(401,'Phiên đăng nhập đã hết hạn.');
        return dashboardLoginRedirect(url);
      }
      if(url.pathname==='/auth/logout')return dashboardLogout();
      if(url.pathname==='/auth/connect'&&request.method==='GET'){requireAdminRole(session.role);const gatewayOrigin=request.headers.get('X-Realtime-Gateway-Origin')||url.origin;return Response.redirect(await createAuthorizationUrl(env,gatewayOrigin),302);}
      if(url.pathname==='/auth/callback'){
        requireAdminRole(session.role);
        if(url.searchParams.has('app_key'))return handleSellerOAuthCallback(env,url);
        return handleOAuthCallback(env,url);
      }
      if(url.pathname==='/oauth/callback'){requireAdminRole(session.role);return handleOAuthCallback(env,url);}
      if(url.pathname==='/seller/auth/connect'&&request.method==='GET'){requireAdminRole(session.role);return Response.redirect(await createSellerAuthorizationUrl(env),302);}
      if(url.pathname==='/seller/auth/callback'&&request.method==='GET'){requireAdminRole(session.role);return handleSellerOAuthCallback(env,url);}
      if(url.pathname.startsWith('/api/'))return await routeApi(request,env,url,session);
      return assetResponse(request,env);
    }catch(error){
      // Workers can deserialize thrown errors across module boundaries, so
      // `instanceof HttpError` is not always reliable in the bundled script.
      // Preserve the explicit HTTP status when present (notably 401 on login)
      // instead of turning it into a misleading 500 response.
      const status=error instanceof HttpError?error.status:Number((error as any)?.status)||500;
      return json({ok:false,error:error instanceof Error?error.message:String(error)},status);
    }
  },
  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext):Promise<void>{
    const now=new Date();const localHour=hourInTimezone(now,env.TIMEZONE);const localDate=dateInTimezone(now,env.TIMEZONE);
    const localParts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:env.TIMEZONE,hour:'2-digit',minute:'2-digit',hour12:false})
      .formatToParts(now).map((part)=>[part.type,part.value]));
    const localMinute=Number(localParts.minute);
    if(env.REALTIME_GATEWAY==='1'){
      // OAuth/MCP and realtime data belong to the new account and new D1.
      ctx.waitUntil((async()=>{
        const runtime=await runtimeProviderEnv(env);
        if(localMinute%5===0){
          // Provider pagination runs in its own Queue invocation. Dashboard
          // requests only read the resulting D1 snapshot and cannot inherit
          // the provider subrequest count.
          await runtime.TASK_QUEUE.send({type:'ads-snapshot',reportDate:localDate});
        }
        if(localMinute%15===0)await keepAccessTokenFresh(runtime).catch((error)=>
          console.error('TikTok Ads MCP proactive token refresh failed',error instanceof Error?error.message:String(error)));
        await pollOperationsInbox(runtime).catch((error)=>console.error('Operations bot polling failed',error instanceof Error?error.message:String(error)));
        if(runtime.ZALO_ORDER_BOT_TOKEN&&runtime.ZALO_ORDER_GROUP_CHAT_ID&&(localMinute===56||localMinute%5===0))
          await enqueueMissingOrderReports(runtime,localDate,localHour,localMinute);
        if(runtime.ZALO_ORDER_BOT_TOKEN&&runtime.ZALO_ORDER_GROUP_CHAT_ID&&localMinute%5===0)
          await runtime.TASK_QUEUE.send({type:'order-bot-monitor',reportDate:localDate});
        // The operations bot sends one closed-day report in the morning. The
        // extra 08:05/08:10 attempts only recover a failed 08:00 enqueue; D1
        // idempotency prevents duplicates after the report is SENT.
        if(localHour===8&&[0,5,10].includes(localMinute)&&runtime.ZALO_OPERATIONS_BOT_TOKEN&&runtime.ZALO_OPERATIONS_GROUP_CHAT_ID){
          const yesterday=shiftDate(localDate,-1);
          await runtime.TASK_QUEUE.send({type:'operations-daily-prepare',reportDate:yesterday,operationsDate:yesterday,stage:0});
        }
        const localWeekday=new Date(`${localDate}T00:00:00Z`).getUTCDay();
        if(localWeekday===6&&localHour===10&&[30,35,40].includes(localMinute)&&runtime.ZALO_OPERATIONS_BOT_TOKEN&&runtime.ZALO_OPERATIONS_GROUP_CHAT_ID)
          await runtime.TASK_QUEUE.send({type:'operations-weekly-prepare',saturdayDate:localDate,stage:0});
        if(localDate.endsWith('-01')&&localHour===10&&[35,40,45].includes(localMinute)&&runtime.ZALO_OPERATIONS_BOT_TOKEN&&runtime.ZALO_OPERATIONS_GROUP_CHAT_ID)
          await runtime.TASK_QUEUE.send({type:'operations-monthly-prepare',firstDayOfMonth:localDate,stage:0});
        if(localMinute%5===0){
          // At 15:00 report the completed 14:00 bucket. The current hour is
          // still changing and must never be presented as an hourly total.
          const reportHour=localHour===0?23:localHour-1;
          const reportDate=localHour===0?shiftDate(localDate,-1):localDate;
          const operationsRouteCollision=
            Boolean(runtime.ZALO_GROUP_CHAT_ID&&runtime.ZALO_OPERATIONS_GROUP_CHAT_ID&&
              runtime.ZALO_GROUP_CHAT_ID===runtime.ZALO_OPERATIONS_GROUP_CHAT_ID)||
            Boolean(runtime.ZALO_BOT_TOKEN&&runtime.ZALO_OPERATIONS_BOT_TOKEN&&
              runtime.ZALO_BOT_TOKEN===runtime.ZALO_OPERATIONS_BOT_TOKEN);
          if(operationsRouteCollision){
            console.error('Zalo bot routing conflict: ADS and operations credentials must be distinct; hourly ADS dispatch suppressed.');
          }else{
            await runtime.TASK_QUEUE.send({type:'hourly-dispatch',reportDate,reportHour});
          }
        }
      })());
      return;
    }
    // The old account only schedules the three agreed Supabase backups.
    if(env.SUPABASE_URL&&env.SUPABASE_SECRET_KEY&&[3,9,12].includes(localHour)&&localMinute===0)
      ctx.waitUntil(env.TASK_QUEUE.send({type:'supabase-backup',reportDate:localDate}));
  },
  async queue(batch:MessageBatch<TaskMessage>,env:Env):Promise<void>{
    const executionEnv=env.REALTIME_GATEWAY==='1'?await runtimeProviderEnv(env):env;
    for(const message of batch.messages){
      try{await consume(message.body,executionEnv);message.ack();}
      catch(error){
        const details=error instanceof Error?error.message:String(error);
        console.error('Queue task failed',message.body,details);
        if(message.body.type==='zalo-video'){
          await executionEnv.DB.prepare("UPDATE webhook_events SET status='RETRYING',result_json=? WHERE id=?")
            .bind(JSON.stringify({error:details}),message.body.eventId).run();
        }
        if(message.body.type==='operations-daily-report'&&message.body.eventId){
          await executionEnv.DB.prepare("UPDATE operations_bot_events SET status='RETRYING' WHERE external_id=?")
            .bind(message.body.eventId).run();
        }
        message.retry({delaySeconds:message.body.type==='tracking-sync'?60:10});
      }
    }
  }
} satisfies ExportedHandler<Env,TaskMessage>;
