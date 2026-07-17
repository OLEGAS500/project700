import type { MerchantCenterOAuthFetch } from "@eim/core";
import {
  createMerchantCenterStatusDependencies,
  resolveMerchantCenterAccessToken,
  type MerchantCenterStatusDependencies
} from "./merchant-center-status";

const merchantRegistrationEndpoint = "https://merchantapi.googleapis.com/accounts/v1/accounts";
const defaultRequestTimeoutMs = 10_000;
const maxRequestTimeoutMs = 60_000;

export type MerchantCenterDeveloperRegistrationResult =
  | { outcome: "registered" }
  | { outcome: "not_connected"; errorCode: "merchant_center_not_connected" }
  | {
      outcome: "authentication_failed";
      errorCode: string;
      httpStatus?: number;
    }
  | {
      outcome: "conflict";
      errorCode: "merchant_center_project_registration_conflict";
      httpStatus: 409;
    }
  | {
      outcome: "source_unavailable";
      errorCode: string;
      httpStatus?: number;
    };

export async function registerMerchantCenterDeveloper(input: {
  storeId: string;
  accountId: string | null;
  fetchImpl?: MerchantCenterOAuthFetch;
  now?: () => Date;
  timeoutMs?: number;
  dependencies?: Partial<MerchantCenterStatusDependencies>;
}): Promise<MerchantCenterDeveloperRegistrationResult> {
  if (!input.accountId) {
    return {
      outcome: "not_connected",
      errorCode: "merchant_center_not_connected"
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const access = await resolveMerchantCenterAccessToken({
    storeId: input.storeId,
    fetchImpl,
    now: input.now ?? (() => new Date()),
    dependencies: createMerchantCenterStatusDependencies(input.dependencies)
  });

  if ("status" in access) {
    return {
      outcome: access.status,
      errorCode: access.errorCode,
      httpStatus: access.httpStatus
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    normalizeTimeout(input.timeoutMs)
  );

  let response: Response;
  try {
    response = await fetchImpl(buildRegistrationEndpoint(input.accountId), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${access.accessToken}`,
        "content-type": "application/json"
      },
      body: "{}",
      signal: controller.signal
    });
  } catch {
    return {
      outcome: "source_unavailable",
      errorCode: controller.signal.aborted
        ? "merchant_center_registration_timeout"
        : "merchant_center_registration_network_error"
    };
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    return {
      outcome: "authentication_failed",
      errorCode: "merchant_center_registration_authentication_failed",
      httpStatus: response.status
    };
  }

  if (response.status === 409) {
    return {
      outcome: "conflict",
      errorCode: "merchant_center_project_registration_conflict",
      httpStatus: response.status
    };
  }

  if (!response.ok) {
    return {
      outcome: "source_unavailable",
      errorCode: response.status === 429
        ? "merchant_center_registration_rate_limited"
        : "merchant_center_registration_http_error",
      httpStatus: response.status
    };
  }

  return { outcome: "registered" };
}

function buildRegistrationEndpoint(accountId: string): string {
  return `${merchantRegistrationEndpoint}/${encodeURIComponent(
    accountId
  )}/developerRegistration:registerGcp`;
}

function normalizeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return defaultRequestTimeoutMs;
  return Math.min(Math.max(Math.floor(value as number), 1), maxRequestTimeoutMs);
}
