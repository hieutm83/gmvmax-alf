import type { Env } from './types';
import { authorizedShop, shopRequest } from './seller';
import { cacheGet, cachePut, numberValue, shiftDate, stableKey } from './utils';

async function periodMetrics(env: Env, shopCipher: string, startDate: string, endDate: string): Promise<any> {
  const [performanceData, sessions] = await Promise.all([
    shopRequest(env, '/customer_service/202407/performance', 'GET', {
      shop_cipher: shopCipher, support_date_ge: startDate, support_date_lt: shiftDate(endDate, 1)
    }),
    (async () => {
      const rows: any[] = []; let pageToken = ''; let pages = 0;
      const begin = Math.floor(Date.parse(`${startDate}T00:00:00+07:00`) / 1000);
      const end = Math.floor(Date.parse(`${shiftDate(endDate, 1)}T00:00:00+07:00`) / 1000);
      do {
        const data = await shopRequest(env, '/customer_service/202602/sessions/search', 'POST', {
          shop_cipher: shopCipher, page_size: 100, page_token: pageToken || undefined, locale: 'vi-VN'
        }, { begin_time_ge: begin, begin_time_lt: end });
        rows.push(...(data.sessions || [])); pageToken = String(data.next_page_token || ''); pages += 1;
      } while (pageToken && pages < 100);
      return rows;
    })()
  ]);
  const performance = performanceData?.performance || {};
  return {
    responseRate: numberValue(performance.response_percentage),
    averageResponseMinutes: numberValue(performance.response_time_mins),
    supportSessionCount: numberValue(performance.support_session_count),
    unansweredWithin24Hours: sessions.filter((session) => session?.first_response_late === true).length
  };
}

export async function loadCustomerServiceAnalysis(env: Env, input: { startDate: string; endDate: string; forceRefresh?: boolean }): Promise<any> {
  const key = stableKey('customer-service-analysis-v1', { startDate: input.startDate, endDate: input.endDate });
  if (!input.forceRefresh) {
    const cached = await cacheGet<any>(env, key);
    if (cached) return cached;
  }
  const shop = await authorizedShop(env);
  const shopCipher = String(shop?.cipher || shop?.shop_cipher || shop?.id || '');
  if (!shopCipher) throw new Error('Không tìm thấy TikTok Shop đã được cấp quyền.');
  const days = Math.floor((Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / 86400000) + 1;
  const previousEndDate = shiftDate(input.startDate, -1);
  const previousStartDate = shiftDate(previousEndDate, -(days - 1));
  const [current, previous] = await Promise.all([
    periodMetrics(env, shopCipher, input.startDate, input.endDate),
    periodMetrics(env, shopCipher, previousStartDate, previousEndDate)
  ]);
  const result = { startDate: input.startDate, endDate: input.endDate, previousStartDate, previousEndDate, current, previous, generatedAt: new Date().toISOString() };
  await cachePut(env, key, result, 300).catch(() => undefined);
  return result;
}
