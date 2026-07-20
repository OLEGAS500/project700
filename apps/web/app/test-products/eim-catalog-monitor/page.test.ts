import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EimCatalogMonitorTestItemPage, { metadata } from "./page";

describe("EIM Catalog Monitor test item", () => {
  it("publishes matching test-only catalog details for Merchant Center", () => {
    const html = renderToStaticMarkup(createElement(EimCatalogMonitorTestItemPage));

    expect(html).toContain("EIM Catalog Monitor Test Item");
    expect(html).toContain("$1.00 USD");
    expect(html).toContain("Out of stock — not for purchase");
    expect(html).toContain("EIM-STAGING-TEST-001");
    expect(html).toContain("no real inventory, fulfilment, payment, or purchase flow");
    expect(html).toContain('src="/test-products/eim-catalog-monitor/opengraph-image"');
  });

  it("labels the page as a Merchant Center integration test item", () => {
    expect(metadata).toMatchObject({
      title: "EIM Catalog Monitor Test Item | Ecommerce Incident Monitor"
    });
  });
});
