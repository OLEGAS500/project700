import { describe, expect, it } from "vitest";
import {
  createSnapshotInputSchema,
  createStoreInputSchema,
  emailDestinationInputSchema,
  incidentLikelySourceSchema,
  incidentTypeSchema,
  merchantCenterConnectionInputSchema,
  sourceCheckStatusSchema,
  telegramDestinationInputSchema,
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

  it("centralizes every incident likely-source value used by rules and demo flows", () => {
    expect(incidentLikelySourceSchema.options).toEqual([
      "feed",
      "sitemap",
      "category",
      "product_page",
      "merchant_center",
      "feed_or_publication",
      "feed_or_storefront_product_data",
      "site_template_or_deployment"
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
    expect(
      updateAlertPreferencesInputSchema.safeParse({
        mutedIncidentTypes: [...incidentTypeSchema.options]
      }).success
    ).toBe(true);
  });

  it("strictly validates Telegram destinations without accepting secrets", () => {
    expect(
      telegramDestinationInputSchema.parse({
        chatId: "-1001234567890",
        threadId: 42,
        displayName: "SEO Alerts",
        enabled: true
      })
    ).toEqual({
      chatId: "-1001234567890",
      threadId: 42,
      displayName: "SEO Alerts",
      enabled: true
    });
    expect(
      telegramDestinationInputSchema.safeParse({
        chatId: "-1001234567890",
        threadId: 0,
        displayName: null,
        enabled: true
      }).success
    ).toBe(false);
    expect(
      telegramDestinationInputSchema.safeParse({
        chatId: "-1001234567890",
        threadId: null,
        displayName: null,
        enabled: true,
        botToken: "must-not-be-accepted"
      }).success
    ).toBe(false);
  });

  it("normalizes and strictly validates email destinations without accepting provider secrets", () => {
    expect(
      emailDestinationInputSchema.parse({
        recipientEmails: [" Alerts@Example.com ", "ops@example.com"],
        enabled: true
      })
    ).toEqual({
      recipientEmails: ["alerts@example.com", "ops@example.com"],
      enabled: true
    });
    expect(
      emailDestinationInputSchema.safeParse({
        recipientEmails: ["alerts@example.com", "ALERTS@example.com"],
        enabled: true
      }).success
    ).toBe(false);
    expect(
      emailDestinationInputSchema.safeParse({
        recipientEmails: ["alerts@example.com"],
        enabled: true,
        providerApiKey: "must-not-be-accepted"
      }).success
    ).toBe(false);
  });

  it("validates Merchant Center account connections without accepting credentials", () => {
    expect(
      merchantCenterConnectionInputSchema.parse({ merchantCenterAccountId: " 123456789 " })
    ).toEqual({ merchantCenterAccountId: "123456789" });
    expect(
      merchantCenterConnectionInputSchema.safeParse({ merchantCenterAccountId: "merchant-id" })
        .success
    ).toBe(false);
    expect(
      merchantCenterConnectionInputSchema.safeParse({
        merchantCenterAccountId: "123456789",
        accessToken: "must-not-be-accepted"
      }).success
    ).toBe(false);
  });
});
