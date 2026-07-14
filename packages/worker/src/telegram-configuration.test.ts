import { describe, expect, it } from "vitest";
import {
  loadTelegramBotConfiguration,
  redactTelegramBotToken,
  TelegramBotConfigurationError
} from "./telegram-configuration";

describe("Telegram bot configuration boundary", () => {
  it("loads the bot token only from the environment boundary", () => {
    expect(
      loadTelegramBotConfiguration({ TELEGRAM_BOT_TOKEN: "123456:secret-token" })
    ).toEqual({ botToken: "123456:secret-token" });
  });

  it("uses a stable missing-secret error without exposing a value", () => {
    expect(() => loadTelegramBotConfiguration({})).toThrow(
      TelegramBotConfigurationError
    );
    expect(() => loadTelegramBotConfiguration({})).toThrow(
      "TELEGRAM_BOT_TOKEN is required for Telegram transport"
    );
  });

  it("redacts a bot token from provider errors before persistence or logging", () => {
    const token = "123456:secret-token";
    const redacted = redactTelegramBotToken(
      new Error(`Request to https://api.telegram.org/bot${token}/sendMessage failed`),
      token
    );

    expect(redacted).not.toContain(token);
    expect(redacted).toContain("[REDACTED]");
  });
});
