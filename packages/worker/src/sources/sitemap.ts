import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { SourceCheckResult, SourceItemInput } from "@eim/core";
import { normalizeUrlForKey } from "@eim/core";
import { XMLParser } from "fast-xml-parser";

export type SitemapCollectorInput = {
  url: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxSitemapIndexEntries?: number;
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

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  parseTagValue: false
});

export async function collectSitemap(
  input: SitemapCollectorInput
): Promise<SourceCheckResult> {
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const timeoutMs = input.timeoutMs ?? 10_000;
  const maxBytes = input.maxBytes ?? 5_000_000;
  const fetchImpl = input.fetchImpl ?? fetch;

  try {
    const primary = await fetchText(input.url, { timeoutMs, maxBytes, fetchImpl });

    if (!primary.ok) {
      return finish({
        source: "sitemap",
        url: input.url,
        status: primary.status,
        startedAt,
        httpStatus: primary.httpStatus,
        items: [],
        errorCode: primary.errorCode,
        errorMessage: primary.errorMessage
      });
    }

    const parsed = parseSitemapXml(primary.text);

    if (parsed.kind === "invalid") {
      return finish({
        source: "sitemap",
        url: input.url,
        status: "parse_failed",
        startedAt,
        httpStatus: primary.httpStatus,
        items: [],
        errorCode: "invalid_xml",
        errorMessage: parsed.error
      });
    }

    if (parsed.kind === "urlset") {
      const items = toSitemapItems(parsed.urls);

      return finish({
        source: "sitemap",
        url: input.url,
        status: "success",
        startedAt,
        httpStatus: primary.httpStatus,
        items
      });
    }

    const indexUrls = parsed.urls.slice(0, input.maxSitemapIndexEntries ?? 50);
    const collectedUrls: string[] = [];
    let partial = false;

    for (const sitemapUrl of indexUrls) {
      const child = await fetchText(sitemapUrl, { timeoutMs, maxBytes, fetchImpl });

      if (!child.ok) {
        partial = true;
        continue;
      }

      const childParsed = parseSitemapXml(child.text);

      if (childParsed.kind === "urlset") {
        collectedUrls.push(...childParsed.urls);
      } else {
        partial = true;
      }
    }

    return finish({
      source: "sitemap",
      url: input.url,
      status: partial ? "partial" : "success",
      startedAt,
      httpStatus: primary.httpStatus,
      items: toSitemapItems(collectedUrls),
      errorCode: partial ? "partial_sitemap_index" : undefined,
      errorMessage: partial
        ? "One or more sitemap index children could not be fetched or parsed"
        : undefined
    });
  } catch (error) {
    return finish({
      source: "sitemap",
      url: input.url,
      status: "source_unavailable",
      startedAt,
      items: [],
      errorCode: "collector_error",
      errorMessage: error instanceof Error ? error.message : "Unknown collector error"
    });
  }
}

async function fetchText(
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
    const response = await options.fetchImpl(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "EcommerceIncidentMonitor/0.1 (+https://example.com)"
      }
    });

    const httpStatus = response.status;

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

    const bytes = new Uint8Array(await response.arrayBuffer());

    if (bytes.byteLength > options.maxBytes) {
      return {
        ok: false,
        status: "source_unavailable",
        httpStatus,
        errorCode: "response_too_large",
        errorMessage: `Sitemap response exceeded ${options.maxBytes} bytes`
      };
    }

    const decoded = url.endsWith(".gz") ? gunzipSync(bytes) : bytes;

    return {
      ok: true,
      text: new TextDecoder().decode(decoded),
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

function parseSitemapXml(
  xml: string
):
  | { kind: "urlset"; urls: string[] }
  | { kind: "sitemapindex"; urls: string[] }
  | { kind: "invalid"; error: string } {
  try {
    const parsed = parser.parse(xml);

    if (Object.hasOwn(parsed ?? {}, "urlset")) {
      const urlset = asRecord(parsed.urlset);
      return {
        kind: "urlset",
        urls: arrayify(urlset?.url)
          .map(getLoc)
          .filter(isString)
      };
    }

    if (Object.hasOwn(parsed ?? {}, "sitemapindex")) {
      const sitemapindex = asRecord(parsed.sitemapindex);
      return {
        kind: "sitemapindex",
        urls: arrayify(sitemapindex?.sitemap)
          .map(getLoc)
          .filter(isString)
      };
    }

    return {
      kind: "invalid",
      error: "XML does not contain urlset or sitemapindex"
    };
  } catch (error) {
    return {
      kind: "invalid",
      error: error instanceof Error ? error.message : "Invalid XML"
    };
  }
}

function toSitemapItems(urls: string[]): SourceItemInput[] {
  const uniqueUrls = [...new Set(urls.map((url) => normalizeUrlForKey(url)))];

  return uniqueUrls.map((url) => ({
    source: "sitemap",
    stableKey: `url:${url}`,
    url,
    rawHash: createHash("sha256").update(url).digest("hex")
  }));
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

function arrayify<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function getLoc(value: unknown): unknown {
  return asRecord(value)?.loc;
}
