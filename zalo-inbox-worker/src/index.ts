interface Env {
  DB: D1Database;
  INGRESS_QUEUE: Queue<IngressTask>;
  PROCESSING_QUEUE: Queue<ProcessingTask>;
  PUBLIC_BASE_URL: string;
  ZALO_GROUP_CHAT_ID: string;
  ZALO_BOT_TOKEN: string;
}

type IngressTask = { type: 'zalo-ingress'; eventId: number } | { type: 'webhook-ensure' };
type ProcessingTask = { type: 'zalo-video'; eventId: number };

const ZALO_API = 'https://bot-api.zaloplatforms.com/bot';

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

async function zaloApi(env: Env, method: string, payload: unknown): Promise<any> {
  const result = await fetch(`${ZALO_API}${encodeURIComponent(env.ZALO_BOT_TOKEN)}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload)
  });
  const data = await result.json<any>().catch(() => ({}));
  if (!result.ok || data.ok !== true) {
    throw new Error(`Zalo Bot API ${data.error_code || result.status}: ${data.description || 'Invalid response'}`);
  }
  return data.result || {};
}

function normalize(payload: any): { id: string; chatId: string; text: string; senderIsBot: boolean } {
  const event = payload?.result || payload || {};
  const message = event.message || event.edited_message || {};
  return {
    id: String(message.message_id || event.update_id || event.event_id || ''),
    chatId: String(message.chat?.id || message.chat_id || event.chat_id || event.group_id || ''),
    text: String(message.text || event.text || event.message_text || event.content || ''),
    senderIsBot: Boolean(message.from?.is_bot ?? event.is_bot ?? event.sender_is_bot)
  };
}

function directVideoId(text: string): string | null {
  return text.match(/(?:tiktok\.com\/[^\s]*\/video\/|\b)(\d{19,30})(?:\b|[?/_])/i)?.[1] || null;
}

async function videoId(text: string): Promise<string | null> {
  const direct = directVideoId(text);
  if (direct) return direct;
  const short = text.match(/https?:\/\/(?:www\.)?(?:vt|vm)\.tiktok\.com\/[^\s]+/i)?.[0]?.replace(/[),.;]+$/, '');
  if (!short) return null;
  let current = short;
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await fetch(current, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0' } });
    const location = res.headers.get('location');
    if (!location) return directVideoId(res.url);
    current = new URL(location, current).toString();
    const found = directVideoId(current);
    if (found) return found;
  }
  return null;
}

async function sendText(env: Env, chatId: string, text: string): Promise<void> {
  await zaloApi(env, 'sendMessage', { chat_id: chatId, text });
}

async function webhookSecret(env: Env): Promise<string> {
  const stored = await env.DB.prepare("SELECT value FROM app_settings WHERE key='ZALO_WEBHOOK_SECRET'").first<{ value: string }>();
  if (stored?.value) return stored.value;
  const value = `cfwh_${crypto.randomUUID().replace(/-/g, '')}`;
  await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('ZALO_WEBHOOK_SECRET',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(value).run();
  return value;
}

async function ensureWebhook(env: Env): Promise<void> {
  const url = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhooks/zalo`;
  const secret = await webhookSecret(env);
  const info = await zaloApi(env, 'getWebhookInfo', {}).catch(() => ({}));
  if (String(info?.url || '') !== url) await zaloApi(env, 'setWebhook', { url, secret_token: secret });
  await env.DB.prepare("INSERT INTO app_settings(key,value) VALUES('ZALO_INBOX_MODE',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .bind(JSON.stringify({ mode: 'DEDICATED_WEBHOOK', url, checkedAt: Date.now() })).run();
}

async function acceptWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secret = await webhookSecret(env);
  if (request.headers.get('x-bot-api-secret-token') !== secret) return response({ ok: false }, 401);
  const payload = await request.json<any>();
  const event = normalize(payload);
  if (!event.id) return response({ ok: true });
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO webhook_events(provider,external_id,received_at,payload,status)
    VALUES('zalo',?,?,?,'PENDING')`).bind(event.id, Date.now(), JSON.stringify(payload)).run();
  if (inserted.meta.changes) {
    const row = await env.DB.prepare("SELECT id FROM webhook_events WHERE provider='zalo' AND external_id=?")
      .bind(event.id).first<{ id: number }>();
    if (row) ctx.waitUntil((async () => {
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        await processIngress(env, row.id);
      } catch (error) {
        console.error('Direct Zalo ingress failed; queued fallback', error instanceof Error ? error.message : String(error));
        await env.INGRESS_QUEUE.send({ type: 'zalo-ingress', eventId: row.id }, { delaySeconds: 2 });
      }
    })());
  }
  return response({ ok: true });
}

async function processIngress(env: Env, eventId: number): Promise<void> {
  const row = await env.DB.prepare('SELECT payload,status,result_json FROM webhook_events WHERE id=?').bind(eventId)
    .first<{ payload: string; status: string; result_json: string | null }>();
  if (!row || row.status !== 'PENDING') return;
  const event = normalize(JSON.parse(row.payload));
  if (event.senderIsBot || event.chatId !== env.ZALO_GROUP_CHAT_ID) {
    await env.DB.prepare("UPDATE webhook_events SET status='SKIPPED',processed_at=? WHERE id=?").bind(Date.now(), eventId).run();
    return;
  }
  const newer = await env.DB.prepare("SELECT payload FROM webhook_events WHERE provider='zalo' AND id>? AND status='PENDING' ORDER BY id DESC LIMIT 20")
    .bind(eventId).all<{ payload: string }>();
  if (newer.results.some(item => normalize(JSON.parse(item.payload)).chatId === event.chatId)) {
    await env.DB.prepare("UPDATE webhook_events SET status='SKIPPED',processed_at=? WHERE id=?").bind(Date.now(), eventId).run();
    return;
  }
  const itemId = await videoId(event.text);
  if (!itemId) {
    await sendText(env, event.chatId, 'Định dạng link sai, vui lòng gửi lại định dạng: @Bot ADS - ALF https://www.tiktok.com/@username/video/POST_ID');
    await env.DB.prepare("UPDATE webhook_events SET status='DONE',result_json=?,processed_at=? WHERE id=?")
      .bind(JSON.stringify({ reason: 'INVALID_LINK' }), Date.now(), eventId).run();
    return;
  }
  let acknowledged = false;
  try { acknowledged = Boolean(row.result_json && JSON.parse(row.result_json)?.acknowledged); } catch { /* Retry acknowledgement safely. */ }
  if (!acknowledged) await sendText(env, event.chatId, `Đang xử lý dữ liệu 30 ngày cho video ${itemId}...`);
  await env.DB.prepare("UPDATE webhook_events SET result_json=? WHERE id=? AND status='PENDING'")
    .bind(JSON.stringify({ acknowledged: true, itemId }), eventId).run();
  await env.PROCESSING_QUEUE.send({ type: 'zalo-video', eventId });
  await env.DB.prepare("UPDATE webhook_events SET status='QUEUED' WHERE id=? AND status='PENDING'").bind(eventId).run();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/webhooks/zalo') return acceptWebhook(request, env, ctx);
    if (request.method === 'POST' && url.pathname === '/internal/ensure-webhook') {
      const secret = await webhookSecret(env);
      if (request.headers.get('x-webhook-secret') !== secret) return response({ ok: false }, 401);
      await ensureWebhook(env);
      return response({ ok: true });
    }
    if (url.pathname === '/health') return response({ ok: true, service: 'zalo-inbox', time: new Date().toISOString() });
    return response({ ok: false, error: 'Not found' }, 404);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(ensureWebhook(env));
  },
  async queue(batch: MessageBatch<IngressTask>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (message.body.type === 'webhook-ensure') await ensureWebhook(env);
        else await processIngress(env, message.body.eventId);
        message.ack();
      } catch (error) {
        console.error('Zalo inbox task failed', message.body, error instanceof Error ? error.message : String(error));
        message.retry({ delaySeconds: 5 });
      }
    }
  }
} satisfies ExportedHandler<Env, IngressTask>;
