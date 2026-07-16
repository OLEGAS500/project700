import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  getPool: vi.fn()
}));

vi.mock("@eim/db", () => database);

import { GET } from "./route";

describe("GET /api/health", () => {
  beforeEach(() => {
    database.getPool.mockReset();
  });

  it("returns an uncached readiness response after the database query succeeds", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
    database.getPool.mockReturnValue({ query });

    const response = await GET();

    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns no provider or database detail when readiness is unavailable", async () => {
    database.getPool.mockImplementation(() => {
      throw new Error("postgres://user:password@example.test/eim is unavailable");
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });
});
