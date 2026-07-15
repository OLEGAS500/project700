import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  disconnectMerchantCenter: vi.fn(),
  MerchantCenterStoreNotFoundError: class MerchantCenterStoreNotFoundError extends Error {}
}));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  })
}));

vi.mock("@eim/db", () => database);
vi.mock("next/cache", () => cache);
vi.mock("next/navigation", () => navigation);

import { disconnectMerchantCenterAction } from "./actions";

const storeId = "70000000-0000-4000-8000-000000000001";

describe("Merchant Center actions", () => {
  beforeEach(() => {
    database.disconnectMerchantCenter.mockReset();
    cache.revalidatePath.mockReset();
    navigation.redirect.mockClear();
  });

  it("disconnects, invalidates related views, and redirects", async () => {
    database.disconnectMerchantCenter.mockResolvedValue({});

    await expect(
      disconnectMerchantCenterAction(storeId, { error: null }, new FormData())
    ).rejects.toThrow(`NEXT_REDIRECT:/stores/${storeId}/merchant-center?oauth=disconnected`);

    expect(database.disconnectMerchantCenter).toHaveBeenCalledWith(storeId);
    expect(cache.revalidatePath.mock.calls).toEqual([
      [`/stores/${storeId}/merchant-center`],
      ["/dashboard"]
    ]);
  });

  it("maps missing stores and database errors without revalidation", async () => {
    database.disconnectMerchantCenter.mockRejectedValue(
      new database.MerchantCenterStoreNotFoundError("secret store details")
    );

    await expect(
      disconnectMerchantCenterAction(storeId, { error: null }, new FormData())
    ).resolves.toEqual({ error: "This store is no longer available." });

    database.disconnectMerchantCenter.mockRejectedValue(new Error("postgres://secret"));
    await expect(
      disconnectMerchantCenterAction(storeId, { error: null }, new FormData())
    ).resolves.toEqual({ error: "Merchant Center could not be disconnected." });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expect(navigation.redirect).not.toHaveBeenCalled();
  });
});
