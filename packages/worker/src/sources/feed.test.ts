import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { collectFeed } from "./feed";

describe("collectFeed", () => {
  it("parses RSS Google Shopping feeds", async () => {
    const result = await collectFeed({
      url: "https://example.com/feed.xml",
      fetchImpl: async () =>
        new Response(`
          <rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
            <channel>
              <item>
                <g:id>SKU-1</g:id>
                <g:title>Trail Shoe</g:title>
                <g:link>https://example.com/products/trail-shoe?utm_source=x</g:link>
                <g:price>99.00 USD</g:price>
                <g:sale_price>79.00 USD</g:sale_price>
                <g:availability>in stock</g:availability>
                <g:image_link>https://example.com/images/shoe.jpg</g:image_link>
              </item>
            </channel>
          </rss>
        `)
    });

    expect(result.status).toBe("success");
    expect(result.totalItemsSeen).toBe(1);
    expect(result.itemsObserved).toBe(1);
    expect(result.items[0]).toMatchObject({
      stableKey: "offer:sku-1",
      offerId: "SKU-1",
      price: "79.00",
      currency: "USD",
      availability: "in stock"
    });
    expect(result.items[0].metadata).toMatchObject({
      basePrice: "99.00",
      salePrice: "79.00",
      effectivePrice: "79.00",
      priceSemantics: "effective_price"
    });
  });

  it("parses Atom product feeds", async () => {
    const result = await collectFeed({
      url: "https://example.com/feed.xml",
      fetchImpl: async () =>
        new Response(`
          <feed xmlns="http://www.w3.org/2005/Atom" xmlns:g="http://base.google.com/ns/1.0">
            <entry>
              <g:id>ATOM-1</g:id>
              <title>Atom Product</title>
              <link>https://example.com/products/atom</link>
              <g:price>10.00 USD</g:price>
              <g:availability>in stock</g:availability>
            </entry>
          </feed>
        `)
    });

    expect(result.status).toBe("success");
    expect(result.itemsObserved).toBe(1);
    expect(result.items[0].stableKey).toBe("offer:atom-1");
  });

  it("reads Google fields regardless of XML namespace prefix", async () => {
    const result = await collectFeed({
      url: "https://example.com/feed.xml",
      fetchImpl: async () =>
        new Response(`
          <rss version="2.0" xmlns:google="http://base.google.com/ns/1.0">
            <channel>
              <item>
                <google:id>PREFIX-1</google:id>
                <google:title>Prefixed Product</google:title>
                <google:link>https://example.com/products/prefix</google:link>
                <google:price>11.00 USD</google:price>
              </item>
            </channel>
          </rss>
        `)
    });

    expect(result.status).toBe("success");
    expect(result.items[0].offerId).toBe("PREFIX-1");
  });

  it("supports gzipped feeds", async () => {
    const result = await collectFeed({
      url: "https://example.com/feed.xml.gz",
      fetchImpl: async () =>
        new Response(
          gzipSync(`
            <rss><channel>
              <item>
                <g:id>GZIP-1</g:id>
                <g:link>https://example.com/products/gzip</g:link>
              </item>
            </channel></rss>
          `)
        )
    });

    expect(result.status).toBe("success");
    expect(result.itemsObserved).toBe(1);
  });

  it("deduplicates duplicate offer IDs inside one result", async () => {
    const result = await collectFeed({
      url: "https://example.com/feed.xml",
      fetchImpl: async () =>
        new Response(`
          <rss><channel>
            <item><g:id>DUP-1</g:id><g:link>https://example.com/products/one</g:link></item>
            <item><g:id>DUP-1</g:id><g:link>https://example.com/products/one</g:link></item>
          </channel></rss>
        `)
    });

    expect(result.status).toBe("success");
    expect(result.totalItemsSeen).toBe(2);
    expect(result.itemsObserved).toBe(1);
    expect(result.skippedItems).toBe(0);
  });

  it("returns partial for conflicting duplicate offer IDs", async () => {
    const result = await collectFeed({
      url: "https://example.com/feed.xml",
      fetchImpl: async () =>
        new Response(`
          <rss><channel>
            <item><g:id>DUP-1</g:id><g:link>https://example.com/products/one</g:link></item>
            <item><g:id>DUP-1</g:id><g:link>https://example.com/products/two</g:link></item>
          </channel></rss>
        `)
    });

    expect(result.status).toBe("partial");
    expect(result.itemsObserved).toBe(1);
    expect(result.skippedItems).toBe(1);
    expect(result.errorSamples?.[0]).toContain("conflicting duplicate");
  });

  it("returns partial when some products cannot produce a stable key", async () => {
    const result = await collectFeed({
      url: "https://example.com/feed.xml",
      fetchImpl: async () =>
        new Response(`
          <rss><channel>
            <item><g:id>OK-1</g:id><g:link>https://example.com/products/ok</g:link></item>
            <item><g:title>Broken item</g:title></item>
          </channel></rss>
        `)
    });

    expect(result.status).toBe("partial");
    expect(result.itemsObserved).toBe(1);
    expect(result.skippedItems).toBe(1);
    expect(result.errorSamples?.[0]).toContain("missing g:id and link");
  });

  it("treats a valid empty feed as success", async () => {
    const result = await collectFeed({
      url: "https://example.com/feed.xml",
      fetchImpl: async () => new Response("<rss><channel></channel></rss>")
    });

    expect(result.status).toBe("success");
    expect(result.itemsObserved).toBe(0);
    expect(result.totalItemsSeen).toBe(0);
  });

  it("classifies invalid feed structures as parse failed", async () => {
    const result = await collectFeed({
      url: "https://example.com/feed.xml",
      fetchImpl: async () => new Response("<not-a-feed />")
    });

    expect(result.status).toBe("parse_failed");
  });

  it("rejects unsafe XML declarations", async () => {
    const result = await collectFeed({
      url: "https://example.com/feed.xml",
      fetchImpl: async () =>
        new Response(`
          <!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
          <rss><channel></channel></rss>
        `)
    });

    expect(result.status).toBe("parse_failed");
    expect(result.errorCode).toBe("unsafe_xml");
  });

  it("classifies blocked and unavailable responses", async () => {
    const blocked = await collectFeed({
      url: "https://example.com/feed.xml",
      fetchImpl: async () => new Response("blocked", { status: 403 })
    });
    const unavailable = await collectFeed({
      url: "https://example.com/feed.xml",
      fetchImpl: async () => new Response("down", { status: 503 })
    });

    expect(blocked.status).toBe("blocked");
    expect(unavailable.status).toBe("source_unavailable");
  });
});
