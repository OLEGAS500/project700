import {
  loadMerchantCenterOAuthConfiguration,
  MerchantCenterOAuthProviderError,
  refreshMerchantCenterAccessToken,
  type MerchantCenterOAuthConfiguration,
  type MerchantCenterOAuthFetch,
  type MerchantCenterOAuthTokenResponse
} from "@eim/core";
import {
  claimMerchantCenterOAuthRefresh,
  completeMerchantCenterOAuthRefresh,
  getMerchantCenterOAuthTokenSet,
  getSnapshotStore,
  persistSourceCheckResult,
  createQueuedSnapshot,
  MerchantCenterOAuthCredentialsNotFoundError,
  MerchantCenterOAuthRefreshInProgressError,
  releaseMerchantCenterOAuthRefresh,
  type MerchantCenterOAuthTokenSet,
  type UpsertMerchantCenterOAuthCredentialsInput
} from "@eim/db";
import { randomUUID } from "node:crypto";

const merchantStatusEndpoint = "https://merchantapi.googleapis.com/accounts/v1/accounts";
const defaultRequestTimeoutMs = 10_000;
const maxRequestTimeoutMs = 60_000;
const refreshSafetyWindowMs = 60_000;
const maxErrorSamples = 3;
const maxStoredCount = 2_147_483_647;

export type MerchantCenterProductStatusCounts = {
  total: number;
  approved: number;
  pending: number;
  disapproved: number;
};

export type MerchantCenterStatusDependencies = {
  getTokenSet: (storeId: string) => Promise<MerchantCenterOAuthTokenSet>;
  claimRefresh: (
    storeId: string,
    lockId: string,
    leaseSeconds?: number
  ) => Promise<MerchantCenterOAuthTokenSet>;
  completeRefresh: (
    storeId: string,
    lockId: string,
    input: UpsertMerchantCenterOAuthCredentialsInput
  ) => Promise<unknown>;
  releaseRefresh: (storeId: string, lockId: string) => Promise<void>;
  loadConfiguration: () => MerchantCenterOAuthConfiguration;
  refreshAccessToken: (
    configuration: MerchantCenterOAuthConfiguration,
    refreshToken: string,
    fetchImpl: MerchantCenterOAuthFetch
  ) => Promise<MerchantCenterOAuthTokenResponse>;
};

const defaultDependencies: MerchantCenterStatusDependencies = {
  getTokenSet: getMerchantCenterOAuthTokenSet,
  claimRefresh: claimMerchantCenterOAuthRefresh,
  completeRefresh: completeMerchantCenterOAuthRefresh,
  releaseRefresh: releaseMerchantCenterOAuthRefresh,
  loadConfiguration: loadMerchantCenterOAuthConfiguration,
  refreshAccessToken: refreshMerchantCenterAccessToken
};

export type CollectMerchantCenterProductStatusesInput = {
  storeId: string;
  accountId: string | null;
  fetchImpl?: MerchantCenterOAuthFetch;
  timeoutMs?: number;
  now?: () => Date;
  dependencies?: Partial<MerchantCenterStatusDependencies>;
};

export async function collectMerchantCenterProductStatuses(
  input: CollectMerchantCenterProductStatusesInput
): Promise<import("@eim/core").SourceCheckResult> {
  const startedAt = new Date();
  const now = input.now ?? (() => new Date());
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const dependencies = {
    ...defaultDependencies,
    ...input.dependencies
  };
  const endpoint = buildMerchantStatusEndpoint(input.accountId);

  if (!input.accountId) {
    return buildResult(startedAt, endpoint, {
      status: "authentication_failed",
      errorCode: "merchant_center_not_connected",
      errorMessage: "Merchant Center is not connected."
    });
  }

  const access = await resolveAccessToken({
    storeId: input.storeId,
    fetchImpl,
    now,
    dependencies
  });

  if ("status" in access) {
    return buildResult(startedAt, endpoint, access);
  }

  return fetchAggregateStatuses({
    endpoint,
    accessToken: access.accessToken,
    fetchImpl,
    timeoutMs,
    startedAt
  });
}

export async function runMerchantCenterStatusSnapshotForStore(storeId: string): Promise<{
  snapshotId: string;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  sourceCheckStatus: import("@eim/core").SourceCheckStatus;
  merchantTotalCount: number | null;
  merchantApprovedCount: number | null;
  merchantPendingCount: number | null;
  merchantDisapprovedCount: number | null;
}> {
  const snapshot = await createQueuedSnapshot(
    storeId,
    "normal_check",
    `merchant-center-status:${storeId}:${toMinuteWindow(new Date().toISOString())}`
  );
  const store = await getSnapshotStore(snapshot.id);

  if (!store) {
    throw new Error(`Snapshot ${snapshot.id} does not belong to an existing store`);
  }

  const result = await collectMerchantCenterProductStatuses({
    storeId: store.id,
    accountId: store.merchantCenterAccountId
  });
  const persisted = await persistSourceCheckResult(snapshot.id, store.id, result);

  return {
    snapshotId: persisted.id,
    status: persisted.status,
    sourceCheckStatus: result.status,
    merchantTotalCount: persisted.merchantTotalCount,
    merchantApprovedCount: persisted.merchantApprovedCount,
    merchantPendingCount: persisted.merchantPendingCount,
    merchantDisapprovedCount: persisted.merchantDisapprovedCount
  };
}

type AccessTokenResolution =
  | { accessToken: string }
  | {
      status: "authentication_failed" | "source_unavailable";
      errorCode: string;
      errorMessage: string;
      httpStatus?: number;
    };

async function resolveAccessToken(input: {
  storeId: string;
  fetchImpl: MerchantCenterOAuthFetch;
  now: () => Date;
  dependencies: MerchantCenterStatusDependencies;
}): Promise<AccessTokenResolution> {
  let current: MerchantCenterOAuthTokenSet;

  try {
    current = await input.dependencies.getTokenSet(input.storeId);
  } catch (error) {
    if (error instanceof MerchantCenterOAuthCredentialsNotFoundError) {
      return {
        status: "authentication_failed",
        errorCode: "merchant_center_credentials_missing",
        errorMessage: "Merchant Center credentials are not available."
      };
    }

    return {
      status: "authentication_failed",
      errorCode: "merchant_center_credentials_unavailable",
      errorMessage: "Merchant Center credentials could not be read."
    };
  }

  if (current.expiresAt.getTime() > input.now().getTime() + refreshSafetyWindowMs) {
    return { accessToken: current.accessToken };
  }

  let configuration: MerchantCenterOAuthConfiguration;
  try {
    configuration = input.dependencies.loadConfiguration();
  } catch {
    return {
      status: "authentication_failed",
      errorCode: "oauth_configuration_unavailable",
      errorMessage: "Merchant Center OAuth configuration is unavailable."
    };
  }

  const lockId = randomUUID();
  let claimed = false;

  try {
    const leased = await input.dependencies.claimRefresh(input.storeId, lockId);
    claimed = true;

    const tokenResponse = await input.dependencies.refreshAccessToken(
      configuration,
      leased.refreshToken,
      input.fetchImpl
    );
    const expiresAt = new Date(input.now().getTime() + tokenResponse.expires_in * 1_000);
    const refreshToken = tokenResponse.refresh_token ?? leased.refreshToken;
    const scopes = tokenResponse.scope
      ? tokenResponse.scope.split(/\s+/).filter(Boolean)
      : leased.scopes;

    await input.dependencies.completeRefresh(input.storeId, lockId, {
      accessToken: tokenResponse.access_token,
      refreshToken,
      tokenType: tokenResponse.token_type ?? leased.tokenType,
      expiresAt,
      scopes,
      metadata: leased.metadata
    });

    return { accessToken: tokenResponse.access_token };
  } catch (error) {
    if (error instanceof MerchantCenterOAuthRefreshInProgressError) {
      return {
        status: "source_unavailable",
        errorCode: "merchant_center_refresh_in_progress",
        errorMessage: "Merchant Center credentials are being refreshed."
      };
    }

    if (error instanceof MerchantCenterOAuthProviderError) {
      return {
        status: "authentication_failed",
        errorCode: error.code,
        errorMessage: "Merchant Center credentials could not be refreshed."
      };
    }

    return {
      status: "source_unavailable",
      errorCode: "merchant_center_refresh_failed",
      errorMessage: "Merchant Center credentials could not be refreshed."
    };
  } finally {
    if (claimed) {
      await input.dependencies.releaseRefresh(input.storeId, lockId).catch(() => undefined);
    }
  }
}

async function fetchAggregateStatuses(input: {
  endpoint: string;
  accessToken: string;
  fetchImpl: MerchantCenterOAuthFetch;
  timeoutMs: number;
  startedAt: Date;
}): Promise<import("@eim/core").SourceCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  let response: Response;

  try {
    response = await input.fetchImpl(input.endpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.accessToken}`
      },
      signal: controller.signal
    });
  } catch {
    return buildResult(input.startedAt, input.endpoint, {
      status: "source_unavailable",
      errorCode: controller.signal.aborted ? "merchant_center_timeout" : "merchant_center_network_error",
      errorMessage: controller.signal.aborted
        ? "Merchant Center status request timed out."
        : "Merchant Center status source could not be reached."
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    return buildResult(input.startedAt, input.endpoint, {
      status: "authentication_failed",
      httpStatus: response.status,
      errorCode: "merchant_center_authentication_failed",
      errorMessage: "Merchant Center rejected the credentials."
    });
  }

  if (!response.ok) {
    return buildResult(input.startedAt, input.endpoint, {
      status: "source_unavailable",
      httpStatus: response.status,
      errorCode: response.status === 429 ? "merchant_center_rate_limited" : "merchant_center_http_error",
      errorMessage: "Merchant Center status source returned an unavailable response."
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    return buildResult(input.startedAt, input.endpoint, {
      status: "partial",
      httpStatus: response.status,
      errorCode: "merchant_center_response_invalid",
      errorMessage: "Merchant Center returned incomplete status data.",
      totalItemsSeen: 0,
      skippedItems: 1,
      errorSamples: ["provider_response_invalid"]
    });
  }

  return buildAggregateResult(input.startedAt, input.endpoint, response.status, payload);
}

function buildAggregateResult(
  startedAt: Date,
  endpoint: string,
  httpStatus: number,
  payload: unknown
): import("@eim/core").SourceCheckResult {
  const resources = readAggregateResources(payload);

  if (!resources) {
    return buildResult(startedAt, endpoint, {
      status: "partial",
      httpStatus,
      errorCode: "merchant_center_response_invalid",
      errorMessage: "Merchant Center returned incomplete status data.",
      totalItemsSeen: 0,
      skippedItems: 1,
      errorSamples: ["aggregate_statuses_missing"]
    });
  }

  let counts: MerchantCenterProductStatusCounts = {
    total: 0,
    approved: 0,
    pending: 0,
    disapproved: 0
  };
  const errorSamples: string[] = [];
  let skippedItems = 0;

  for (const resource of resources) {
    const parsed = readResourceCounts(resource);
    if (!parsed) {
      skippedItems += 1;
      if (errorSamples.length < maxErrorSamples) {
        errorSamples.push("aggregate_status_invalid");
      }
      continue;
    }

    const next = addCounts(counts, parsed);
    if (!next) {
      skippedItems += 1;
      if (errorSamples.length < maxErrorSamples) {
        errorSamples.push("aggregate_status_count_out_of_range");
      }
      continue;
    }
    counts = next;
  }

  const status = skippedItems > 0 ? "partial" : "success";

  return buildResult(startedAt, endpoint, {
    status,
    httpStatus,
    itemsObserved: counts.total,
    totalItemsSeen: resources.length,
    skippedItems,
    errorSamples,
    metadata: {
      merchantStatusAggregationVersion: "v1",
      aggregationScope: "all_reporting_contexts_and_countries",
      aggregateResourcesObserved: resources.length,
      aggregateResourcesValid: resources.length - skippedItems,
      merchantStatusCounts: counts
    }
  });
}

function readAggregateResources(payload: unknown): unknown[] | null {
  if (!isRecord(payload)) return null;
  const resources = payload.aggregateProductStatuses ?? payload.aggregate_product_statuses;
  return Array.isArray(resources) ? resources : null;
}

function readResourceCounts(value: unknown): MerchantCenterProductStatusCounts | null {
  if (!isRecord(value)) return null;
  const statsValue = value.stats ?? value.statistics;
  if (!isRecord(statsValue)) return null;

  const approved = readCount(
    statsValue.approvedCount ?? statsValue.approved_count ?? statsValue.activeCount ?? statsValue.active_count
  );
  const pending = readCount(statsValue.pendingCount ?? statsValue.pending_count);
  const disapproved = readCount(
    statsValue.disapprovedCount ?? statsValue.disapproved_count
  );

  if (approved === null || pending === null || disapproved === null) return null;

  return {
    total: approved + pending + disapproved,
    approved,
    pending,
    disapproved
  };
}

function addCounts(
  current: MerchantCenterProductStatusCounts,
  next: MerchantCenterProductStatusCounts
): MerchantCenterProductStatusCounts | null {
  const total = current.total + next.total;
  const approved = current.approved + next.approved;
  const pending = current.pending + next.pending;
  const disapproved = current.disapproved + next.disapproved;

  if ([total, approved, pending, disapproved].some((value) => value > maxStoredCount)) {
    return null;
  }

  return { total, approved, pending, disapproved };
}

function readCount(value: unknown): number | null {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !/^\d+$/.test(normalized)) return null;

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed <= maxStoredCount ? parsed : null;
}

function buildResult(
  startedAt: Date,
  endpoint: string,
  input: {
    status: import("@eim/core").SourceCheckStatus;
    httpStatus?: number;
    itemsObserved?: number;
    totalItemsSeen?: number;
    skippedItems?: number;
    errorCode?: string;
    errorMessage?: string;
    errorSamples?: string[];
    metadata?: Record<string, unknown>;
  }
): import("@eim/core").SourceCheckResult {
  const finishedAt = new Date();
  return {
    source: "merchant_center",
    url: endpoint,
    status: input.status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    httpStatus: input.httpStatus,
    itemsObserved: input.itemsObserved ?? 0,
    totalItemsSeen: input.totalItemsSeen,
    skippedItems: input.skippedItems,
    items: [],
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    errorSamples: input.errorSamples,
    metadata: input.metadata
  };
}

function buildMerchantStatusEndpoint(accountId: string | null): string {
  return `${merchantStatusEndpoint}/${encodeURIComponent(accountId ?? "unconfigured")}/aggregateProductStatuses`;
}

function normalizeTimeout(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return defaultRequestTimeoutMs;
  }

  return Math.max(1, Math.min(Math.floor(value), maxRequestTimeoutMs));
}

function toMinuteWindow(value: string): string {
  const date = new Date(value);
  date.setSeconds(0, 0);
  return date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
