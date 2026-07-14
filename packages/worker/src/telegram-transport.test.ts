import { describe, expect, it } from "vitest";
import type { TelegramSendRequest } from "./alert-deliveries";
import {
  createTelegramTransport,
  TelegramTransportConfigurationError,
  TelegramTransportError,
  type TelegramFetch
} from "./telegram-transport";

const botToken = "123456:top-secret";

describe("Telegram transport", () => {
  it.each([
    ["", undefined, "telegram_bot_token_invalid"],
    ["   ", undefined, "telegram_bot_token_invalid"],
    [botToken, 0, "telegram_timeout_invalid"],
    [botToken, Number.NaN, "telegram_timeout_invalid"]
  ] as const)("rejects invalid factory configuration", (configuredToken, timeoutMs, code) => {
    expect(() =>
      createTelegramTransport({ botToken: configuredToken, timeoutMs })
    ).toThrow(TelegramTransportConfigurationError);
    expect(() =>
      createTelegramTransport({ botToken: configuredToken, timeoutMs })
    ).toThrow(code);
  });

  it("sends HTML content and returns a stable provider message ID", async () => {
    let body: Record<string, unknown> | undefined;
    let calls = 0;
    const transport = createTelegramTransport({
      botToken,
      fetchImpl: async (_url, init) => {
        calls += 1;
        body = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, result: { message_id: 314 } });
      }
    });

    await expect(transport.send(createRequest())).resolves.toEqual({
      providerMessageId: "-1001234567890:314"
    });
    expect(body).toMatchObject({
      chat_id: "-1001234567890",
      message_thread_id: 42,
      text: "<b>Feed incident</b>",
      parse_mode: "HTML"
    });
    expect(calls).toBe(1);
  });

  it("omits message_thread_id when the destination has no topic", async () => {
    let body: Record<string, unknown> | undefined;
    const transport = createTelegramTransport({
      botToken,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      }
    });

    await transport.send(createRequest({ threadId: null }));
    expect(body).not.toHaveProperty("message_thread_id");
  });

  it("redacts the token and request URL from network errors", async () => {
    const fetchImpl: TelegramFetch = async () => {
      throw new Error(
        `request to https://api.telegram.org/bot${botToken}/sendMessage failed`
      );
    };
    const transport = createTelegramTransport({ botToken, fetchImpl });

    const error = await captureError(transport.send(createRequest()));
    expect(error).toMatchObject({
      code: "telegram_network_error",
      retryable: true
    });
    expect(error.message).not.toContain(botToken);
    expect(error.message).not.toContain("api.telegram.org");
  });

  it("classifies request timeout as transient", async () => {
    const fetchImpl: TelegramFetch = async (_url, init) =>
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
    const transport = createTelegramTransport({ botToken, fetchImpl, timeoutMs: 5 });

    await expect(captureError(transport.send(createRequest()))).resolves.toMatchObject({
      code: "telegram_timeout",
      retryable: true
    });
  });

  it("classifies HTTP 5xx as transient even when the body is invalid", async () => {
    const transport = createTelegramTransport({
      botToken,
      fetchImpl: async () => new Response("upstream unavailable", { status: 500 })
    });

    await expect(captureError(transport.send(createRequest()))).resolves.toMatchObject({
      code: "telegram_server_error",
      retryable: true
    });
  });

  it("uses Telegram retry_after for rate limiting", async () => {
    const transport = createTelegramTransport({
      botToken,
      fetchImpl: async () =>
        jsonResponse(
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 123 }
          },
          429
        )
    });

    await expect(captureError(transport.send(createRequest()))).resolves.toMatchObject({
      code: "telegram_rate_limited",
      retryable: true,
      retryAfterSeconds: 123
    });
  });

  it("classifies HTTP 400 as a permanent provider failure", async () => {
    const transport = createTelegramTransport({
      botToken,
      fetchImpl: async () =>
        jsonResponse(
          { ok: false, error_code: 400, description: "Bad Request: chat not found" },
          400
        )
    });

    await expect(captureError(transport.send(createRequest()))).resolves.toMatchObject({
      code: "telegram_chat_not_found",
      retryable: false,
      providerDescription: "Bad Request: chat not found"
    });
  });

  it.each([
    [401, "telegram_unauthorized"],
    [403, "telegram_forbidden"]
  ] as const)("classifies HTTP %s as %s", async (status, code) => {
    const transport = createTelegramTransport({
      botToken,
      fetchImpl: async () =>
        jsonResponse({ ok: false, error_code: status, description: "Provider rejected request" }, status)
    });

    await expect(captureError(transport.send(createRequest()))).resolves.toMatchObject({
      code,
      retryable: false
    });
  });

  it("does not treat invalid JSON as a sent message", async () => {
    let calls = 0;
    const transport = createTelegramTransport({
      botToken,
      fetchImpl: async () => {
        calls += 1;
        return new Response("not-json", { status: 200 });
      }
    });

    await expect(captureError(transport.send(createRequest()))).resolves.toMatchObject({
      code: "telegram_response_invalid",
      retryable: false
    });
    expect(calls).toBe(1);
  });

  it("classifies HTTP 200 with ok=false as a provider error", async () => {
    const transport = createTelegramTransport({
      botToken,
      fetchImpl: async () =>
        jsonResponse({
          ok: false,
          error_code: 400,
          description: "Bad Request: message thread not found"
        })
    });

    await expect(captureError(transport.send(createRequest()))).resolves.toMatchObject({
      code: "telegram_topic_not_found",
      retryable: false
    });
  });
});

function createRequest(
  destination: Partial<TelegramSendRequest["destination"]> = {}
): TelegramSendRequest {
  return {
    deliveryId: "delivery-id",
    incidentEventId: "event-id",
    alertType: "incident_opened",
    channel: "telegram",
    destination: {
      chatId: "-1001234567890",
      threadId: 42,
      ...destination
    },
    content: {
      parseMode: "HTML",
      text: "<b>Feed incident</b>"
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function captureError(promise: Promise<unknown>): Promise<TelegramTransportError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TelegramTransportError);
    return error as TelegramTransportError;
  }
  throw new Error("Expected Telegram transport to reject");
}
