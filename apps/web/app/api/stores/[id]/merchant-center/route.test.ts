import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  connectMerchantCenter: vi.fn(),
  disconnectMerchantCenter: vi.fn(),
  getMerchantCenterConnection: vi.fn(),
  MerchantCenterStoreNotFoundError: class MerchantCenterStoreNotFoundError extends Error {}
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
  });

  it("reads a connection without exposing credentials", async () => {
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

  it("returns 404 when the connection read finds no store", async () => {
    database.getMerchantCenterConnection.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost"), context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Store not found" });
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
    expect(database.connectMerchantCenter).not.toHaveBeenCalled();

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

  it("maps a connection write race to a safe 404", async () => {
    database.connectMerchantCenter.mockRejectedValue(
      new database.MerchantCenterStoreNotFoundError("internal store details")
    );

    const response = await PUT(
      new Request("http://localhost", {
        method: "PUT",
        body: JSON.stringify({ merchantCenterAccountId: "123456789" })
      }),
      context
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: "Store not found" });
    expect(JSON.stringify(body)).not.toContain("internal store details");
  });

  it("disconnects an existing store connection", async () => {
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

  it("maps a disconnect write race to a safe 404", async () => {
    database.disconnectMerchantCenter.mockRejectedValue(
      new database.MerchantCenterStoreNotFoundError("internal store details")
    );

    const response = await DELETE(new Request("http://localhost", { method: "DELETE" }), context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Store not found" });
  });

  it("maps unknown stores and database failures safely", async () => {
    database.getMerchantCenterConnection.mockResolvedValue(null);
    const notFound = await GET(new Request("http://localhost"), context);
    expect(notFound.status).toBe(404);

    database.getMerchantCenterConnection.mockRejectedValue(new Error("postgres://secret/internal"));
    const failure = await GET(new Request("http://localhost"), context);
    expect(failure.status).toBe(503);
    const body = await failure.json();
    expect(body.error).toBe("Merchant Center connection is temporarily unavailable");
    expect(JSON.stringify(body)).not.toContain("postgres://secret");
  });
});
