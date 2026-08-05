import { describe, expect, it } from 'vitest';
import { supabaseObjectUrl } from '../src/supabase-backup';

describe('Supabase backup', () => {
  it('builds an encoded Storage object URL without exposing credentials', () => {
    expect(supabaseObjectUrl('https://project.supabase.co/', 'gmv max', 'daily/2026-08-05.json'))
      .toBe('https://project.supabase.co/storage/v1/object/gmv%20max/daily/2026-08-05.json');
  });
});
