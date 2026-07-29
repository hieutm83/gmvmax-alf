import { describe, expect, it } from 'vitest';
import { normalizeZaloEvent } from '../src/zalo';

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
});
