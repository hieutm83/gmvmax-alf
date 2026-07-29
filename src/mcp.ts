import type { Env, McpRow, McpSession } from './types';
import { getAccessToken } from './oauth';

const PROTOCOL = '2025-06-18';

function parseEnvelope(text: string, id: number): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  let fallback: any;
  for (const event of trimmed.split(/\r?\n\r?\n/)) {
    const value = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.replace(/^data:\s?/, '')).join('\n');
    if (!value) continue;
    const parsed = JSON.parse(value);
    if (String(parsed.id) === String(id)) return parsed;
    fallback = parsed;
  }
  if (fallback) return fallback;
  throw new Error('TikTok MCP returned an invalid response.');
}

function unwrap(result: any): any {
  if (result?.structuredContent) return unwrapTikTok(result.structuredContent);
  for (const block of result?.content || []) {
    if (block.type === 'text') {
      try { return unwrapTikTok(JSON.parse(block.text)); } catch { /* continue */ }
    }
  }
  return unwrapTikTok(result || {});
}

function unwrapTikTok(payload: any): any {
  if (payload?.result && Object.keys(payload).length === 1) return unwrapTikTok(payload.result);
  if (payload?.code !== undefined && Number(payload.code) !== 0) throw new Error(`TikTok Ads: ${payload.message || payload.msg || payload.code}`);
  return payload?.data !== undefined ? payload.data : payload;
}

async function request(env: Env, session: McpSession, method: string, params: any, notification = false, retried = false): Promise<any> {
  const payload: any = { jsonrpc: '2.0', method, params: params || {} };
  if (!notification) payload.id = ++session.requestId;
  const headers: Record<string, string> = { Authorization: `Bearer ${await getAccessToken(env)}`,
    Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': PROTOCOL };
  if (session.id) headers['Mcp-Session-Id'] = session.id;
  const response = await fetch(env.MCP_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (response.status === 401 && !retried) {
    await getAccessToken(env, true);
    return request(env, session, method, params, notification, true);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`TikTok MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
  session.id = response.headers.get('mcp-session-id') || session.id;
  if (notification || response.status === 202 || !text) return null;
  const envelope = parseEnvelope(text, payload.id);
  if (envelope.error) throw new Error(`TikTok MCP: ${envelope.error.message || JSON.stringify(envelope.error)}`);
  return envelope.result;
}

export async function createSession(env: Env): Promise<McpSession> {
  const session: McpSession = { requestId: 0 };
  await request(env, session, 'initialize', { protocolVersion: PROTOCOL, capabilities: {},
    clientInfo: { name: 'tiktok-gmv-max-cloudflare', version: '1.0.0' } });
  await request(env, session, 'notifications/initialized', {}, true);
  return session;
}

export async function callTool(env: Env, session: McpSession, name: string, args: Record<string, unknown>): Promise<any> {
  const delays = [1200, 3000, 7000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await request(env, session, 'tools/call', { name, arguments: args });
      if (result?.isError) throw new Error((result.content || []).map((b: any) => b.text || '').join(' ') || 'MCP tool error');
      return unwrap(result);
    } catch (error) {
      if (!/rate limit|too many requests|429/i.test(String(error)) || attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

export async function resolveTool(env: Env, session: McpSession, candidates: string[]): Promise<string> {
  if (!session.toolNames) {
    session.toolNames = [];
    let cursor: string | undefined;
    do {
      const result = await request(env, session, 'tools/list', cursor ? { cursor } : {});
      session.toolNames.push(...(result?.tools || []).map((tool: any) => String(tool.name)));
      cursor = result?.nextCursor;
    } while (cursor);
  }
  const found = candidates.find((name) => session.toolNames!.includes(name));
  if (!found) throw new Error(`TikTok MCP is missing tool: ${candidates.join(', ')}`);
  return found;
}

export async function pagedReport(env: Env, session: McpSession, args: Record<string, any>): Promise<McpRow[]> {
  const rows: McpRow[] = [];
  let page = 1;
  let pages = 1;
  do {
    const data = await callTool(env, session, 'gmv_max_report_get', { ...args, page, page_size: 1000 });
    rows.push(...(data.list || []));
    pages = Number(data.page_info?.total_page) || 1;
    page += 1;
  } while (page <= pages);
  return rows;
}

export async function listAdvertisers(env: Env, session: McpSession): Promise<any[]> {
  const data = await callTool(env, session, 'auth_advertiser_get', {});
  const list = Array.isArray(data) ? data : (data.list || data.advertisers ||
    (data.advertiser_ids || []).map((id: unknown) => ({ advertiser_id: id })));
  return list.map((item: any) => ({ advertiserId: String(item.advertiser_id || item.id || ''),
    advertiserName: item.advertiser_name || item.name || `Advertiser ${item.advertiser_id || item.id}` })).filter((item: any) => item.advertiserId);
}

export async function listStores(env: Env, session: McpSession, advertiserId: string): Promise<any[]> {
  const data = await callTool(env, session, 'gmv_max_store_list_get', { advertiser_id: advertiserId });
  return (data.store_list || data.list || data.stores || []).filter((item: any) => item.is_gmv_max_available !== false)
    .map((item: any) => ({ storeId: String(item.store_id || item.shop_id || item.id || ''),
      storeName: item.store_name || item.shop_name || item.name, storeCode: item.store_code || item.shop_code || '' }))
    .filter((item: any) => item.storeId);
}
