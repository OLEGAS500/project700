import { describe, expect, it, vi } from "vitest";
import {
  registerMerchantCenterDeveloper
} from "./merchant-center-registration";
import type { MerchantCenterStatusDependencies } from "./merchant-center-status";

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

describe("registerMerchantCenterDeveloper", () => {
  it("registers the configured Google Cloud project without provider response data", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://merchantapi.googleapis.com/accounts/v1/accounts/123/developerRegistration:registerGcp"
      );
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        accept: "application/json",
        authorization: "Bearer access-token",
        "content-type": "application/json"
      });
      expect(init?.body).toBe("{}");
      return new Response('{"provider":"response-is-not-read"}', { status: 200 });
    });

    const result = await registerMerchantCenterDeveloper({
      storeId: "store-1",
      accountId: "123",
      fetchImpl,
      dependencies: dependencies()
    });

    expect(result).toEqual({ outcome: "registered" });
    expect(JSON.stringify(result)).not.toContain("response-is-not-read");
  });

  it("returns a safe authentication result when registration is rejected", async () => {
    const result = await registerMerchantCenterDeveloper({
      storeId: "store-1",
      accountId: "123",
      fetchImpl: vi.fn(async () => new Response("provider details", { status: 401 })),
      dependencies: dependencies()
    });

    expect(result).toEqual({
      outcome: "authentication_failed",
      errorCode: "merchant_center_registration_authentication_failed",
      httpStatus: 401
    });
    expect(JSON.stringify(result)).not.toContain("provider details");
  });

  it("reports a registration conflict without treating it as success", async () => {
    const result = await registerMerchantCenterDeveloper({
      storeId: "store-1",
      accountId: "123",
      fetchImpl: vi.fn(async () => new Response("already registered elsewhere", { status: 409 })),
      dependencies: dependencies()
    });

    expect(result).toEqual({
      outcome: "conflict",
      errorCode: "merchant_center_project_registration_conflict",
      httpStatus: 409
    });
    expect(JSON.stringify(result)).not.toContain("already registered elsewhere");
  });

  it("does not send a provider request when no Merchant Center account is linked", async () => {
    const fetchImpl = vi.fn();
    const result = await registerMerchantCenterDeveloper({
      storeId: "store-1",
      accountId: null,
      fetchImpl,
      dependencies: dependencies()
    });

    expect(result).toEqual({
      outcome: "not_connected",
      errorCode: "merchant_center_not_connected"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
