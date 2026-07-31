import type { Env } from './types';
import { resolveDefaultStoreId } from './mcp';
import { loadMainReport } from './reports';
import { authorizedShop, epoch, shopRequest } from './seller';
import { cacheGet, cachePut, dateInTimezone, numberValue, shiftDate, stableKey } from './utils';

type Scope = { startDate: string; endDate: string; forceRefresh?: boolean };
type NumberMap = Record<string, number>;

const PLATFORM_FEES = new Set([
  'platform_commission_amount', 'transaction_fee_amount', 'referral_fee_amount',
  'refund_administration_fee_amount', 'credit_card_handling_fee_amount'
]);
const KOC_FEES = new Set([
  'affiliate_commission_amount', 'affiliate_commission_amount_before_pit',
  'affiliate_commission_before_pit_amount',
  'affiliate_partner_commission_amount', 'affiliate_ads_commission_amount',
  'tap_shop_ads_commission', 'tap_shop_ads_commission_amount',
  'cps_shop_ads_commission_amount', 'cofunded_creator_bonus_amount'
]);
const PROMOTION_FEES = new Set([
  'gmv_max_ad_fee_amount', 'smart_promotion_fee_amount', 'cofunded_promotion_service_fee_amount',
  'campaign_period_fee_cfp_amount', 'campaign_period_fee_sp_amount', 'gmv_max_coupon_fee_amount'
]);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function add(target: NumberMap, key: string, value: unknown): void {
  const amount = numberValue(value);
  if (amount) target[key] = (target[key] || 0) + amount;
}

function nonZero(values: NumberMap): NumberMap {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => Math.abs(value) > 0.000001));
}

function amount(value: any): number {
  return numberValue(value?.amount ?? value?.value ?? value);
}

function mapObject(target: NumberMap, source: any, excluded = new Set<string>()): void {
  if (!source || typeof source !== 'object') return;
  for (const [key, value] of Object.entries(source)) {
    if (excluded.has(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) mapObject(target, value, excluded);
    else add(target, key, value);
  }
}

async function statements(env: Env, cipher: string, startDate: string, endDate: string): Promise<any[]> {
  const rows: any[] = [];
  let pageToken = '';
  let pages = 0;
  do {
    const data = await shopRequest(env, '/finance/202309/statements', 'GET', {
      shop_cipher: cipher,
      statement_time_ge: epoch(startDate),
      statement_time_lt: epoch(shiftDate(endDate, 1)),
      page_size: 100,
      page_token: pageToken || undefined,
      sort_field: 'statement_time',
      sort_order: 'DESC'
    });
    rows.push(...(Array.isArray(data.statements) ? data.statements : []));
    pageToken = String(data.next_page_token || '');
    pages += 1;
  } while (pageToken && pages < 100);
  return rows;
}

async function statementTransactions(env: Env, cipher: string, statementId: string): Promise<any[]> {
  const rows: any[] = [];
  let pageToken = '';
  let pages = 0;
  do {
    const data = await shopRequest(env,
      `/finance/202501/statements/${encodeURIComponent(statementId)}/statement_transactions`, 'GET', {
        shop_cipher: cipher,
        page_size: 100,
        page_token: pageToken || undefined,
        sort_field: 'order_create_time',
        sort_order: 'DESC'
      });
    rows.push(...(Array.isArray(data.transactions) ? data.transactions : []));
    pageToken = String(data.next_page_token || '');
    pages += 1;
  } while (pageToken && pages < 100);
  return rows;
}

export function aggregateStatementTransactions(transactions: any[]): any {
  const revenue = { subtotalBeforeDiscount: 0, sellerDiscount: 0, refundSubtotal: 0,
    sellerDiscountRefund: 0, netRevenue: 0 };
  const shippingBreakdown: NumberMap = {};
  const platform: NumberMap = {};
  const koc: NumberMap = {};
  const promotion: NumberMap = {};
  const otherPrograms: NumberMap = {};
  const tax: NumberMap = {};
  const adjustments: any[] = [];
  const orderIds = new Set<string>();
  let shippingTotal = 0;
  let totalFeeTax = 0;
  let settlementAmount = 0;

  for (const transaction of transactions) {
    const breakdown = transaction.revenue_breakdown || {};
    revenue.subtotalBeforeDiscount += numberValue(breakdown.subtotal_before_discount_amount);
    revenue.sellerDiscount += numberValue(breakdown.seller_discount_amount);
    revenue.refundSubtotal += numberValue(breakdown.refund_subtotal_before_discount_amount);
    revenue.sellerDiscountRefund += numberValue(breakdown.seller_discount_refund_amount);
    revenue.netRevenue += numberValue(transaction.revenue_amount);
    shippingTotal += numberValue(transaction.shipping_cost_amount);
    totalFeeTax += numberValue(transaction.fee_tax_amount);
    settlementAmount += numberValue(transaction.settlement_amount);
    mapObject(shippingBreakdown, transaction.shipping_cost_breakdown, new Set(['supplementary_component']));

    const fee = transaction.fee_tax_breakdown?.fee || {};
    for (const [key, value] of Object.entries(fee)) {
      if (!numberValue(value)) continue;
      if (PLATFORM_FEES.has(key)) add(platform, key, value);
      else if (KOC_FEES.has(key)) add(koc, key, value);
      else if (PROMOTION_FEES.has(key)) add(promotion, key, value);
      else add(otherPrograms, key, value);
    }
    mapObject(tax, transaction.fee_tax_breakdown?.tax);

    const adjustment = numberValue(transaction.adjustment_amount);
    if (adjustment) adjustments.push({
      type: String(transaction.type || 'OTHER_ADJUSTMENT'),
      amount: adjustment,
      orderId: String(transaction.adjustment_order_id || transaction.order_id || '') || undefined
    });
    if (transaction.order_id) orderIds.add(String(transaction.order_id));
  }
  return {
    revenue,
    shipping: { total: shippingTotal, breakdown: nonZero(shippingBreakdown) },
    fees: { platform: nonZero(platform), koc: nonZero(koc), promotion: nonZero(promotion),
      otherPrograms: nonZero(otherPrograms), tax: nonZero(tax), totalFeeTax },
    adjustments,
    settlementAmount,
    orderCount: orderIds.size
  };
}

function mergeBreakdown(target: any, source: any): void {
  for (const key of ['subtotalBeforeDiscount', 'sellerDiscount', 'refundSubtotal', 'sellerDiscountRefund', 'netRevenue']) {
    target.revenue[key] += numberValue(source.revenue?.[key]);
  }
  target.shipping.total += numberValue(source.shipping?.total);
  for (const [key, value] of Object.entries(source.shipping?.breakdown || {})) {
    add(target.shipping.breakdown, key, value);
  }
  for (const group of ['platform', 'koc', 'promotion', 'otherPrograms', 'tax']) {
    for (const [key, value] of Object.entries(source.fees?.[group] || {})) add(target.fees[group], key, value);
  }
  target.fees.totalFeeTax += numberValue(source.fees?.totalFeeTax);
  target.adjustments.push(...(source.adjustments || []));
  target.settlementAmount += numberValue(source.settlementAmount);
  target.orderCount += numberValue(source.orderCount);
}

async function settledBlock(env: Env, cipher: string, startDate: string, endDate: string): Promise<any> {
  const list = await statements(env, cipher, startDate, endDate);
  const total = aggregateStatementTransactions([]);
  const statementRows: any[] = [];
  for (const statement of list) {
    const transactions = await statementTransactions(env, cipher, String(statement.id));
    const detail = aggregateStatementTransactions(transactions);
    mergeBreakdown(total, detail);
    statementRows.push({
      id: String(statement.id),
      statementTime: numberValue(statement.statement_time) * 1000,
      paymentStatus: String(statement.payment_status || 'UNKNOWN'),
      settlementAmount: numberValue(statement.settlement_amount ?? detail.settlementAmount),
      revenue: numberValue(statement.revenue_amount ?? detail.revenue.netRevenue),
      platformFees: Object.values(detail.fees.platform).reduce((sum: number, value) => sum + numberValue(value), 0),
      promotionFees: Object.values(detail.fees.promotion).reduce((sum: number, value) => sum + numberValue(value), 0),
      kocFees: Object.values(detail.fees.koc).reduce((sum: number, value) => sum + numberValue(value), 0),
      orderCount: detail.orderCount,
      detail
    });
  }
  total.fees.platform = nonZero(total.fees.platform);
  total.fees.koc = nonZero(total.fees.koc);
  total.fees.promotion = nonZero(total.fees.promotion);
  total.fees.otherPrograms = nonZero(total.fees.otherPrograms);
  total.fees.tax = nonZero(total.fees.tax);
  total.shipping.breakdown = nonZero(total.shipping.breakdown);
  total.statements = statementRows;
  return total;
}

export function unsettledReasonLabel(value: unknown): string {
  const reason = String(value || '').trim();
  if (/deliver|shipment|package|parcel/i.test(reason)) return 'Đang chờ giao kiện hàng';
  if (/return|refund|reverse/i.test(reason)) return 'Đang chờ hoàn tất trả hàng/hoàn tiền';
  if (/settle|process|processing|reserve/i.test(reason)) return 'Đang tiến hành quyết toán';
  return reason || 'Lý do khác';
}

async function unsettledBlock(env: Env, cipher: string, startDate: string, endDate: string): Promise<any> {
  const transactions: any[] = [];
  const reasonCounts = new Map<string, { count: number; amount: number; raw: Set<string> }>();
  let pageToken = '';
  let pages = 0;
  let sums: any = null;
  do {
    const data = await shopRequest(env, '/finance/202507/orders/unsettled', 'GET', {
      shop_cipher: cipher,
      sort_field: 'order_create_time',
      sort_order: 'DESC',
      search_time_ge: epoch(startDate),
      search_time_lt: epoch(shiftDate(endDate, 1)),
      page_size: 100,
      page_token: pageToken || undefined
    });
    if (!sums) sums = data;
    transactions.push(...(Array.isArray(data.transactions) ? data.transactions : []));
    pageToken = String(data.next_page_token || '');
    pages += 1;
  } while (pageToken && pages < 100);

  for (const transaction of transactions) {
    const label = unsettledReasonLabel(transaction.unsettled_reason);
    const current = reasonCounts.get(label) || { count: 0, amount: 0, raw: new Set<string>() };
    current.count += 1;
    current.amount += numberValue(transaction.est_settlement_amount);
    if (transaction.unsettled_reason) current.raw.add(String(transaction.unsettled_reason));
    reasonCounts.set(label, current);
  }
  const start = epoch(startDate);
  const end = epoch(shiftDate(endDate, 1));
  const orderTimes = transactions.map((item) => numberValue(item.order_create_time)).filter(Boolean);
  return {
    isEstimate: true,
    sumEstSettlementAmount: numberValue(sums?.sum_est_settlement_amount),
    sumEstRevenueAmount: numberValue(sums?.sum_est_revenue_amount),
    sumEstFeeAmount: numberValue(sums?.sum_est_fee_amount),
    sumEstAdjustmentAmount: numberValue(sums?.sum_est_adjustment_amount),
    transactionCount: transactions.length,
    reasons: Array.from(reasonCounts, ([label, item]) => ({ label, count: item.count, amount: item.amount, rawValues: Array.from(item.raw) })),
    observedOrderCreateTime: orderTimes.length ? { min: Math.min(...orderTimes) * 1000, max: Math.max(...orderTimes) * 1000,
      allWithinSelectedRange: orderTimes.every((value) => value >= start && value < end) } : null
  };
}

async function productCatalog(env: Env, cipher: string): Promise<Record<string, any>> {
  const key = stableKey('shop-skus-catalog-v3', { cipher });
  const cached = await cacheGet<Record<string, any>>(env, key);
  if (cached) return cached;
  const catalog: Record<string, any> = {};
  let pageToken = '';
  let pages = 0;
  do {
    const data = await shopRequest(env, '/product/202502/products/search', 'POST', {
      shop_cipher: cipher,
      page_size: 100,
      page_token: pageToken || undefined
    }, { status: 'ALL', locale: 'vi-VN' });
    for (const product of data.products || []) {
      for (const sku of product.skus || []) {
        const skuId = String(sku.id);
        const entry = {
        skuId,
        skuName: String(sku.seller_sku || sku.sku_name || product.title || sku.id),
        productName: String(product.title || `Sản phẩm ${product.id}`),
        productId: String(product.id)
      };
        catalog[skuId] = entry;
        // Analytics currently emits SKU IDs as JSON numbers in some markets.
        // Keep a numeric alias so a rounded IEEE-754 value can still join to
        // the exact string ID returned by Product Search.
        catalog[`numeric:${Number(skuId)}`] = entry;
      }
    }
    pageToken = String(data.next_page_token || '');
    pages += 1;
  } while (pageToken && pages < 100);
  await cachePut(env, key, catalog, 21600);
  return catalog;
}

async function skuBlock(env: Env, cipher: string, startDate: string, endDate: string): Promise<any> {
  const [catalog, performance] = await Promise.all([
    productCatalog(env, cipher),
    (async () => {
      const rows: any[] = [];
      let pageToken = '';
      let pages = 0;
      do {
        const data = await shopRequest(env, '/analytics/202509/shop_skus/performance', 'GET', {
          shop_cipher: cipher,
          start_date_ge: startDate,
          end_date_lt: shiftDate(endDate, 1),
          sort_field: 'units_sold',
          sort_order: 'DESC',
          page_size: 100,
          page_token: pageToken || undefined,
          product_status_filter: 'ALL',
          currency: 'LOCAL'
        });
        rows.push(...(Array.isArray(data.skus) ? data.skus : []));
        pageToken = String(data.next_page_token || '');
        pages += 1;
      } while (pageToken && pages < 100);
      return rows;
    })()
  ]);
  const products = new Map<string, any>();
  let totalUnitsSold = 0;
  let totalSkuOrders = 0;
  let totalGmv = 0;
  for (const item of performance) {
    const analyticsSkuId = String(item.id || item.sku_id || '');
    const info = catalog[analyticsSkuId] || catalog[`numeric:${Number(analyticsSkuId)}`] || {};
    const skuId = String(info.skuId || analyticsSkuId);
    const productId = String(info.productId || item.product_id || '');
    const row = { skuId, skuName: info.skuName || `SKU ${skuId}`, unitsSold: numberValue(item.units_sold),
      skuOrders: numberValue(item.sku_orders), gmv: amount(item.gmv) };
    if (!products.has(productId)) products.set(productId, { productId, productName: info.productName || `Sản phẩm ${productId}`, skus: [] });
    products.get(productId).skus.push(row);
    totalUnitsSold += row.unitsSold;
    totalSkuOrders += row.skuOrders;
    totalGmv += row.gmv;
  }
  const rows = Array.from(products.values()).map((product) => ({ ...product,
    unitsSold: product.skus.reduce((sum: number, item: any) => sum + item.unitsSold, 0),
    skuOrders: product.skus.reduce((sum: number, item: any) => sum + item.skuOrders, 0),
    gmv: product.skus.reduce((sum: number, item: any) => sum + item.gmv, 0),
    skus: product.skus.sort((left: any, right: any) => right.unitsSold - left.unitsSold)
  })).sort((left, right) => right.unitsSold - left.unitsSold);
  return { products: rows, totalUnitsSold, totalSkuOrders, totalGmv };
}

function emptySettled(): any {
  return { ...aggregateStatementTransactions([]), statements: [] };
}

function emptyUnsettled(): any {
  return { isEstimate: true, sumEstSettlementAmount: 0, sumEstRevenueAmount: 0,
    sumEstFeeAmount: 0, sumEstAdjustmentAmount: 0, transactionCount: 0, reasons: [], observedOrderCreateTime: null };
}

async function period(env: Env, cipher: string, input: Scope, includeSku: boolean, warnings: string[]): Promise<any> {
  const storeIdPromise = resolveDefaultStoreId(env);
  const settledPromise = settledBlock(env, cipher, input.startDate, input.endDate)
    .catch((error) => { warnings.push(`Đã quyết toán: ${message(error)}`); return emptySettled(); });
  const unsettledPromise = unsettledBlock(env, cipher, input.startDate, input.endDate)
    .catch((error) => { warnings.push(`Sẽ quyết toán: ${message(error)}`); return emptyUnsettled(); });
  const skuPromise = includeSku ? skuBlock(env, cipher, input.startDate, input.endDate)
    .catch((error) => { warnings.push(`Sản lượng SKU: ${message(error)}`); return { products: [], totalUnitsSold: 0, totalSkuOrders: 0, totalGmv: 0 }; }) : Promise.resolve(null);
  const storeId = await storeIdPromise;
  const adsPromise = loadMainReport(env, { advertiserId: env.DEFAULT_ADVERTISER_ID, storeId,
    startDate: input.startDate, endDate: input.endDate }, input.forceRefresh === true)
    .catch((error) => { warnings.push(`Chi phí Ads: ${message(error)}`); return { totals: {} }; });
  const [settled, unsettled, sku, adsReport] = await Promise.all([settledPromise, unsettledPromise, skuPromise, adsPromise]);
  const adsTotals = adsReport.totals || {};
  const ads = { cost: numberValue(adsTotals.cost), orders: numberValue(adsTotals.orders),
    grossRevenue: numberValue(adsTotals.grossRevenue), roi: numberValue(adsTotals.roi),
    costPerOrder: numberValue(adsTotals.costPerOrder), cAds: 0, gmvMax: numberValue(adsTotals.cost) };
  const netProfitSettledOnly = numberValue(settled.settlementAmount) - ads.cost;
  const netProfitWithEstimate = netProfitSettledOnly + numberValue(unsettled.sumEstSettlementAmount);
  return { settled, unsettled, sku, ads, netProfitSettledOnly, netProfitWithEstimate,
    totalGmv: numberValue(settled.revenue?.netRevenue) + numberValue(unsettled.sumEstRevenueAmount) };
}

export async function loadFinanceAnalysis(env: Env, input: Scope): Promise<any> {
  const key = stableKey('seller-finance-v1', { startDate: input.startDate, endDate: input.endDate });
  const cached = input.forceRefresh === true ? null : await cacheGet<any>(env, key);
  if (cached) return cached;
  const shop = await authorizedShop(env);
  if (!shop) throw new Error('Seller OAuth chưa trả về TikTok Shop được ủy quyền.');
  const cipher = String(shop.cipher || shop.shop_cipher || shop.id || '');
  if (!cipher) throw new Error('Không tìm thấy shop_cipher.');
  const days = Math.max(1, Math.floor((Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / 86400000) + 1);
  const previousEndDate = shiftDate(input.startDate, -1);
  const previousStartDate = shiftDate(previousEndDate, -(days - 1));
  const warnings: string[] = [];
  const previousWarnings: string[] = [];
  const [current, previous] = await Promise.all([
    period(env, cipher, input, true, warnings),
    period(env, cipher, { startDate: previousStartDate, endDate: previousEndDate }, false, previousWarnings)
  ]);
  const today = dateInTimezone(new Date(), env.TIMEZONE);
  const result = {
    schemaVersion: 'finance-v1', generatedAt: new Date().toISOString(), startDate: input.startDate, endDate: input.endDate,
    previousStartDate, previousEndDate, shop: { name: shop.name || shop.shop_name, code: shop.code || shop.shop_code },
    warnings, current, previous: { totalGmv: previous.totalGmv,
      netRevenue: previous.settled.revenue?.netRevenue || 0,
      totalFeeTax: previous.settled.fees?.totalFeeTax || 0,
      adsCost: previous.ads.cost,
      netProfitSettledOnly: previous.netProfitSettledOnly,
      netProfitWithEstimate: previous.netProfitWithEstimate },
    todaySettlementNotice: input.startDate === today && input.endDate === today,
    dateScopeNote: 'Số liệu quyết toán tính theo ngày TikTok xử lý, có thể khác ngày khách đặt hàng.'
  };
  const ttl = input.endDate >= today ? 300 : 86400;
  await cachePut(env, key, result, ttl);
  return result;
}
