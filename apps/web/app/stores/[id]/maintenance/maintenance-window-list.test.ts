import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
  cancelMaintenanceWindowAction: vi.fn(),
  createMaintenanceWindowAction: vi.fn()
}));

import MaintenanceWindowList from "./maintenance-window-list";

const storeId = "70000000-0000-4000-8000-000000000001";

describe("maintenance window list", () => {
  it("shows cancel only for active or upcoming windows", () => {
    const now = Date.now();
    const activeStart = new Date(now - 60 * 60 * 1000).toISOString();
    const activeEnd = new Date(now + 60 * 60 * 1000).toISOString();
    const completedStart = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    const completedEnd = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const cancelledStart = new Date(now + 60 * 60 * 1000).toISOString();
    const cancelledEnd = new Date(now + 2 * 60 * 60 * 1000).toISOString();

    const html = renderToStaticMarkup(
      createElement(MaintenanceWindowList, {
        storeId,
        windows: [
          {
            id: "70000000-0000-4000-8000-000000000002",
            storeId,
            startsAt: activeStart,
            endsAt: activeEnd,
            reason: "Active window",
            createdBy: "Oleg",
            createdAt: "2026-07-15T09:00:00.000Z",
            cancelledAt: null
          },
          {
            id: "70000000-0000-4000-8000-000000000003",
            storeId,
            startsAt: completedStart,
            endsAt: completedEnd,
            reason: "Completed window",
            createdBy: "Oleg",
            createdAt: "2026-07-14T09:00:00.000Z",
            cancelledAt: null
          },
          {
            id: "70000000-0000-4000-8000-000000000004",
            storeId,
            startsAt: cancelledStart,
            endsAt: cancelledEnd,
            reason: "Cancelled window",
            createdBy: "Oleg",
            createdAt: "2026-07-15T09:00:00.000Z",
            cancelledAt: "2026-07-15T09:30:00.000Z"
          }
        ]
      })
    );

    expect(html.match(/>Cancel<\/button>/g)).toHaveLength(1);
    expect(html).toContain("Completed");
    expect(html).toContain("Cancelled");
  });
});
