import { describe, expect, it } from "vitest";
import type {
  AlertDeliveryBatchResult,
  EmailTransport,
  RunAlertDeliveryBatchInput
} from "@eim/worker";
import {
  createEmailWorkerId,
  loadEmailRuntimeConfiguration,
  runEmailAlertsOnce,
  runEmailRuntime,
  EmailRuntimeConfigurationError,
  type EmailRuntimeDependencies
} from "./run-email-alerts";

const environment = {
  DATABASE_URL: "postgres://runtime-test.example/eim",
  RESEND_API_KEY: "re_runtime_secret",
  EMAIL_FROM_ADDRESS: "alerts@example.com",
  EMAIL_FROM_NAME: "EIM Alerts",
  EMAIL_WORKER_ID: "email-runtime-test"
};

const expectedResult: AlertDeliveryBatchResult = {
  claimed: 2,
  sent: 1,
  retried: 1,
  failed: 0
};

describe("email alert runtime", () => {
  it("loads configuration before constructing one transport and invoking one email batch", async () => {
    let transportInput: { apiKey: string; fromAddress: string; fromName: string | null } | undefined;
    let batchInput: RunAlertDeliveryBatchInput | undefined;
    let transportCalls = 0;
    let batchCalls = 0;
    const transport = createTransport();

    await expect(
      runEmailAlertsOnce(environment, {
        createTransport(input) {
          transportCalls += 1;
          transportInput = input;
          return transport;
        },
        async runBatch(input) {
          batchCalls += 1;
          batchInput = input;
          return expectedResult;
        }
      })
    ).resolves.toEqual(expectedResult);

    expect(transportInput).toEqual({
      apiKey: "re_runtime_secret",
      fromAddress: "alerts@example.com",
      fromName: "EIM Alerts"
    });
    expect(batchInput).toMatchObject({
      channel: "email",
      workerId: "email-runtime-test",
      sender: transport
    });
    expect(transportCalls).toBe(1);
    expect(batchCalls).toBe(1);
  });

  it.each([
    [{ ...environment, DATABASE_URL: " " }, "database_url_missing"],
    [{ DATABASE_URL: environment.DATABASE_URL }, "resend_api_key_missing"],
    [
      { ...environment, RESEND_API_KEY: " ", EMAIL_FROM_ADDRESS: "alerts@example.com" },
      "resend_api_key_missing"
    ],
    [{ ...environment, EMAIL_FROM_ADDRESS: " " }, "email_from_address_missing"],
    [{ ...environment, EMAIL_FROM_ADDRESS: "invalid" }, "email_from_address_invalid"]
  ] as const)("rejects %s before constructing a transport or claiming work", async (input, code) => {
    let calls = 0;
    await expect(
      runEmailAlertsOnce(input, {
        createTransport() {
          calls += 1;
          throw new Error("transport must not be constructed");
        },
        async runBatch() {
          calls += 1;
          throw new Error("deliveries must not be claimed");
        }
      })
    ).rejects.toThrow(code);
    expect(calls).toBe(0);
  });

  it("keeps the database configuration error typed", () => {
    expect(() => loadEmailRuntimeConfiguration({ ...environment, DATABASE_URL: "" })).toThrow(
      EmailRuntimeConfigurationError
    );
  });

  it("uses an explicit worker ID or a non-empty process-scoped default", () => {
    expect(createEmailWorkerId({ EMAIL_WORKER_ID: " configured-worker " })).toBe(
      "configured-worker"
    );
    expect(createEmailWorkerId({ EMAIL_WORKER_ID: "   " })).toMatch(
      /^email-alerts:.+:[0-9]+$/
    );
    expect(createEmailWorkerId({})).toMatch(/^email-alerts:.+:[0-9]+$/);
  });

  it("emits only aggregate delivery results and closes the pool after success", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    let closed = 0;
    const result = await runEmailRuntime(environment, {
      createTransport: () => createTransport(),
      async runBatch() {
        return expectedResult;
      },
      async closePool() {
        closed += 1;
      }
    }, {
      log(message) {
        logs.push(message);
      },
      error(message) {
        errors.push(message);
      }
    });

    expect(result).toEqual({ exitCode: 0, batchResult: expectedResult });
    expect(logs).toEqual([
      JSON.stringify({ channel: "email", claimed: 2, sent: 1, retried: 1, failed: 0 })
    ]);
    expect(errors).toEqual([]);
    expect(closed).toBe(1);
  });

  it("does not fail the runtime for delivery-level failures", async () => {
    const result = await runEmailRuntime(
      environment,
      createRuntimeDependencies({ claimed: 1, sent: 0, retried: 0, failed: 1 })
    );
    expect(result.exitCode).toBe(0);
    expect(result.batchResult).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });
  });

  it("returns a nonzero runtime outcome and closes the pool after batch or configuration failures", async () => {
    const batchErrors: string[] = [];
    let batchClosed = 0;
    const batchFailure = await runEmailRuntime(
      environment,
      {
        createTransport: () => createTransport(),
        async runBatch() {
          throw new Error("provider details must not be logged");
        },
        async closePool() {
          batchClosed += 1;
        }
      },
      { log() {}, error(message) { batchErrors.push(message); } }
    );
    expect(batchFailure).toEqual({ exitCode: 1 });
    expect(batchErrors).toEqual([JSON.stringify({ channel: "email", error: "email_worker_failed" })]);
    expect(batchClosed).toBe(1);

    let configurationClosed = 0;
    const configurationFailure = await runEmailRuntime(
      { DATABASE_URL: environment.DATABASE_URL },
      {
        createTransport: () => createTransport(),
        async runBatch() {
          throw new Error("must not run");
        },
        async closePool() {
          configurationClosed += 1;
        }
      },
      { log() {}, error() {} }
    );
    expect(configurationFailure).toEqual({ exitCode: 1 });
    expect(configurationClosed).toBe(1);
  });

  it("turns a pool-close failure into a nonzero runtime outcome without leaking details", async () => {
    const errors: string[] = [];
    const result = await runEmailRuntime(
      environment,
      {
        createTransport: () => createTransport(),
        async runBatch() {
          return { claimed: 0, sent: 0, retried: 0, failed: 0 };
        },
        async closePool() {
          throw new Error("postgres://secret@example.com");
        }
      },
      { log() {}, error(message) { errors.push(message); } }
    );

    expect(result.exitCode).toBe(1);
    expect(errors).toEqual([
      JSON.stringify({ channel: "email", error: "database_pool_close_failed" })
    ]);
  });
});

function createRuntimeDependencies(
  result: AlertDeliveryBatchResult
): EmailRuntimeDependencies {
  return {
    createTransport: () => createTransport(),
    async runBatch() {
      return result;
    },
    async closePool() {}
  };
}

function createTransport(): EmailTransport {
  return {
    async send() {
      return { providerMessageId: "unused" };
    }
  };
}
