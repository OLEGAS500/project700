import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  cancelMaintenanceWindow: vi.fn(),
  createMaintenanceWindow: vi.fn(),
  MaintenanceWindowConflictError: class MaintenanceWindowConflictError extends Error {},
  MaintenanceWindowNotFoundError: class MaintenanceWindowNotFoundError extends Error {}
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

import { cancelMaintenanceWindowAction, createMaintenanceWindowAction } from "./actions";

const storeId = "70000000-0000-4000-8000-000000000001";
const initialState = { error: null };

describe("maintenance window server actions", () => {
  beforeEach(() => {
    database.cancelMaintenanceWindow.mockReset();
    database.createMaintenanceWindow.mockReset();
    cache.revalidatePath.mockReset();
    navigation.redirect.mockClear();
  });

  it("rejects invalid dates and fields before calling the database", async () => {
    const result = await createMaintenanceWindowAction(
      storeId,
      initialState,
      formData({
        startsAt: "2026-07-15T12:00:00.000Z",
        endsAt: "2026-07-15T12:00:00.000Z",
        reason: " ",
        createdBy: " "
      })
    );

    expect(result).toEqual({ error: "Enter valid dates, a reason, and who created this window." });
    expect(database.createMaintenanceWindow).not.toHaveBeenCalled();
  });

  it("trims create fields, invalidates maintenance views, and redirects", async () => {
    database.createMaintenanceWindow.mockResolvedValue({});

    await expect(
      createMaintenanceWindowAction(
        storeId,
        initialState,
        formData({
          startsAt: "2026-07-15T10:00:00.000Z",
          endsAt: "2026-07-15T11:00:00.000Z",
          reason: "  Catalog deployment  ",
          createdBy: "  Oleg  "
        })
      )
    ).rejects.toThrow(`NEXT_REDIRECT:/stores/${storeId}/maintenance`);

    expect(database.createMaintenanceWindow).toHaveBeenCalledWith(storeId, {
      startsAt: "2026-07-15T10:00:00.000Z",
      endsAt: "2026-07-15T11:00:00.000Z",
      reason: "Catalog deployment",
      createdBy: "Oleg"
    });
    expect(cache.revalidatePath.mock.calls).toEqual([
      [`/stores/${storeId}/maintenance`],
      ["/dashboard"]
    ]);
  });

  it("cancels a window, invalidates the maintenance views, and redirects", async () => {
    database.cancelMaintenanceWindow.mockResolvedValue({});
    const windowId = "70000000-0000-4000-8000-000000000002";

    await expect(cancelMaintenanceWindowAction(storeId, windowId)).rejects.toThrow(
      `NEXT_REDIRECT:/stores/${storeId}/maintenance`
    );

    expect(database.cancelMaintenanceWindow).toHaveBeenCalledWith(storeId, windowId);
    expect(cache.revalidatePath.mock.calls).toEqual([
      [`/stores/${storeId}/maintenance`],
      ["/dashboard"]
    ]);
  });

  it("maps missing windows to a safe message", async () => {
    database.cancelMaintenanceWindow.mockRejectedValue(
      new database.MaintenanceWindowNotFoundError("missing")
    );

    const result = await cancelMaintenanceWindowAction(
      storeId,
      "70000000-0000-4000-8000-000000000003"
    );

    expect(result).toEqual({ error: "This maintenance window no longer exists." });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("maps stale or cancelled windows to a safe conflict message", async () => {
    database.cancelMaintenanceWindow.mockRejectedValue(
      new database.MaintenanceWindowConflictError("stale")
    );

    const result = await cancelMaintenanceWindowAction(
      storeId,
      "70000000-0000-4000-8000-000000000004"
    );

    expect(result).toEqual({ error: "This maintenance window can no longer be cancelled." });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("does not expose database errors", async () => {
    database.createMaintenanceWindow.mockRejectedValue(
      new Error("SQL secret@example.com https://internal.example/maintenance")
    );

    const result = await createMaintenanceWindowAction(
      storeId,
      initialState,
      formData({
        startsAt: "2026-07-15T10:00:00.000Z",
        endsAt: "2026-07-15T11:00:00.000Z",
        reason: "Deployment",
        createdBy: "Oleg"
      })
    );

    expect(result).toEqual({ error: "The maintenance window could not be created." });
    expect(result.error).not.toContain("secret@example.com");
    expect(result.error).not.toContain("internal.example");
  });
});

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}
