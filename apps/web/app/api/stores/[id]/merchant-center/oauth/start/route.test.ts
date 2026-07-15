import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  createMerchantCenterOAuthState: vi.fn(),
  hashMerchantCenterOAuthState: vi.fn((value: string) => `hash:${value}`),
  MerchantCenterStoreNotFoundError: class MerchantCenterStoreNotFoundError extends Error {}
}));

vi.mock("@eim/db", () => database);

import { GET } from "./route";

const storeId = "70000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id: storeId }) };

describe("Merchant Center OAuth start API", () => {
  beforeEach(() => {
    database.createMerchantCenterOAuthState.mockReset();
    database.hashMerchantCenterOAuthState.mockClear();
    vi.stubEnv("GOOGLE_MERCHANT_CENTER_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_MERCHANT_CENTER_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GOOGLE_MERCHANT_CENTER_REDIRECT_URI", "https://app.example.com/oauth/callback");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("stores only a hash and redirects to offline Google authorization", async () => {
    const response = await GET(new Request("http://localhost"), context);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.hostname).toBe("accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(database.createMerchantCenterOAuthState).toHaveBeenCalledWith(
      storeId,
      expect.objectContaining({
        stateHash: expect.stringMatching(/^hash:/),
        redirectUri: "https://app.example.com/oauth/callback",
        expiresAt: expect.any(Date)
      })
    );
    expect(database.createMerchantCenterOAuthState.mock.calls[0][1].stateHash).not.toBe(
      location.searchParams.get("state")
    );
  });

  it("returns safe configuration and not-found errors", async () => {
    vi.stubEnv("GOOGLE_MERCHANT_CENTER_CLIENT_ID", "");
    const missingConfiguration = await GET(new Request("http://localhost"), context);
    expect(missingConfiguration.status).toBe(503);
    expect(database.createMerchantCenterOAuthState).not.toHaveBeenCalled();

    vi.stubEnv("GOOGLE_MERCHANT_CENTER_CLIENT_ID", "client-id");
    database.createMerchantCenterOAuthState.mockRejectedValue(
      new database.MerchantCenterStoreNotFoundError("secret store details")
    );
    const notFound = await GET(new Request("http://localhost"), context);
    expect(notFound.status).toBe(404);
    expect(await notFound.text()).not.toContain("secret store details");
  });
});
