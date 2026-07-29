import { describe, expect, it } from 'vitest';
import { evaluateVideos } from '../src/evaluator';

describe('evaluateVideos', () => {
  it('does not stop a new video below 50k', () => {
    const result=evaluateVideos([{dimensions:{item_id:'123',campaign_id:'1'},metrics:{cost:49999,orders:0,product_impressions:10}}]);
    expect(result.stop).toHaveLength(0);
  });
  it('ignores excluded creatives', () => {
    const result=evaluateVideos([{dimensions:{item_id:'123'},metrics:{cost:200000,orders:0,creative_delivery_status:'EXCLUDED'}}]);
    expect(result.stop).toHaveLength(0);
  });
});
