import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { SourceCheckResult, SourceItemInput } from "@eim/core";
import { normalizeUrlForKey } from "@eim/core";
import { assertPublicHttpUrl } from "./url-safety";

export type CategoryExtractionStrategy =
  | "shopify_json"
  | "embedded_json"
  | "json_ld"
  | "html_links";

export type CategoryObservation = {
  reportedTotal?: number;
  discoveredCount: number;
  productUrls: string[];
  extractionStrategy: CategoryExtractionStrategy;
  paginationComplete: boolean;
  truncated: boolean;
  confidence: number;
};

export type CategoryCollectorInput = {
  url: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxPages?: number;
  maxProducts?: number;
  fetchImpl?: typeof fetch;
};

type FetchOutcome =
  | { ok: true; text: string; httpStatus: number; finalUrl: string }
  | {
      ok: false;
      status: SourceCheckResult["status"];
      httpStatus?: number;
      errorCode: string;
      errorMessage: string;
    };

export async function collectCategory(
  input: CategoryCollectorInput
): Promise<SourceCheckResult> {
  const startedAt = new Date().toISOString();
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 12_000;
  const maxBytes = input.maxBytes ?? 3_000_000;
  const maxPages = input.maxPages ?? 10;
  const maxProducts = input.maxProducts ?? 1_000;

  const shopifyJson = await tryShopifyJson(input.url, {
    timeoutMs,
    maxBytes,
    maxProducts,
    fetchImpl
  });

  if (shopifyJson) {
    return finishCategory(input.url, startedAt, shopifyJson.httpStatus, shopifyJson.observation);
  }

  const firstPage = await fetchCategoryText(input.url, {
    timeoutMs,
    maxBytes,
    fetchImpl
  });

  if (!firstPage.ok) {
    return finish({
      source: "category",
      url: input.url,
      status: firstPage.status,
      startedAt,
      httpStatus: firstPage.httpStatus,
      items: [],
      totalItemsSeen: 0,
      skippedItems: 0,
      errorCode: firstPage.errorCode,
      errorMessage: firstPage.errorMessage
    });
  }

  const embedded = extractEmbeddedObservation(firstPage.text, firstPage.finalUrl, maxProducts);

  if (embedded) {
    return finishCategory(input.url, startedAt, firstPage.httpStatus, embedded);
  }

  const htmlObservation = await collectHtmlLinksAcrossPagination(firstPage, {
    originalUrl: input.url,
    timeoutMs,
    maxBytes,
    maxPages,
    maxProducts,
    fetchImpl
  });

  return finishCategory(input.url, startedAt, firstPage.httpStatus, htmlObservation);
}

async function tryShopifyJson(
  categoryUrl: string,
  options: {
    timeoutMs: number;
    maxBytes: number;
    maxProducts: number;
    fetchImpl: typeof fetch;
  }
): Promise<{ httpStatus: number; observation: CategoryObservation } | null> {
  const jsonUrl = `${categoryUrl.replace(/\/$/, "")}/products.json`;
  const fetched = await fetchCategoryText(jsonUrl, options);

  if (!fetched.ok) {
    return null;
  }

  try {
    const parsed = JSON.parse(fetched.text);
    const products = Array.isArray(parsed.products) ? parsed.products : null;

    if (!products) {
      return null;
    }

    const origin = new URL(categoryUrl).origin;
    const urls = products
      .slice(0, options.maxProducts)
      .map((product: unknown) => asRecord(product)?.handle)
      .filter(isString)
      .map((handle: string) => `${origin}/products/${handle}`);
    const uniqueUrls = normalizeUniqueUrls(urls);
    const reportedTotal =
      typeof parsed.products_count === "number" ? parsed.products_count : undefined;

    return {
      httpStatus: fetched.httpStatus,
      observation: {
        reportedTotal,
        discoveredCount: uniqueUrls.length,
        productUrls: uniqueUrls,
        extractionStrategy: "shopify_json",
        paginationComplete: reportedTotal === undefined || reportedTotal <= uniqueUrls.length,
        truncated: uniqueUrls.length >= options.maxProducts,
        confidence: reportedTotal === undefined ? 0.85 : 0.95
      }
    };
  } catch {
    return null;
  }
}

function extractEmbeddedObservation(
  html: string,
  pageUrl: string,
  maxProducts: number
): CategoryObservation | null {
  const $ = cheerio.load(html);

  for (const element of $("script[type='application/json']").toArray()) {
    const text = $(element).text();
    const parsed = safeJsonParse(text);
    const extracted = parsed ? findProductCollection(parsed, pageUrl, maxProducts) : null;

    if (extracted) {
      return {
        ...extracted,
        extractionStrategy: "embedded_json",
        confidence: extracted.reportedTotal === undefined ? 0.8 : 0.92
      };
    }
  }

  for (const element of $("script[type='application/ld+json']").toArray()) {
    const text = $(element).text();
    const parsed = safeJsonParse(text);
    const urls = parsed ? findProductUrls(parsed, pageUrl, maxProducts) : [];

    if (urls.length > 0) {
      const uniqueUrls = normalizeUniqueUrls(urls);
      return {
        discoveredCount: uniqueUrls.length,
        productUrls: uniqueUrls,
        extractionStrategy: "json_ld",
        paginationComplete: false,
        truncated: uniqueUrls.length >= maxProducts,
        confidence: 0.55
      };
    }
  }

  return null;
}

async function collectHtmlLinksAcrossPagination(
  firstPage: { text: string; finalUrl: string },
  options: {
    originalUrl: string;
    timeoutMs: number;
    maxBytes: number;
    maxPages: number;
    maxProducts: number;
    fetchImpl: typeof fetch;
  }
): Promise<CategoryObservation> {
  let currentHtml = firstPage.text;
  let currentUrl = firstPage.finalUrl;
  const productUrls: string[] = [];
  let pageCount = 0;
  let truncated = false;
  let paginationComplete = false;
  let sawInfiniteScroll = false;

  while (pageCount < options.maxPages && productUrls.length < options.maxProducts) {
    pageCount += 1;
    const $ = cheerio.load(currentHtml);
    sawInfiniteScroll ||= /infinite|load more|data-next-url/i.test(currentHtml);
    productUrls.push(...extractProductLinks($, currentUrl));

    const nextUrl = findNextPageUrl($, currentUrl);

    if (!nextUrl) {
      paginationComplete = true;
      break;
    }

    const nextPage = await fetchCategoryText(nextUrl, {
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      fetchImpl: options.fetchImpl
    });

    if (!nextPage.ok) {
      truncated = true;
      break;
    }

    currentHtml = nextPage.text;
    currentUrl = nextPage.finalUrl;
  }

  if (pageCount >= options.maxPages || productUrls.length >= options.maxProducts) {
    truncated = true;
  }

  const uniqueUrls = normalizeUniqueUrls(productUrls).slice(0, options.maxProducts);
  const confirmedEmpty = uniqueUrls.length === 0 && /no products|nothing found|empty/i.test(firstPage.text);
  const reliableComplete = paginationComplete && !sawInfiniteScroll;

  return {
    discoveredCount: uniqueUrls.length,
    productUrls: uniqueUrls,
    extractionStrategy: "html_links",
    paginationComplete: reliableComplete || confirmedEmpty,
    truncated,
    confidence: reliableComplete || confirmedEmpty ? 0.7 : 0.4
  };
}

async function fetchCategoryText(
  url: string,
  options: {
    timeoutMs: number;
    maxBytes: number;
    fetchImpl: typeof fetch;
  }
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    assertPublicHttpUrl(url);
    const response = await options.fetchImpl(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "EcommerceIncidentMonitor/0.1 (+https://example.com)"
      }
    });
    const httpStatus = response.status;

    if (response.url) {
      assertPublicHttpUrl(response.url);
    }

    if (httpStatus === 403 || httpStatus === 429) {
      return {
        ok: false,
        status: "blocked",
        httpStatus,
        errorCode: "blocked",
        errorMessage: `Source returned HTTP ${httpStatus}`
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

    const text = await response.text();

    if (new TextEncoder().encode(text).byteLength > options.maxBytes) {
      return {
        ok: false,
        status: "source_unavailable",
        httpStatus,
        errorCode: "response_too_large",
        errorMessage: `Category response exceeded ${options.maxBytes} bytes`
      };
    }

    return {
      ok: true,
      text,
      httpStatus,
      finalUrl: response.url || url
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

function finishCategory(
  url: string,
  startedAt: string,
  httpStatus: number,
  observation: CategoryObservation
): SourceCheckResult {
  const items = observation.productUrls.map((productUrl) =>
    toStorefrontItem(productUrl, url, observation.extractionStrategy)
  );
  const reliable =
    observation.paginationComplete &&
    !observation.truncated &&
    observation.confidence >= 0.65;

  return finish({
    source: "category",
    url,
    status: reliable ? "success" : "partial",
    startedAt,
    httpStatus,
    items,
    totalItemsSeen: observation.reportedTotal ?? observation.discoveredCount,
    skippedItems: 0,
    errorCode: reliable ? undefined : "category_count_not_confirmed",
    errorMessage: reliable
      ? undefined
      : "Category products were discovered, but total category coverage is not fully confirmed",
    metadata: observation
  });
}

function extractProductLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
  return $("a[href*='/products/']")
    .toArray()
    .map((element) => $(element).attr("href"))
    .filter(isString)
    .map((href) => new URL(href, baseUrl).toString());
}

function findNextPageUrl($: cheerio.CheerioAPI, baseUrl: string): string | null {
  const relNext = $("a[rel='next'], link[rel='next']").first().attr("href");

  if (relNext) {
    return new URL(relNext, baseUrl).toString();
  }

  return null;
}

function findProductCollection(
  value: unknown,
  pageUrl: string,
  maxProducts: number
): Omit<CategoryObservation, "extractionStrategy" | "confidence"> | null {
  const record = asRecord(value);

  if (!record) {
    return null;
  }

  const products = Array.isArray(record.products)
    ? record.products
    : Array.isArray(record.items)
      ? record.items
      : null;

  if (products) {
    const urls = products
      .slice(0, maxProducts)
      .map((product) => productToUrl(product, pageUrl))
      .filter(isString);
    const uniqueUrls = normalizeUniqueUrls(urls);
    const reportedTotal = numberValue(record.products_count) ?? numberValue(record.total);

    return {
      reportedTotal,
      discoveredCount: uniqueUrls.length,
      productUrls: uniqueUrls,
      paginationComplete: reportedTotal === undefined || reportedTotal <= uniqueUrls.length,
      truncated: uniqueUrls.length >= maxProducts
    };
  }

  for (const nested of Object.values(record)) {
    const found = findProductCollection(nested, pageUrl, maxProducts);

    if (found) {
      return found;
    }
  }

  return null;
}

function findProductUrls(value: unknown, pageUrl: string, maxProducts: number): string[] {
  const urls: string[] = [];

  function walk(node: unknown): void {
    if (urls.length >= maxProducts) {
      return;
    }

    const record = asRecord(node);

    if (record) {
      if (record["@type"] === "Product" || record.type === "Product") {
        const url = productToUrl(record, pageUrl);
        if (url) {
          urls.push(url);
        }
      }

      Object.values(record).forEach(walk);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
    }
  }

  walk(value);
  return urls;
}

function productToUrl(value: unknown, pageUrl: string): string | undefined {
  const product = asRecord(value);

  if (!product) {
    return undefined;
  }

  const url = firstString(product.url) ?? firstString(product.link);

  if (url) {
    return new URL(url, pageUrl).toString();
  }

  const handle = firstString(product.handle);

  if (handle) {
    return `${new URL(pageUrl).origin}/products/${handle}`;
  }

  return undefined;
}

function toStorefrontItem(
  url: string,
  categoryUrl: string,
  extractionStrategy: CategoryExtractionStrategy
): SourceItemInput {
  const categoryDiscoveryHash = createHash("sha256")
    .update(JSON.stringify({ url, categoryUrl, extractionStrategy }))
    .digest("hex");

  return {
    source: "storefront",
    stableKey: `url:${url}`,
    url,
    metadata: {
      discoveredFrom: [
        {
          type: "category",
          url: categoryUrl,
          extractionStrategy
        }
      ],
      sourceHashes: {
        categoryDiscovery: categoryDiscoveryHash
      }
    },
    rawHash: categoryDiscoveryHash
  };
}

function normalizeUniqueUrls(urls: string[]): string[] {
  return [...new Set(urls.map((url) => normalizeUrlForKey(url)))];
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

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return firstString(value[0]);
  }

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
