import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReturnPolicyPage, { metadata } from "./page";

describe("staging return policy", () => {
  it("publishes a static policy for Merchant Center without real-store claims", () => {
    const html = renderToStaticMarkup(createElement(ReturnPolicyPage));

    expect(html).toContain("Staging test storefront");
    expect(html).toContain("No real products, payments, or customer orders are offered");
    expect(html).toContain("Return window");
    expect(html).toContain("Return cost and refund");
    expect(html).toContain("How to request a test return");
    expect(html).toContain('href="/"');
  });

  it("identifies the page as the staging storefront return policy", () => {
    expect(metadata).toMatchObject({
      title: "Return policy | Ecommerce Incident Monitor"
    });
  });
});
