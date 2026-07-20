import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /google-feed.xml", () => {
  it("serves one safe out-of-stock staging fixture product", async () => {
    const response = GET(
      new Request("http://localhost:3000/google-feed.xml", {
        headers: {
          "x-forwarded-host": "eimweb-production.up.railway.app",
          "x-forwarded-proto": "https"
        }
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("<g:id>EIM-STAGING-TEST-001</g:id>");
    expect(body).toContain("<g:availability>out_of_stock</g:availability>");
  });
});
