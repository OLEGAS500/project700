import {
  normalizeOfferId,
  type SourceCheckResult,
  type SourceItemInput,
  type MerchantCenterOAuthFetch
} from "@eim/core";
import {
  createQueuedSnapshot,
  getSnapshotStore,
  merchantItemIssuesConfigurationHash,
  merchantProductIdentityDataKind,
  merchantProductIdentityVersion,
  persistMerchantCenterItemIssuesResult,
  type SnapshotRecord
} from "@eim/db";
import { createHash } from "node:crypto";
import {
  createMerchantCenterStatusDependencies,
  resolveMerchantCenterAccessToken,
  type MerchantCenterStatusDependencies
} from "./merchant-center-status";

const merchantProductsEndpoint = "https://merchantapi.googleapis.com/products/v1/accounts";
const productsPageSize = 1_000;
const defaultRequestTimeoutMs = 10_000;
const maxRequestTimeoutMs = 60_000;
const defaultMaxPages = 20;
const hardMaxPages = 100;
const defaultMaxProducts = 1_000;
const hardMaxProducts = 10_000;
const defaultMaxIssuesPerProduct = 25;
const hardMaxIssuesPerProduct = 100;
const defaultMaxPageTokenLength = 2_048;
const hardMaxPageTokenLength = 8_192;
const defaultMaxStringLength = 512;
const hardMaxStringLength = 4_096;
const maxErrorSamples = 5;

export type MerchantCenterItemIssuesLimits = {
  maxPages?: number;
  maxProducts?: number;
  maxIssuesPerProduct?: number;
  maxPageTokenLength?: number;
  maxStringLength?: number;
};

export type CollectMerchantCenterItemIssuesInput = {
  storeId: string;
  accountId: string | null;
  fetchImpl?: MerchantCenterOAuthFetch;
  timeoutMs?: number;
  now?: () => Date;
  limits?: MerchantCenterItemIssuesLimits;
  dependencies?: Partial<MerchantCenterStatusDependencies>;
};

type NormalizedMerchantCenterItemIssue = {
  code: string;
  severity: string;
  resolution: string;
  attribute: string;
  reportingContext: string;
  description?: string;
  detail?: string;
  documentation?: string;
  applicableCountries: string[];
};

type NormalizedMerchantCenterProduct = {
  stableKey: string;
  offerId?: string;
  productName?: string;
  title?: string;
  merchantStatus: "approved" | "pending" | "disapproved" | "unknown";
  issues: NormalizedMerchantCenterItemIssue[];
  rawHash: string;
};

type NormalizedLimits = {
  maxPages: number;
  maxProducts: number;
  maxIssuesPerProduct: number;
  maxPageTokenLength: number;
  maxStringLength: number;
};

type ProductPageFailure = {
  status: "authentication_failed" | "source_unavailable" | "partial" | "parse_failed";
  errorCode: string;
  errorMessage: string;
  httpStatus?: number;
};

type ProductNormalization = {
  product: NormalizedMerchantCenterProduct | null;
  invalidIssueCount: number;
  issueLimitReached: boolean;
  invalidProduct: boolean;
};

export async function collectMerchantCenterItemIssues(
  input: CollectMerchantCenterItemIssuesInput
): Promise<SourceCheckResult> {
  const startedAt = new Date();
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const limits = normalizeLimits(input.limits);
  const dependencies = createMerchantCenterStatusDependencies(input.dependencies);
  const endpoint = buildMerchantProductsEndpoint(input.accountId);

  if (!input.accountId) {
    return addConfigurationMetadata(input.accountId, buildResult(startedAt, endpoint, {
      status: "authentication_failed",
      errorCode: "merchant_center_not_connected",
      errorMessage: "Merchant Center is not connected."
    }));
  }

  const access = await resolveMerchantCenterAccessToken({
    storeId: input.storeId,
    fetchImpl,
    now,
    dependencies
  });

  if ("status" in access) {
    return addConfigurationMetadata(input.accountId, buildResult(startedAt, endpoint, access));
  }

  const result = await fetchMerchantProducts({
    endpoint,
    accessToken: access.accessToken,
    fetchImpl,
    timeoutMs,
    startedAt,
    limits
  });

  return addConfigurationMetadata(input.accountId, result);
}

export async function runMerchantCenterItemIssuesSnapshotForStore(storeId: string): Promise<{
  snapshotId: string;
  status: SnapshotRecord["status"];
  sourceCheckStatus: SourceCheckResult["status"];
  productsSeen: number;
  productsWithIssues: number;
  issuesObserved: number;
}> {
  const snapshot = await createQueuedSnapshot(
    storeId,
    "normal_check",
    `merchant-center-item-issues:${storeId}:${toMinuteWindow(new Date().toISOString())}`
  );
  const store = await getSnapshotStore(snapshot.id);

  if (!store) {
    throw new Error(`Snapshot ${snapshot.id} does not belong to an existing store`);
  }

  const result = await collectMerchantCenterItemIssues({
    storeId: store.id,
    accountId: store.merchantCenterAccountId
  });
  const persisted = await persistMerchantCenterItemIssuesResult(snapshot.id, store.id, result);
  const metadata = isRecord(result.metadata) ? result.metadata : {};

  return {
    snapshotId: persisted.id,
    status: persisted.status,
    sourceCheckStatus: result.status,
    productsSeen: readNonNegativeInteger(metadata.productsSeen) ?? 0,
    productsWithIssues: readNonNegativeInteger(metadata.productsWithIssues) ?? 0,
    issuesObserved: readNonNegativeInteger(metadata.issuesObserved) ?? 0
  };
}

async function fetchMerchantProducts(input: {
  endpoint: string;
  accessToken: string;
  fetchImpl: MerchantCenterOAuthFetch;
  timeoutMs: number;
  startedAt: Date;
  limits: NormalizedLimits;
}): Promise<SourceCheckResult> {
  const deadlineAt = Date.now() + input.timeoutMs;
  const products = new Map<string, NormalizedMerchantCenterProduct>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  let pagesFetched = 0;
  let productsSeen = 0;
  let skippedProducts = 0;
  let invalidIssueCount = 0;
  let issueLimitReached = false;
  let lastHttpStatus: number | undefined;

  while (true) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return buildProductFailureResult(input, products, {
        status: "source_unavailable",
        errorCode: "merchant_center_products_deadline_exceeded",
        errorMessage: "Merchant Center product pagination exceeded its deadline.",
        httpStatus: lastHttpStatus
      }, pagesFetched, productsSeen, skippedProducts, invalidIssueCount, issueLimitReached);
    }

    const page = await requestProductPage({
      pageUrl: buildPageUrl(input.endpoint, pageToken),
      accessToken: input.accessToken,
      fetchImpl: input.fetchImpl,
      timeoutMs: Math.min(remainingMs, input.timeoutMs)
    });

    if (page.kind === "error") {
      return buildProductFailureResult(
        input,
        products,
        page,
        pagesFetched,
        productsSeen,
        skippedProducts,
        invalidIssueCount,
        issueLimitReached
      );
    }

    pagesFetched += 1;
    lastHttpStatus = page.httpStatus;
    const pageProducts = readProducts(page.payload);

    if (!pageProducts) {
      if (products.size === 0) {
        return buildResult(input.startedAt, input.endpoint, {
          status: "parse_failed",
          httpStatus: page.httpStatus,
          totalItemsSeen: productsSeen,
          skippedItems: skippedProducts + invalidIssueCount + 1,
          errorCode: "merchant_center_products_response_invalid",
          errorMessage: "Merchant Center returned incomplete product data.",
          errorSamples: ["merchant_center_products_response_invalid"]
        });
      }
      return buildProductResult(input, products, {
        httpStatus: page.httpStatus,
        pagesFetched,
        productsSeen,
        skippedProducts,
        invalidIssueCount,
        issueLimitReached,
        paginationError: {
          errorCode: "merchant_center_products_response_invalid",
          errorMessage: "Merchant Center returned incomplete product data."
        }
      });
    }

    const remainingProducts = input.limits.maxProducts - productsSeen;
    if (pageProducts.length > remainingProducts) {
      const boundedProducts = pageProducts.slice(0, Math.max(0, remainingProducts));
      for (const value of boundedProducts) {
        const normalized = normalizeProduct(value, input.limits);
        productsSeen += 1;
        if (normalized.invalidProduct) {
          skippedProducts += 1;
        }
        invalidIssueCount += normalized.invalidIssueCount;
        issueLimitReached ||= normalized.issueLimitReached;
        mergeProduct(products, normalized.product);
      }

      return buildProductResult(input, products, {
        httpStatus: page.httpStatus,
        pagesFetched,
        productsSeen,
        skippedProducts,
        invalidIssueCount,
        issueLimitReached,
        paginationError: {
          errorCode: "merchant_center_products_resource_limit",
          errorMessage: "Merchant Center product pagination exceeded its product limit."
        }
      });
    }

    for (const value of pageProducts) {
      const normalized = normalizeProduct(value, input.limits);
      productsSeen += 1;
      if (normalized.invalidProduct) {
        skippedProducts += 1;
      }
      invalidIssueCount += normalized.invalidIssueCount;
      issueLimitReached ||= normalized.issueLimitReached;
      mergeProduct(products, normalized.product);
    }

    const nextPageToken = readNextPageToken(page.payload);
    if (nextPageToken.malformed) {
      return buildProductResult(input, products, {
        httpStatus: page.httpStatus,
        pagesFetched,
        productsSeen,
        skippedProducts,
        invalidIssueCount,
        issueLimitReached,
        paginationError: {
          errorCode: "merchant_center_products_page_token_invalid",
          errorMessage: "Merchant Center returned an invalid product pagination token."
        }
      });
    }

    if (!nextPageToken.token) {
      return buildProductResult(input, products, {
        httpStatus: page.httpStatus,
        pagesFetched,
        productsSeen,
        skippedProducts,
        invalidIssueCount,
        issueLimitReached
      });
    }

    if (nextPageToken.token.length > input.limits.maxPageTokenLength) {
      return buildProductResult(input, products, {
        httpStatus: page.httpStatus,
        pagesFetched,
        productsSeen,
        skippedProducts,
        invalidIssueCount,
        issueLimitReached,
        paginationError: {
          errorCode: "merchant_center_products_page_token_too_long",
          errorMessage: "Merchant Center product pagination token exceeded its limit."
        }
      });
    }

    if (seenPageTokens.has(nextPageToken.token)) {
      return buildProductResult(input, products, {
        httpStatus: page.httpStatus,
        pagesFetched,
        productsSeen,
        skippedProducts,
        invalidIssueCount,
        issueLimitReached,
        paginationError: {
          errorCode: "merchant_center_products_page_token_repeated",
          errorMessage: "Merchant Center returned a repeated product pagination token."
        }
      });
    }

    if (pagesFetched >= input.limits.maxPages) {
      return buildProductResult(input, products, {
        httpStatus: page.httpStatus,
        pagesFetched,
        productsSeen,
        skippedProducts,
        invalidIssueCount,
        issueLimitReached,
        paginationError: {
          errorCode: "merchant_center_products_page_limit",
          errorMessage: "Merchant Center product pagination reached its page limit."
        }
      });
    }

    seenPageTokens.add(nextPageToken.token);
    pageToken = nextPageToken.token;
  }
}

function normalizeProduct(value: unknown, limits: NormalizedLimits): ProductNormalization {
  if (!isRecord(value)) {
    return { product: null, invalidIssueCount: 0, issueLimitReached: false, invalidProduct: true };
  }

  const productName = readMerchantProductName(value.name, limits.maxStringLength);
  const offerId = normalizeOfferId(readString(value.offerId, limits.maxStringLength));
  if (!productName) {
    return { product: null, invalidIssueCount: 0, issueLimitReached: false, invalidProduct: true };
  }

  const productStatus = isRecord(value.productStatus) ? value.productStatus : null;
  const rawIssues = productStatus?.itemLevelIssues;
  if (rawIssues !== undefined && !Array.isArray(rawIssues)) {
    return { product: null, invalidIssueCount: 1, issueLimitReached: false, invalidProduct: true };
  }

  const issues: NormalizedMerchantCenterItemIssue[] = [];
  const issueKeys = new Set<string>();
  let invalidIssueCount = 0;
  let issueLimitReached = false;
  for (const rawIssue of (Array.isArray(rawIssues) ? rawIssues : []).slice(
    0,
    limits.maxIssuesPerProduct
  )) {
    const normalized = normalizeIssue(rawIssue, limits.maxStringLength);
    if (!normalized) {
      invalidIssueCount += 1;
      continue;
    }
    const key = JSON.stringify([
      normalized.code,
      normalized.severity,
      normalized.resolution,
      normalized.attribute,
      normalized.reportingContext,
      normalized.applicableCountries
    ]);
    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      issues.push(normalized);
    }
  }
  if (Array.isArray(rawIssues) && rawIssues.length > limits.maxIssuesPerProduct) {
    issueLimitReached = true;
  }

  // A Merchant resource name includes language/feed-label identity. Offer IDs are for matching,
  // not for collapsing distinct provider resources before ambiguity can be evaluated.
  const stableKey = `merchant_product:${createHash("sha256").update(productName).digest("hex")}`;
  const title = productAttributesTitle(value, limits.maxStringLength);
  const merchantStatus = readMerchantStatus(productStatus);
  const normalizedProductWithoutHash = {
    stableKey,
    offerId,
    productName,
    title,
    merchantStatus,
    issues
  };

  return {
    product: {
      ...normalizedProductWithoutHash,
      rawHash: createHash("sha256")
        .update(JSON.stringify(normalizedProductWithoutHash))
        .digest("hex")
    },
    invalidIssueCount,
    issueLimitReached,
    invalidProduct: false
  };
}

function mergeProduct(
  products: Map<string, NormalizedMerchantCenterProduct>,
  next: NormalizedMerchantCenterProduct | null
): void {
  if (!next) return;
  const current = products.get(next.stableKey);
  if (!current) {
    products.set(next.stableKey, next);
    return;
  }

  const issues = new Map<string, NormalizedMerchantCenterItemIssue>();
  for (const issue of [...current.issues, ...next.issues]) {
    issues.set(JSON.stringify(issue), issue);
  }
  const mergedIssues = [...issues.values()];
  const merged = {
    ...current,
    title: next.title ?? current.title,
    productName: next.productName ?? current.productName,
    merchantStatus: next.merchantStatus === "unknown" ? current.merchantStatus : next.merchantStatus,
    issues: mergedIssues
  };
  products.set(next.stableKey, {
    ...merged,
    rawHash: createHash("sha256").update(JSON.stringify({
      stableKey: merged.stableKey,
      offerId: merged.offerId,
      productName: merged.productName,
      title: merged.title,
      merchantStatus: merged.merchantStatus,
      issues: merged.issues
    })).digest("hex")
  });
}

function normalizeIssue(value: unknown, maxStringLength: number): NormalizedMerchantCenterItemIssue | null {
  if (!isRecord(value)) return null;
  const code = normalizeToken(value.code, maxStringLength);
  if (!code) return null;

  return {
    code,
    severity: normalizeToken(value.severity, maxStringLength) ?? "unknown",
    resolution: normalizeToken(value.resolution, maxStringLength) ?? "unknown",
    attribute: normalizeText(value.attribute, maxStringLength) ?? "unknown",
    reportingContext: normalizeToken(value.reportingContext, maxStringLength) ?? "unknown",
    description: normalizeText(value.description, maxStringLength),
    detail: normalizeText(value.detail, maxStringLength),
    documentation: normalizeHttpUrl(value.documentation, maxStringLength),
    applicableCountries: normalizeCountries(value.applicableCountries)
  };
}

function readMerchantStatus(productStatus: Record<string, unknown> | null):
  | "approved"
  | "pending"
  | "disapproved"
  | "unknown" {
  const destinations = productStatus?.destinationStatuses;
  if (!Array.isArray(destinations)) return "unknown";

  let hasPending = false;
  for (const value of destinations) {
    if (!isRecord(value)) continue;
    if (Array.isArray(value.disapprovedCountries) && value.disapprovedCountries.length > 0) {
      return "disapproved";
    }
    if (Array.isArray(value.pendingCountries) && value.pendingCountries.length > 0) {
      hasPending = true;
    }
  }
  if (hasPending) return "pending";
  if (destinations.some((value) => isRecord(value) && Array.isArray(value.approvedCountries))) {
    return "approved";
  }
  return "unknown";
}

function productAttributesTitle(value: Record<string, unknown>, maxStringLength: number): string | undefined {
  const attributes = isRecord(value.productAttributes) ? value.productAttributes : null;
  return normalizeText(attributes?.title, maxStringLength);
}

function buildProductResult(
  input: {
    endpoint: string;
    startedAt: Date;
  },
  products: Map<string, NormalizedMerchantCenterProduct>,
  details: {
    httpStatus?: number;
    pagesFetched: number;
    productsSeen: number;
    skippedProducts: number;
    invalidIssueCount: number;
    issueLimitReached: boolean;
    paginationError?: { errorCode: string; errorMessage: string };
  }
): SourceCheckResult {
  const normalizedProducts = [...products.values()];
  const issueProducts = normalizedProducts.filter((product) => product.issues.length > 0);
  const items = normalizedProducts.map(toSourceItem);
  const partial =
    details.skippedProducts > 0 ||
    details.invalidIssueCount > 0 ||
    details.issueLimitReached ||
    Boolean(details.paginationError);
  const errorSamples: string[] = [];
  if (details.skippedProducts > 0) errorSamples.push("merchant_product_invalid");
  if (details.invalidIssueCount > 0) errorSamples.push("merchant_issue_invalid");
  if (details.issueLimitReached) errorSamples.push("merchant_issue_limit");
  if (details.paginationError) errorSamples.push(details.paginationError.errorCode);

  return buildResult(input.startedAt, input.endpoint, {
    status: partial ? "partial" : "success",
    httpStatus: details.httpStatus,
    itemsObserved: issueProducts.length,
    totalItemsSeen: details.productsSeen,
    skippedItems: details.skippedProducts + details.invalidIssueCount,
    errorCode: details.paginationError?.errorCode ?? (partial ? errorSamples[0] : undefined),
    errorMessage: details.paginationError?.errorMessage ??
      (partial ? "Merchant Center returned incomplete product issue data." : undefined),
    errorSamples: errorSamples.slice(0, maxErrorSamples),
    items,
    metadata: {
      merchantItemIssuesVersion: "v1",
      merchantProductIdentityVersion,
      merchantProductIdentityComplete: !partial,
      productsSeen: details.productsSeen,
      productsWithIssues: issueProducts.length,
      issuesObserved: items.reduce((count, item) => count + (item.merchantIssues?.length ?? 0), 0),
      invalidIssueCount: details.invalidIssueCount,
      pagination: {
        pagesFetched: details.pagesFetched,
        complete: !details.paginationError
      }
    }
  });
}

function buildProductFailureResult(
  input: {
    endpoint: string;
    startedAt: Date;
  },
  products: Map<string, NormalizedMerchantCenterProduct>,
  failure: ProductPageFailure,
  pagesFetched: number,
  productsSeen: number,
  skippedProducts: number,
  invalidIssueCount: number,
  issueLimitReached: boolean
): SourceCheckResult {
  if (products.size > 0) {
    return buildProductResult(input, products, {
      httpStatus: failure.httpStatus,
      pagesFetched,
      productsSeen,
      skippedProducts,
      invalidIssueCount,
      issueLimitReached,
      paginationError: {
        errorCode: `merchant_center_products_pagination_${failure.errorCode.replace(
          "merchant_center_products_",
          ""
        )}`,
        errorMessage: "Merchant Center product pagination could not be completed."
      }
    });
  }

  return buildResult(input.startedAt, input.endpoint, {
    status: failure.status,
    httpStatus: failure.httpStatus,
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
    totalItemsSeen: productsSeen,
    skippedItems: skippedProducts + invalidIssueCount + 1,
    errorSamples: [failure.errorCode]
  });
}

function toSourceItem(product: NormalizedMerchantCenterProduct): SourceItemInput {
  return {
    source: "merchant_center",
    stableKey: product.stableKey,
    offerId: product.offerId,
    title: product.title,
    merchantStatus: product.merchantStatus,
    ...(product.issues.length > 0 ? { merchantIssues: product.issues } : {}),
    metadata: {
      merchantDataKind: merchantProductIdentityDataKind,
      merchantProductIdentityVersion
    },
    rawHash: product.rawHash
  };
}

async function requestProductPage(input: {
  pageUrl: string;
  accessToken: string;
  fetchImpl: MerchantCenterOAuthFetch;
  timeoutMs: number;
}): Promise<
  | { kind: "success"; httpStatus: number; payload: unknown }
  | { kind: "error"; } & ProductPageFailure
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  let response: Response;

  try {
    response = await input.fetchImpl(input.pageUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.accessToken}`
      },
      signal: controller.signal
    });
  } catch {
    return {
      kind: "error",
      status: "source_unavailable",
      errorCode: controller.signal.aborted
        ? "merchant_center_products_timeout"
        : "merchant_center_products_network_error",
      errorMessage: controller.signal.aborted
        ? "Merchant Center product request timed out."
        : "Merchant Center product source could not be reached."
    };
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    return {
      kind: "error",
      status: "authentication_failed",
      httpStatus: response.status,
      errorCode: "merchant_center_products_authentication_failed",
      errorMessage: "Merchant Center rejected the credentials."
    };
  }

  if (!response.ok) {
    return {
      kind: "error",
      status: "source_unavailable",
      httpStatus: response.status,
      errorCode: response.status === 429
        ? "merchant_center_products_rate_limited"
        : "merchant_center_products_http_error",
      errorMessage: "Merchant Center product source returned an unavailable response."
    };
  }

  try {
    return {
      kind: "success",
      httpStatus: response.status,
      payload: JSON.parse(await response.text())
    };
  } catch {
    return {
      kind: "error",
      status: "parse_failed",
      httpStatus: response.status,
      errorCode: "merchant_center_products_response_invalid",
      errorMessage: "Merchant Center returned invalid product data."
    };
  }
}

function readProducts(payload: unknown): unknown[] | null {
  if (!isRecord(payload)) return null;
  const products = payload.products;
  if (products === undefined) {
    return hasOnlyPaginationFields(payload) ? [] : null;
  }
  return Array.isArray(products) ? products : null;
}

function hasOnlyPaginationFields(value: Record<string, unknown>): boolean {
  return Object.keys(value).every(
    (key) => key === "nextPageToken" || key === "next_page_token"
  );
}

function readNextPageToken(payload: unknown): { token: string | null; malformed: boolean } {
  if (!isRecord(payload)) return { token: null, malformed: true };
  const value = payload.nextPageToken ?? payload.next_page_token;
  if (value === undefined || value === null || value === "") {
    return { token: null, malformed: false };
  }
  return typeof value === "string"
    ? { token: value, malformed: false }
    : { token: null, malformed: true };
}

function buildMerchantProductsEndpoint(accountId: string | null): string {
  return `${merchantProductsEndpoint}/${encodeURIComponent(accountId ?? "unconfigured")}/products`;
}

function buildPageUrl(endpoint: string, pageToken: string | undefined): string {
  const url = new URL(endpoint);
  url.searchParams.set("pageSize", String(productsPageSize));
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url.toString();
}

function buildResult(
  startedAt: Date,
  endpoint: string,
  input: {
    status: SourceCheckResult["status"];
    httpStatus?: number;
    itemsObserved?: number;
    totalItemsSeen?: number;
    skippedItems?: number;
    errorCode?: string;
    errorMessage?: string;
    errorSamples?: string[];
    items?: SourceItemInput[];
    metadata?: Record<string, unknown>;
  }
): SourceCheckResult {
  const finishedAt = new Date();
  return {
    source: "merchant_center",
    url: endpoint,
    status: input.status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    httpStatus: input.httpStatus,
    itemsObserved: input.itemsObserved ?? 0,
    totalItemsSeen: input.totalItemsSeen,
    skippedItems: input.skippedItems,
    items: input.items ?? [],
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    errorSamples: input.errorSamples,
    metadata: input.metadata
  };
}

function addConfigurationMetadata(
  accountId: string | null,
  result: SourceCheckResult
): SourceCheckResult {
  if (!accountId) return result;

  const configurationHash = merchantItemIssuesConfigurationHash(accountId);

  return {
    ...result,
    items: result.items.map((item) => ({
      ...item,
      metadata: {
        ...(item.metadata ?? {}),
        merchantItemIssuesConfigurationHash: configurationHash
      }
    })),
    metadata: {
      ...(isRecord(result.metadata) ? result.metadata : {}),
      merchantItemIssuesConfigurationHash: configurationHash
    }
  };
}

function normalizeLimits(input: MerchantCenterItemIssuesLimits | undefined): NormalizedLimits {
  return {
    maxPages: boundedInteger(input?.maxPages, defaultMaxPages, 1, hardMaxPages),
    maxProducts: boundedInteger(input?.maxProducts, defaultMaxProducts, 1, hardMaxProducts),
    maxIssuesPerProduct: boundedInteger(
      input?.maxIssuesPerProduct,
      defaultMaxIssuesPerProduct,
      1,
      hardMaxIssuesPerProduct
    ),
    maxPageTokenLength: boundedInteger(
      input?.maxPageTokenLength,
      defaultMaxPageTokenLength,
      1,
      hardMaxPageTokenLength
    ),
    maxStringLength: boundedInteger(
      input?.maxStringLength,
      defaultMaxStringLength,
      16,
      hardMaxStringLength
    )
  };
}

function normalizeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return defaultRequestTimeoutMs;
  return Math.max(1, Math.min(Math.floor(value!), maxRequestTimeoutMs));
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.floor(value!), max));
}

function normalizeToken(value: unknown, maxLength: number): string | undefined {
  const text = normalizeText(value, maxLength);
  if (!text) return undefined;
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
  return normalized || undefined;
}

function normalizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function normalizeHttpUrl(value: unknown, maxLength: number): string | undefined {
  const text = normalizeText(value, maxLength);
  if (!text || (!text.startsWith("http://") && !text.startsWith("https://"))) return undefined;
  try {
    const normalized = new URL(text).toString();
    return normalized.length <= maxLength ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCountries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((country): country is string => typeof country === "string")
      .map((country) => country.trim().toUpperCase())
      .filter((country) => /^[A-Z]{2}$/.test(country))
  )].slice(0, 50);
}

function readString(value: unknown, maxLength: number): string | undefined {
  return normalizeText(value, maxLength);
}

function readMerchantProductName(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;

  const name = value.trim();
  if (name.length === 0 || name.length > maxLength) return undefined;

  const segments = name.split("/");
  return segments.length === 4 &&
    segments[0] === "accounts" &&
    segments[1] &&
    segments[2] === "products" &&
    segments[3]
    ? name
    : undefined;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMinuteWindow(value: string): string {
  const date = new Date(value);
  date.setSeconds(0, 0);
  return date.toISOString();
}
