import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  connectMerchantCenter: vi.fn(),
  disconnectMerchantCenter: vi.fn(),
  getMerchantCenterConnection: vi.fn(),
  getStore: vi.fn()
}));

vi.mock("@eim/db", () => database);

import { DELETE, GET, PUT } from "./route";

const storeId = "70000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id: storeId }) };

describe("Merchant Center connection API", () => {
  beforeEach(() => {
    database.connectMerchantCenter.mockReset();
    database.disconnectMerchantCenter.mockReset();
    database.getMerchantCenterConnection.mockReset();
    database.getStore.mockReset();
  });

  it("reads a connection without exposing credentials", async () => {
    database.getStore.mockResolvedValue({ id: storeId });
    database.getMerchantCenterConnection.mockResolvedValue({
      storeId,
      merchantCenterAccountId: "123456789",
      connected: true
    });

    const response = await GET(new Request("http://localhost"), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connection: {
        storeId,
        merchantCenterAccountId: "123456789",
        connected: true
      }
    });
  });

  it("validates before the database and stores a normalized account ID", async () => {
    const invalidResponse = await PUT(
      new Request("http://localhost", {
        method: "PUT",
        body: JSON.stringify({ merchantCenterAccountId: "oauth-token", accessToken: "secret" })
      }),
      context
    );

    expect(invalidResponse.status).toBe(400);
    expect(database.getStore).not.toHaveBeenCalled();
    expect(database.connectMerchantCenter).not.toHaveBeenCalled();

    database.getStore.mockResolvedValue({ id: storeId });
    database.connectMerchantCenter.mockResolvedValue({
      storeId,
      merchantCenterAccountId: "123456789",
      connected: true
    });

    const response = await PUT(
      new Request("http://localhost", {
        method: "PUT",
        body: JSON.stringify({ merchantCenterAccountId: " 123456789 " })
      }),
      context
    );

    expect(response.status).toBe(200);
    expect(database.connectMerchantCenter).toHaveBeenCalledWith(storeId, {
      merchantCenterAccountId: "123456789"
    });
  });

  it("disconnects an existing store connection", async () => {
    database.getStore.mockResolvedValue({ id: storeId });
    database.disconnectMerchantCenter.mockResolvedValue({
      storeId,
      merchantCenterAccountId: null,
      connected: false
    });

    const response = await DELETE(new Request("http://localhost", { method: "DELETE" }), context);

    expect(response.status).toBe(200);
    expect(database.disconnectMerchantCenter).toHaveBeenCalledWith(storeId);
    await expect(response.json()).resolves.toMatchObject({
      connection: { merchantCenterAccountId: null, connected: false }
    });
  });

  it("maps unknown stores and database failures safely", async () => {
    database.getStore.mockResolvedValue(null);
    const notFound = await GET(new Request("http://localhost"), context);
    expect(notFound.status).toBe(404);

    database.getStore.mockRejectedValue(new Error("postgres://secret/internal"));
    const failure = await GET(new Request("http://localhost"), context);
    expect(failure.status).toBe(503);
    const body = await failure.json();
    expect(body.error).toBe("Merchant Center connection is temporarily unavailable");
    expect(JSON.stringify(body)).not.toContain("postgres://secret");
  });
});
