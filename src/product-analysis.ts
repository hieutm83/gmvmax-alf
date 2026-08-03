import type { Env } from './types';
import { authorizedShop, shopRequest } from './seller';
import { cacheGet, cachePut, numberValue, shiftDate, stableKey } from './utils';

export type ProductMetricSet = {
  gmv: number;
  orders: number;
  skuOrders: number;
  soldItems: number;
  impressions: number;
  clicks: number;
  addCartCount: number;
  estimatedCustomers: number;
  aov: number | null;
  ctr: number | null;
  addCartRate: number | null;
  ctor: number | null;
};

type ChannelKey = 'affiliate' | 'sellerProductCard' | 'sellerVideo' | 'sellerLive';

const CHANNEL_FIELDS: Record<ChannelKey, string> = {
  affiliate: 'affiliate_total_performance',
  sellerProductCard: 'seller_product_card_performance',
  sellerVideo: 'seller_video_performance',
  sellerLive: 'seller_live_performance'
};

function amount(value: any): number {
  return numberValue(value?.amount ?? value?.value ?? value);
}

function emptyMetrics(): ProductMetricSet {
  return { gmv: 0, orders: 0, skuOrders: 0, soldItems: 0, impressions: 0, clicks: 0,
    addCartCount: 0, estimatedCustomers: 0, aov: null, ctr: null, addCartRate: null, ctor: null };
}

function metricNumber(source: any, aliases: string[]): number {
  for (const alias of aliases) {
    if (source?.[alias] !== undefined && source?.[alias] !== null) return numberValue(source[alias]);
  }
  return 0;
}

function normalizeMetrics(source: any, channel: boolean): ProductMetricSet {
  const metrics = emptyMetrics();
  metrics.gmv = amount(source?.[channel ? 'attributed_gmv' : 'gmv']);
  metrics.orders = metricNumber(source, channel ? ['attributed_orders', 'orders'] : ['orders', 'orders_count']);
  metrics.skuOrders = metricNumber(source, channel ? ['attributed_sku_orders', 'sku_orders'] : ['sku_orders']);
  metrics.soldItems = metricNumber(source, channel ? ['attributed_sold_items', 'sold_items'] : ['sold_items', 'units_sold']);
  metrics.impressions = metricNumber(source, ['product_impressions']);
  metrics.clicks = metricNumber(source, ['product_clicks']);
  metrics.addCartCount = metricNumber(source, ['add_cart_count']);
  metrics.estimatedCustomers = metricNumber(source, ['estimated_customers']);
  return deriveMetrics(metrics);
}

function deriveMetrics(metrics: ProductMetricSet): ProductMetricSet {
  return { ...metrics,
    aov: metrics.skuOrders > 0 ? metrics.gmv / metrics.skuOrders : null,
    ctr: metrics.impressions > 0 ? metrics.clicks / metrics.impressions : null,
    addCartRate: metrics.clicks > 0 ? metrics.addCartCount / metrics.clicks : null,
    ctor: metrics.clicks > 0 ? metrics.skuOrders / metrics.clicks : null };
}

function addMetrics(target: ProductMetricSet, source: ProductMetricSet): void {
  target.gmv += source.gmv; target.orders += source.orders; target.skuOrders += source.skuOrders;
  target.soldItems += source.soldItems; target.impressions += source.impressions;
  target.clicks += source.clicks; target.addCartCount += source.addCartCount;
  target.estimatedCustomers += source.estimatedCustomers;
}

function catalogImage(product: any): string {
  const images = product?.main_images || product?.images || [];
  const image = images[0] || product?.main_image || {};
  const urls = image?.thumb_urls || image?.urls || image?.url_list || [];
  return String(urls[0] || image?.url || product?.image_url || '');
}

export function summarizeProductPerformance(products: any[], catalog: Record<string, any> = {}): any {
  const total = emptyMetrics();
  const channels = Object.fromEntries(Object.keys(CHANNEL_FIELDS).map((key) => [key, emptyMetrics()])) as Record<ChannelKey, ProductMetricSet>;
  const rows = products.map((product) => {
    const id = String(product.id || product.product_id || '');
    const totalMetrics = normalizeMetrics(product.total_performance || {}, false);
    addMetrics(total, totalMetrics);
    const productChannels = {} as Record<ChannelKey, ProductMetricSet>;
    (Object.keys(CHANNEL_FIELDS) as ChannelKey[]).forEach((key) => {
      const metrics = normalizeMetrics(product[CHANNEL_FIELDS[key]] || {}, true);
      productChannels[key] = metrics;
      addMetrics(channels[key], metrics);
    });
    const item = catalog[id] || {};
    return { id, title: String(item.title || product.product_name || product.title || `Sản phẩm ${id}`),
      imageUrl: String(item.imageUrl || catalogImage(product)), total: totalMetrics, channels: productChannels };
  });
  return {
    total: deriveMetrics(total),
    channels: Object.fromEntries((Object.keys(CHANNEL_FIELDS) as ChannelKey[]).map((key) => [key, deriveMetrics(channels[key])])),
    products: rows
  };
}

async function fetchProductPages(env: Env, shopCipher: string, startDate: string, endDate: string): Promise<{ products: any[]; latestAvailableDate: string | null }> {
  const products: any[] = [];
  let pageToken = ''; let pages = 0; let latestAvailableDate: string | null = null;
  do {
    const data = await shopRequest(env, '/analytics/202605/shop_products/performance', 'GET', {
      shop_cipher: shopCipher, start_date_ge: startDate, end_date_lt: shiftDate(endDate, 1),
      page_size: 100, page_token: pageToken || undefined, sort_field: 'gmv', sort_order: 'DESC',
      currency: 'LOCAL', product_status_filter: 'ALL'
    });
    products.push(...(data.products || []));
    latestAvailableDate = data.latest_available_date || latestAvailableDate;
    pageToken = String(data.next_page_token || ''); pages += 1;
  } while (pageToken && pages < 100);
  return { products, latestAvailableDate };
}

async function productCatalog(env: Env, shopCipher: string): Promise<Record<string, any>> {
  const key = stableKey('product-analysis-catalog-v2', { shopCipher });
  const cached = await cacheGet<Record<string, any>>(env, key);
  if (cached) return cached;
  const catalog: Record<string, any> = {};
  let pageToken = ''; let pages = 0;
  do {
    const data = await shopRequest(env, '/product/202502/products/search', 'POST', {
      shop_cipher: shopCipher, page_size: 100, page_token: pageToken || undefined
    }, { status: 'ALL', locale: 'vi-VN' });
    for (const product of data.products || []) {
      const id = String(product.id || product.product_id || '');
      if (!id) continue;
      catalog[id] = { title: String(product.title || product.name || `Sản phẩm ${id}`), imageUrl: catalogImage(product) };
    }
    pageToken = String(data.next_page_token || ''); pages += 1;
  } while (pageToken && pages < 100);
  await cachePut(env, key, catalog, 21600).catch(() => undefined);
  return catalog;
}

async function productDetail(env: Env, shopCipher: string, productId: string): Promise<any | null> {
  const key = stableKey('product-analysis-detail-v1', { shopCipher, productId });
  const cached = await cacheGet<any>(env, key);
  if (cached) return cached;
  try {
    const product = await shopRequest(env, `/product/202309/products/${productId}`, 'GET', { shop_cipher: shopCipher });
    const detail = {
      title: String(product?.title || product?.name || ''),
      imageUrl: catalogImage(product)
    };
    if (detail.title || detail.imageUrl) await cachePut(env, key, detail, 21600).catch(() => undefined);
    return detail;
  } catch (error) {
    console.warn('Product image lookup failed', productId, error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function hydrateProductImages(env: Env, shopCipher: string, catalog: Record<string, any>, products: any[]): Promise<void> {
  const ids = products
    .filter((product) => Object.values(CHANNEL_FIELDS).some((field) => numberValue(product?.[field]?.product_clicks) > 0))
    .map((product) => String(product.id || product.product_id || ''))
    .filter((id) => id && !catalog[id]?.imageUrl);
  for (let offset = 0; offset < ids.length; offset += 8) {
    const batch = ids.slice(offset, offset + 8);
    const details = await Promise.all(batch.map((id) => productDetail(env, shopCipher, id)));
    batch.forEach((id, index) => {
      const detail = details[index];
      if (!detail) return;
      catalog[id] = {
        title: detail.title || catalog[id]?.title || `Sản phẩm ${id}`,
        imageUrl: detail.imageUrl || catalog[id]?.imageUrl || ''
      };
    });
  }
}

function dayCount(startDate: string, endDate: string): number {
  return Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
}

export async function loadProductAnalysis(env: Env, input: { startDate: string; endDate: string; forceRefresh?: boolean }): Promise<any> {
  const key = stableKey('product-analysis-v2', { startDate: input.startDate, endDate: input.endDate });
  if (!input.forceRefresh) {
    const cached = await cacheGet<any>(env, key);
    if (cached) return cached;
  }
  const shop = await authorizedShop(env);
  const shopCipher = String(shop?.cipher || shop?.shop_cipher || shop?.id || '');
  if (!shopCipher) throw new Error('Không tìm thấy TikTok Shop đã được cấp quyền.');
  const days = dayCount(input.startDate, input.endDate);
  const previousEndDate = shiftDate(input.startDate, -1);
  const previousStartDate = shiftDate(previousEndDate, -(days - 1));
  const [currentRaw, previousRaw, catalog] = await Promise.all([
    fetchProductPages(env, shopCipher, input.startDate, input.endDate),
    fetchProductPages(env, shopCipher, previousStartDate, previousEndDate),
    productCatalog(env, shopCipher)
  ]);
  await hydrateProductImages(env, shopCipher, catalog, currentRaw.products);
  const current = summarizeProductPerformance(currentRaw.products, catalog);
  const previous = summarizeProductPerformance(previousRaw.products, catalog);
  const chartStartDate = days === 1 ? shiftDate(input.endDate, -6) : days > 31 ? shiftDate(input.endDate, -30) : input.startDate;
  const daily: any[] = [];
  for (let date = chartStartDate; date <= input.endDate; date = shiftDate(date, 1)) {
    const raw = days === 1 && date === input.startDate ? currentRaw : await fetchProductPages(env, shopCipher, date, date);
    const metrics = summarizeProductPerformance(raw.products).total;
    daily.push({ date, clicks: metrics.clicks, ctr: metrics.ctr });
  }
  const result = {
    startDate: input.startDate, endDate: input.endDate, previousStartDate, previousEndDate,
    generatedAt: new Date().toISOString(), latestAvailableDate: currentRaw.latestAvailableDate,
    current, previous, daily, chartMode: days === 1 ? 'LAST_7_DAYS' : 'SELECTED_RANGE',
    warnings: days > 31 ? ['Biểu đồ hiển thị 31 ngày gần nhất để bảo đảm giới hạn API.'] : []
  };
  await cachePut(env, key, result, 300).catch(() => undefined);
  return result;
}
