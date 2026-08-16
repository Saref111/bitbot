import type { FetchLike, Notifier, TelegramCredentials } from './types.js';

/**
 * MVP §13.6: Telegram-бот на ключові події. Talks to Telegram's HTTP API
 * directly (no client library — Node 24 has a global `fetch`, and this is
 * one POST call). `fetchImpl` is injectable for tests, defaulting to the
 * real global `fetch`.
 */
export function createTelegramNotifier(
  credentials: TelegramCredentials,
  fetchImpl: FetchLike = fetch,
): Notifier {
  const url = `https://api.telegram.org/bot${credentials.botToken}/sendMessage`;
  return {
    async notify(message: string): Promise<void> {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: credentials.chatId, text: message }),
      });
      if (!response.ok) {
        throw new Error(
          `telegramNotifier: sendMessage failed with status ${String(response.status)}`,
        );
      }
    },
  };
}
