import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  claimMerchantCenterOAuthRefresh: vi.fn(),
  completeMerchantCenterOAuthRefresh: vi.fn(),
  releaseMerchantCenterOAuthRefresh: vi.fn(),
  MerchantCenterOAuthCredentialsNotFoundError: class MerchantCenterOAuthCredentialsNotFoundError extends Error {},
  MerchantCenterOAuthRefreshInProgressError: class MerchantCenterOAuthRefreshInProgressError extends Error {}
}));

vi.mock("@eim/db", () => database);

import { POST } from "./route";

const storeId = "70000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id: storeId }) };

describe("Merchant Center OAuth refresh API", () => {
  beforeEach(() => {
    database.claimMerchantCenterOAuthRefresh.mockReset();
    database.completeMerchantCenterOAuthRefresh.mockReset();
    database.releaseMerchantCenterOAuthRefresh.mockReset();
    database.releaseMerchantCenterOAuthRefresh.mockResolvedValue(undefined);
    vi.stubEnv("GOOGLE_MERCHANT_CENTER_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_MERCHANT_CENTER_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GOOGLE_MERCHANT_CENTER_REDIRECT_URI", "https://app.example.com/oauth/callback");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("refreshes under a lease and returns only safe metadata", async () => {
    database.claimMerchantCenterOAuthRefresh.mockResolvedValue({
      accessToken: "old-access",
      refreshToken: "refresh-secret",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 1_000),
      scopes: ["scope-a"],
      metadata: { provider: "google" }
    });
    database.completeMerchantCenterOAuthRefresh.mockResolvedValue({
      storeId,
      hasAccessToken: true,
      hasRefreshToken: true,
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: ["scope-a"],
      metadata: { provider: "google" },
      credentialsVersion: 2,
      refreshInProgress: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), { status: 200 })
      )
    );

    const response = await POST(new Request("http://localhost", { method: "POST" }), context);
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("new-access");
    expect(database.completeMerchantCenterOAuthRefresh).toHaveBeenCalledWith(
      storeId,
      expect.any(String),
      expect.objectContaining({ accessToken: "new-access", refreshToken: "refresh-secret" })
    );
    expect(database.releaseMerchantCenterOAuthRefresh).toHaveBeenCalledOnce();
  });

  it("maps an active refresh lease and missing credentials safely", async () => {
    database.claimMerchantCenterOAuthRefresh.mockRejectedValue(
      new database.MerchantCenterOAuthRefreshInProgressError()
    );
    expect((await POST(new Request("http://localhost", { method: "POST" }), context)).status).toBe(409);

    database.claimMerchantCenterOAuthRefresh.mockRejectedValue(
      new database.MerchantCenterOAuthCredentialsNotFoundError(storeId)
    );
    const response = await POST(new Request("http://localhost", { method: "POST" }), context);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(storeId);
  });
});
