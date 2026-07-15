import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  getStore: vi.fn(),
  getEmailDestination: vi.fn(),
  getTelegramDestination: vi.fn()
}));
const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
}));

vi.mock("@eim/db", () => database);
vi.mock("next/navigation", () => navigation);

import DestinationsPage from "./page";

const storeId = "70000000-0000-4000-8000-000000000001";

describe("destinations page", () => {
  beforeEach(() => {
    database.getStore.mockReset();
    database.getEmailDestination.mockReset();
    database.getTelegramDestination.mockReset();
    navigation.notFound.mockClear();
  });

  it("uses the true not-found path for an unknown store", async () => {
    database.getStore.mockResolvedValue(null);

    await expect(DestinationsPage({ params: Promise.resolve({ id: storeId }) })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );

    expect(navigation.notFound).toHaveBeenCalledOnce();
    expect(database.getEmailDestination).not.toHaveBeenCalled();
    expect(database.getTelegramDestination).not.toHaveBeenCalled();
  });

  it("renders a safe read failure state", async () => {
    database.getStore.mockResolvedValue({
      id: storeId,
      name: "Example store",
      domain: "https://example.com"
    });
    database.getEmailDestination.mockRejectedValue(new Error("SQL secret"));
    database.getTelegramDestination.mockResolvedValue(null);

    const page = await DestinationsPage({ params: Promise.resolve({ id: storeId }) });

    expect(page).toBeTruthy();
    expect(navigation.notFound).not.toHaveBeenCalled();
  });
});
