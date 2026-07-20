import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /sitemap.xml", () => {
  it("serves the staging test product through the forwarded public origin", async () => {
    const response = GET(
      new Request("http://localhost:3000/sitemap.xml", {
        headers: {
          "x-forwarded-host": "eimweb-production.up.railway.app",
          "x-forwarded-proto": "https"
        }
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    await expect(response.text()).resolves.toContain(
      "<loc>https://eimweb-production.up.railway.app/test-products/eim-catalog-monitor</loc>"
    );
  });
});
