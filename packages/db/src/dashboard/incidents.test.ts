import { describe, expect, it } from "vitest";
import {
  decodeDashboardIncidentCursor,
  encodeDashboardIncidentCursor,
  InvalidDashboardCursorError
} from "./incidents";

describe("dashboard incident cursors", () => {
  it("round-trips the exact database ordering fields", () => {
    const cursor = encodeDashboardIncidentCursor({
      updatedAt: "2026-07-14T20:29:38.123456Z",
      id: "00000000-0000-4000-8000-000000000001"
    });

    expect(decodeDashboardIncidentCursor(cursor)).toEqual({
      updatedAt: "2026-07-14T20:29:38.123456Z",
      id: "00000000-0000-4000-8000-000000000001"
    });
  });

  it("rejects malformed and incomplete cursors", () => {
    expect(() => decodeDashboardIncidentCursor("not-base64-json")).toThrow(
      InvalidDashboardCursorError
    );
    expect(() =>
      decodeDashboardIncidentCursor(
        Buffer.from(JSON.stringify({ updatedAt: "2026-07-14T20:29:38Z" })).toString("base64url")
      )
    ).toThrow(InvalidDashboardCursorError);
  });
});
