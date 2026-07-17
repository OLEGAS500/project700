import { describe, expect, it, vi } from "vitest";
import { merchantItemIssuesConfigurationHash } from "@eim/db";
import {
  collectMerchantCenterProductStatuses,
  type MerchantCenterStatusDependencies
} from "./merchant-center-status";

function futureTokenSet() {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenType: "Bearer",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    scopes: ["https://www.googleapis.com/auth/content"],
    metadata: {}
  };
}

function dependencies(
  overrides: Partial<MerchantCenterStatusDependencies> = {}
): MerchantCenterStatusDependencies {
  return {
    getTokenSet: vi.fn(async () => futureTokenSet()),
    claimRefresh: vi.fn(async () => futureTokenSet()),
    completeRefresh: vi.fn(async () => undefined),
    releaseRefresh: vi.fn(async () => undefined),
    loadConfiguration: vi.fn(() => ({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://example.com/oauth/callback",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/content"]
    })),
    refreshAccessToken: vi.fn(async () => ({
      access_token: "refreshed-access-token",
      refresh_token: "refreshed-refresh-token",
      expires_in: 3600,
      token_type: "Bearer"
    })),
    ...overrides
  };
}

describe("collectMerchantCenterProductStatuses", () => {
  it("uses the official v1 endpoint and aggregates current stats fields", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://merchantapi.googleapis.com/issueresolution/v1/accounts/123/aggregateProductStatuses?pageSize=250"
      );
      expect(init?.headers).toMatchObject({ authorization: "Bearer access-token" });
      return new Response(
        JSON.stringify({
          aggregateProductStatuses: [
            {
              reportingContext: "SHOPPING_ADS",
              countryCode: "US",
              stats: {
                activeCount: "10",
                pendingCount: "2",
                disapprovedCount: "1"
              }
            },
            {
              reportingContext: "FREE_LISTINGS",
              countryCode: "US",
              stats: {
                activeCount: "4",
                pendingCount: "1",
                disapprovedCount: "0"
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await collectMerchantCenterProductStatuses({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      dependencies: dependencies()
    });

    expect(result).toMatchObject({
      source: "merchant_center",
      status: "success",
      itemsObserved: 18,
      totalItemsSeen: 2,
      skippedItems: 0
    });
    expect(result.metadata).toMatchObject({
      aggregationScope: "all_reporting_contexts_and_countries",
      merchantCenterConfigurationHash: merchantItemIssuesConfigurationHash("123"),
      merchantStatusCounts: {
        total: 18,
        approved: 14,
        pending: 3,
        disapproved: 1
      }
    });
  });

  it("follows nextPageToken with the same bounded page size", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.toString());

      if (!url.searchParams.has("pageToken")) {
        return new Response(
          JSON.stringify({
            aggregateProductStatuses: [
              { stats: { activeCount: "3", pendingCount: "1", disapprovedCount: "0" } }
            ],
            nextPageToken: "page-two"
          }),
          { status: 200 }
        );
      }

      expect(url.searchParams.get("pageSize")).toBe("250");
      expect(url.searchParams.get("pageToken")).toBe("page-two");
      return new Response(
        JSON.stringify({
          aggregateProductStatuses: [
            { stats: { activeCount: "2", pendingCount: "0", disapprovedCount: "1" } }
          ]
        }),
        { status: 200 }
      );
    });

    const result = await collectMerchantCenterProductStatuses({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      dependencies: dependencies()
    });

    expect(result).toMatchObject({
      status: "success",
      itemsObserved: 7,
      totalItemsSeen: 2,
      skippedItems: 0
    });
    expect(calls).toHaveLength(2);
    expect(result.metadata).toMatchObject({
      pagination: { pagesFetched: 2, complete: true }
    });
  });

  it("returns partial when a pagination token repeats", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          aggregateProductStatuses: [
            { stats: { activeCount: "3", pendingCount: "0", disapprovedCount: "0" } }
          ],
          nextPageToken: "same-token"
        }),
        { status: 200 }
      )
    );

    const result = await collectMerchantCenterProductStatuses({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      dependencies: dependencies()
    });

    expect(result.status).toBe("partial");
    expect(result.errorCode).toBe("merchant_center_page_token_repeated");
    expect(result.itemsObserved).toBe(6);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result.metadata)).not.toContain("same-token");
  });

  it("stops at the page cap without looping forever", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          aggregateProductStatuses: [
            { stats: { activeCount: "4", pendingCount: "0", disapprovedCount: "0" } }
          ],
          nextPageToken: "another-page"
        }),
        { status: 200 }
      )
    );

    const result = await collectMerchantCenterProductStatuses({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      limits: { maxPages: 1 },
      dependencies: dependencies()
    });

    expect(result.status).toBe("partial");
    expect(result.errorCode).toBe("merchant_center_page_limit");
    expect(result.itemsObserved).toBe(4);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects an oversized pagination token without sending it", async () => {
    const oversizedToken = "x".repeat(20);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          aggregateProductStatuses: [
            { stats: { activeCount: "1", pendingCount: "0", disapprovedCount: "0" } }
          ],
          nextPageToken: oversizedToken
        }),
        { status: 200 }
      )
    );

    const result = await collectMerchantCenterProductStatuses({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      limits: { maxPageTokenLength: 8 },
      dependencies: dependencies()
    });

    expect(result.status).toBe("partial");
    expect(result.errorCode).toBe("merchant_center_page_token_too_long");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.metadata)).not.toContain(oversizedToken);
  });

  it("keeps earlier counts when a later page fails", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (!new URL(String(input)).searchParams.has("pageToken")) {
        return new Response(
          JSON.stringify({
            aggregateProductStatuses: [
              { stats: { activeCount: "8", pendingCount: "1", disapprovedCount: "0" } }
            ],
            nextPageToken: "failing-page"
          }),
          { status: 200 }
        );
      }
      return new Response("unavailable details", { status: 503 });
    });

    const result = await collectMerchantCenterProductStatuses({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      dependencies: dependencies()
    });

    expect(result).toMatchObject({
      status: "partial",
      errorCode: "merchant_center_pagination_http_error",
      httpStatus: 503,
      itemsObserved: 9
    });
    expect(result.errorMessage).not.toContain("unavailable details");
    expect(result.metadata).toMatchObject({
      merchantStatusCounts: { total: 9, approved: 8, pending: 1, disapproved: 0 },
      pagination: { pagesFetched: 1, complete: false }
    });
  });

  it("refreshes an expired access token before the provider call", async () => {
    const oauth = dependencies({
      getTokenSet: vi.fn(async () => ({
        ...futureTokenSet(),
        expiresAt: new Date("2020-01-01T00:00:00.000Z")
      }))
    });
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ aggregateProductStatuses: [] }),
        { status: 200 }
      )
    );

    const result = await collectMerchantCenterProductStatuses({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      dependencies: oauth
    });

    expect(result.status).toBe("success");
    expect(oauth.claimRefresh).toHaveBeenCalledOnce();
    expect(oauth.completeRefresh).toHaveBeenCalledOnce();
    expect(oauth.releaseRefresh).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("accepts an empty aggregate response when its repeated field is omitted", async () => {
    const result = await collectMerchantCenterProductStatuses({
      storeId: "store-1",
      accountId: "123",
      fetchImpl: async () => new Response("{}", { status: 200 }),
      dependencies: dependencies()
    });

    expect(result).toMatchObject({
      status: "success",
      itemsObserved: 0,
      totalItemsSeen: 0,
      skippedItems: 0,
      metadata: { pagination: { pagesFetched: 1, complete: true } }
    });
  });

  it("returns partial for malformed aggregate resources without raw provider data", async () => {
    const result = await collectMerchantCenterProductStatuses({
      storeId: "store-1",
      accountId: "123",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            aggregateProductStatuses: [
              { stats: { approvedCount: "3", pendingCount: "1", disapprovedCount: "0" } },
              { stats: { approvedCount: "not-a-count" } }
            ]
          }),
          { status: 200 }
        ),
      dependencies: dependencies()
    });

    expect(result.status).toBe("partial");
    expect(result.itemsObserved).toBe(4);
    expect(result.skippedItems).toBe(1);
    expect(result.errorSamples).toEqual(["aggregate_status_invalid"]);
    expect(JSON.stringify(result)).not.toContain("not-a-count");
  });

  it.each([
    [401, "authentication_failed"],
    [403, "authentication_failed"],
    [429, "source_unavailable"],
    [503, "source_unavailable"]
  ] as const)("classifies provider HTTP %s safely", async (status, expected) => {
    const result = await collectMerchantCenterProductStatuses({
      storeId: "store-1",
      accountId: "123",
      fetchImpl: async () => new Response("provider details", { status }),
      dependencies: dependencies()
    });

    expect(result.status).toBe(expected);
    expect(result.errorMessage).not.toContain("provider details");
  });

  it("classifies timeout as source unavailable", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );

    const result = await collectMerchantCenterProductStatuses({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      timeoutMs: 1,
      dependencies: dependencies()
    });

    expect(result.status).toBe("source_unavailable");
    expect(result.errorCode).toBe("merchant_center_timeout");
  });

  it("does not call the provider when Merchant Center is not connected", async () => {
    const fetchImpl = vi.fn();
    const result = await collectMerchantCenterProductStatuses({
      storeId: "store-1",
      accountId: null,
      fetchImpl,
      dependencies: dependencies()
    });

    expect(result.status).toBe("authentication_failed");
    expect(result.errorCode).toBe("merchant_center_not_connected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
