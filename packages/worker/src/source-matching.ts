import type { MatchableSourceItem, SourceMatchInput } from "@eim/db";
import { normalizeUrlForKey } from "@eim/core";

export function buildSourceMatches(items: MatchableSourceItem[]): SourceMatchInput[] {
  const byKey = new Map<string, SourceMatchInput>();

  for (const item of items) {
    if (item.offerId) {
      addToMatch(byKey, {
        key: `offer:${item.offerId.toLowerCase()}`,
        method: "offer_id",
        confidence: 0.98,
        item
      });
    }

    for (const url of candidateUrls(item)) {
      addToMatch(byKey, {
        key: `url:${url}`,
        method: item.canonicalUrl && normalizeSafe(item.canonicalUrl) === url ? "canonical_url" : "normalized_url",
        confidence: item.canonicalUrl && normalizeSafe(item.canonicalUrl) === url ? 0.92 : 0.95,
        item
      });
    }
  }

  return [...byKey.values()].filter((match) =>
    Boolean(match.sitemapItemId || match.feedItemId || match.storefrontItemId)
  );
}

function addToMatch(
  byKey: Map<string, SourceMatchInput>,
  input: {
    key: string;
    method: SourceMatchInput["matchMethod"];
    confidence: number;
    item: MatchableSourceItem;
  }
): void {
  const existing =
    byKey.get(input.key) ??
    ({
      matchedKey: input.key,
      matchMethod: input.method,
      matchConfidence: input.confidence,
      metadata: {
        methods: []
      }
    } satisfies SourceMatchInput);

  if (input.confidence > existing.matchConfidence) {
    existing.matchMethod = input.method;
    existing.matchConfidence = input.confidence;
  }

  if (input.item.source === "sitemap") {
    existing.sitemapItemId ??= input.item.id;
  }
  if (input.item.source === "feed" || input.item.source === "merchant_center") {
    existing.feedItemId ??= input.item.id;
  }
  if (input.item.source === "storefront") {
    existing.storefrontItemId ??= input.item.id;
  }

  const methods = Array.isArray(existing.metadata?.methods)
    ? existing.metadata.methods
    : [];
  existing.metadata = {
    ...existing.metadata,
    methods: [...new Set([...methods, input.method])]
  };

  byKey.set(input.key, existing);
}

function candidateUrls(item: MatchableSourceItem): string[] {
  return [item.url, item.canonicalUrl, productPageFinalUrl(item)]
    .map((url) => (url ? normalizeSafe(url) : null))
    .filter((url): url is string => Boolean(url));
}

function productPageFinalUrl(item: MatchableSourceItem): string | null {
  const productPage = item.metadata.productPage;

  if (
    typeof productPage === "object" &&
    productPage !== null &&
    "finalUrl" in productPage &&
    typeof productPage.finalUrl === "string"
  ) {
    return productPage.finalUrl;
  }

  return null;
}

function normalizeSafe(url: string): string | null {
  try {
    return normalizeUrlForKey(url);
  } catch {
    return null;
  }
}
