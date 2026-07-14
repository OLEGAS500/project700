import { closePool } from "@eim/db";
import {
  createTelegramTransport,
  loadTelegramBotConfiguration,
  runAlertDeliveryBatch,
  type AlertDeliveryBatchResult,
  type RunAlertDeliveryBatchInput,
  type TelegramTransport
} from "@eim/worker";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export type TelegramRuntimeConfiguration = {
  databaseUrl: string;
  botToken: string;
  workerId: string;
};

export type TelegramRuntimeDependencies = {
  createTransport(input: { botToken: string }): TelegramTransport;
  runBatch(input: RunAlertDeliveryBatchInput): Promise<AlertDeliveryBatchResult>;
};

const runtimeDependencies: TelegramRuntimeDependencies = {
  createTransport: createTelegramTransport,
  runBatch: runAlertDeliveryBatch
};

export class TelegramRuntimeConfigurationError extends Error {
  constructor(readonly code: "database_url_missing") {
    super(code);
    this.name = "TelegramRuntimeConfigurationError";
  }
}

export function loadTelegramRuntimeConfiguration(
  environment: Record<string, string | undefined> = process.env
): TelegramRuntimeConfiguration {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) throw new TelegramRuntimeConfigurationError("database_url_missing");

  return {
    databaseUrl,
    botToken: loadTelegramBotConfiguration(environment).botToken,
    workerId: createTelegramWorkerId(environment)
  };
}

export function createTelegramWorkerId(
  environment: Record<string, string | undefined> = process.env
): string {
  const configuredWorkerId = environment.TELEGRAM_WORKER_ID?.trim();
  return configuredWorkerId ?? `telegram-alerts:${hostname()}:${process.pid}`;
}

export async function runTelegramAlertsOnce(
  environment: Record<string, string | undefined> = process.env,
  dependencies: TelegramRuntimeDependencies = runtimeDependencies
): Promise<AlertDeliveryBatchResult> {
  const configuration = loadTelegramRuntimeConfiguration(environment);
  const transport = dependencies.createTransport({ botToken: configuration.botToken });

  return dependencies.runBatch({
    channel: "telegram",
    workerId: configuration.workerId,
    sender: transport
  });
}

export async function main(): Promise<void> {
  let shutdownRequested = false;
  const requestShutdown = () => {
    shutdownRequested = true;
  };
  process.once("SIGTERM", requestShutdown);

  try {
    if (shutdownRequested) return;

    const result = await runTelegramAlertsOnce();
    console.log(
      JSON.stringify({
        channel: "telegram",
        claimed: result.claimed,
        sent: result.sent,
        retried: result.retried,
        failed: result.failed
      })
    );
  } catch (error) {
    console.error(JSON.stringify({ channel: "telegram", error: toSafeRuntimeErrorCode(error) }));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", requestShutdown);
    try {
      await closePool();
    } catch {
      console.error(JSON.stringify({ channel: "telegram", error: "database_pool_close_failed" }));
      process.exitCode = 1;
    }
  }
}

function toSafeRuntimeErrorCode(error: unknown): string {
  if (error instanceof TelegramRuntimeConfigurationError) return error.code;
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "telegram_worker_failed";
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  void main();
}
