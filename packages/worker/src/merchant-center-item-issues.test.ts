import {
  collectMerchantCenterItemIssues,
  type MerchantCenterItemIssuesLimits
} from "./merchant-center-item-issues";
import type {
  MerchantCenterOAuthConfiguration,
  MerchantCenterOAuthFetch,
  MerchantCenterOAuthTokenResponse
} from "@eim/core";
import type {
  MerchantCenterStatusDependencies,
} from "./merchant-center-status";
import type { MerchantCenterOAuthTokenSet } from "@eim/db";
import { describe, expect, it, vi } from "vitest";

function futureTokenSet(): MerchantCenterOAuthTokenSet {
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
  const configuration: MerchantCenterOAuthConfiguration = {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://example.com/callback",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/content"]
  };

  const refreshAccessToken = vi.fn<(
    configuration: MerchantCenterOAuthConfiguration,
    refreshToken: string,
    fetchImpl: MerchantCenterOAuthFetch
  ) => Promise<MerchantCenterOAuthTokenResponse>>(async () => ({
    access_token: "refreshed-access-token",
    expires_in: 3_600,
    token_type: "Bearer"
  }));

  return {
    getTokenSet: vi.fn(async () => futureTokenSet()),
    claimRefresh: vi.fn(async () => futureTokenSet()),
    completeRefresh: vi.fn(async () => undefined),
    releaseRefresh: vi.fn(async () => undefined),
    loadConfiguration: vi.fn(() => configuration),
    refreshAccessToken,
    ...overrides
  };
}

function product(
  offerId: string,
  issues: unknown[],
  name = `accounts/123/products/en~US~${offerId}`
): Record<string, unknown> {
  return {
    name,
    offerId,
    productAttributes: { title: `Title ${offerId}` },
    productStatus: {
      destinationStatuses: [
        { reportingContext: "SHOPPING_ADS", approvedCountries: ["US"] }
      ],
      itemLevelIssues: issues
    }
  };
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: "invalid_gtin",
    severity: "DISAPPROVED",
    resolution: "MERCHANT_ACTION",
    attribute: "gtins",
    reportingContext: "SHOPPING_ADS",
    description: "Invalid GTIN",
    detail: "The supplied GTIN is invalid.",
    documentation: "https://support.google.com/merchants/answer/6324461",
    applicableCountries: ["US"],
    ...overrides
  };
}

describe("collectMerchantCenterItemIssues", () => {
  it("uses the official products.list endpoint and normalizes bounded issues", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(
        "https://merchantapi.googleapis.com/products/v1/accounts/123/products?pageSize=1000"
      );
      return new Response(
        JSON.stringify({
          products: [
            product("SKU-1", [issue(), issue()])
          ]
        }),
        { status: 200 }
      );
    });

    const result = await collectMerchantCenterItemIssues({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      dependencies: dependencies()
    });

    expect(result).toMatchObject({
      source: "merchant_center",
      status: "success",
      itemsObserved: 1,
      totalItemsSeen: 1,
      skippedItems: 0
    });
    expect(result.items[0]).toMatchObject({
      stableKey: "offer:sku-1",
      offerId: "SKU-1",
      merchantStatus: "approved",
      merchantIssues: [
        {
          code: "invalid_gtin",
          severity: "disapproved",
          resolution: "merchant_action",
          attribute: "gtins",
          reportingContext: "shopping_ads",
          applicableCountries: ["US"]
        }
      ]
    });
    expect(result.metadata).toMatchObject({
      productsSeen: 1,
      productsWithIssues: 1,
      issuesObserved: 1,
      pagination: { pagesFetched: 1, complete: true }
    });
  });

  it("follows nextPageToken and merges products from bounded pages", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (!url.searchParams.has("pageToken")) {
        return new Response(
          JSON.stringify({ products: [product("SKU-1", [issue()])], nextPageToken: "page-two" }),
          { status: 200 }
        );
      }
      expect(url.searchParams.get("pageSize")).toBe("1000");
      expect(url.searchParams.get("pageToken")).toBe("page-two");
      return new Response(
        JSON.stringify({ products: [product("SKU-2", [issue({ code: "missing_price" })])] }),
        { status: 200 }
      );
    });

    const result = await collectMerchantCenterItemIssues({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      dependencies: dependencies()
    });

    expect(result.status).toBe("success");
    expect(result.itemsObserved).toBe(2);
    expect(result.totalItemsSeen).toBe(2);
    expect(calls).toHaveLength(2);
    expect(result.metadata).toMatchObject({ pagination: { pagesFetched: 2, complete: true } });
  });

  it("returns partial on a repeated token without exposing it", async () => {
    const repeatedToken = "repeat-me";
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ products: [product("SKU-1", [issue()])], nextPageToken: repeatedToken }),
        { status: 200 }
      )
    );

    const result = await collectMerchantCenterItemIssues({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      dependencies: dependencies()
    });

    expect(result.status).toBe("partial");
    expect(result.errorCode).toBe("merchant_center_products_page_token_repeated");
    expect(result.itemsObserved).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(repeatedToken);
  });

  it("stops at the product bound and preserves bounded items", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          products: [
            product("SKU-1", [issue()]),
            product("SKU-2", [issue({ code: "missing_price" })]),
            product("SKU-3", [issue({ code: "missing_link" })])
          ],
          nextPageToken: "another-page"
        }),
        { status: 200 }
      )
    );
    const limits: MerchantCenterItemIssuesLimits = { maxProducts: 2 };

    const result = await collectMerchantCenterItemIssues({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      limits,
      dependencies: dependencies()
    });

    expect(result.status).toBe("partial");
    expect(result.errorCode).toBe("merchant_center_products_resource_limit");
    expect(result.itemsObserved).toBe(2);
    expect(result.totalItemsSeen).toBe(2);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps earlier items when a later page fails", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (!new URL(String(input)).searchParams.has("pageToken")) {
        return new Response(
          JSON.stringify({ products: [product("SKU-1", [issue()])], nextPageToken: "failing-page" }),
          { status: 200 }
        );
      }
      return new Response("provider secret details", { status: 503 });
    });

    const result = await collectMerchantCenterItemIssues({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      dependencies: dependencies()
    });

    expect(result).toMatchObject({
      status: "partial",
      errorCode: "merchant_center_products_pagination_http_error",
      itemsObserved: 1,
      totalItemsSeen: 1
    });
    expect(result.errorMessage).not.toContain("provider secret details");
  });

  it("returns success for a valid empty product page", async () => {
    const result = await collectMerchantCenterItemIssues({
      storeId: "store-1",
      accountId: "123",
      fetchImpl: async () => new Response(JSON.stringify({ products: [] }), { status: 200 }),
      dependencies: dependencies()
    });

    expect(result).toMatchObject({
      status: "success",
      itemsObserved: 0,
      totalItemsSeen: 0,
      skippedItems: 0
    });
  });

  it("classifies a malformed products response as parse_failed", async () => {
    const result = await collectMerchantCenterItemIssues({
      storeId: "store-1",
      accountId: "123",
      fetchImpl: async () => new Response(JSON.stringify({ unexpected: [] }), { status: 200 }),
      dependencies: dependencies()
    });

    expect(result).toMatchObject({
      status: "parse_failed",
      errorCode: "merchant_center_products_response_invalid",
      itemsObserved: 0
    });
  });

  it("classifies authentication and rate-limit failures safely", async () => {
    for (const [status, expected] of [
      [401, "authentication_failed"],
      [429, "source_unavailable"]
    ] as const) {
      const result = await collectMerchantCenterItemIssues({
        storeId: "store-1",
        accountId: "123",
        fetchImpl: async () => new Response("provider details", { status }),
        dependencies: dependencies()
      });
      expect(result.status).toBe(expected);
      expect(result.errorMessage).not.toContain("provider details");
    }
  });

  it("does not call Merchant API when the account is not connected", async () => {
    const fetchImpl = vi.fn();
    const result = await collectMerchantCenterItemIssues({
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
