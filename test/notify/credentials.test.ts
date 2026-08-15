import { describe, expect, it, afterEach } from 'vitest';
import { loadTelegramCredentials } from '../../src/notify/credentials.js';

describe('loadTelegramCredentials — optional, unlike loadExchangeCredentials', () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChatId = process.env.TELEGRAM_CHAT_ID;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChatId;
  });

  it('returns null (not a throw) when neither variable is set', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    expect(loadTelegramCredentials()).toBeNull();
  });

  it('returns null when only one of the two is set', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'abc';
    delete process.env.TELEGRAM_CHAT_ID;
    expect(loadTelegramCredentials()).toBeNull();
  });

  it('returns the credentials when both are set', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'abc';
    process.env.TELEGRAM_CHAT_ID = '12345';
    expect(loadTelegramCredentials()).toEqual({ botToken: 'abc', chatId: '12345' });
  });
});
