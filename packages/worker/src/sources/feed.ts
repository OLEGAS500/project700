import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { SourceCheckResult, SourceItemInput } from "@eim/core";
import { createStableProductKey, normalizeOfferId } from "@eim/core";
import { XMLParser } from "fast-xml-parser";
import { assertPublicHttpUrl } from "./url-safety";

export type FeedCollectorInput = {
  url: string;
  timeoutMs?: number;
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
  maxRedirects?: number;
  maxItems?: number;
  maxValueLength?: number;
  fetchImpl?: typeof fetch;
};

type FetchOutcome =
  | {
      ok: true;
      text: string;
      httpStatus: number;
    }
  | {
      ok: false;
      status: SourceCheckResult["status"];
      httpStatus?: number;
      errorCode: string;
      errorMessage: string;
    };

type ParsedFeedItem = {
  offerId?: string;
  title?: string;
  link?: string;
  price?: string;
  salePrice?: string;
  availability?: string;
  imageLink?: string;
  brand?: string;
  gtin?: string;
  mpn?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  processEntities: false,
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (_name, jPath) =>
    ["rss.channel.item", "feed.entry"].includes(String(jPath))
});

export async function collectFeed(input: FeedCollectorInput): Promise<SourceCheckResult> {
  const startedAt = new Date().toISOString();
  const timeoutMs = input.timeoutMs ?? 15_000;
  const maxCompressedBytes = input.maxCompressedBytes ?? 8_000_000;
  const maxDecompressedBytes = input.maxDecompressedBytes ?? 25_000_000;
  const maxRedirects = input.maxRedirects ?? 5;
  const maxItems = input.maxItems ?? 50_000;
  const maxValueLength = input.maxValueLength ?? 2_000;
  const fetchImpl = input.fetchImpl ?? fetch;

  const fetched = await fetchFeedText(input.url, {
    timeoutMs,
    maxCompressedBytes,
    maxDecompressedBytes,
    maxRedirects,
    fetchImpl
  });

  if (!fetched.ok) {
    return finish({
      source: "feed",
      url: input.url,
      status: fetched.status,
      startedAt,
      httpStatus: fetched.httpStatus,
      items: [],
      totalItemsSeen: 0,
      skippedItems: 0,
      errorCode: fetched.errorCode,
      errorMessage: fetched.errorMessage
    });
  }

  if (containsUnsafeXml(fetched.text)) {
    return finish({
      source: "feed",
      url: input.url,
      status: "parse_failed",
      startedAt,
      httpStatus: fetched.httpStatus,
      items: [],
      totalItemsSeen: 0,
      skippedItems: 0,
      errorCode: "unsafe_xml",
      errorMessage: "Feed contains DOCTYPE or entity declarations"
    });
  }

  const parsed = parseFeedXml(fetched.text, maxItems);

  if (parsed.kind === "invalid") {
    return finish({
      source: "feed",
      url: input.url,
      status: "parse_failed",
      startedAt,
      httpStatus: fetched.httpStatus,
      items: [],
      totalItemsSeen: 0,
      skippedItems: 0,
      errorCode: "invalid_feed",
      errorMessage: parsed.error
    });
  }

  const normalized = normalizeFeedItems(parsed.items, maxValueLength);
  const status =
    normalized.items.length > 0 && normalized.skippedItems > 0 ? "partial" : "success";

  return finish({
    source: "feed",
    url: input.url,
    status,
    startedAt,
    httpStatus: fetched.httpStatus,
    items: normalized.items,
    totalItemsSeen: parsed.items.length,
    skippedItems: normalized.skippedItems,
    errorCode: normalized.skippedItems > 0 ? "partial_feed_items" : undefined,
    errorMessage:
      normalized.skippedItems > 0
        ? `${normalized.skippedItems} feed items were skipped`
        : undefined,
    errorSamples: normalized.errorSamples
  });
}

async function fetchFeedText(
  url: string,
  options: {
    timeoutMs: number;
    maxCompressedBytes: number;
    maxDecompressedBytes: number;
    maxRedirects: number;
    fetchImpl: typeof fetch;
  }
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    assertPublicHttpUrl(url);
    const response = await options.fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "EcommerceIncidentMonitor/0.1 (+https://example.com)"
      }
    });

    const httpStatus = response.status;

    if (response.redirected && response.url) {
      assertPublicHttpUrl(response.url);
      const redirectCount = estimateRedirectCount(url, response.url);
      if (redirectCount > options.maxRedirects) {
        return {
          ok: false,
          status: "source_unavailable",
          httpStatus,
          errorCode: "too_many_redirects",
          errorMessage: `Feed exceeded ${options.maxRedirects} redirects`
        };
      }
    }

    if (httpStatus === 401 || httpStatus === 403) {
      return {
        ok: false,
        status: httpStatus === 401 ? "authentication_failed" : "blocked",
        httpStatus,
        errorCode: httpStatus === 401 ? "authentication_failed" : "blocked",
        errorMessage: `Source returned HTTP ${httpStatus}`
      };
    }

    if (httpStatus === 429) {
      return {
        ok: false,
        status: "blocked",
        httpStatus,
        errorCode: "rate_limited",
        errorMessage: "Source returned HTTP 429"
      };
    }

    if (httpStatus >= 500) {
      return {
        ok: false,
        status: "source_unavailable",
        httpStatus,
        errorCode: "upstream_5xx",
        errorMessage: `Source returned HTTP ${httpStatus}`
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: "source_unavailable",
        httpStatus,
        errorCode: "http_error",
        errorMessage: `Source returned HTTP ${httpStatus}`
      };
    }

    const compressedBytes = new Uint8Array(await response.arrayBuffer());

    if (compressedBytes.byteLength > options.maxCompressedBytes) {
      return {
        ok: false,
        status: "source_unavailable",
        httpStatus,
        errorCode: "compressed_response_too_large",
        errorMessage: `Feed response exceeded ${options.maxCompressedBytes} compressed bytes`
      };
    }

    const decompressedBytes = url.endsWith(".gz")
      ? gunzipSync(compressedBytes)
      : compressedBytes;

    if (decompressedBytes.byteLength > options.maxDecompressedBytes) {
      return {
        ok: false,
        status: "source_unavailable",
        httpStatus,
        errorCode: "decompressed_response_too_large",
        errorMessage: `Feed response exceeded ${options.maxDecompressedBytes} decompressed bytes`
      };
    }

    return {
      ok: true,
      text: new TextDecoder().decode(decompressedBytes),
      httpStatus
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        status: "timeout",
        errorCode: "timeout",
        errorMessage: `Source timed out after ${options.timeoutMs}ms`
      };
    }

    return {
      ok: false,
      status: "source_unavailable",
      errorCode: "network_error",
      errorMessage: error instanceof Error ? error.message : "Network error"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseFeedXml(
  xml: string,
  maxItems: number
): { kind: "feed"; items: ParsedFeedItem[] } | { kind: "invalid"; error: string } {
  try {
    const parsed = parser.parse(xml);
    const root = asRecord(parsed);

    if (!root) {
      return { kind: "invalid", error: "XML root is empty" };
    }

    if (Object.hasOwn(root, "rss")) {
      const rss = asRecord(root.rss);
      const channel = asRecord(rss?.channel);

      if (!channel || !Object.hasOwn(channel, "item")) {
        return { kind: "feed", items: [] };
      }

      return {
        kind: "feed",
        items: arrayify(channel.item).slice(0, maxItems).map(toParsedFeedItem)
      };
    }

    if (Object.hasOwn(root, "feed")) {
      const feed = asRecord(root.feed);

      if (!feed || !Object.hasOwn(feed, "entry")) {
        return { kind: "feed", items: [] };
      }

      return {
        kind: "feed",
        items: arrayify(feed.entry).slice(0, maxItems).map(toParsedFeedItem)
      };
    }

    return {
      kind: "invalid",
      error: "XML does not contain RSS channel items or Atom entries"
    };
  } catch (error) {
    return {
      kind: "invalid",
      error: error instanceof Error ? error.message : "Invalid XML"
    };
  }
}

function toParsedFeedItem(value: unknown): ParsedFeedItem {
  const item = asRecord(value) ?? {};

  return {
    offerId: firstString(item.id),
    title: firstString(item.title),
    link: firstString(item.link),
    price: firstString(item.price),
    salePrice: firstString(item.sale_price),
    availability: firstString(item.availability),
    imageLink: firstString(item.image_link),
    brand: firstString(item.brand),
    gtin: firstString(item.gtin),
    mpn: firstString(item.mpn)
  };
}

function normalizeFeedItems(
  items: ParsedFeedItem[],
  maxValueLength: number
): {
  items: SourceItemInput[];
  skippedItems: number;
  errorSamples: string[];
} {
  const normalizedItems: SourceItemInput[] = [];
  const seenByKey = new Map<string, string>();
  const errorSamples: string[] = [];
  let skippedItems = 0;

  for (const [index, item] of items.entries()) {
    const clipped = clipFeedItem(item, maxValueLength);

    if (!clipped.offerId && !clipped.link) {
      skippedItems += 1;
      pushErrorSample(errorSamples, `Item ${index + 1}: missing g:id and link`);
      continue;
    }

    let stableKey: string;

    try {
      stableKey = createStableProductKey({
        offerId: clipped.offerId,
        url: clipped.link,
        title: clipped.title,
        imageUrl: clipped.imageLink
      });
    } catch (error) {
      skippedItems += 1;
      pushErrorSample(
        errorSamples,
        `Item ${index + 1}: ${
          error instanceof Error ? error.message : "could not create stable key"
        }`
      );
      continue;
    }

    const rawHashInput = {
      offerId: clipped.offerId,
      title: clipped.title,
      link: clipped.link,
      price: clipped.price,
      salePrice: clipped.salePrice,
      availability: clipped.availability,
      imageLink: clipped.imageLink,
      brand: clipped.brand,
      gtin: clipped.gtin,
      mpn: clipped.mpn
    };
    const rawHash = createHash("sha256").update(JSON.stringify(rawHashInput)).digest("hex");

    const existingHash = seenByKey.get(stableKey);

    if (existingHash) {
      if (existingHash !== rawHash) {
        skippedItems += 1;
        pushErrorSample(errorSamples, `Item ${index + 1}: conflicting duplicate ${stableKey}`);
      }
      continue;
    }

    seenByKey.set(stableKey, rawHash);
    const basePrice = parseMoney(clipped.price);
    const salePrice = parseMoney(clipped.salePrice);
    const effectivePrice = salePrice ?? basePrice;

    normalizedItems.push({
      source: "feed",
      stableKey,
      offerId: clipped.offerId,
      url: clipped.link,
      title: clipped.title,
      price: effectivePrice?.amount ?? clipped.salePrice ?? clipped.price,
      currency: effectivePrice?.currency ?? basePrice?.currency,
      availability: clipped.availability,
      imageUrl: clipped.imageLink,
      metadata: {
        basePrice: basePrice?.amount ?? clipped.price,
        salePrice: salePrice?.amount ?? clipped.salePrice,
        effectivePrice: effectivePrice?.amount ?? clipped.salePrice ?? clipped.price,
        currency: effectivePrice?.currency ?? basePrice?.currency,
        priceSemantics: "effective_price"
      },
      rawHash
    });
  }

  return {
    items: normalizedItems,
    skippedItems,
    errorSamples
  };
}

function clipFeedItem(item: ParsedFeedItem, maxValueLength: number): ParsedFeedItem {
  const clipped = Object.fromEntries(
    Object.entries(item).map(([key, value]) => [
      key,
      typeof value === "string" ? value.slice(0, maxValueLength) : value
    ])
  ) as ParsedFeedItem;

  return {
    ...clipped,
    offerId: normalizeOfferId(clipped.offerId)
  };
}

function parseMoney(value?: string): { amount: string; currency?: string } | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.trim().match(/^([0-9]+(?:[.,][0-9]+)?)\s*([A-Z]{3})?$/i);

  if (!match) {
    return {
      amount: value
    };
  }

  return {
    amount: match[1].replace(",", "."),
    currency: match[2]?.toUpperCase()
  };
}

function containsUnsafeXml(xml: string): boolean {
  return /<!DOCTYPE|<!ENTITY/i.test(xml);
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return firstString(value[0]);
  }

  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  const record = asRecord(value);

  if (record) {
    const text = record["#text"] ?? record["@_href"];
    return typeof text === "string" && text.trim() ? text.trim() : undefined;
  }

  return undefined;
}

function finish(
  result: Omit<SourceCheckResult, "finishedAt" | "durationMs" | "itemsObserved">
): SourceCheckResult {
  const finishedAt = new Date().toISOString();

  return {
    ...result,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(result.startedAt)),
    itemsObserved: result.items.length
  };
}

function estimateRedirectCount(originalUrl: string, finalUrl: string): number {
  return originalUrl === finalUrl ? 0 : 1;
}

function pushErrorSample(samples: string[], value: string): void {
  if (samples.length < 5) {
    samples.push(value);
  }
}

function arrayify<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
