import { TelegramCredentials } from './types.js';

/**
 * Unlike loadExchangeCredentials, this does NOT throw when unset — Telegram
 * is an optional visibility channel (MVP §13.6), not a hard requirement to
 * run the bot. Reads process.env directly; caller loads .env first.
 */
export function loadTelegramCredentials(): TelegramCredentials | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}
