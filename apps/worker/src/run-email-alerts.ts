import { closePool } from "@eim/db";
import {
  createResendEmailTransport,
  loadEmailProviderConfiguration,
  runAlertDeliveryBatch,
  type AlertDeliveryBatchResult,
  type EmailProviderConfiguration,
  type EmailTransport,
  type RunAlertDeliveryBatchInput
} from "@eim/worker";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type EmailRuntimeConfiguration = EmailProviderConfiguration & {
  databaseUrl: string;
  workerId: string;
};

export type EmailRuntimeDependencies = {
  createTransport(input: EmailProviderConfiguration): EmailTransport;
  runBatch(input: RunAlertDeliveryBatchInput): Promise<AlertDeliveryBatchResult>;
  closePool(): Promise<void>;
};

export type EmailRuntimeLogger = Pick<Console, "log" | "error">;

export type EmailRuntimeResult = {
  exitCode: 0 | 1;
  batchResult?: AlertDeliveryBatchResult;
};

const runtimeDependencies: EmailRuntimeDependencies = {
  createTransport: createResendEmailTransport,
  runBatch: runAlertDeliveryBatch,
  closePool
};

export class EmailRuntimeConfigurationError extends Error {
  constructor(readonly code: "database_url_missing") {
    super(code);
    this.name = "EmailRuntimeConfigurationError";
  }
}

export function loadEmailRuntimeConfiguration(
  environment: Record<string, string | undefined> = process.env
): EmailRuntimeConfiguration {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) throw new EmailRuntimeConfigurationError("database_url_missing");

  return {
    databaseUrl,
    ...loadEmailProviderConfiguration(environment),
    workerId: createEmailWorkerId(environment)
  };
}

export function createEmailWorkerId(
  environment: Record<string, string | undefined> = process.env
): string {
  const configuredWorkerId = environment.EMAIL_WORKER_ID?.trim();
  return configuredWorkerId || `email-alerts:${hostname()}:${process.pid}`;
}

export async function runEmailAlertsOnce(
  environment: Record<string, string | undefined> = process.env,
  dependencies: Pick<EmailRuntimeDependencies, "createTransport" | "runBatch"> =
    runtimeDependencies
): Promise<AlertDeliveryBatchResult> {
  const configuration = loadEmailRuntimeConfiguration(environment);
  const transport = dependencies.createTransport({
    apiKey: configuration.apiKey,
    fromAddress: configuration.fromAddress,
    fromName: configuration.fromName
  });

  return dependencies.runBatch({
    channel: "email",
    workerId: configuration.workerId,
    sender: transport
  });
}

export async function runEmailRuntime(
  environment: Record<string, string | undefined> = process.env,
  dependencies: EmailRuntimeDependencies = runtimeDependencies,
  logger: EmailRuntimeLogger = console
): Promise<EmailRuntimeResult> {
  let result: EmailRuntimeResult;

  try {
    const batchResult = await runEmailAlertsOnce(environment, dependencies);
    logger.log(
      JSON.stringify({
        channel: "email",
        claimed: batchResult.claimed,
        sent: batchResult.sent,
        retried: batchResult.retried,
        failed: batchResult.failed
      })
    );
    result = { exitCode: 0, batchResult };
  } catch (error) {
    logger.error(JSON.stringify({ channel: "email", error: toSafeRuntimeErrorCode(error) }));
    result = { exitCode: 1 };
  }

  try {
    await dependencies.closePool();
  } catch {
    logger.error(JSON.stringify({ channel: "email", error: "database_pool_close_failed" }));
    result = { exitCode: 1 };
  }

  return result;
}

export async function main(): Promise<void> {
  let shutdownRequested = false;
  const requestShutdown = () => {
    shutdownRequested = true;
  };
  process.once("SIGTERM", requestShutdown);

  try {
    if (shutdownRequested) return;

    const result = await runEmailRuntime();
    if (result.exitCode === 1) process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", requestShutdown);
  }
}

function toSafeRuntimeErrorCode(error: unknown): string {
  if (error instanceof EmailRuntimeConfigurationError) return error.code;
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "email_worker_failed";
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  void main();
}
