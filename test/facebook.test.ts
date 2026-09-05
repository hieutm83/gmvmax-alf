import { describe, expect, it } from 'vitest';
import { summarizeFacebookRows } from '../src/facebook';

describe('Facebook Ads normalization',()=>{
  it('selects one canonical action per metric and does not double count aliases',()=>{
    const report=summarizeFacebookRows([{campaign_id:'1',campaign_name:'Hunter | Mess to Shopee',date_start:'2026-09-01',spend:'100000',impressions:'1000',reach:'800',clicks:'50',
      actions:[{action_type:'post_engagement',value:'90'},{action_type:'page_engagement',value:'100'},{action_type:'onsite_conversion.messaging_conversation_started_7d',value:'4'},{action_type:'onsite_conversion.total_messaging_connection',value:'7'},{action_type:'omni_purchase',value:'2'},{action_type:'onsite_conversion.purchase',value:'2'}],
      action_values:[{action_type:'omni_purchase',value:'300000'},{action_type:'onsite_conversion.purchase',value:'300000'}]}]);
    expect(report.totals).toMatchObject({spend:100000,impressions:1000,clicks:50,postEngagement:90,messages:4,orders:2,revenue:300000,cpm:100000,cpc:2000,ctr:.05,cpo:50000,roas:3});
    expect(report.campaigns[0].resultCategory).toBe('Cuộc trò chuyện mới');
  });
});
