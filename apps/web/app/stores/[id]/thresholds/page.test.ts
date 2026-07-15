import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  getStore: vi.fn(),
  getStoreThresholds: vi.fn()
}));
const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
}));

vi.mock("@eim/db", () => database);
vi.mock("next/navigation", () => navigation);

import ThresholdsPage from "./page";

const storeId = "70000000-0000-4000-8000-000000000001";

describe("thresholds page", () => {
  beforeEach(() => {
    database.getStore.mockReset();
    database.getStoreThresholds.mockReset();
    navigation.notFound.mockClear();
  });

  it("uses the true not-found path for an unknown store", async () => {
    database.getStore.mockResolvedValue(null);

    await expect(ThresholdsPage({ params: Promise.resolve({ id: storeId }) })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );

    expect(navigation.notFound).toHaveBeenCalledOnce();
    expect(database.getStoreThresholds).not.toHaveBeenCalled();
  });

  it("renders a safe read failure state", async () => {
    database.getStore.mockResolvedValue({
      id: storeId,
      name: "Example store",
      domain: "https://example.com"
    });
    database.getStoreThresholds.mockRejectedValue(new Error("SQL secret"));

    const page = await ThresholdsPage({ params: Promise.resolve({ id: storeId }) });

    expect(page).toBeTruthy();
    expect(navigation.notFound).not.toHaveBeenCalled();
  });
});
