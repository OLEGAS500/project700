import { describe, expect, it, vi } from "vitest";
import {
  buildMerchantCenterAuthorizationUrl,
  exchangeMerchantCenterAuthorizationCode,
  loadMerchantCenterOAuthConfiguration,
  MerchantCenterOAuthConfigurationError,
  MerchantCenterOAuthProviderError,
  refreshMerchantCenterAccessToken
} from "./merchant-center-oauth";

const configuration = loadMerchantCenterOAuthConfiguration({
  GOOGLE_MERCHANT_CENTER_CLIENT_ID: "client-id",
  GOOGLE_MERCHANT_CENTER_CLIENT_SECRET: "client-secret",
  GOOGLE_MERCHANT_CENTER_REDIRECT_URI: "https://app.example.com/oauth/callback"
});

describe("Merchant Center OAuth foundation", () => {
  it("requires all server-side OAuth configuration without exposing values", () => {
    expect(() =>
      loadMerchantCenterOAuthConfiguration({
        GOOGLE_MERCHANT_CENTER_CLIENT_ID: "client-id"
      })
    ).toThrowError(new MerchantCenterOAuthConfigurationError("oauth_configuration_missing"));
  });

  it("builds an offline authorization URL without the client secret", () => {
    const url = new URL(buildMerchantCenterAuthorizationUrl(configuration, "state-value"));

    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(configuration.redirectUri);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.search).not.toContain("client-secret");
  });

  it("exchanges a code and parses only the supported token fields", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("grant_type=authorization_code");
      expect(String(init?.body)).toContain("code=auth-code");
      return new Response(
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "scope-a scope-b",
          provider_secret: "must-not-be-persisted"
        }),
        { status: 200 }
      );
    });

    await expect(
      exchangeMerchantCenterAuthorizationCode(configuration, "auth-code", fetchImpl)
    ).resolves.toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600
    });
  });

  it("refreshes through the token endpoint and keeps provider failures stable", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

    await expect(
      refreshMerchantCenterAccessToken(configuration, "refresh-token", fetchImpl)
    ).rejects.toEqual(new MerchantCenterOAuthProviderError("oauth_refresh_failed"));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects malformed provider responses without returning raw content", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "only-token" }), { status: 200 })
    );

    await expect(
      exchangeMerchantCenterAuthorizationCode(configuration, "auth-code", fetchImpl)
    ).rejects.toEqual(new MerchantCenterOAuthProviderError("oauth_response_invalid"));
  });
});
