import { describe, expect, it } from "vitest";
import { collectCategory } from "./category";

describe("collectCategory", () => {
  it("uses Shopify-like products JSON when available", async () => {
    const result = await collectCategory({
      url: "https://example.com/collections/shoes",
      fetchImpl: async (url) => {
        if (String(url).endsWith("/products.json")) {
          return new Response(
            JSON.stringify({
              products_count: 2,
              products: [{ handle: "red-shoe" }, { handle: "blue-shoe" }]
            })
          );
        }

        return new Response("not found", { status: 404 });
      }
    });

    expect(result.status).toBe("success");
    expect(result.itemsObserved).toBe(2);
    expect(result.metadata).toMatchObject({
      extractionStrategy: "shopify_json",
      reportedTotal: 2,
      paginationComplete: true
    });
  });

  it("walks rel-next pagination and deduplicates product URLs", async () => {
    const pages = new Map([
      [
        "https://example.com/collections/shoes",
        `
          <a href="/products/one?utm_source=x">One</a>
          <a href="/products/one">One duplicate</a>
          <a rel="next" href="/collections/shoes?page=2">Next</a>
        `
      ],
      [
        "https://example.com/collections/shoes?page=2",
        `<a href="/products/two">Two</a>`
      ]
    ]);

    const result = await collectCategory({
      url: "https://example.com/collections/shoes",
      fetchImpl: async (url) => {
        if (String(url).endsWith("/products.json")) {
          return new Response("not found", { status: 404 });
        }

        return new Response(pages.get(String(url)));
      }
    });

    expect(result.status).toBe("success");
    expect(result.items.map((item) => item.url)).toEqual([
      "https://example.com/products/one",
      "https://example.com/products/two"
    ]);
    expect(result.metadata).toMatchObject({
      extractionStrategy: "html_links",
      paginationComplete: true
    });
  });

  it("does not treat an infinite-scroll first page as a complete category count", async () => {
    const result = await collectCategory({
      url: "https://example.com/collections/shoes",
      fetchImpl: async (url) => {
        if (String(url).endsWith("/products.json")) {
          return new Response("not found", { status: 404 });
        }

        return new Response(`
          <div data-next-url="/collections/shoes?page=2"></div>
          <a href="/products/one">One</a>
          <a href="/products/two">Two</a>
        `);
      }
    });

    expect(result.status).toBe("partial");
    expect(result.itemsObserved).toBe(2);
    expect(result.metadata).toMatchObject({
      paginationComplete: false,
      confidence: 0.4
    });
  });

  it("treats a confirmed empty state as success with zero products", async () => {
    const result = await collectCategory({
      url: "https://example.com/collections/empty",
      fetchImpl: async (url) => {
        if (String(url).endsWith("/products.json")) {
          return new Response("not found", { status: 404 });
        }

        return new Response("<main>No products found</main>");
      }
    });

    expect(result.status).toBe("success");
    expect(result.itemsObserved).toBe(0);
  });

  it("classifies blocked and unavailable category pages", async () => {
    const blocked = await collectCategory({
      url: "https://example.com/collections/shoes",
      fetchImpl: async (url) =>
        String(url).endsWith("/products.json")
          ? new Response("not found", { status: 404 })
          : new Response("blocked", { status: 403 })
    });
    const unavailable = await collectCategory({
      url: "https://example.com/collections/shoes",
      fetchImpl: async (url) =>
        String(url).endsWith("/products.json")
          ? new Response("not found", { status: 404 })
          : new Response("down", { status: 503 })
    });

    expect(blocked.status).toBe("blocked");
    expect(unavailable.status).toBe("source_unavailable");
  });

  it("blocks internal URLs before fetching", async () => {
    const result = await collectCategory({
      url: "http://127.0.0.1/collections/shoes",
      fetchImpl: async () => new Response("should not fetch")
    });

    expect(result.status).toBe("source_unavailable");
    expect(result.errorMessage).toContain("Blocked private IPv4");
  });
});
