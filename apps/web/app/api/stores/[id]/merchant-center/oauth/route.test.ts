import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ getMerchantCenterOAuthStatus: vi.fn() }));
vi.mock("@eim/db", () => database);

import { GET } from "./route";

const storeId = "70000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id: storeId }) };

describe("Merchant Center OAuth status API", () => {
  beforeEach(() => database.getMerchantCenterOAuthStatus.mockReset());

  it("returns safe credential metadata only", async () => {
    database.getMerchantCenterOAuthStatus.mockResolvedValue({
      storeId,
      credentials: {
        storeId,
        hasAccessToken: true,
        hasRefreshToken: true,
        tokenType: "Bearer",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ["https://www.googleapis.com/auth/content"],
        metadata: { provider: "google" },
        credentialsVersion: 2,
        refreshInProgress: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });

    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status.credentials.hasAccessToken).toBe(true);
    expect(JSON.stringify(body)).not.toContain("access-secret");
    expect(JSON.stringify(body)).not.toContain("refresh-secret");
  });

  it("returns 404 for an unknown store and 503 for read failure", async () => {
    database.getMerchantCenterOAuthStatus.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost"), context)).status).toBe(404);

    database.getMerchantCenterOAuthStatus.mockImplementationOnce(async () => {
      throw new Error("postgres secret");
    });
    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("postgres secret");
  });
});
