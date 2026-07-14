import type { AlertDeliveryPermanentErrorCode } from "@eim/db";
import type { EmailSendRequest } from "./alert-deliveries";
import {
  formatEmailFromAddress,
  isValidEmailAddress,
  redactResendApiKey
} from "./email-configuration";

const resendEmailUrl = "https://api.resend.com/emails";

type ResendPermanentTransportErrorCode = Extract<
  AlertDeliveryPermanentErrorCode,
  `resend_${string}`
>;

export type ResendTransportErrorCode =
  | "resend_network_error"
  | "resend_timeout"
  | "resend_server_error"
  | "resend_rate_limited"
  | "resend_concurrent_idempotent_request"
  | ResendPermanentTransportErrorCode;

export class ResendTransportError extends Error {
  constructor(
    readonly code: ResendTransportErrorCode,
    readonly retryable: boolean,
    readonly safeDescription?: string,
    readonly retryAfterSeconds?: number
  ) {
    super(safeDescription ? `${code}: ${safeDescription}` : code);
    this.name = "ResendTransportError";
  }
}

export class ResendTransportConfigurationError extends Error {
  constructor(
    readonly code:
      | "resend_api_key_invalid"
      | "email_from_address_invalid"
      | "resend_timeout_invalid"
  ) {
    super(code);
    this.name = "ResendTransportConfigurationError";
  }
}

export function isPermanentResendTransportError(
  error: unknown
): error is ResendTransportError & {
  code: ResendPermanentTransportErrorCode;
  retryable: false;
} {
  return error instanceof ResendTransportError && !error.retryable;
}

export type ResendFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type EmailTransport = {
  send(request: EmailSendRequest): Promise<{ providerMessageId: string }>;
};

export type CreateResendEmailTransportInput = {
  apiKey: string;
  fromAddress: string;
  fromName: string | null;
  fetchImpl?: ResendFetch;
  timeoutMs?: number;
};

type ResendErrorResponse = {
  name?: string;
  message?: string;
};

export function createResendEmailTransport(
  input: CreateResendEmailTransportInput
): EmailTransport {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new ResendTransportConfigurationError("resend_api_key_invalid");
  }

  const fromAddress = input.fromAddress.trim();
  if (!isValidEmailAddress(fromAddress)) {
    throw new ResendTransportConfigurationError("email_from_address_invalid");
  }

  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ResendTransportConfigurationError("resend_timeout_invalid");
  }

  const fromName = input.fromName?.replace(/\s+/g, " ").trim() || null;
  const fetchImpl = input.fetchImpl ?? fetch;
  const from = formatEmailFromAddress({ fromAddress, fromName });

  return {
    async send(request) {
      const body = JSON.stringify({
        from,
        to: request.destination.recipientEmails,
        subject: request.content.subject,
        text: request.content.text
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
      let response: Response;

      try {
        response = await fetchImpl(resendEmailUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": `eim-delivery-${request.deliveryId}`
          },
          body,
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          throw new ResendTransportError("resend_timeout", true);
        }

        throw new ResendTransportError(
          "resend_network_error",
          true,
          sanitizeDescription(errorMessage(error), apiKey, request, body, from)
        );
      } finally {
        clearTimeout(timeout);
      }

      if (response.status >= 500) {
        throw new ResendTransportError(
          "resend_server_error",
          true,
          await readOptionalDescription(response, apiKey, request, body, from)
        );
      }

      const parsed = await readResponse(response, apiKey, request, body, from);
      if (response.ok) {
        if (typeof parsed.id !== "string" || !parsed.id.trim()) {
          throw new ResendTransportError("resend_response_invalid", false);
        }
        return { providerMessageId: parsed.id };
      }

      throw classifyResponseError(
        response.status,
        parsed.error,
        parseRetryAfter(response.headers.get("retry-after"))
      );
    }
  };
}

async function readResponse(
  response: Response,
  apiKey: string,
  request: EmailSendRequest,
  requestBody: string,
  from: string
): Promise<{ id?: string; error?: ResendErrorResponse }> {
  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch {
    throw new ResendTransportError("resend_response_invalid", false);
  }

  if (!isRecord(value)) {
    throw new ResendTransportError("resend_response_invalid", false);
  }

  const errorValue = isRecord(value.error) ? value.error : value;
  const error = isRecord(errorValue)
    ? {
        name: typeof errorValue.name === "string" ? errorValue.name : undefined,
        message:
          typeof errorValue.message === "string"
            ? sanitizeDescription(errorValue.message, apiKey, request, requestBody, from)
            : undefined
      }
    : undefined;

  return {
    id: typeof value.id === "string" ? value.id : undefined,
    error
  };
}

async function readOptionalDescription(
  response: Response,
  apiKey: string,
  request: EmailSendRequest,
  requestBody: string,
  from: string
): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await response.text());
    const errorValue = isRecord(value) && isRecord(value.error) ? value.error : value;
    return isRecord(errorValue) && typeof errorValue.message === "string"
      ? sanitizeDescription(errorValue.message, apiKey, request, requestBody, from)
      : undefined;
  } catch {
    return undefined;
  }
}

function classifyResponseError(
  httpStatus: number,
  error: ResendErrorResponse | undefined,
  retryAfterSeconds: number | undefined
): ResendTransportError {
  const name = error?.name?.toLowerCase();
  const safeDescription = error?.message;

  if (name === "rate_limit_exceeded") {
    return new ResendTransportError(
      "resend_rate_limited",
      true,
      safeDescription,
      retryAfterSeconds
    );
  }
  if (name === "concurrent_idempotent_requests") {
    return new ResendTransportError(
      "resend_concurrent_idempotent_request",
      true,
      safeDescription,
      retryAfterSeconds
    );
  }
  if (name === "application_error" || name === "internal_server_error") {
    return new ResendTransportError("resend_server_error", true, safeDescription);
  }
  if (name === "daily_quota_exceeded" || name === "monthly_quota_exceeded") {
    return new ResendTransportError("resend_quota_exceeded", false, safeDescription);
  }
  if (httpStatus === 429) {
    return new ResendTransportError(
      "resend_rate_limited",
      true,
      safeDescription,
      retryAfterSeconds
    );
  }

  const code = permanentErrorCode(name, httpStatus);
  return new ResendTransportError(code, false, safeDescription);
}

function permanentErrorCode(
  name: string | undefined,
  httpStatus: number
): ResendPermanentTransportErrorCode {
  switch (name) {
    case "missing_api_key":
    case "restricted_api_key":
    case "invalid_api_key":
      return "resend_authentication_failed";
    case "permission_denied":
    case "invalid_access":
      return "resend_permission_denied";
    case "invalid_from_address":
      return "resend_invalid_from_address";
    case "invalid_idempotency_key":
      return "resend_invalid_idempotency_key";
    case "invalid_idempotent_request":
      return "resend_invalid_idempotent_request";
    case "security_error":
      return "resend_security_error";
    case "validation_error":
    case "invalid_attachment":
    case "invalid_parameter":
    case "invalid_region":
    case "missing_required_field":
      return "resend_validation_error";
    default:
      if (httpStatus === 401 || httpStatus === 403) {
        return "resend_authentication_failed";
      }
      if (httpStatus === 451) return "resend_security_error";
      return "resend_validation_error";
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.trunc(seconds) : undefined;
}

function sanitizeDescription(
  description: string,
  apiKey: string,
  request: EmailSendRequest,
  requestBody: string,
  from: string
): string | undefined {
  let sanitized = redactResendApiKey(description, apiKey);
  for (const value of [
    requestBody,
    request.content.subject,
    request.content.text,
    from,
    ...request.destination.recipientEmails
  ]) {
    if (value) sanitized = sanitized.replaceAll(value, "[REDACTED]");
  }
  sanitized = sanitized
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/[^\s"']+/gi, "[URL REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return sanitized ? sanitized.slice(0, 500) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
