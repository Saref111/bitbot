export interface Notifier {
  notify(message: string): Promise<void>;
}

export interface TelegramCredentials {
  botToken: string;
  chatId: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
