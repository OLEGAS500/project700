import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  getStore: vi.fn(),
  listMaintenanceWindows: vi.fn()
}));
const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
}));

vi.mock("@eim/db", () => database);
vi.mock("next/navigation", () => navigation);

import MaintenancePage from "./page";

describe("maintenance page", () => {
  beforeEach(() => {
    database.getStore.mockReset();
    database.listMaintenanceWindows.mockReset();
    navigation.notFound.mockClear();
  });

  it("uses the true not-found path for an unknown store", async () => {
    database.getStore.mockResolvedValue(null);

    await expect(
      MaintenancePage({ params: Promise.resolve({ id: "70000000-0000-4000-8000-000000000001" }) })
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(navigation.notFound).toHaveBeenCalledOnce();
    expect(database.listMaintenanceWindows).not.toHaveBeenCalled();
  });

  it("renders a safe read failure state", async () => {
    database.getStore.mockRejectedValue(new Error("SQL secret"));

    const page = await MaintenancePage({
      params: Promise.resolve({ id: "70000000-0000-4000-8000-000000000001" })
    });

    expect(page).toBeTruthy();
    expect(navigation.notFound).not.toHaveBeenCalled();
  });
});
