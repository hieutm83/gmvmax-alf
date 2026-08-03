import { describe, expect, it } from 'vitest';
import { oauthConnectionState } from '../src/oauth';

const now = Date.UTC(2026, 7, 3, 4, 0, 0);

describe('TikTok Ads MCP OAuth state', () => {
  it('reports a healthy refreshable connection without exposing tokens', () => {
    const state = oauthConnectionState({ accessToken: 'secret', refreshToken: 'refresh-secret',
      expiresAt: now + 2 * 60 * 60_000, refreshExpiresAt: now + 30 * 86400_000, scope: 'mcp:tt4b' }, 'fallback', now);
    expect(state).toMatchObject({ connected: true, status: 'connected', refreshAvailable: true,
      canRefresh: true, scope: 'mcp:tt4b' });
    expect(state).not.toHaveProperty('accessToken');
    expect(state).not.toHaveProperty('refreshToken');
  });

  it('warns before access-token expiry', () => {
    expect(oauthConnectionState({ accessToken: 'secret', refreshToken: 'refresh',
      expiresAt: now + 10 * 60_000 }, 'mcp:tt4b', now).status).toBe('expiring');
  });

  it('distinguishes a refreshable expired access token from an expired connection', () => {
    expect(oauthConnectionState({ accessToken: 'secret', refreshToken: 'refresh', expiresAt: now - 1 },
      'mcp:tt4b', now).status).toBe('refresh-required');
    expect(oauthConnectionState({ accessToken: 'secret', refreshToken: '', expiresAt: now - 1 },
      'mcp:tt4b', now).status).toBe('expired');
  });
});
