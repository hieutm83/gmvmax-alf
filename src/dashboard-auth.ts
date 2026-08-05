import type { Env } from './types';
import { bytesToBase64Url, HttpError, sha256Base64Url } from './utils';

export type DashboardRole = 'admin' | 'ceo' | 'content';
export type DashboardSession = { role: DashboardRole; issuedAt: number; expiresAt: number };

const COOKIE_NAME = 'alf_dashboard_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

function sessionSecret(env: Env): string {
  const secret = String(env.DASHBOARD_SESSION_SECRET || '').trim();
  if (secret.length < 32) throw new HttpError(503, 'Chưa cấu hình khóa phiên đăng nhập an toàn.');
  return secret;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function safeTextEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) mismatch |= (a[index % a.length] ^ b[index % b.length]);
  return mismatch === 0;
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function decodePayload(value: string): any {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
}

export async function dashboardRoleForPassword(env: Env, password: string): Promise<DashboardRole | null> {
  const configured: Array<[DashboardRole, string]> = [
    ['admin', String(env.ADMIN_PASSWORD || '')],
    ['ceo', String(env.DASHBOARD_CEO_PASSWORD || '')],
    ['content', String(env.DASHBOARD_CONTENT_PASSWORD || '')]
  ];
  let matched: DashboardRole | null = null;
  for (const [role, expected] of configured) {
    if (expected && await safeTextEqual(password, expected)) matched = role;
  }
  return matched;
}

export async function createDashboardSession(env: Env, role: DashboardRole, now = Date.now()): Promise<string> {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ v: 1, role, iat: now, exp: now + SESSION_SECONDS * 1000 })));
  return `${payload}.${await hmac(sessionSecret(env), payload)}`;
}

export async function verifyDashboardSession(env: Env, token: string, now = Date.now()): Promise<DashboardSession | null> {
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra || !await safeTextEqual(signature, await hmac(sessionSecret(env), payload))) return null;
  try {
    const decoded = decodePayload(payload);
    if (decoded?.v !== 1 || !['admin', 'ceo', 'content'].includes(decoded.role) || Number(decoded.exp) <= now) return null;
    return { role: decoded.role, issuedAt: Number(decoded.iat), expiresAt: Number(decoded.exp) };
  } catch {
    return null;
  }
}

export async function dashboardSessionFromRequest(request: Request, env: Env): Promise<DashboardSession | null> {
  const cookie = request.headers.get('cookie') || '';
  const value = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1) || '';
  return value ? verifyDashboardSession(env, value) : null;
}

export function dashboardSessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearDashboardSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

async function loginFingerprint(request: Request, env: Env): Promise<string> {
  const address = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  return sha256Base64Url(`${sessionSecret(env)}:${address}`);
}

export async function assertDashboardLoginAllowed(request: Request, env: Env, now = Date.now()): Promise<string> {
  const fingerprint = await loginFingerprint(request, env);
  const row = await env.DB.prepare('SELECT window_started_at,attempts,blocked_until FROM dashboard_login_attempts WHERE fingerprint=?')
    .bind(fingerprint).first<{ window_started_at: number; attempts: number; blocked_until: number }>();
  if (row?.blocked_until && row.blocked_until > now) throw new HttpError(429, 'Đã nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.');
  if (row && now - row.window_started_at > LOGIN_WINDOW_MS) {
    await env.DB.prepare('DELETE FROM dashboard_login_attempts WHERE fingerprint=?').bind(fingerprint).run();
  }
  return fingerprint;
}

export async function recordDashboardLoginFailure(env: Env, fingerprint: string, now = Date.now()): Promise<void> {
  await env.DB.prepare(`INSERT INTO dashboard_login_attempts(fingerprint,window_started_at,attempts,blocked_until,updated_at)
    VALUES(?,?,1,0,?) ON CONFLICT(fingerprint) DO UPDATE SET
    attempts=CASE WHEN ?-window_started_at>? THEN 1 ELSE attempts+1 END,
    window_started_at=CASE WHEN ?-window_started_at>? THEN ? ELSE window_started_at END,
    blocked_until=CASE WHEN (CASE WHEN ?-window_started_at>? THEN 1 ELSE attempts+1 END)>=? THEN ? ELSE 0 END,
    updated_at=excluded.updated_at`)
    .bind(fingerprint, now, now, now, LOGIN_WINDOW_MS, now, LOGIN_WINDOW_MS, now,
      now, LOGIN_WINDOW_MS, MAX_LOGIN_FAILURES, now + LOGIN_BLOCK_MS).run();
}

export async function clearDashboardLoginFailures(env: Env, fingerprint: string): Promise<void> {
  await env.DB.prepare('DELETE FROM dashboard_login_attempts WHERE fingerprint=?').bind(fingerprint).run();
}

const CONTENT_API_PATHS = new Set([
  '/api/state', '/api/stores', '/api/report', '/api/cads-report', '/api/revenue-analysis', '/api/content-koc-analysis', '/api/koc-analysis',
  '/api/product-videos', '/api/creative-summaries', '/api/comparison', '/api/video-stats', '/api/video-metadata',
  '/api/customer-service-analysis'
]);
const ADMIN_API_PATHS = new Set([
  '/api/oauth/connect', '/api/oauth/refresh', '/api/oauth/disconnect', '/api/seller/disconnect', '/api/admin/verify'
]);

export function assertDashboardApiAccess(role: DashboardRole, path: string, method: string): void {
  if (role === 'admin') return;
  if (ADMIN_API_PATHS.has(path) || (path === '/api/finance-sku-cost' && method !== 'GET')) throw new HttpError(403, 'Tài khoản không có quyền thực hiện thao tác này.');
  if (role === 'content' && !CONTENT_API_PATHS.has(path)) throw new HttpError(403, 'Tài khoản không có quyền truy cập dữ liệu này.');
}
