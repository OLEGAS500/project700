import { describe, expect, it } from "vitest";
import type { AlertDeliveryBatchResult, RunAlertDeliveryBatchInput, TelegramTransport } from "@eim/worker";
import {
  createTelegramWorkerId,
  loadTelegramRuntimeConfiguration,
  runTelegramAlertsOnce,
  TelegramRuntimeConfigurationError
} from "./run-telegram-alerts";

describe("Telegram alert runtime", () => {
  it("uses configured worker identity and invokes one Telegram batch", async () => {
    let transportInput: { botToken: string } | undefined;
    let batchInput: RunAlertDeliveryBatchInput | undefined;
    const transport: TelegramTransport = {
      async send() {
        return { providerMessageId: "unused" };
      }
    };
    const expectedResult: AlertDeliveryBatchResult = {
      claimed: 4,
      sent: 3,
      retried: 1,
      failed: 0
    };

    await expect(
      runTelegramAlertsOnce(
        {
          DATABASE_URL: "postgres://runtime-test.example/eim",
          TELEGRAM_BOT_TOKEN: "runtime-token",
          TELEGRAM_WORKER_ID: "telegram-runtime-test"
        },
        {
          createTransport(input) {
            transportInput = input;
            return transport;
          },
          async runBatch(input) {
            batchInput = input;
            return expectedResult;
          }
        }
      )
    ).resolves.toEqual(expectedResult);

    expect(transportInput).toEqual({ botToken: "runtime-token" });
    expect(batchInput).toMatchObject({
      channel: "telegram",
      workerId: "telegram-runtime-test",
      sender: transport
    });
  });

  it("validates database and bot configuration before constructing a transport or claiming work", async () => {
    expect(() => loadTelegramRuntimeConfiguration({ TELEGRAM_BOT_TOKEN: "token" })).toThrow(
      TelegramRuntimeConfigurationError
    );
    expect(() => loadTelegramRuntimeConfiguration({ DATABASE_URL: "postgres://test" })).toThrow(
      "TELEGRAM_BOT_TOKEN is required for Telegram transport"
    );

    let calls = 0;
    await expect(
      runTelegramAlertsOnce(
        { DATABASE_URL: "postgres://test" },
        {
          createTransport() {
            calls += 1;
            throw new Error("must not construct transport");
          },
          async runBatch() {
            calls += 1;
            throw new Error("must not claim deliveries");
          }
        }
      )
    ).rejects.toThrow("TELEGRAM_BOT_TOKEN is required for Telegram transport");
    expect(calls).toBe(0);
  });

  it("uses an explicit worker ID or a non-empty process-scoped default", () => {
    expect(createTelegramWorkerId({ TELEGRAM_WORKER_ID: " configured-worker " })).toBe(
      "configured-worker"
    );
    expect(createTelegramWorkerId({ TELEGRAM_WORKER_ID: "   " })).toMatch(
      /^telegram-alerts:.+:[0-9]+$/
    );
    expect(createTelegramWorkerId({})).toMatch(/^telegram-alerts:.+:[0-9]+$/);
  });
});
