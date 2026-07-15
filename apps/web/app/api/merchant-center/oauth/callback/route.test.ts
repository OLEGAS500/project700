import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  consumeMerchantCenterOAuthState: vi.fn(),
  hashMerchantCenterOAuthState: vi.fn(() => "hashed-state"),
  upsertMerchantCenterOAuthCredentials: vi.fn(),
  MerchantCenterOAuthStateInvalidError: class MerchantCenterOAuthStateInvalidError extends Error {}
}));

vi.mock("@eim/db", () => database);

import { GET } from "./route";

const storeId = "70000000-0000-4000-8000-000000000001";

describe("Merchant Center OAuth callback API", () => {
  beforeEach(() => {
    database.consumeMerchantCenterOAuthState.mockReset();
    database.hashMerchantCenterOAuthState.mockClear();
    database.upsertMerchantCenterOAuthCredentials.mockReset();
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

  it("consumes state once, exchanges the code server-side, and returns safe metadata", async () => {
    database.consumeMerchantCenterOAuthState.mockResolvedValue({
      storeId,
      redirectUri: "https://app.example.com/oauth/callback",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    database.upsertMerchantCenterOAuthCredentials.mockResolvedValue({
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
      new Request("https://app.example.com/api/merchant-center/oauth/callback?state=raw-state&code=auth-code")
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ connected: true, storeId });
    expect(JSON.stringify(body)).not.toContain("access-secret");
    expect(JSON.stringify(body)).not.toContain("refresh-secret");
    expect(database.consumeMerchantCenterOAuthState).toHaveBeenCalledWith("hashed-state");
    expect(database.upsertMerchantCenterOAuthCredentials).toHaveBeenCalledWith(
      storeId,
      expect.objectContaining({
        accessToken: "access-secret",
        refreshToken: "refresh-secret"
      })
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
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("provider secret diagnostics");
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
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("old.example.com");
  });
});
