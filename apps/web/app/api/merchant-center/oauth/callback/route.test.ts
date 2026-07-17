import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  consumeMerchantCenterOAuthState: vi.fn(),
  completeMerchantCenterOAuthAuthorization: vi.fn(),
  hashMerchantCenterOAuthState: vi.fn(() => "hashed-state"),
  MerchantCenterOAuthStateInvalidError: class MerchantCenterOAuthStateInvalidError extends Error {}
}));

vi.mock("@eim/db", () => database);

import { GET } from "./route";

const storeId = "70000000-0000-4000-8000-000000000001";

describe("Merchant Center OAuth callback API", () => {
  beforeEach(() => {
    database.consumeMerchantCenterOAuthState.mockReset();
    database.completeMerchantCenterOAuthAuthorization.mockReset();
    database.hashMerchantCenterOAuthState.mockClear();
    vi.stubEnv("GOOGLE_MERCHANT_CENTER_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_MERCHANT_CENTER_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GOOGLE_MERCHANT_CENTER_REDIRECT_URI", "https://app.example.com/oauth/callback");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: "access-secret",
            refresh_token: "refresh-secret",
            expires_in: 3600,
            token_type: "Bearer"
          }),
          { status: 200 }
        )
      )
    );
  });

  afterEach(() => vi.unstubAllEnvs());

  it("consumes state once, exchanges the code server-side, and redirects safely", async () => {
    database.consumeMerchantCenterOAuthState.mockResolvedValue({
      storeId,
      redirectUri: "https://app.example.com/oauth/callback",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    database.completeMerchantCenterOAuthAuthorization.mockResolvedValue({
      storeId,
      hasAccessToken: true,
      hasRefreshToken: true,
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: ["https://www.googleapis.com/auth/content"],
      metadata: { provider: "google", authorization: "oauth2" },
      credentialsVersion: 1,
      refreshInProgress: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const response = await GET(
      new Request("http://localhost:8080/api/merchant-center/oauth/callback?state=raw-state&code=auth-code")
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `https://app.example.com/stores/${storeId}/merchant-center?oauth=connected`
    );
    expect(database.consumeMerchantCenterOAuthState).toHaveBeenCalledWith("hashed-state");
    expect(database.completeMerchantCenterOAuthAuthorization).toHaveBeenCalledWith(
      "hashed-state",
      expect.objectContaining({
        accessToken: "access-secret",
        refreshToken: "refresh-secret"
      })
    );
  });

  it("rejects a completion invalidated by disconnect without exposing credentials", async () => {
    database.consumeMerchantCenterOAuthState.mockResolvedValue({
      storeId,
      redirectUri: "https://app.example.com/oauth/callback",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    database.completeMerchantCenterOAuthAuthorization.mockRejectedValue(
      new database.MerchantCenterOAuthStateInvalidError()
    );

    const response = await GET(
      new Request("https://app.example.com/api/merchant-center/oauth/callback?state=raw-state&code=auth-code")
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `https://app.example.com/stores/${storeId}/merchant-center?oauth=reconnect_required`
    );
  });

  it("rejects replayed state and provider failures safely", async () => {
    database.consumeMerchantCenterOAuthState.mockRejectedValue(
      new database.MerchantCenterOAuthStateInvalidError()
    );

    const replayed = await GET(
      new Request("https://app.example.com/api/merchant-center/oauth/callback?state=used&code=auth-code")
    );
    expect(replayed.status).toBe(400);
    expect(await replayed.text()).not.toContain("access-secret");

    database.consumeMerchantCenterOAuthState.mockResolvedValue({
      storeId,
      redirectUri: "https://app.example.com/oauth/callback",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider secret diagnostics", { status: 500 })));

    const failed = await GET(
      new Request("https://app.example.com/api/merchant-center/oauth/callback?state=used&code=auth-code")
    );
    expect(failed.status).toBe(303);
    expect(failed.headers.get("location")).toBe(
      `https://app.example.com/stores/${storeId}/merchant-center?oauth=error`
    );
  });

  it("rejects a callback when the configured redirect URI changed", async () => {
    database.consumeMerchantCenterOAuthState.mockResolvedValue({
      storeId,
      redirectUri: "https://old.example.com/oauth/callback",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    const response = await GET(
      new Request("https://app.example.com/api/merchant-center/oauth/callback?state=raw-state&code=auth-code")
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `https://old.example.com/stores/${storeId}/merchant-center?oauth=error`
    );
  });
});
