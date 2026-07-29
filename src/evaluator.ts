import type { McpRow } from './types';
import { numberValue } from './utils';

function divide(a: number, b: number): number | null { return b ? a / b : null; }
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function evaluateVideos(rows: McpRow[]): any {
  const byId = new Map<string, any>();
  for (const row of rows) {
    const d = row.dimensions || {}; const m = row.metrics || {};
    const status = String(m.creative_delivery_status || d.creative_delivery_status || m.status || d.status || '').toUpperCase();
    if (status.includes('EXCLUDED')) continue;
    const itemId = String(d.item_id || m.item_id || '');
    const campaignId = String(d.campaign_id || m.campaign_id || '');
    if (!itemId || itemId === '-1') continue;
    const video = byId.get(itemId) || { itemId, campaignIds: [], cost: 0, orders: 0,
      grossRevenue: 0, impressions: 0, traffic: 0 };
    if (campaignId && !video.campaignIds.includes(campaignId)) video.campaignIds.push(campaignId);
    video.cost += numberValue(m.cost); video.orders += numberValue(m.orders);
    video.grossRevenue += numberValue(m.gross_revenue); video.impressions += numberValue(m.product_impressions);
    video.traffic += numberValue(m.product_clicks); byId.set(itemId, video);
  }
  const videos = [...byId.values()].filter((v) => v.cost || v.orders || v.impressions).map((v) => ({ ...v,
    costPerOrder: divide(v.cost, v.orders), roi: divide(v.grossRevenue, v.cost) }));
  if (!videos.length) return { referenceRoi: null, evidenceSpend: 0, boost: [], stop: [] };
  const totalCost = videos.reduce((sum, v) => sum + v.cost, 0);
  const referenceRoi = divide(videos.reduce((sum, v) => sum + v.grossRevenue, 0), totalCost) || 1;
  const evidenceSpend = Math.max(50_000, median(videos.filter((v) => v.cost > 0).map((v) => v.cost)) * 0.5);
  const boost: any[] = []; const stop: any[] = [];
  for (const video of videos) {
    const roi = video.roi || 0;
    if ((video.cost >= evidenceSpend || video.orders >= 2) &&
        ((video.orders >= 2 && roi >= referenceRoi) ||
         (video.orders >= 1 && roi >= referenceRoi * 1.25 && video.cost >= evidenceSpend * 0.5))) {
      video.reason = `ROI ${roi.toFixed(2).replace('.', ',')} so voi moc ${referenceRoi.toFixed(2).replace('.', ',')}\n${Math.round(video.orders)} SKU orders.`;
      video.score = roi * Math.log(video.orders + 1); boost.push(video);
    } else if ((video.cost >= evidenceSpend && video.orders === 0) ||
      (video.cost >= evidenceSpend && video.orders > 0 && roi < referenceRoi * 0.55)) {
      video.reason = video.orders === 0 ? `Da chi ${Math.round(video.cost).toLocaleString('vi-VN')} nhung chua co SKU order.` :
        `ROI ${roi.toFixed(2).replace('.', ',')} thap hon ro ret so voi moc ${referenceRoi.toFixed(2).replace('.', ',')}.`;
      video.score = video.orders === 0 ? video.cost : video.cost * Math.max(0, referenceRoi - roi); stop.push(video);
    }
  }
  return { referenceRoi, evidenceSpend, boost: boost.sort((a, b) => b.score - a.score).slice(0, 30),
    stop: stop.sort((a, b) => b.score - a.score).slice(0, 30) };
}
