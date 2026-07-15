import { describe, expect, it } from "vitest";
import { buildMerchantItemIssuesEvaluation, merchantItemIssuesFingerprint } from "./merchant-item-issues";

describe("merchant item issue incident evaluation", () => {
  it("groups normalized issues and escalates when a product has a critical issue", () => {
    const evaluation = buildMerchantItemIssuesEvaluation([
      {
        stableKey: "offer:sku-1",
        offerId: "sku-1",
        title: "Red shoes",
        issues: [
          {
            code: "invalid_gtin",
            severity: "error",
            attribute: "gtin",
            reportingContext: "shopping_ads"
          },
          {
            code: "missing_brand",
            severity: "warning",
            attribute: "brand",
            reportingContext: "shopping_ads"
          }
        ]
      },
      {
        stableKey: "offer:sku-2",
        offerId: "sku-2",
        title: "Blue bag",
        issues: [
          {
            code: "missing_price",
            severity: "warning",
            attribute: "price",
            reportingContext: "shopping_ads"
          }
        ]
      }
    ]);

    expect(evaluation).toMatchObject({
      severity: "critical",
      affectedProducts: 2,
      issueCount: 3,
      criticalProducts: 1,
      warningProducts: 1,
      issueCodes: [
        { code: "invalid_gtin", count: 1 },
        { code: "missing_brand", count: 1 },
        { code: "missing_price", count: 1 }
      ]
    });
    expect(evaluation.sampleItems).toHaveLength(3);
    expect(evaluation.summary).toContain("2 products");
  });

  it("does not create evidence for products without issues", () => {
    const evaluation = buildMerchantItemIssuesEvaluation([
      {
        stableKey: "offer:healthy",
        offerId: "healthy",
        title: "Healthy product",
        issues: []
      }
    ]);

    expect(evaluation).toMatchObject({
      severity: "warning",
      affectedProducts: 0,
      issueCount: 0,
      criticalProducts: 0,
      warningProducts: 0,
      sampleItems: []
    });
  });

  it("uses a stable configuration-scoped debounce fingerprint", () => {
    expect(merchantItemIssuesFingerprint("store-1", "config-a")).toBe(
      merchantItemIssuesFingerprint("store-1", "config-a")
    );
    expect(merchantItemIssuesFingerprint("store-1", "config-a")).not.toBe(
      merchantItemIssuesFingerprint("store-1", "config-b")
    );
  });
});
