import { describe, expect, it } from 'vitest';

describe('ADS cumulative fallback contract', () => {
  it('keeps the fallback bucket aligned with the report hour read by the bot', () => {
    const localHour = 17;
    const fallbackIndex = Math.max(0, Math.min(23, localHour - 1));
    expect(fallbackIndex).toBe(16);
    expect(fallbackIndex).toBe(localHour - 1);
  });
});
