import { describe, expect, it, vi } from 'vitest';
import { createTelegramNotifier } from '../../src/notify/telegramNotifier.js';

const credentials = { botToken: 'test-token', chatId: '12345' };

describe('createTelegramNotifier — MVP §13.6', () => {
  it('POSTs to the correct URL with chat_id and text in the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const notifier = createTelegramNotifier(credentials, fetchImpl);

    await notifier.notify('Deal opened at 1996');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: '12345', text: 'Deal opened at 1996' }),
      }),
    );
  });

  it('throws when Telegram responds with a non-ok status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const notifier = createTelegramNotifier(credentials, fetchImpl);

    await expect(notifier.notify('test')).rejects.toThrow(/401/);
  });

  it('propagates a network-level rejection unchanged', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const notifier = createTelegramNotifier(credentials, fetchImpl);

    await expect(notifier.notify('test')).rejects.toThrow(/network down/);
  });
});
