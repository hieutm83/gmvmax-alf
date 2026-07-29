import type { Env } from './types';

export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin'
    }
  });
}

export async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    throw new HttpError(415, 'Yêu cầu phải dùng application/json.');
  }
  return request.json<T>();
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function validateId(value: unknown, label: string): string {
  const id = String(value ?? '').trim();
  if (!/^\d+$/.test(id)) throw new HttpError(400, `${label} không hợp lệ.`);
  return id;
}

export function validateDate(value: unknown, label: string): string {
  const date = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new HttpError(400, `${label} không hợp lệ.`);
  }
  return date;
}

export function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dateInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

export function hourInTimezone(date: Date, timezone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', hour12: false
  }).format(date));
}

export function randomBase64Url(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToBase64Url(data);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function formEncode(values: Record<string, unknown>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

export async function cacheGet<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare(
    'SELECT payload FROM report_cache WHERE cache_key = ? AND expires_at > ?'
  ).bind(key, Date.now()).first<{ payload: string }>();
  return row ? JSON.parse(row.payload) as T : null;
}

export async function cachePut(env: Env, key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO report_cache(cache_key, payload, expires_at) VALUES(?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,
       expires_at=excluded.expires_at, created_at=CURRENT_TIMESTAMP`
  ).bind(key, JSON.stringify(value), Date.now() + ttlSeconds * 1000).run();
}

export function stableKey(prefix: string, value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]));
    }
    return input;
  };
  return `${prefix}:${JSON.stringify(normalize(value))}`;
}

export function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
