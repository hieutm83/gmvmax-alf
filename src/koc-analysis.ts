import type { Env } from './types';
import { authorizedShop, epoch, shopRequest } from './seller';
import { cacheGet, cachePut, numberValue, shiftDate, stableKey } from './utils';

type SourceKey = 'video' | 'showcase' | 'live' | 'linkshare';

type KocSkuRow = {
  orderId: string;
  createTime: number;
  creatorUsername: string;
  contentType: string;
  source: SourceKey;
  productId: string;
  quantity: number;
  gmv: number;
  fullyReturned: boolean;
};

type Aggregate = {
  orderIds: Set<string>;
  skuOrders: number;
  returnedSkuOrders: number;
  gmv: number;
};

const SOURCE_KEYS: SourceKey[] = ['video', 'showcase', 'live', 'linkshare'];

function emptyAggregate(): Aggregate {
  return { orderIds: new Set<string>(), skuOrders: 0, returnedSkuOrders: 0, gmv: 0 };
}

function sourceFor(contentType: unknown): SourceKey {
  const value = String(contentType || '').toUpperCase();
  if (value === 'VIDEO') return 'video';
  if (value === 'LIVE' || value === 'PRE_LIVE') return 'live';
  if (value === 'LINKSHARE') return 'linkshare';
  return 'showcase';
}

function gmvForSku(sku: any): number {
  const estimated = numberValue(sku?.estimated_commission_base?.amount);
  if (estimated) return estimated;
  return numberValue(sku?.price?.amount) * Math.max(1, numberValue(sku?.quantity));
}

function flattenOrders(orders: any[]): KocSkuRow[] {
  const rows: KocSkuRow[] = [];
  for (const order of orders) {
    const orderId = String(order?.id || '');
    for (const sku of Array.isArray(order?.skus) ? order.skus : []) {
      const creatorUsername = String(sku?.creator_username || '').trim().replace(/^@/, '');
      const productId = String(sku?.product_id || '');
      if (!orderId || !creatorUsername || !productId) continue;
      const contentType = String(sku?.content_type || '').toUpperCase();
      rows.push({
        orderId,
        createTime: numberValue(order?.create_time),
        creatorUsername,
        contentType,
        source: sourceFor(contentType),
        productId,
        quantity: Math.max(1, numberValue(sku?.quantity)),
        gmv: gmvForSku(sku),
        fullyReturned: String(sku?.fully_return || '').toLowerCase() === 'yes'
      });
    }
  }
  return rows;
}

function addAggregate(target: Aggregate, row: KocSkuRow): void {
  target.orderIds.add(row.orderId);
  target.skuOrders += 1;
  target.returnedSkuOrders += row.fullyReturned ? 1 : 0;
  target.gmv += row.gmv;
}

function publicAggregate(value: Aggregate): any {
  return {
    orders: value.orderIds.size,
    skuOrders: value.skuOrders,
    cancellationRate: value.skuOrders ? value.returnedSkuOrders / value.skuOrders : 0,
    gmv: value.gmv
  };
}

function periodComparison(current: number, previous: number): any {
  return {
    current,
    previous,
    delta: current - previous,
    rate: previous ? (current - previous) / previous : null,
    isNew: previous === 0 && current > 0
  };
}

export function summarizeKocOrders(currentOrders: any[], previousOrders: any[], productNames: Record<string, string>): any {
  const current = flattenOrders(currentOrders);
  const previous = flattenOrders(previousOrders);
  const currentOrderIds = new Set(current.map((row) => row.orderId));
  const previousOrderIds = new Set(previous.map((row) => row.orderId));
  const currentCreators = new Set(current.map((row) => row.creatorUsername));
  const previousCreators = new Set(previous.map((row) => row.creatorUsername));
  const currentGmv = current.reduce((sum, row) => sum + row.gmv, 0);
  const previousGmv = previous.reduce((sum, row) => sum + row.gmv, 0);

  const creatorMap = new Map<string, Record<SourceKey, Aggregate>>();
  for (const row of current) {
    let groups = creatorMap.get(row.creatorUsername);
    if (!groups) {
      groups = { video: emptyAggregate(), showcase: emptyAggregate(), live: emptyAggregate(), linkshare: emptyAggregate() };
      creatorMap.set(row.creatorUsername, groups);
    }
    addAggregate(groups[row.source], row);
  }
  const creators = Array.from(creatorMap.entries()).map(([creatorUsername, groups]) => {
    const total = emptyAggregate();
    SOURCE_KEYS.forEach((key) => {
      const group = groups[key];
      group.orderIds.forEach((id) => total.orderIds.add(id));
      total.skuOrders += group.skuOrders;
      total.returnedSkuOrders += group.returnedSkuOrders;
      total.gmv += group.gmv;
    });
    return {
      creatorUsername,
      sources: Object.fromEntries(SOURCE_KEYS.map((key) => [key, publicAggregate(groups[key])])),
      total: publicAggregate(total)
    };
  }).sort((left, right) => right.total.gmv - left.total.gmv || right.total.orders - left.total.orders);

  const previousByProductCreator = new Map<string, Aggregate>();
  for (const row of previous) {
    const key = `${row.productId}\u0000${row.creatorUsername}`;
    const aggregate = previousByProductCreator.get(key) || emptyAggregate();
    addAggregate(aggregate, row);
    previousByProductCreator.set(key, aggregate);
  }
  const productMap = new Map<string, Map<string, Aggregate>>();
  for (const row of current) {
    let creatorGroups = productMap.get(row.productId);
    if (!creatorGroups) { creatorGroups = new Map<string, Aggregate>(); productMap.set(row.productId, creatorGroups); }
    const aggregate = creatorGroups.get(row.creatorUsername) || emptyAggregate();
    addAggregate(aggregate, row);
    creatorGroups.set(row.creatorUsername, aggregate);
  }
  const products = Array.from(productMap.entries()).map(([productId, creatorGroups]) => {
    const productGmv = Array.from(creatorGroups.values()).reduce((sum, value) => sum + value.gmv, 0);
    const creatorsForProduct = Array.from(creatorGroups.entries()).map(([creatorUsername, aggregate]) => {
      const previousAggregate = previousByProductCreator.get(`${productId}\u0000${creatorUsername}`) || emptyAggregate();
      return {
        creatorUsername,
        ...publicAggregate(aggregate),
        gmvShare: productGmv ? aggregate.gmv / productGmv : 0,
        comparison: periodComparison(aggregate.orderIds.size, previousAggregate.orderIds.size),
        details: current.filter((row) => row.productId === productId && row.creatorUsername === creatorUsername)
          .map((row) => ({ orderId: row.orderId, createTime: row.createTime, contentType: row.contentType,
            quantity: row.quantity, gmv: row.gmv, fullyReturned: row.fullyReturned }))
      };
    }).sort((left, right) => right.gmv - left.gmv || right.orders - left.orders);
    return { productId, productName: productNames[productId] || `Sản phẩm ${productId}`, gmv: productGmv, creators: creatorsForProduct };
  }).sort((left, right) => right.gmv - left.gmv);

  return {
    totals: {
      creators: currentCreators.size,
      orders: currentOrderIds.size,
      revenue: currentGmv,
      comparison: {
        creators: periodComparison(currentCreators.size, previousCreators.size),
        orders: periodComparison(currentOrderIds.size, previousOrderIds.size),
        revenue: periodComparison(currentGmv, previousGmv)
      }
    },
    creators,
    products
  };
}

async function affiliateOrdersForPeriod(env: Env, shopCipher: string, startDate: string, endDate: string): Promise<any[]> {
  const orders: any[] = [];
  let pageToken = '';
  let pages = 0;
  do {
    const data = await shopRequest(env, '/affiliate_seller/202410/orders/search', 'POST', {
      shop_cipher: shopCipher,
      page_size: 100,
      page_token: pageToken || undefined
    }, { create_time_ge: epoch(startDate), create_time_lt: epoch(shiftDate(endDate, 1)) });
    orders.push(...(Array.isArray(data.orders) ? data.orders : []));
    pageToken = String(data.next_page_token || '');
    pages += 1;
  } while (pageToken && pages < 100);
  return orders;
}

async function productNamesForShop(env: Env, shopCipher: string): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  let pageToken = '';
  let pages = 0;
  do {
    const data = await shopRequest(env, '/product/202502/products/search', 'POST', {
      shop_cipher: shopCipher,
      page_size: 100,
      page_token: pageToken || undefined
    }, { status: 'ALL', locale: 'vi-VN' });
    for (const product of Array.isArray(data.products) ? data.products : []) {
      if (product?.id) names[String(product.id)] = String(product.title || product.id);
    }
    pageToken = String(data.next_page_token || '');
    pages += 1;
  } while (pageToken && pages < 30);
  return names;
}

export async function loadKocAnalysis(env: Env, input: { startDate: string; endDate: string; forceRefresh?: boolean }): Promise<any> {
  const days = Math.round((Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / 86400000) + 1;
  if (days > 92) throw new Error('Phân tích KOC hỗ trợ tối đa 3 tháng cho mỗi lần tải.');
  const key = stableKey('seller-koc-analysis-v1', { startDate: input.startDate, endDate: input.endDate });
  if (!input.forceRefresh) {
    const cached = await cacheGet<any>(env, key);
    if (cached) return { ...cached, cacheStatus: 'HIT' };
  }
  const shop = await authorizedShop(env);
  const shopCipher = String(shop?.cipher || shop?.shop_cipher || shop?.id || '');
  if (!shopCipher) throw new Error('Không tìm thấy TikTok Shop đã ủy quyền.');
  const previousEndDate = shiftDate(input.startDate, -1);
  const previousStartDate = shiftDate(previousEndDate, -(days - 1));
  const [currentOrders, previousOrders, productNames] = await Promise.all([
    affiliateOrdersForPeriod(env, shopCipher, input.startDate, input.endDate),
    affiliateOrdersForPeriod(env, shopCipher, previousStartDate, previousEndDate),
    productNamesForShop(env, shopCipher).catch(() => ({}))
  ]);
  const result = {
    startDate: input.startDate,
    endDate: input.endDate,
    previousStartDate,
    previousEndDate,
    generatedAt: new Date().toISOString(),
    ...summarizeKocOrders(currentOrders, previousOrders, productNames),
    cacheStatus: 'REFRESHED'
  };
  await cachePut(env, key, result, 300).catch(() => undefined);
  return result;
}
