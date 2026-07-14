const telegramBotTokenEnvironmentVariable = "TELEGRAM_BOT_TOKEN";

export type TelegramBotConfiguration = {
  botToken: string;
};

export class TelegramBotConfigurationError extends Error {
  readonly code = "telegram_bot_token_missing";

  constructor() {
    super(`${telegramBotTokenEnvironmentVariable} is required for Telegram transport`);
    this.name = "TelegramBotConfigurationError";
  }
}

export function loadTelegramBotConfiguration(
  environment: Record<string, string | undefined> = process.env
): TelegramBotConfiguration {
  const botToken = environment[telegramBotTokenEnvironmentVariable]?.trim();
  if (!botToken) throw new TelegramBotConfigurationError();
  return { botToken };
}

export function redactTelegramBotToken(error: unknown, botToken: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!botToken) return message.slice(0, 2_000);
  return message.replaceAll(botToken, "[REDACTED]").slice(0, 2_000);
}
