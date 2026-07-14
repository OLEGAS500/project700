import type { SourceCheckResult } from "@eim/core";
import { normalizeUrlForKey } from "@eim/core";
import { fetchProductPage } from "./fetch";
import { productPageObservationToItem } from "./normalize";
import { parseProductPage } from "./parse";
import type { ProductPageObservation } from "./types";

export type ProductPageCollectorInput = {
  url: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
};

export async function collectProductPage(
  input: ProductPageCollectorInput
): Promise<SourceCheckResult> {
  const startedAt = new Date().toISOString();
  const fetchImpl = input.fetchImpl ?? fetch;
  const fetched = await fetchProductPage(input.url, {
    timeoutMs: input.timeoutMs ?? 12_000,
    maxBytes: input.maxBytes ?? 3_000_000,
    fetchImpl
  });

  if (!fetched.ok) {
    const fallbackObservation = failedObservation(input.url, fetched.finalUrl, fetched.httpStatus);

    return finish({
      source: "product_page",
      url: input.url,
      status: fetched.status,
      startedAt,
      httpStatus: fetched.httpStatus,
      items: [productPageObservationToItem(fallbackObservation)],
      totalItemsSeen: 1,
      skippedItems: 0,
      errorCode: fetched.errorCode,
      errorMessage: fetched.errorMessage,
      metadata: fallbackObservation
    });
  }

  const observation = parseProductPage({
    originalUrl: input.url,
    finalUrl: fetched.finalUrl,
    httpStatus: fetched.httpStatus,
    redirected: fetched.redirected,
    html: fetched.html,
    headers: fetched.headers
  });

  const reliable = fetched.httpStatus >= 200 && fetched.httpStatus < 400;

  return finish({
    source: "product_page",
    url: input.url,
    status: reliable ? "success" : "partial",
    startedAt,
    httpStatus: fetched.httpStatus,
    items: [productPageObservationToItem(observation)],
    totalItemsSeen: 1,
    skippedItems: 0,
    metadata: observation
  });
}

function failedObservation(
  originalUrl: string,
  finalUrl?: string,
  httpStatus?: number
): ProductPageObservation {
  return {
    url: normalizeUrlForKey(originalUrl),
    finalUrl: finalUrl ? normalizeUrlForKey(finalUrl) : undefined,
    httpStatus,
    redirectCount: finalUrl && finalUrl !== originalUrl ? 1 : 0,
    redirectChain: finalUrl && finalUrl !== originalUrl ? [originalUrl, finalUrl] : [originalUrl],
    crossDomainRedirect: finalUrl ? new URL(originalUrl).hostname !== new URL(finalUrl).hostname : false,
    indexability: "unknown",
    canonicalState: "missing",
    schemaPresent: false,
    schemaValidEnough: false,
    extractionStrategy: "html"
  };
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
