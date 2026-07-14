import { describe, expect, it } from "vitest";
import { buildSourceMatches } from "./source-matching";

describe("buildSourceMatches", () => {
  it("matches sitemap, feed, and storefront by normalized URL", () => {
    const matches = buildSourceMatches([
      {
        id: "sitemap-item",
        source: "sitemap",
        stableKey: "url:https://example.com/products/shoe",
        offerId: null,
        url: "https://example.com/products/shoe?utm_source=x",
        canonicalUrl: null,
        metadata: {}
      },
      {
        id: "feed-item",
        source: "feed",
        stableKey: "offer:sku-1",
        offerId: "SKU-1",
        url: "https://example.com/products/shoe",
        canonicalUrl: null,
        metadata: {}
      },
      {
        id: "storefront-item",
        source: "storefront",
        stableKey: "url:https://example.com/products/shoe",
        offerId: null,
        url: "https://example.com/products/shoe",
        canonicalUrl: "https://example.com/products/shoe",
        metadata: {}
      }
    ]);

    const urlMatch = matches.find(
      (match) => match.matchedKey === "url:https://example.com/products/shoe"
    );

    expect(urlMatch).toMatchObject({
      matchMethod: "normalized_url",
      matchConfidence: 0.95,
      sitemapItemId: "sitemap-item",
      feedItemId: "feed-item",
      storefrontItemId: "storefront-item"
    });
  });

  it("keeps offer-id matches separate and high confidence", () => {
    const matches = buildSourceMatches([
      {
        id: "feed-item",
        source: "feed",
        stableKey: "offer:sku-1",
        offerId: "SKU-1",
        url: "https://example.com/products/shoe",
        canonicalUrl: null,
        metadata: {}
      }
    ]);

    expect(matches).toContainEqual(
      expect.objectContaining({
        matchedKey: "offer:sku-1",
        matchMethod: "offer_id",
        matchConfidence: 0.98,
        feedItemId: "feed-item"
      })
    );
  });
});
