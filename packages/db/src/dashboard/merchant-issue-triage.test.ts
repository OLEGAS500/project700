import { describe, expect, it } from "vitest";
import { buildMerchantIssueSummary } from "./merchant-issue-triage";

describe("merchant issue triage", () => {
  it("groups codes and prioritizes critical products", () => {
    const summary = buildMerchantIssueSummary([
      {
        stableKey: "offer:critical",
        offerId: "critical",
        title: "Critical product",
        issues: [
          { code: "invalid_gtin", severity: "error", attribute: "gtin" },
          { code: "invalid_gtin", severity: "error", attribute: "gtin" },
          { code: "missing_brand", severity: "warning", attribute: "brand" }
        ]
      },
      {
        stableKey: "offer:warning",
        offerId: "warning",
        title: "Warning product",
        issues: [{ code: "missing_brand", severity: "warning", attribute: "brand" }]
      }
    ]);

    expect(summary).toEqual({
      totalProducts: 2,
      totalIssues: 3,
      truncated: false,
      issueGroups: [
        {
          code: "invalid_gtin",
          issueCount: 1,
          productCount: 1,
          priority: "critical",
          severities: ["error"],
          attributes: ["gtin"]
        },
        {
          code: "missing_brand",
          issueCount: 2,
          productCount: 2,
          priority: "high",
          severities: ["warning"],
          attributes: ["brand"]
        }
      ],
      prioritizedProducts: [
        {
          stableKey: "offer:critical",
          offerId: "critical",
          title: "Critical product",
          priority: "critical",
          issueCount: 2,
          issueCodes: ["invalid_gtin", "missing_brand"],
          affectedAttributes: ["brand", "gtin"]
        },
        {
          stableKey: "offer:warning",
          offerId: "warning",
          title: "Warning product",
          priority: "high",
          issueCount: 1,
          issueCodes: ["missing_brand"],
          affectedAttributes: ["brand"]
        }
      ]
    });
  });

  it("deduplicates malformed issues and bounds the triage list", () => {
    const summary = buildMerchantIssueSummary(
      Array.from({ length: 51 }, (_, index) => ({
        stableKey: `offer:${index}`,
        offerId: `sku-${index}`,
        title: "Product",
        issues: [
          { code: "issue_code", severity: "warning", attribute: "price" },
          { code: "issue_code", severity: "warning", attribute: "price" },
          { message: "must be ignored" }
        ]
      })),
      true
    );

    expect(summary.totalProducts).toBe(51);
    expect(summary.totalIssues).toBe(51);
    expect(summary.prioritizedProducts).toHaveLength(50);
    expect(summary.issueGroups).toEqual([
      expect.objectContaining({ code: "issue_code", issueCount: 51, productCount: 51 })
    ]);
    expect(summary.truncated).toBe(true);
  });
});
