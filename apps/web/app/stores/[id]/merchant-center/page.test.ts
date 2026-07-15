import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const database = vi.hoisted(() => ({
  getMerchantCenterConnection: vi.fn(),
  getMerchantCenterOAuthStatus: vi.fn(),
  getStore: vi.fn()
}));
const core = vi.hoisted(() => ({
  loadMerchantCenterOAuthConfiguration: vi.fn(),
  MerchantCenterOAuthConfigurationError: class MerchantCenterOAuthConfigurationError extends Error {}
}));
const navigation = vi.hoisted(() => ({
  useRouter: vi.fn(() => ({ refresh: vi.fn() })),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
}));

vi.mock("@eim/db", () => database);
vi.mock("@eim/core", () => ({
  loadMerchantCenterOAuthConfiguration: core.loadMerchantCenterOAuthConfiguration,
  MerchantCenterOAuthConfigurationError: core.MerchantCenterOAuthConfigurationError
}));
vi.mock("next/navigation", () => navigation);

import MerchantCenterPage from "./page";

const storeId = "70000000-0000-4000-8000-000000000001";
const store = { id: storeId, name: "Example store", domain: "https://example.com" };

describe("Merchant Center page", () => {
  beforeEach(() => {
    database.getMerchantCenterConnection.mockReset();
    database.getMerchantCenterOAuthStatus.mockReset();
    database.getStore.mockReset();
    core.loadMerchantCenterOAuthConfiguration.mockReset();
    navigation.notFound.mockClear();
    core.loadMerchantCenterOAuthConfiguration.mockReturnValue({});
  });

  it("uses the true not-found path for an unknown store", async () => {
    database.getStore.mockResolvedValue(null);

    await expect(MerchantCenterPage({ params: Promise.resolve({ id: storeId }) })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );

    expect(navigation.notFound).toHaveBeenCalledOnce();
    expect(database.getMerchantCenterOAuthStatus).not.toHaveBeenCalled();
  });

  it("renders safe connection metadata without credentials", async () => {
    database.getStore.mockResolvedValue(store);
    database.getMerchantCenterOAuthStatus.mockResolvedValue({
      storeId,
      credentials: {
        storeId,
        hasAccessToken: true,
        hasRefreshToken: true,
        tokenType: "Bearer",
        expiresAt: "2099-01-01T00:00:00.000Z",
        scopes: ["https://www.googleapis.com/auth/content"],
        metadata: { provider: "google" },
        credentialsVersion: 2,
        refreshInProgress: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z"
      }
    });
    database.getMerchantCenterConnection.mockResolvedValue({
      storeId,
      merchantCenterAccountId: "123456789",
      connected: true
    });

    const html = renderToStaticMarkup(
      await MerchantCenterPage({
        params: Promise.resolve({ id: storeId }),
        searchParams: Promise.resolve({ oauth: "connected" })
      })
    );

    expect(html).toContain("Merchant Center connected.");
    expect(html).toContain("123456789");
    expect(html).toContain("Credentials version");
    expect(html).toContain("https://www.googleapis.com/auth/content");
    expect(html).not.toContain("accessToken");
    expect(html).not.toContain("refreshToken");
  });

  it("renders configuration unavailable without showing provider details", async () => {
    database.getStore.mockResolvedValue(store);
    database.getMerchantCenterOAuthStatus.mockResolvedValue({ storeId, credentials: null });
    database.getMerchantCenterConnection.mockResolvedValue({
      storeId,
      merchantCenterAccountId: null,
      connected: false
    });
    core.loadMerchantCenterOAuthConfiguration.mockImplementation(() => {
      throw new core.MerchantCenterOAuthConfigurationError("oauth_configuration_missing");
    });

    const html = renderToStaticMarkup(
      await MerchantCenterPage({ params: Promise.resolve({ id: storeId }) })
    );

    expect(html).toContain("Configuration unavailable");
    expect(html).toContain("OAuth configuration is unavailable");
    expect(html).not.toContain("client-secret");
  });
});
