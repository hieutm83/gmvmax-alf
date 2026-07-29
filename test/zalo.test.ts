import { describe, expect, it } from 'vitest';
import { buildAdsStyles, extractZaloUpdates, normalizeZaloEvent } from '../src/zalo';

describe('normalizeZaloEvent', () => {
  it('reads the current Zalo webhook message shape', () => {
    expect(normalizeZaloEvent({
      event_name: 'message.text.received',
      message: {
        message_id: 'message-1',
        chat: { id: 'group-1', chat_type: 'GROUP' },
        from: { id: 'user-1', is_bot: false },
        text: '@Bot ADS - ALF https://www.tiktok.com/@user/video/7660775643268943111'
      }
    })).toEqual({
      id: 'message-1',
      chatId: 'group-1',
      senderIsBot: false,
      text: '@Bot ADS - ALF https://www.tiktok.com/@user/video/7660775643268943111'
    });
  });

  it('extracts the latest message from a getUpdates array',()=>{
    const updates=extractZaloUpdates([
      {update_id:'1',message:{message_id:'old',chat:{id:'group-1'},text:'old'}},
      {update_id:'2',message:{message_id:'latest',chat:{id:'group-1'},text:'latest'}}
    ]);
    expect(updates).toHaveLength(2);
    expect(normalizeZaloEvent(updates.at(-1))).toMatchObject({id:'latest',chatId:'group-1',text:'latest'});
  });
});

describe('buildAdsStyles',()=>{
  it('styles the title, compact body, and recommendation colors',()=>{
    const text='Chỉ số ADS 29/07/2026 - 11:00\nCost: 65.266\n\n- Boost:\n123 | ROI 6,80 so với mốc 1,27\n- Tắt:\n456 | Đã chi 60.980 nhưng chưa có SKU order.';
    const styles=buildAdsStyles(text);
    const titleEnd=text.indexOf('\n');
    expect(styles).toContainEqual({start:0,len:titleEnd,st:['i']});
    expect(styles).toContainEqual({start:titleEnd+1,len:text.length-titleEnd-1,st:['f_13','b']});
    expect(styles.some(style=>style.st.includes('c_15a85f'))).toBe(true);
    expect(styles.some(style=>style.st.includes('c_db342e'))).toBe(true);
  });
});
