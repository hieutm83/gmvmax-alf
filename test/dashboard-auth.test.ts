import { describe, expect, it } from 'vitest';
import { assertDashboardApiAccess, createDashboardSession, dashboardRoleForPassword, verifyDashboardSession } from '../src/dashboard-auth';
import type { Env } from '../src/types';

const env = {
  ADMIN_PASSWORD: 'admin-pass',
  DASHBOARD_CEO_PASSWORD: 'ceo-pass',
  DASHBOARD_CONTENT_PASSWORD: 'content-pass',
  DASHBOARD_ADS_PASSWORD: 'ads-pass',
  DASHBOARD_SESSION_SECRET: 'a-session-secret-that-is-longer-than-thirty-two-characters'
} as Env;

describe('dashboard authentication', () => {
  it('maps each configured password to one role', async () => {
    await expect(dashboardRoleForPassword(env, 'admin-pass')).resolves.toBe('admin');
    await expect(dashboardRoleForPassword(env, 'ceo-pass')).resolves.toBe('ceo');
    await expect(dashboardRoleForPassword(env, 'content-pass')).resolves.toBe('content');
    await expect(dashboardRoleForPassword(env, 'ads-pass')).resolves.toBe('ads');
    await expect(dashboardRoleForPassword(env, 'wrong')).resolves.toBeNull();
  });

  it('creates a signed 30-day session and rejects expired sessions', async () => {
    const now = Date.UTC(2026, 7, 3);
    const token = await createDashboardSession(env, 'ceo', now);
    await expect(verifyDashboardSession(env, token, now + 29 * 86400000)).resolves.toMatchObject({ role: 'ceo' });
    await expect(verifyDashboardSession(env, token, now + 31 * 86400000)).resolves.toBeNull();
    await expect(verifyDashboardSession(env, `${token}broken`, now)).resolves.toBeNull();
  });

  it('limits content to three report API groups and keeps writes admin-only', () => {
    expect(() => assertDashboardApiAccess('content', '/api/report', 'POST')).not.toThrow();
    expect(() => assertDashboardApiAccess('content', '/api/content-koc-analysis', 'POST')).not.toThrow();
    expect(() => assertDashboardApiAccess('content', '/api/finance-analysis', 'POST')).toThrow();
    expect(() => assertDashboardApiAccess('ads', '/api/ads-overview', 'POST')).not.toThrow();
    expect(() => assertDashboardApiAccess('ads', '/api/facebook-ads', 'POST')).not.toThrow();
    expect(() => assertDashboardApiAccess('ads', '/api/report', 'POST')).not.toThrow();
    expect(() => assertDashboardApiAccess('ads', '/api/cads-report', 'POST')).toThrow();
    expect(() => assertDashboardApiAccess('ceo', '/api/finance-analysis', 'POST')).not.toThrow();
    expect(() => assertDashboardApiAccess('ceo', '/api/oauth/refresh', 'POST')).toThrow();
    expect(() => assertDashboardApiAccess('ceo', '/api/finance-sku-cost', 'POST')).toThrow();
    expect(() => assertDashboardApiAccess('admin', '/api/finance-sku-cost', 'POST')).not.toThrow();
  });
});
