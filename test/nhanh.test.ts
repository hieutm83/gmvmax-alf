import { describe, expect, it } from 'vitest';
import { createNhanhAuthorizationUrl, receiveNhanhWebhook } from '../src/nhanh';
import type { Env } from '../src/types';

describe('Nhanh.vn integration', () => {
  it('creates a v3 authorization URL with the registered callback', () => {
    const env = {
      NHANH_APP_ID: '76036',
      NHANH_SECRET_KEY: 'test-secret',
      PUBLIC_BASE_URL: 'https://example.workers.dev'
    } as Env;
    const url = new URL(createNhanhAuthorizationUrl(env, 'https://ignored.example'));
    expect(url.origin + url.pathname).toBe('https://nhanh.vn/oauth');
    expect(url.searchParams.get('version')).toBe('3.0');
    expect(url.searchParams.get('appId')).toBe('76036');
    expect(url.searchParams.get('returnLink')).toBe('https://example.workers.dev/nhanh/callback');
  });

  it('acknowledges an empty webhook health check', async () => {
    const response = await receiveNhanhWebhook(new Request('https://example.test/nhanh/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ''
    }), {} as Env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
  });
});
