import { assertPublicHttpUrl } from "../url-safety";

export type ProductPageFetchResult =
  | {
      ok: true;
      originalUrl: string;
      finalUrl: string;
      httpStatus: number;
      html: string;
      headers: Headers;
      redirected: boolean;
    }
  | {
      ok: false;
      originalUrl: string;
      finalUrl?: string;
      httpStatus?: number;
      status: "timeout" | "blocked" | "source_unavailable";
      errorCode: string;
      errorMessage: string;
      headers?: Headers;
    };

export async function fetchProductPage(
  url: string,
  options: {
    timeoutMs: number;
    maxBytes: number;
    fetchImpl: typeof fetch;
  }
): Promise<ProductPageFetchResult> {
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

    if (response.url) {
      assertPublicHttpUrl(response.url);
    }

    const httpStatus = response.status;

    if (httpStatus === 403 || httpStatus === 429) {
      return {
        ok: false,
        originalUrl: url,
        finalUrl: response.url || url,
        httpStatus,
        status: "blocked",
        errorCode: "blocked",
        errorMessage: `Source returned HTTP ${httpStatus}`,
        headers: response.headers
      };
    }

    if (httpStatus >= 500) {
      return {
        ok: false,
        originalUrl: url,
        finalUrl: response.url || url,
        httpStatus,
        status: "source_unavailable",
        errorCode: "upstream_5xx",
        errorMessage: `Source returned HTTP ${httpStatus}`,
        headers: response.headers
      };
    }

    const html = await response.text();

    if (new TextEncoder().encode(html).byteLength > options.maxBytes) {
      return {
        ok: false,
        originalUrl: url,
        finalUrl: response.url || url,
        httpStatus,
        status: "source_unavailable",
        errorCode: "response_too_large",
        errorMessage: `Product page response exceeded ${options.maxBytes} bytes`,
        headers: response.headers
      };
    }

    return {
      ok: true,
      originalUrl: url,
      finalUrl: response.url || url,
      httpStatus,
      html,
      headers: response.headers,
      redirected: response.redirected || (response.url ? response.url !== url : false)
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        originalUrl: url,
        status: "timeout",
        errorCode: "timeout",
        errorMessage: `Source timed out after ${options.timeoutMs}ms`
      };
    }

    return {
      ok: false,
      originalUrl: url,
      status: "source_unavailable",
      errorCode: "network_error",
      errorMessage: error instanceof Error ? error.message : "Network error"
    };
  } finally {
    clearTimeout(timeout);
  }
}
