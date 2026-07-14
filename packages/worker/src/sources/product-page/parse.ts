import * as cheerio from "cheerio";
import { normalizeUrlForKey } from "@eim/core";
import type {
  CanonicalState,
  ProductPageExtractionStrategy,
  ProductPageObservation
} from "./types";

export function parseProductPage(input: {
  originalUrl: string;
  finalUrl: string;
  httpStatus: number;
  redirected: boolean;
  html: string;
  headers: Headers;
}): ProductPageObservation {
  const $ = cheerio.load(input.html);
  const robotsHeader = input.headers.get("x-robots-tag") ?? "";
  const robotsMeta = $("meta[name='robots'], meta[name='googlebot']")
    .toArray()
    .map((element) => $(element).attr("content") ?? "")
    .join(",");
  const noindex = /noindex/i.test(`${robotsHeader},${robotsMeta}`);
  const canonicalRaw = $("link[rel='canonical']").first().attr("href");
  const canonicalUrl = canonicalRaw ? safeAbsoluteUrl(canonicalRaw, input.finalUrl) : undefined;
  const canonicalState = classifyCanonical(canonicalUrl, input.finalUrl);
  const jsonLd = extractJsonLdProduct($, input.finalUrl);
  const embedded = jsonLd ?? extractEmbeddedProductJson($, input.finalUrl);
  const htmlFallback = extractHtmlFallback($, input.finalUrl);
  const extracted = embedded ?? htmlFallback;

  return {
    url: normalizeUrlForKey(input.originalUrl),
    finalUrl: normalizeUrlForKey(input.finalUrl),
    httpStatus: input.httpStatus,
    redirectCount: input.redirected ? 1 : 0,
    redirectChain:
      input.redirected && input.originalUrl !== input.finalUrl
        ? [input.originalUrl, input.finalUrl]
        : [input.originalUrl],
    crossDomainRedirect:
      new URL(input.originalUrl).hostname !== new URL(input.finalUrl).hostname,
    indexability: noindex ? "noindex" : input.httpStatus >= 200 && input.httpStatus < 400 ? "indexable" : "unknown",
    canonicalUrl,
    canonicalState,
    schemaPresent: Boolean(jsonLd),
    schemaValidEnough: Boolean(jsonLd?.title || jsonLd?.effectivePrice || jsonLd?.availability),
    title: extracted.title,
    imageUrl: extracted.imageUrl,
    basePrice: extracted.basePrice,
    salePrice: extracted.salePrice,
    effectivePrice: extracted.effectivePrice,
    currency: extracted.currency,
    availability: extracted.availability,
    extractionStrategy: extracted.strategy
  };
}

function extractJsonLdProduct(
  $: cheerio.CheerioAPI,
  baseUrl: string
): ExtractedProduct | null {
  for (const element of $("script[type='application/ld+json']").toArray()) {
    const parsed = safeJsonParse($(element).text());
    const product = findProductNode(parsed);

    if (product) {
      return productNodeToExtracted(product, baseUrl, "json_ld");
    }
  }

  return null;
}

function extractEmbeddedProductJson(
  $: cheerio.CheerioAPI,
  baseUrl: string
): ExtractedProduct | null {
  for (const element of $("script[type='application/json']").toArray()) {
    const parsed = safeJsonParse($(element).text());
    const product = findProductNode(parsed);

    if (product) {
      return productNodeToExtracted(product, baseUrl, "embedded_json");
    }
  }

  return null;
}

function extractHtmlFallback($: cheerio.CheerioAPI, baseUrl: string): ExtractedProduct {
  const title =
    $("meta[property='og:title']").attr("content") ??
    $("h1").first().text().trim() ??
    $("title").first().text().trim();
  const imageUrlRaw =
    $("meta[property='og:image']").attr("content") ??
    $("img[src*='product'], img").first().attr("src");
  const imageUrl = imageUrlRaw ? safeAbsoluteUrl(imageUrlRaw, baseUrl) : undefined;
  const price =
    $("[itemprop='price']").attr("content") ??
    $("[data-price]").first().attr("data-price") ??
    $(".price").first().text().trim();
  const currency =
    $("[itemprop='priceCurrency']").attr("content") ??
    $("[data-currency]").first().attr("data-currency");
  const availability =
    $("[itemprop='availability']").attr("content") ??
    $("[data-availability]").first().attr("data-availability");

  return {
    title: title || undefined,
    imageUrl,
    basePrice: price || undefined,
    effectivePrice: price || undefined,
    currency,
    availability,
    strategy: "html"
  };
}

type ExtractedProduct = {
  title?: string;
  imageUrl?: string;
  basePrice?: string;
  salePrice?: string;
  effectivePrice?: string;
  currency?: string;
  availability?: string;
  strategy: ProductPageExtractionStrategy;
};

function productNodeToExtracted(
  product: Record<string, unknown>,
  baseUrl: string,
  strategy: ProductPageExtractionStrategy
): ExtractedProduct {
  const offers = firstRecord(product.offers);
  const image = firstString(product.image);
  const basePrice = firstString(offers?.price) ?? firstString(product.price);
  const salePrice = firstString(offers?.sale_price);
  const currency = firstString(offers?.priceCurrency) ?? firstString(product.priceCurrency);

  return {
    title: firstString(product.name) ?? firstString(product.title),
    imageUrl: image ? safeAbsoluteUrl(image, baseUrl) : undefined,
    basePrice,
    salePrice,
    effectivePrice: salePrice ?? basePrice,
    currency,
    availability: firstString(offers?.availability) ?? firstString(product.availability),
    strategy
  };
}

function findProductNode(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);

  if (record) {
    const type = record["@type"] ?? record.type;
    if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) {
      return record;
    }

    for (const nested of Object.values(record)) {
      const found = findProductNode(nested);
      if (found) {
        return found;
      }
    }
  }

  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findProductNode(nested);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function classifyCanonical(canonicalUrl: string | undefined, finalUrl: string): CanonicalState {
  if (!canonicalUrl) {
    return "missing";
  }

  try {
    return normalizeUrlForKey(canonicalUrl) === normalizeUrlForKey(finalUrl)
      ? "self"
      : "different";
  } catch {
    return "invalid";
  }
}

function safeAbsoluteUrl(value: string, baseUrl: string): string | undefined {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
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

  if (typeof value === "number") {
    return String(value);
  }

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    return firstRecord(value[0]);
  }

  return asRecord(value) ?? undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
