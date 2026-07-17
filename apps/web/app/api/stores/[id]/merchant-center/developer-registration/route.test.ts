import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ getMerchantCenterConnection: vi.fn() }));
const worker = vi.hoisted(() => ({ registerMerchantCenterDeveloper: vi.fn() }));

vi.mock("@eim/db", () => database);
vi.mock("@eim/worker", () => worker);

import { POST } from "./route";

const storeId = "70000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id: storeId }) };

describe("Merchant Center developer registration API", () => {
  beforeEach(() => {
    database.getMerchantCenterConnection.mockReset();
    worker.registerMerchantCenterDeveloper.mockReset();
    database.getMerchantCenterConnection.mockResolvedValue({
      storeId,
      merchantCenterAccountId: "123456789",
      connected: true
    });
  });

  it("returns only a safe success acknowledgement", async () => {
    worker.registerMerchantCenterDeveloper.mockResolvedValue({ outcome: "registered" });

    const response = await POST(new Request("http://localhost", { method: "POST" }), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ registered: true });
    expect(worker.registerMerchantCenterDeveloper).toHaveBeenCalledWith({
      storeId,
      accountId: "123456789"
    });
  });

  it("maps provider outcomes without leaking provider details", async () => {
    worker.registerMerchantCenterDeveloper.mockResolvedValue({
      outcome: "authentication_failed",
      errorCode: "sensitive_provider_error",
      httpStatus: 401
    });
    const rejected = await POST(new Request("http://localhost", { method: "POST" }), context);
    expect(rejected.status).toBe(401);
    expect(await rejected.text()).not.toContain("sensitive_provider_error");

    worker.registerMerchantCenterDeveloper.mockResolvedValue({
      outcome: "conflict",
      errorCode: "merchant_center_project_registration_conflict",
      httpStatus: 409
    });
    expect((await POST(new Request("http://localhost", { method: "POST" }), context)).status).toBe(409);

    worker.registerMerchantCenterDeveloper.mockResolvedValue({
      outcome: "source_unavailable",
      errorCode: "merchant_center_registration_http_error",
      httpStatus: 500
    });
    expect((await POST(new Request("http://localhost", { method: "POST" }), context)).status).toBe(503);
  });

  it("does not attempt registration without a linked Merchant Center account", async () => {
    database.getMerchantCenterConnection.mockResolvedValue(null);
    worker.registerMerchantCenterDeveloper.mockResolvedValue({
      outcome: "not_connected",
      errorCode: "merchant_center_not_connected"
    });

    const response = await POST(new Request("http://localhost", { method: "POST" }), context);

    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain(storeId);
  });
});
