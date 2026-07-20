export const stagingTestCatalogProduct = {
  availability: "out_of_stock",
  brand: "EIM",
  condition: "new",
  currency: "USD",
  description:
    "A catalog-only test item used to check the Ecommerce Incident Monitor Merchant Center integration. It has no real inventory, fulfilment, payment, or purchase flow.",
  offerId: "EIM-STAGING-TEST-001",
  price: "1.00",
  title: "EIM Catalog Monitor Test Item"
} as const;

export function stagingTestCatalogUrls(request: Request) {
  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const origin = forwardedHost
    ? `${forwardedProtocol === "http" ? "http" : "https"}://${forwardedHost}`
    : requestUrl.origin;
  const productPage = new URL("/test-products/eim-catalog-monitor", origin).toString();

  return {
    image: new URL("/test-products/eim-catalog-monitor/opengraph-image", origin).toString(),
    productPage,
    storefront: origin
  };
}

export function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, (character) => {
    switch (character) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return character;
    }
  });
}
