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
      productsTruncated: false,
      issuesTruncated: false,
      groupsTruncated: false,
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

  it("bounds nested issues and grouped output from adversarial rows", () => {
    const summary = buildMerchantIssueSummary(
      Array.from({ length: 501 }, (_, productIndex) => ({
        stableKey: `offer:${productIndex}`,
        offerId: `sku-${productIndex}`,
        title: `Product ${productIndex}`,
        issues:
          productIndex === 0
            ? [
                ...Array.from({ length: 1_000 }, (_, issueIndex) => ({
                  code: issueIndex % 2 === 0 ? `critical_${issueIndex}` : `attribute_${issueIndex}`,
                  severity: issueIndex === 0 ? "critical" : "warning",
                  attribute: `attribute_${issueIndex}`
                })),
                ...Array.from({ length: 1_000 }, () => ({ malformed: true }))
              ]
            : [
                { code: `code_${productIndex}`, severity: "warning", attribute: `attribute_${productIndex}` },
                { malformed: true }
              ]
      }))
    );

    expect(summary.truncated).toBe(true);
    expect(summary.productsTruncated).toBe(true);
    expect(summary.issuesTruncated).toBe(true);
    expect(summary.groupsTruncated).toBe(true);
    expect(summary.prioritizedProducts).toHaveLength(50);
    expect(summary.prioritizedProducts[0]).toMatchObject({
      stableKey: "offer:0",
      priority: "critical"
    });
    expect(summary.issueGroups.length).toBeLessThanOrEqual(100);
    expect(summary.issueGroups.every((group) => group.severities.length <= 8)).toBe(true);
    expect(summary.issueGroups.every((group) => group.attributes.length <= 16)).toBe(true);
    expect(summary.prioritizedProducts.every((product) => product.issueCodes.length <= 16)).toBe(true);
    expect(summary.prioritizedProducts.every((product) => product.affectedAttributes.length <= 16)).toBe(true);
    expect(summary.totalIssues).toBeLessThanOrEqual(50_000);
  });
});
