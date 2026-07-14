import { describe, expect, it } from "vitest";
import { parseDashboardIncidentQuery } from "./query";

describe("dashboard incident query parsing", () => {
  it("accepts the supported filters and bounded limit", () => {
    expect(
      parseDashboardIncidentQuery(
        new URLSearchParams({
          storeId: "00000000-0000-4000-8000-000000000001",
          status: "open",
          severity: "critical",
          type: "catalog_drop",
          source: "feed",
          limit: "100"
        })
      )
    ).toEqual({
      success: true,
      data: {
        storeId: "00000000-0000-4000-8000-000000000001",
        status: "open",
        severity: "critical",
        type: "catalog_drop",
        source: "feed",
        limit: 100
      }
    });
  });

  it("rejects unknown, repeated, and unbounded query parameters", () => {
    expect(parseDashboardIncidentQuery(new URLSearchParams({ unknown: "value" }))).toMatchObject({
      success: false,
      error: "Invalid incident list query"
    });
    expect(
      parseDashboardIncidentQuery(new URLSearchParams("status=open&status=resolved"))
    ).toEqual({ success: false, error: "Query parameters must not be repeated" });
    expect(parseDashboardIncidentQuery(new URLSearchParams({ limit: "101" }))).toMatchObject({
      success: false,
      error: "Invalid incident list query"
    });
    expect(parseDashboardIncidentQuery(new URLSearchParams({ source: "not-a-source" }))).toMatchObject({
      success: false,
      error: "Invalid incident list query"
    });
  });
});
