import { describe, expect, it } from "vitest";
import type { EmailSendRequest } from "./alert-deliveries";
import {
  createResendEmailTransport,
  ResendTransportConfigurationError,
  ResendTransportError,
  type ResendFetch
} from "./resend-email-transport";

const apiKey = "re_test_secret";
const recipient = "ops@example.com";
const messageText = "A private alert body";

describe("Resend email transport", () => {
  it.each([
    ["", "alerts@example.com", undefined, "resend_api_key_invalid"],
    ["   ", "alerts@example.com", undefined, "resend_api_key_invalid"],
    [apiKey, "not-an-address", undefined, "email_from_address_invalid"],
    [apiKey, "alerts@example.com", 0, "resend_timeout_invalid"],
    [apiKey, "alerts@example.com", Number.NaN, "resend_timeout_invalid"]
  ] as const)(
    "rejects invalid factory configuration",
    (configuredApiKey, fromAddress, timeoutMs, code) => {
      expect(() =>
        createResendEmailTransport({
          apiKey: configuredApiKey,
          fromAddress,
          fromName: "EIM Alerts",
          timeoutMs
        })
      ).toThrow(ResendTransportConfigurationError);
      expect(() =>
        createResendEmailTransport({
          apiKey: configuredApiKey,
          fromAddress,
          fromName: "EIM Alerts",
          timeoutMs
        })
      ).toThrow(code);
    }
  );

  it("sends immutable email content once and returns the Resend provider ID", async () => {
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    let calls = 0;
    const transport = createResendEmailTransport({
      apiKey,
      fromAddress: "alerts@example.com",
      fromName: "EIM Alerts",
      fetchImpl: async (url, init) => {
        calls += 1;
        requestUrl = url;
        requestInit = init;
        return jsonResponse({ id: "re_email_123" });
      }
    });

    await expect(transport.send(createRequest())).resolves.toEqual({
      providerMessageId: "re_email_123"
    });
    expect(requestUrl).toBe("https://api.resend.com/emails");
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toMatchObject({
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": "eim-delivery-delivery-id"
    });
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      from: "EIM Alerts <alerts@example.com>",
      to: [recipient],
      subject: "[New incident] Example Store: Catalog drop detected",
      text: messageText
    });
    expect(calls).toBe(1);
  });

  it("uses the same delivery idempotency key on every retry", async () => {
    const keys: string[] = [];
    const transport = createResendEmailTransport({
      apiKey,
      fromAddress: "alerts@example.com",
      fromName: null,
      fetchImpl: async (_url, init) => {
        keys.push(String((init?.headers as Record<string, string>)["idempotency-key"]));
        return jsonResponse({ id: "re_email_replayed" });
      }
    });

    await transport.send(createRequest());
    await transport.send(createRequest());
    expect(keys).toEqual(["eim-delivery-delivery-id", "eim-delivery-delivery-id"]);
  });

  it("redacts API keys, recipients, content, and URLs from network errors", async () => {
    const fetchImpl: ResendFetch = async () => {
      throw new Error(
        `POST https://api.resend.com/emails Bearer ${apiKey} ${recipient} ${messageText}`
      );
    };
    const transport = createResendEmailTransport({
      apiKey,
      fromAddress: "alerts@example.com",
      fromName: null,
      fetchImpl
    });

    const error = await captureError(transport.send(createRequest()));
    expect(error).toMatchObject({ code: "resend_network_error", retryable: true });
    expect(error.message).not.toContain(apiKey);
    expect(error.message).not.toContain(recipient);
    expect(error.message).not.toContain(messageText);
    expect(error.message).not.toContain("api.resend.com");
  });

  it("classifies a request timeout as transient", async () => {
    const fetchImpl: ResendFetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    const transport = createResendEmailTransport({
      apiKey,
      fromAddress: "alerts@example.com",
      fromName: null,
      fetchImpl,
      timeoutMs: 5
    });

    await expect(captureError(transport.send(createRequest()))).resolves.toMatchObject({
      code: "resend_timeout",
      retryable: true
    });
  });

  it("classifies HTTP 5xx as transient even with an invalid body", async () => {
    const transport = createTransport(async () => new Response("unavailable", { status: 503 }));
    await expect(captureError(transport.send(createRequest()))).resolves.toMatchObject({
      code: "resend_server_error",
      retryable: true
    });
  });

  it("uses retry-after for Resend rate limiting", async () => {
    const transport = createTransport(async () =>
      jsonResponse(
        { error: { name: "rate_limit_exceeded", message: "Slow down" } },
        429,
        { "retry-after": "123" }
      )
    );
    await expect(captureError(transport.send(createRequest()))).resolves.toMatchObject({
      code: "resend_rate_limited",
      retryable: true,
      retryAfterSeconds: 123
    });
  });

  it("retries a concurrent idempotent request", async () => {
    const transport = createTransport(async () =>
      jsonResponse(
        {
          error: {
            name: "concurrent_idempotent_requests",
            message: "Original request is still processing"
          }
        },
        409
      )
    );
    await expect(captureError(transport.send(createRequest()))).resolves.toMatchObject({
      code: "resend_concurrent_idempotent_request",
      retryable: true
    });
  });

  it.each([
    [403, "invalid_api_key", "resend_authentication_failed"],
    [403, "validation_error", "resend_validation_error"],
    [422, "invalid_from_address", "resend_invalid_from_address"],
    [429, "daily_quota_exceeded", "resend_quota_exceeded"],
    [400, "invalid_idempotency_key", "resend_invalid_idempotency_key"],
    [409, "invalid_idempotent_request", "resend_invalid_idempotent_request"],
    [451, "security_error", "resend_security_error"]
  ] as const)("classifies %s %s as permanent %s", async (status, name, code) => {
    const transport = createTransport(async () =>
      jsonResponse({ error: { name, message: "Provider rejected request" } }, status)
    );
    await expect(captureError(transport.send(createRequest()))).resolves.toMatchObject({
      code,
      retryable: false
    });
  });

  it.each([
    [new Response("not-json", { status: 200 })],
    [jsonResponse({ status: "ok" })]
  ])("treats a malformed success response as permanent", async (response) => {
    const transport = createTransport(async () => response);
    await expect(captureError(transport.send(createRequest()))).resolves.toMatchObject({
      code: "resend_response_invalid",
      retryable: false
    });
  });
});

function createTransport(fetchImpl: ResendFetch) {
  return createResendEmailTransport({
    apiKey,
    fromAddress: "alerts@example.com",
    fromName: "EIM Alerts",
    fetchImpl
  });
}

function createRequest(): EmailSendRequest {
  return {
    deliveryId: "delivery-id",
    incidentEventId: "event-id",
    alertType: "incident_opened",
    channel: "email",
    destination: { recipientEmails: [recipient] },
    content: {
      subject: "[New incident] Example Store: Catalog drop detected",
      text: messageText
    }
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

async function captureError(promise: Promise<unknown>): Promise<ResendTransportError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ResendTransportError);
    return error as ResendTransportError;
  }
  throw new Error("Expected Resend transport to reject");
}
