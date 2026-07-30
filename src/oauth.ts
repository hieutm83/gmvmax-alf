import type { Env, OAuthTokenSet } from './types';
import { decryptTokens, encryptTokens } from './crypto';
import { formEncode, randomBase64Url, sha256Base64Url } from './utils';

const TOKEN_KEY = 'oauth_tokens';
const CLIENT_KEY = 'oauth_client';

async function setting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function putSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO app_settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(key, value).run();
}

async function oauthJson(url: string, init: RequestInit): Promise<Record<string, any>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: Record<string, any> = {};
  try { body = JSON.parse(text); } catch { /* handled below */ }
  if (!response.ok || body.error) {
    throw new Error(body.error_description || body.error || body.message || `OAuth HTTP ${response.status}`);
  }
  return body;
}

async function getClient(env: Env, origin: string, callbackUri?: string): Promise<{ clientId: string; redirectUri: string }> {
  const redirectUri = callbackUri || `${origin}/auth/callback`;
  const stored = await setting(env, CLIENT_KEY);
  if (stored) {
    const parsed = JSON.parse(stored) as { clientId: string; redirectUri: string };
    if (parsed.redirectUri === redirectUri) return parsed;
    const existingTokens = await readTokens(env);
    if (existingTokens && !existingTokens.clientId) {
      existingTokens.clientId = parsed.clientId;
      await putSetting(env, TOKEN_KEY, await encryptTokens(env, existingTokens));
    }
  }
  const data = await oauthJson(`${env.MCP_URL}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'TikTok GMV Max Cloudflare Report', redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', scope: env.MCP_SCOPE
    })
  });
  if (!data.client_id) throw new Error('OAuth did not return client_id.');
  const client = { clientId: String(data.client_id), redirectUri };
  await putSetting(env, CLIENT_KEY, JSON.stringify(client));
  return client;
}

export async function createAuthorizationUrl(env: Env, origin: string): Promise<string> {
  const client = await getClient(env, origin);
  const verifier = randomBase64Url(64);
  const state = randomBase64Url(32);
  await env.DB.prepare('INSERT INTO oauth_states(state,verifier,redirect_uri,expires_at) VALUES(?,?,?,?)')
    .bind(state, verifier, client.redirectUri, Date.now() + 30 * 60_000).run();
  const query = formEncode({ response_type: 'code', client_id: client.clientId,
    redirect_uri: client.redirectUri, scope: env.MCP_SCOPE, state,
    code_challenge: await sha256Base64Url(verifier), code_challenge_method: 'S256', resource: env.MCP_URL });
  return `${env.MCP_URL}/oauth/authorize?${query}`;
}

export async function handleOAuthCallback(env: Env, url: URL): Promise<Response> {
  const state = url.searchParams.get('state') || '';
  const row = await env.DB.prepare('SELECT verifier,redirect_uri,expires_at FROM oauth_states WHERE state=?')
    .bind(state).first<{ verifier: string; redirect_uri: string; expires_at: number }>();
  try {
    if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error')!);
    if (!row || row.expires_at < Date.now()) throw new Error('Phien OAuth khong hop le hoac da het han.');
    const client = await getClient(env, url.origin, row.redirect_uri);
    const data = await oauthJson(`${env.MCP_URL}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode({ grant_type: 'authorization_code', code: url.searchParams.get('code'),
        client_id: client.clientId, redirect_uri: row.redirect_uri, code_verifier: row.verifier, resource: env.MCP_URL })
    });
    await saveTokens(env, data, undefined, client.clientId);
    await env.DB.prepare('DELETE FROM oauth_states WHERE state=?').bind(state).run();
    return new Response(null, { status: 302, headers: { Location: '/?connected=1' } });
  } catch (error) {
    return new Response(`TikTok OAuth: ${error instanceof Error ? error.message : String(error)}`, { status: 400 });
  }
}

async function saveTokens(env: Env, raw: Record<string, any>, previous?: OAuthTokenSet, clientId?: string): Promise<OAuthTokenSet> {
  if (!raw.access_token) throw new Error('OAuth did not return access_token.');
  const tokens: OAuthTokenSet = {
    accessToken: String(raw.access_token), refreshToken: String(raw.refresh_token || previous?.refreshToken || ''),
    expiresAt: raw.expires_in ? Date.now() + Math.max(Number(raw.expires_in) - 60, 60) * 1000 : 0,
    clientId: clientId || previous?.clientId,
    tokenType: raw.token_type, scope: raw.scope
  };
  await putSetting(env, TOKEN_KEY, await encryptTokens(env, tokens));
  return tokens;
}

export async function readTokens(env: Env): Promise<OAuthTokenSet | null> {
  const encrypted = await setting(env, TOKEN_KEY);
  return encrypted ? decryptTokens(env, encrypted) : null;
}

export async function getAccessToken(env: Env, force = false): Promise<string> {
  const tokens = await readTokens(env);
  if (!tokens) throw new Error('Chua ket noi TikTok.');
  if (!force && tokens.accessToken && (!tokens.expiresAt || tokens.expiresAt > Date.now())) return tokens.accessToken;
  const stub = env.OAUTH_COORDINATOR.get(env.OAUTH_COORDINATOR.idFromName('tiktok'));
  const response = await stub.fetch('https://oauth.internal/refresh', { method: 'POST' });
  const body = await response.json<{ accessToken?: string; error?: string }>();
  if (!response.ok || !body.accessToken) throw new Error(body.error || 'Khong refresh duoc TikTok token.');
  return body.accessToken;
}

export async function disconnect(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM app_settings WHERE key=?').bind(TOKEN_KEY).run();
}

export class OAuthCoordinator implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    void this.state;
  }
  async fetch(): Promise<Response> {
    try {
      const tokens = await readTokens(this.env);
      if (!tokens?.refreshToken) throw new Error('Khong co refresh token. Vui long ket noi lai mot lan.');
      const clientRaw = await setting(this.env, CLIENT_KEY);
      if (!tokens.clientId && !clientRaw) throw new Error('Khong co OAuth client.');
      const clientId = tokens.clientId || (JSON.parse(clientRaw!) as { clientId: string }).clientId;
      const raw = await oauthJson(`${this.env.MCP_URL}/oauth/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formEncode({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken,
          client_id: clientId, scope: this.env.MCP_SCOPE, resource: this.env.MCP_URL })
      });
      const saved = await saveTokens(this.env, raw, tokens, clientId);
      return Response.json({ accessToken: saved.accessToken });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }
}
