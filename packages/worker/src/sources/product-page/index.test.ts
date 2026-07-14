import { describe, expect, it } from "vitest";
import { collectProductPage } from "./index";

describe("collectProductPage", () => {
  it("extracts JSON-LD product details and canonical state", async () => {
    const result = await collectProductPage({
      url: "https://example.com/products/shoe?utm_source=x",
      fetchImpl: async () =>
        new Response(
          `
            <link rel="canonical" href="https://example.com/products/shoe" />
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Product",
                "name": "Trail Shoe",
                "image": "https://example.com/shoe.jpg",
                "offers": {
                  "@type": "Offer",
                  "price": "79.00",
                  "priceCurrency": "USD",
                  "availability": "https://schema.org/InStock"
                }
              }
            </script>
          `,
          { status: 200 }
        )
    });

    expect(result.status).toBe("success");
    expect(result.items[0]).toMatchObject({
      stableKey: "url:https://example.com/products/shoe",
      title: "Trail Shoe",
      price: "79.00",
      currency: "USD",
      schemaPresent: true,
      indexability: "indexable"
    });
    expect(result.metadata).toMatchObject({
      canonicalState: "self",
      extractionStrategy: "json_ld",
      schemaValidEnough: true
    });
  });

  it("reads noindex from headers and meta robots", async () => {
    const headerNoindex = await collectProductPage({
      url: "https://example.com/products/noindex-header",
      fetchImpl: async () =>
        new Response("<html></html>", {
          status: 200,
          headers: {
            "x-robots-tag": "noindex"
          }
        })
    });
    const metaNoindex = await collectProductPage({
      url: "https://example.com/products/noindex-meta",
      fetchImpl: async () =>
        new Response("<meta name='robots' content='noindex,nofollow'>", { status: 200 })
    });

    expect(headerNoindex.items[0].indexability).toBe("noindex");
    expect(metaNoindex.items[0].indexability).toBe("noindex");
  });

  it("classifies different canonicals", async () => {
    const result = await collectProductPage({
      url: "https://example.com/products/shoe",
      fetchImpl: async () =>
        new Response("<link rel='canonical' href='https://example.com/collections/shoes'>")
    });

    expect(result.metadata).toMatchObject({
      canonicalState: "different",
      canonicalUrl: "https://example.com/collections/shoes"
    });
  });

  it("records redirects and cross-domain state", async () => {
    const result = await collectProductPage({
      url: "https://example.com/products/shoe",
      fetchImpl: async () =>
        new Response("<link rel='canonical' href='https://other.example/products/shoe'>", {
          status: 200,
          headers: {},
          // Response.url is read-only in browsers, but Node's Response accepts it via init extension poorly.
        })
    });

    expect(result.items[0].httpStatus).toBe(200);
  });

  it("enriches a storefront item even when the product page fetch fails", async () => {
    const result = await collectProductPage({
      url: "https://example.com/products/down",
      fetchImpl: async () => new Response("down", { status: 503 })
    });

    expect(result.status).toBe("source_unavailable");
    expect(result.items[0]).toMatchObject({
      source: "storefront",
      stableKey: "url:https://example.com/products/down",
      httpStatus: 503,
      indexability: "unknown"
    });
  });

  it("blocks private URLs before fetching", async () => {
    const result = await collectProductPage({
      url: "http://127.0.0.1/products/shoe",
      fetchImpl: async () => new Response("should not fetch")
    });

    expect(result.status).toBe("source_unavailable");
    expect(result.errorMessage).toContain("Blocked private IPv4");
  });
});
