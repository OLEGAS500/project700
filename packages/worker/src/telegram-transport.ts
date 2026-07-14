import type { AlertDeliveryPermanentErrorCode } from "@eim/db";
import type { TelegramSendRequest } from "./alert-deliveries";
import { redactTelegramBotToken } from "./telegram-configuration";

export type TelegramTransport = {
  send(request: TelegramSendRequest): Promise<{ providerMessageId: string }>;
};

export type TelegramTransportErrorCode =
  | "telegram_network_error"
  | "telegram_timeout"
  | "telegram_server_error"
  | "telegram_rate_limited"
  | AlertDeliveryPermanentErrorCode;

export class TelegramTransportError extends Error {
  constructor(
    readonly code: TelegramTransportErrorCode,
    readonly retryable: boolean,
    readonly providerDescription?: string,
    readonly retryAfterSeconds?: number
  ) {
    super(providerDescription ? `${code}: ${providerDescription}` : code);
    this.name = "TelegramTransportError";
  }
}

export class TelegramTransportConfigurationError extends Error {
  constructor(readonly code: "telegram_bot_token_invalid" | "telegram_timeout_invalid") {
    super(code);
    this.name = "TelegramTransportConfigurationError";
  }
}

export function isPermanentTelegramTransportError(
  error: unknown
): error is TelegramTransportError & {
  code: AlertDeliveryPermanentErrorCode;
  retryable: false;
} {
  return (
    error instanceof TelegramTransportError &&
    !error.retryable &&
    ![
      "telegram_network_error",
      "telegram_timeout",
      "telegram_server_error",
      "telegram_rate_limited"
    ].includes(error.code)
  );
}

export type TelegramFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type CreateTelegramTransportInput = {
  botToken: string;
  fetchImpl?: TelegramFetch;
  timeoutMs?: number;
};

type TelegramResponse = {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
  result?: {
    message_id?: number;
  };
};

export function createTelegramTransport(
  input: CreateTelegramTransportInput
): TelegramTransport {
  const botToken = input.botToken.trim();
  if (!botToken) {
    throw new TelegramTransportConfigurationError("telegram_bot_token_invalid");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TelegramTransportConfigurationError("telegram_timeout_invalid");
  }

  return {
    async send(request) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
      let response: Response;

      try {
        response = await fetchImpl(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: request.destination.chatId,
              ...(request.destination.threadId === null
                ? {}
                : { message_thread_id: request.destination.threadId }),
              text: request.content.text,
              parse_mode: request.content.parseMode
            }),
            signal: controller.signal
          }
        );
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          throw new TelegramTransportError("telegram_timeout", true);
        }

        throw new TelegramTransportError(
          "telegram_network_error",
          true,
          sanitizeDescription(redactTelegramBotToken(error, botToken))
        );
      } finally {
        clearTimeout(timeout);
      }

      if (response.status >= 500) {
        throw new TelegramTransportError(
          "telegram_server_error",
          true,
          await readOptionalDescription(response, botToken)
        );
      }

      if (response.status === 429) {
        const body = await readOptionalTelegramResponse(response, botToken);
        throw new TelegramTransportError(
          "telegram_rate_limited",
          true,
          body?.description,
          normalizeRetryAfter(body?.parameters?.retry_after)
        );
      }

      const body = await readTelegramResponse(response, botToken);
      if (body.error_code === 429) {
        throw new TelegramTransportError(
          "telegram_rate_limited",
          true,
          sanitizeDescription(body.description, botToken),
          normalizeRetryAfter(body.parameters?.retry_after)
        );
      }

      if (!response.ok || body.ok !== true) {
        throw classifyPermanentError(response.status, body, botToken);
      }

      const messageId = body.result?.message_id;
      if (!Number.isInteger(messageId)) {
        throw new TelegramTransportError("telegram_response_invalid", false);
      }

      return {
        providerMessageId: `${request.destination.chatId}:${messageId}`
      };
    }
  };
}

async function readOptionalTelegramResponse(
  response: Response,
  botToken: string
): Promise<TelegramResponse | undefined> {
  try {
    const value: unknown = JSON.parse(await response.text());
    if (!isRecord(value) || typeof value.ok !== "boolean") return undefined;
    return {
      ok: value.ok,
      description:
        typeof value.description === "string"
          ? sanitizeDescription(value.description, botToken)
          : undefined,
      error_code: typeof value.error_code === "number" ? value.error_code : undefined,
      parameters: isRecord(value.parameters)
        ? {
            retry_after:
              typeof value.parameters.retry_after === "number"
                ? value.parameters.retry_after
                : undefined
          }
        : undefined
    };
  } catch {
    return undefined;
  }
}

function classifyPermanentError(
  httpStatus: number,
  body: TelegramResponse,
  botToken: string
): TelegramTransportError {
  const status = body.error_code ?? httpStatus;
  const description = sanitizeDescription(body.description, botToken);
  let code: AlertDeliveryPermanentErrorCode;

  if (status === 401) {
    code = "telegram_unauthorized";
  } else if (status === 403) {
    code = "telegram_forbidden";
  } else if (isTopicNotFound(description)) {
    code = "telegram_topic_not_found";
  } else if (isChatNotFound(description)) {
    code = "telegram_chat_not_found";
  } else {
    code = "telegram_bad_request";
  }

  return new TelegramTransportError(code, false, description);
}

async function readTelegramResponse(
  response: Response,
  botToken: string
): Promise<TelegramResponse> {
  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch {
    throw new TelegramTransportError("telegram_response_invalid", false);
  }

  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new TelegramTransportError("telegram_response_invalid", false);
  }

  return {
    ok: value.ok,
    description:
      typeof value.description === "string"
        ? sanitizeDescription(value.description, botToken)
        : undefined,
    error_code: typeof value.error_code === "number" ? value.error_code : undefined,
    parameters: isRecord(value.parameters)
      ? {
          retry_after:
            typeof value.parameters.retry_after === "number"
              ? value.parameters.retry_after
              : undefined
        }
      : undefined,
    result: isRecord(value.result)
      ? {
          message_id:
            typeof value.result.message_id === "number"
              ? value.result.message_id
              : undefined
        }
      : undefined
  };
}

async function readOptionalDescription(
  response: Response,
  botToken: string
): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await response.text());
    return isRecord(value) && typeof value.description === "string"
      ? sanitizeDescription(value.description, botToken)
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeDescription(
  description: string | undefined,
  botToken?: string
): string | undefined {
  if (!description) return undefined;
  const redacted = redactTelegramBotToken(description, botToken);
  const withoutUrls = redacted.replace(/https?:\/\/\S+/gi, "[URL REDACTED]");
  const sanitized = withoutUrls.replace(/[\r\n\t]+/g, " ").trim();
  return sanitized ? sanitized.slice(0, 500) : undefined;
}

function normalizeRetryAfter(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChatNotFound(description: string | undefined): boolean {
  return description?.toLowerCase().includes("chat not found") ?? false;
}

function isTopicNotFound(description: string | undefined): boolean {
  if (!description) return false;
  const normalized = description.toLowerCase();
  return (
    normalized.includes("message thread not found") ||
    normalized.includes("topic not found")
  );
}
