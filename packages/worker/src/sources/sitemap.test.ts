import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { collectSitemap } from "./sitemap";

describe("collectSitemap", () => {
  it("parses urlset sitemaps, normalizes URLs, and removes duplicates", async () => {
    const result = await collectSitemap({
      url: "https://example.com/sitemap.xml",
      fetchImpl: async () =>
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
          <urlset>
            <url><loc>https://EXAMPLE.com/products/shoe/?utm_source=x</loc></url>
            <url><loc>https://example.com/products/shoe/</loc></url>
            <url><loc>https://example.com/products/bag</loc></url>
          </urlset>`
        )
    });

    expect(result.status).toBe("success");
    expect(result.itemsObserved).toBe(2);
    expect(result.items.map((item) => item.url)).toEqual([
      "https://example.com/products/shoe",
      "https://example.com/products/bag"
    ]);
  });

  it("supports sitemap indexes", async () => {
    const responses = new Map([
      [
        "https://example.com/sitemap.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
        <sitemapindex>
          <sitemap><loc>https://example.com/products.xml</loc></sitemap>
        </sitemapindex>`
      ],
      [
        "https://example.com/products.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
        <urlset>
          <url><loc>https://example.com/products/one</loc></url>
        </urlset>`
      ]
    ]);

    const result = await collectSitemap({
      url: "https://example.com/sitemap.xml",
      fetchImpl: async (url) => new Response(responses.get(String(url)))
    });

    expect(result.status).toBe("success");
    expect(result.itemsObserved).toBe(1);
    expect(result.items[0].url).toBe("https://example.com/products/one");
  });

  it("supports gzipped xml sitemaps", async () => {
    const result = await collectSitemap({
      url: "https://example.com/sitemap.xml.gz",
      fetchImpl: async () =>
        new Response(
          gzipSync(`
            <urlset>
              <url><loc>https://example.com/products/gzip</loc></url>
            </urlset>
          `)
        )
    });

    expect(result.status).toBe("success");
    expect(result.itemsObserved).toBe(1);
    expect(result.items[0].url).toBe("https://example.com/products/gzip");
  });

  it("classifies blocked responses", async () => {
    const result = await collectSitemap({
      url: "https://example.com/sitemap.xml",
      fetchImpl: async () => new Response("blocked", { status: 403 })
    });

    expect(result.status).toBe("blocked");
    expect(result.itemsObserved).toBe(0);
  });

  it("classifies 5xx responses as source unavailable", async () => {
    const result = await collectSitemap({
      url: "https://example.com/sitemap.xml",
      fetchImpl: async () => new Response("down", { status: 503 })
    });

    expect(result.status).toBe("source_unavailable");
    expect(result.errorCode).toBe("upstream_5xx");
  });

  it("classifies invalid sitemap XML as parse failed", async () => {
    const result = await collectSitemap({
      url: "https://example.com/sitemap.xml",
      fetchImpl: async () => new Response("<not-a-sitemap />")
    });

    expect(result.status).toBe("parse_failed");
    expect(result.itemsObserved).toBe(0);
  });

  it("treats an empty valid sitemap as a successful zero-count source check", async () => {
    const result = await collectSitemap({
      url: "https://example.com/sitemap.xml",
      fetchImpl: async () => new Response("<urlset></urlset>")
    });

    expect(result.status).toBe("success");
    expect(result.itemsObserved).toBe(0);
  });
});
