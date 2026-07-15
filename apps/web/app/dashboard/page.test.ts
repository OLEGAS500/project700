import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  listDashboardStoreSummaries: vi.fn()
}));

vi.mock("@eim/db", () => database);

import DashboardPage from "./page";

const storeId = "70000000-0000-4000-8000-000000000001";

describe("stores overview", () => {
  beforeEach(() => {
    database.listDashboardStoreSummaries.mockReset();
  });

  it("links a store to its maintenance windows route", async () => {
    database.listDashboardStoreSummaries.mockResolvedValue([
      {
        id: storeId,
        name: "Example store",
        domain: "https://example.com",
        incidents: { open: 0, critical: 0, high: 0, recovering: 0 },
        sources: [],
        baseline: { status: "learning", updatedAt: null },
        lastCheckedAt: null
      }
    ]);

    const html = renderToStaticMarkup(await DashboardPage());

    expect(html).toContain(`href="/stores/${storeId}/maintenance"`);
    expect(html).toContain(`href="/stores/${storeId}/thresholds"`);
    expect(html).toContain("Maintenance");
    expect(html).toContain("Thresholds");
  });
});
