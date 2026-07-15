import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  InvalidDashboardCursorError: class InvalidDashboardCursorError extends Error {},
  listDashboardIncidents: vi.fn(),
  listDashboardStoreSummaries: vi.fn()
}));

vi.mock("@eim/db", () => database);

import IncidentsPage from "./page";

const incidentId = "70000000-0000-4000-8000-000000000010";

describe("incident list page", () => {
  beforeEach(() => {
    database.listDashboardIncidents.mockReset();
    database.listDashboardStoreSummaries.mockReset();
  });

  it("links each incident title to the existing detail route", async () => {
    database.listDashboardIncidents.mockResolvedValue({
      incidents: [
        {
          id: incidentId,
          storeId: "70000000-0000-4000-8000-000000000011",
          storeName: "Example store",
          type: "catalog_drop",
          severity: "critical",
          status: "open",
          title: "Product feed count dropped",
          summary: "The product feed count declined.",
          affectedCount: 300,
          likelySource: "feed",
          confidenceScore: 0.86,
          firstDetectedAt: "2026-07-15T10:00:00.000Z",
          updatedAt: "2026-07-15T10:01:00.000Z"
        }
      ],
      nextCursor: null
    });
    database.listDashboardStoreSummaries.mockResolvedValue([]);

    const html = renderToStaticMarkup(await IncidentsPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain(`href="/incidents/${incidentId}"`);
    expect(html).not.toContain("/api/incidents");
  });
});
