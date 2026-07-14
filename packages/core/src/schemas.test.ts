import { describe, expect, it } from "vitest";
import {
  createSnapshotInputSchema,
  createStoreInputSchema,
  sourceCheckStatusSchema,
  updateAlertPreferencesInputSchema,
  updateStoreThresholdsInputSchema
} from "./schemas";

describe("core schemas", () => {
  it("accepts a valid store onboarding payload", () => {
    const parsed = createStoreInputSchema.parse({
      name: "Example Store",
      domain: "https://example.com",
      sitemapUrl: "https://example.com/sitemap.xml",
      feedUrl: "https://example.com/google-feed.xml",
      categoryUrls: [
        "https://example.com/collections/shoes",
        "https://example.com/collections/bags"
      ]
    });

    expect(parsed.categoryUrls).toHaveLength(2);
  });

  it("rejects stores without critical categories", () => {
    const parsed = createStoreInputSchema.safeParse({
      name: "Example Store",
      domain: "https://example.com",
      sitemapUrl: "https://example.com/sitemap.xml",
      feedUrl: "https://example.com/google-feed.xml",
      categoryUrls: []
    });

    expect(parsed.success).toBe(false);
  });

  it("keeps monitor failure states distinct from business metrics", () => {
    expect(sourceCheckStatusSchema.options).toEqual([
      "success",
      "partial",
      "timeout",
      "blocked",
      "authentication_failed",
      "parse_failed",
      "source_unavailable"
    ]);
  });

  it("supports baseline candidate snapshots", () => {
    const parsed = createSnapshotInputSchema.parse({
      storeId: "0f53ad25-9008-41df-9e6e-c4a0bb69d95d",
      baselineRole: "candidate"
    });

    expect(parsed.baselineRole).toBe("candidate");
  });

  it("rejects invalid and unknown store threshold fields", () => {
    expect(
      updateStoreThresholdsInputSchema.safeParse({
        catalogDropPercentage: 1.1
      }).success
    ).toBe(false);
    expect(
      updateStoreThresholdsInputSchema.safeParse({
        unknownThreshold: 1
      }).success
    ).toBe(false);
    expect(
      updateStoreThresholdsInputSchema.safeParse({
        priceMismatchTolerance: { absolute: -1, relative: 0.001 }
      }).success
    ).toBe(false);
  });

  it("strictly validates alert preference updates", () => {
    expect(
      updateAlertPreferencesInputSchema.parse({
        telegramEnabled: true,
        mutedIncidentTypes: ["source_health"],
        worseningAffectedCountPercent: 0.25
      })
    ).toMatchObject({ telegramEnabled: true, mutedIncidentTypes: ["source_health"] });
    expect(
      updateAlertPreferencesInputSchema.safeParse({ worseningAffectedCountPercent: 1.1 }).success
    ).toBe(false);
    expect(updateAlertPreferencesInputSchema.safeParse({ smsEnabled: true }).success).toBe(false);
  });
});
