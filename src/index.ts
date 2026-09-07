import type { Env, TaskMessage } from './types';
import { OAuthCoordinator, createAuthorizationUrl, disconnect, getAccessToken, handleOAuthCallback, keepAccessTokenFresh,
  oauthConnectionState, readTokens, refreshAccessToken } from './oauth';
import { createSession, listAdvertisers, listStores, resolveDefaultStoreId } from './mcp';
import { loadComparison, loadCreativeSummaries, loadMainReport, loadProductVideos, loadVideoMetadata, loadVideoStats } from './reports';
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
import { pollOperationsBot, prepareMonthlyOperationsReport, prepareWeeklyOperationsReport, sendOperationsReport, sendWeeklyOperationsReport } from './operations-bot';
import { dueOrderBotSlots, monitorOrderBot, sendOrderBotReport } from './order-bot';
import { cacheGet, dateInTimezone, hourInTimezone, HttpError, json, readJson, shiftDate, validateDate, validateId } from './utils';
import { assertDashboardApiAccess, assertDashboardLoginAllowed, clearDashboardLoginFailures, clearDashboardSessionCookie,
  createDashboardSession, dashboardRoleForPassword, dashboardSessionCookie, dashboardSessionFromRequest,
  recordDashboardLoginFailure, type DashboardRole, type DashboardSession } from './dashboard-auth';

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
  if(request.method==='POST'&&url.pathname==='/api/admin/supabase-sync'){const value=await readJson<any>(request);const start=validateDate(value.startDate,'startDate'),end=validateDate(value.endDate,'endDate');if(start>end)throw new HttpError(400,'Khoảng ngày không hợp lệ.');const tables=Array.isArray(value.tables)?value.tables.map(String):['all'];await env.TASK_QUEUE.send({type:'supabase-manual-sync',startDate:start,endDate:end,tables});await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({status:'QUEUED',startDate:start,endDate:end,progress:0,tables})).run();return ok({queued:true});}
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
  let chunkEnd=message.startDate;for(let i=1;i<14&&chunkEnd<message.endDate;i+=1)chunkEnd=shiftDate(chunkEnd,1);
  const total=Math.max(1,Math.round((Date.parse(message.endDate)-Date.parse(message.startDate))/86400000)+1),done=Math.max(0,Math.round((Date.parse(chunkEnd)-Date.parse(message.startDate)+86400000)/86400000));
  await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({status:'RUNNING',startDate:message.startDate,endDate:message.endDate,progress:Math.min(95,Math.round(done/total*95)),tables:message.tables})).run();
  const sourceRows=await loadShopSourceRows(zaloRuntime(env),message.startDate,chunkEnd);
  for(const row of sourceRows)await env.DB.prepare(`INSERT INTO tiktok_ads_source_daily(advertiser_id,store_id,report_date,source,product_id,title,cost,gross_revenue,sku_orders,impressions,clicks,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(advertiser_id,store_id,report_date,source,product_id) DO UPDATE SET title=excluded.title,cost=excluded.cost,gross_revenue=excluded.gross_revenue,sku_orders=excluded.sku_orders,impressions=excluded.impressions,clicks=excluded.clicks,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP`).bind(row.advertiserId,row.storeId,row.reportDate,row.source,row.productId,row.title,row.cost,row.grossRevenue,row.skuOrders,row.impressions,row.clicks,JSON.stringify(row.payload||{})).run();
  const next=shiftDate(chunkEnd,1);if(next<=message.endDate){await env.TASK_QUEUE.send({type:'supabase-manual-sync',startDate:next,endDate:message.endDate,tables:message.tables});return;}
  await syncSupabaseBackup(env,message.endDate);const backup=await env.DB.prepare("SELECT value FROM app_settings WHERE key='SUPABASE_BACKUP_STATUS'").first<any>();const state=backup?.value?JSON.parse(backup.value):{};if(state.status!=='SUCCESS'||(state.tableErrors||[]).length)throw new Error('Supabase backup '+String(state.status||'FAILED')+': '+JSON.stringify(state.tableErrors||[]));
  await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({status:'SUCCESS',startDate:message.startDate,endDate:message.endDate,progress:100,tables:message.tables,sourceRows:sourceRows.length})).run();
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
  if(message.type==='supabase-manual-sync'){await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({status:'RUNNING',startDate:message.startDate,endDate:message.endDate,progress:10,tables:message.tables})).run();try{const sourceRows=await loadShopSourceRows(runtime,message.startDate,message.endDate);for(const row of sourceRows)await env.DB.prepare(`INSERT INTO tiktok_ads_source_daily(advertiser_id,store_id,report_date,source,product_id,title,cost,gross_revenue,sku_orders,impressions,clicks,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(advertiser_id,store_id,report_date,source,product_id) DO UPDATE SET title=excluded.title,cost=excluded.cost,gross_revenue=excluded.gross_revenue,sku_orders=excluded.sku_orders,impressions=excluded.impressions,clicks=excluded.clicks,payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP`).bind(row.advertiserId,row.storeId,row.reportDate,row.source,row.productId,row.title,row.cost,row.grossRevenue,row.skuOrders,row.impressions,row.clicks,JSON.stringify(row.payload||{})).run();await syncSupabaseBackup(env,message.endDate);const backup=await env.DB.prepare("SELECT value FROM app_settings WHERE key='SUPABASE_BACKUP_STATUS'").first<any>();const backupStatus=backup?.value?JSON.parse(backup.value):{};if(backupStatus.status!=='SUCCESS'||(backupStatus.tableErrors||[]).length)throw new Error('Supabase backup '+String(backupStatus.status||'FAILED')+': '+JSON.stringify(backupStatus.tableErrors||[]));await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({status:'SUCCESS',startDate:message.startDate,endDate:message.endDate,progress:100,tables:message.tables,sourceRows:sourceRows.length})).run();}catch(error){await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('SUPABASE_MANUAL_SYNC_STATUS',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify({status:'FAILED',startDate:message.startDate,endDate:message.endDate,progress:100,tables:message.tables,error:String(error)})).run();throw error;}return;}
  if(message.type==='ads-snapshot'){
    const storeId=await resolveDefaultStore(runtime);
    const input={advertiserId:runtime.DEFAULT_ADVERTISER_ID,storeId,startDate:message.reportDate,endDate:message.reportDate};
    await Promise.all([loadMainReport(runtime,input,true),loadFacebookAdsReport(runtime,input)]); return;
  }
  if(message.type==='ads-backfill'){
    const row=await env.DB.prepare("SELECT value FROM app_settings WHERE key='ADS_BACKFILL_NEXT_DATE'").first<{value:string}>();
    const next=String(row?.value||'2026-01-01'); const today=dateInTimezone(new Date(),env.TIMEZONE); const yesterday=shiftDate(today,-1);
    if(next>yesterday){
      await env.DB.prepare(`WITH RECURSIVE dates(d) AS (SELECT '2026-01-01' UNION ALL SELECT date(d,'+1 day') FROM dates WHERE d<'${yesterday}')
        INSERT OR IGNORE INTO tiktok_ads_daily(advertiser_id,store_id,report_date,payload_json,source)
        SELECT ?,?,d, '{}','backfill-missing' FROM dates`).bind(runtime.DEFAULT_ADVERTISER_ID,await resolveDefaultStore(runtime)).run().catch(()=>undefined);
      return;
    }
    await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('ADS_BACKFILL_RUNNING',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(next).run();
    try{
      const storeId=await resolveDefaultStore(runtime); let date=next;
      // Process a larger bounded chunk per queue message. Calls remain
      // sequential to avoid provider rate limits and protect Zalo workers.
      for(let count=0;count<15&&date<=yesterday;count+=1,date=shiftDate(date,1)){
        const input={advertiserId:runtime.DEFAULT_ADVERTISER_ID,storeId,startDate:date,endDate:date};
        // A revoked provider token must not block the whole historical cursor.
        // Persist whichever provider succeeds, then advance this date so the
        // queue keeps making progress; failed dates can be retried after auth
        // is restored.
        const results=await Promise.allSettled([loadMainReport(runtime,input,true),loadFacebookAdsReport(runtime,input)]);
        const failures=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
        if(failures.length) console.warn('ADS_BACKFILL_PARTIAL',date,failures.map((failure)=>String(failure.reason)).join(' | '));
        await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('ADS_BACKFILL_NEXT_DATE',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(shiftDate(date,1)).run();
      }
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
    if(env.ZALO_BOT_TOKEN&&env.ZALO_GROUP_CHAT_ID)tasks.push(env.TASK_QUEUE.send(
      {type:'scheduled-report',reportDate:message.reportDate,reportHour:message.reportHour},
      message.reportHour===8?{delaySeconds:30}:undefined));
    await Promise.all(tasks);return;
  }
  if(message.type==='operations-daily-report'){
    const storeId=env.ZALO_STORE_ID||await resolveDefaultStore(runtime);
    await sendOperationsReport({...runtime,DEFAULT_STORE_CODE:storeId},message.reportDate,message.mode,message.chatId,message.operationsDate||message.reportDate);
    if(message.eventId)await env.DB.prepare("UPDATE operations_bot_events SET status='DONE',processed_at=? WHERE external_id=?")
      .bind(Date.now(),message.eventId).run();
    return;
  }
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
      if(url.pathname==='/tiktok/webhook')return await tiktokShopWebhook(request,env);
      if(url.pathname==='/webhooks/zalo-operations'&&request.method==='POST')return operationsBotWebhook(request,env,ctx);
      if(url.pathname==='/webhooks/zalo'&&request.method==='POST')return json({ok:false,error:'Zalo interactive messages are disabled.'},410);
      const chartMatch=url.pathname.match(/^\/charts\/(\d+)\.png$/);
      if(chartMatch&&request.method==='GET')return chartImage(env,chartMatch[1]);
      if(url.pathname==='/auth/login')return dashboardLogin(request,env);
      if(url.pathname==='/login'&&request.method==='GET')return assetResponse(request,env);
      if(url.pathname==='/FAVICON.png'&&request.method==='GET')return assetResponse(request,env);

      const session=await dashboardSessionFromRequest(request,env);
      if(!session){
        if(url.pathname.startsWith('/api/')||request.method!=='GET')throw new HttpError(401,'Phiên đăng nhập đã hết hạn.');
        return dashboardLoginRedirect(url);
      }
      if(url.pathname==='/auth/logout')return dashboardLogout();
      if(url.pathname==='/auth/connect'&&request.method==='GET'){requireAdminRole(session.role);return Response.redirect(await createAuthorizationUrl(env,url.origin),302);}
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
    }catch(error){const status=error instanceof HttpError?error.status:500;return json({ok:false,error:error instanceof Error?error.message:String(error)},status);}
  },
  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext):Promise<void>{
    const now=new Date();const localHour=hourInTimezone(now,env.TIMEZONE);const localDate=dateInTimezone(now,env.TIMEZONE);
    const localParts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:env.TIMEZONE,hour:'2-digit',minute:'2-digit',hour12:false})
      .formatToParts(now).map((part)=>[part.type,part.value]));
    const localMinute=Number(localParts.minute);
    if(localMinute%15===0)ctx.waitUntil(keepAccessTokenFresh(env).catch((error)=>
      console.error('TikTok Ads MCP proactive token refresh failed',error instanceof Error?error.message:String(error))));
    ctx.waitUntil(pollOperationsInbox(env).catch((error)=>console.error('Operations bot polling failed',error instanceof Error?error.message:String(error))));
    if(env.ZALO_ORDER_BOT_TOKEN&&env.ZALO_ORDER_GROUP_CHAT_ID&&(localMinute===56||localMinute%5===0))
      ctx.waitUntil(enqueueMissingOrderReports(env,localDate,localHour,localMinute));
    if(env.ZALO_ORDER_BOT_TOKEN&&env.ZALO_ORDER_GROUP_CHAT_ID&&localMinute%5===0)
      ctx.waitUntil(env.TASK_QUEUE.send({type:'order-bot-monitor',reportDate:localDate}));
    if(env.SUPABASE_URL&&env.SUPABASE_SECRET_KEY&&localMinute%5===0)
      ctx.waitUntil(env.TASK_QUEUE.send({type:'supabase-backup',reportDate:localDate}));
    if([3,9,12].includes(localHour)&&localMinute===0)
      ctx.waitUntil(env.TASK_QUEUE.send({type:'ads-snapshot',reportDate:shiftDate(localDate, -1)}));
    // Queue the next bounded backfill chunk every minute until history is complete.
    {
      ctx.waitUntil((async()=>{const row=await env.DB.prepare("SELECT value,updated_at FROM app_settings WHERE key='ADS_BACKFILL_RUNNING'").first<{value:string;updated_at:string}>();const stale=!row||Date.now()-Date.parse(String(row.updated_at||''))>15*60*1000;if(stale)await env.TASK_QUEUE.send({type:'ads-backfill'});})());
    }
    // Start at 08:00 and keep retrying until TikTok Shop data passes the
    // consistency check. The report table is the idempotency key.
    if(localHour>=8&&localMinute%5===0&&env.ZALO_OPERATIONS_BOT_TOKEN&&env.ZALO_OPERATIONS_GROUP_CHAT_ID){
      const yesterday=shiftDate(localDate,-1);
      ctx.waitUntil(env.TASK_QUEUE.send({type:'operations-daily-report',reportDate:yesterday,operationsDate:yesterday,mode:'DAILY'}));
    }
    const localWeekday=new Date(`${localDate}T00:00:00Z`).getUTCDay();
    if(localWeekday===6&&localHour===10&&[30,35,40].includes(localMinute)&&env.ZALO_OPERATIONS_BOT_TOKEN&&env.ZALO_OPERATIONS_GROUP_CHAT_ID)
      ctx.waitUntil(env.TASK_QUEUE.send({type:'operations-weekly-prepare',saturdayDate:localDate,stage:0}));
    if(localDate.endsWith('-01')&&localHour===10&&[35,40,45].includes(localMinute)&&env.ZALO_OPERATIONS_BOT_TOKEN&&env.ZALO_OPERATIONS_GROUP_CHAT_ID)
      ctx.waitUntil(env.TASK_QUEUE.send({type:'operations-monthly-prepare',firstDayOfMonth:localDate,stage:0}));
    // Retry every five minutes. scheduled_reports is the idempotency key, so a
    // successful hourly slot is not sent twice while transient failures and
    // deployments at the top of an hour recover automatically.
    if(localMinute%5!==0)return;
    const reportHour=localHour===0?24:localHour;
    const reportDate=localHour===0?shiftDate(localDate,-1):localDate;
    ctx.waitUntil(env.TASK_QUEUE.send({type:'hourly-dispatch',reportDate,reportHour,
      backupDate:localHour===8&&localMinute===0?shiftDate(localDate,-1):undefined}));
  },
  async queue(batch:MessageBatch<TaskMessage>,env:Env):Promise<void>{
    for(const message of batch.messages){
      try{await consume(message.body,env);message.ack();}
      catch(error){
        const details=error instanceof Error?error.message:String(error);
        console.error('Queue task failed',message.body,details);
        if(message.body.type==='zalo-video'){
          await env.DB.prepare("UPDATE webhook_events SET status='RETRYING',result_json=? WHERE id=?")
            .bind(JSON.stringify({error:details}),message.body.eventId).run();
        }
        if(message.body.type==='operations-daily-report'&&message.body.eventId){
          await env.DB.prepare("UPDATE operations_bot_events SET status='RETRYING' WHERE external_id=?")
            .bind(message.body.eventId).run();
        }
        message.retry({delaySeconds:message.body.type==='tracking-sync'?60:10});
      }
    }
  }
} satisfies ExportedHandler<Env,TaskMessage>;
