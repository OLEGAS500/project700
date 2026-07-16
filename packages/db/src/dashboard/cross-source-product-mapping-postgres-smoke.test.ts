import type { SourceCheckResult, SourceItemInput } from "@eim/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { merchantItemIssuesConfigurationHash } from "../incidents/merchant-item-issues";

const { Client } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase =
  testDatabaseUrl && process.env.RUN_POSTGRES_TESTS === "1" ? describe : describe.skip;
const schemaName = `eim_cross_source_${Date.now()}_${Math.random().toString(16).slice(2)}`;

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

function feedItem(
  stableKey: string,
  offerId: string | undefined,
  title = `Feed ${stableKey}`
): SourceItemInput {
  return {
    source: "feed",
    stableKey,
    offerId,
    title,
    url: `https://cross-source.example.test/products/${encodeURIComponent(stableKey)}`,
    rawHash: `feed:${stableKey}:${offerId ?? "none"}`
  };
}

function merchantItem(
  stableKey: string,
  offerId: string | undefined,
  title = `Merchant ${stableKey}`,
  hasIssue = true
): SourceItemInput {
  return {
    source: "merchant_center",
    stableKey,
    offerId,
    title,
    merchantStatus: hasIssue ? "disapproved" : "approved",
    ...(hasIssue
      ? {
          merchantIssues: [
            {
              code: "invalid_gtin",
              severity: "error",
              attribute: "gtin"
            }
          ]
        }
      : {}),
    metadata: {
      merchantDataKind: "item_issues",
      productName: `accounts/123/products/${stableKey}`
    },
    rawHash: `merchant:${stableKey}:${offerId ?? "none"}`
  };
}

function feedResult(items: SourceItemInput[], status: SourceCheckResult["status"] = "success"):
  SourceCheckResult {
  return {
    source: "feed",
    url: "https://cross-source.example.test/feed.xml",
    status,
    startedAt: "2026-07-15T12:00:00.000Z",
    finishedAt: "2026-07-15T12:00:01.000Z",
    durationMs: 1_000,
    itemsObserved: items.length,
    totalItemsSeen: items.length,
    skippedItems: status === "success" ? 0 : 1,
    items,
    errorCode: status === "success" ? undefined : "feed_partial",
    errorMessage: status === "success" ? undefined : "Feed snapshot was partial."
  };
}

function merchantResult(
  items: SourceItemInput[],
  status: SourceCheckResult["status"] = "success",
  accountId = "123"
): SourceCheckResult {
  return {
    source: "merchant_center",
    url: `https://merchantapi.googleapis.com/products/v1/accounts/${accountId}/products`,
    status,
    startedAt: "2026-07-15T12:00:00.000Z",
    finishedAt: "2026-07-15T12:00:01.000Z",
    durationMs: 1_000,
    itemsObserved: items.filter((item) => item.merchantIssues?.length).length,
    totalItemsSeen: items.length,
    skippedItems: status === "success" ? 0 : 1,
    items,
    errorCode: status === "success" ? undefined : "merchant_center_partial",
    errorMessage: status === "success" ? undefined : "Merchant snapshot was partial.",
    metadata: {
      merchantItemIssuesVersion: "v1",
      merchantProductIdentityVersion: "v1",
      merchantProductIdentityComplete: status === "success",
      merchantItemIssuesConfigurationHash: merchantConfigurationHash(accountId),
      merchantDataKind: "product_identity"
    }
  };
}

function merchantConfigurationHash(accountId: string): string {
  return merchantItemIssuesConfigurationHash(accountId);
}

function merchantProviderProduct(input: {
  name: string;
  offerId: string;
  title: string;
  issueCode?: string;
}): Record<string, unknown> {
  return {
    name: input.name,
    offerId: input.offerId,
    productAttributes: { title: input.title },
    productStatus: {
      destinationStatuses: [{ approvedCountries: ["US"] }],
      itemLevelIssues: input.issueCode
        ? [
            {
              code: input.issueCode,
              severity: "DISAPPROVED",
              resolution: "MERCHANT_ACTION",
              attribute: "gtins",
              reportingContext: "SHOPPING_ADS",
              applicableCountries: ["US"]
            }
          ]
        : []
    }
  };
}

function merchantCollectorDependencies() {
  return {
    getTokenSet: async () => ({
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      tokenType: "Bearer",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      scopes: ["https://www.googleapis.com/auth/content"],
      metadata: {}
    })
  };
}

describeIfDatabase("cross-source product mapping", () => {
  const admin = new Client({ connectionString: testDatabaseUrl });
  let dbUrlWithSchema: string;
  const previousDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    dbUrlWithSchema = withSearchPath(testDatabaseUrl!, schemaName);
    process.env.DATABASE_URL = dbUrlWithSchema;

    const migrator = new Client({ connectionString: dbUrlWithSchema });
    await migrator.connect();
    const { applyMigrations } = await import("../migrations");
    await applyMigrations(migrator);
    await migrator.end();
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin.end();
  });

  it("matches immutable snapshots, classifies collisions, bounds samples, and rejects partial or cross-store pairs", async () => {
    const {
      connectMerchantCenter,
      createQueuedSnapshot,
      createStore,
      getCrossSourceProductMatchSummary,
      persistFeedCheckResult,
      persistMerchantCenterItemIssuesResult
    } = await import("@eim/db");

    const created = await createStore({
      name: "Cross-source mapping store",
      domain: "https://cross-source.example.test",
      sitemapUrl: "https://cross-source.example.test/sitemap.xml",
      feedUrl: "https://cross-source.example.test/feed.xml",
      categoryUrls: ["https://cross-source.example.test/category"]
    });
    await connectMerchantCenter(created.store.id, { merchantCenterAccountId: "123" });

    const feedSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-feed"
    );
    const merchantSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-merchant"
    );

    const feedItems = [
      feedItem("offer:sku-1", " SKU-1 "),
      feedItem("hash:unicode-😀", undefined, "Unicode feed product"),
      feedItem("offer:feed-only", "feed-only"),
      feedItem("offer:dup-a", " DUP "),
      feedItem("offer:dup-b", "dup")
    ];
    const merchantItems = [
      merchantItem("offer:sku-1", "sku-1"),
      merchantItem("hash:unicode-😀", undefined, "Unicode Merchant product"),
      merchantItem("offer:merchant-only", "merchant-only"),
      merchantItem("offer:merchant-dup-a", "dup"),
      merchantItem("offer:merchant-dup-b", " DUP ")
    ];
    for (let index = 0; index < 60; index += 1) {
      feedItems.push(feedItem(`offer:bounded-${index}`, `bounded-${index}`));
      merchantItems.push(merchantItem(`offer:bounded-${index}`, `bounded-${index}`));
    }

    await persistFeedCheckResult(feedSnapshot.id, created.store.id, feedResult(feedItems));
    await persistMerchantCenterItemIssuesResult(
      merchantSnapshot.id,
      created.store.id,
      merchantResult(merchantItems)
    );

    const summary = await getCrossSourceProductMatchSummary({
      feedSnapshotId: feedSnapshot.id,
      merchantSnapshotId: merchantSnapshot.id
    });

    expect(summary).toMatchObject({
      storeId: created.store.id,
      comparable: true,
      feedCheckStatus: "success",
      merchantCheckStatus: "success",
      matchedCount: 62,
      feedOnlyCount: 1,
      merchantOnlyCount: 1,
      ambiguousCount: 1,
      countsTruncated: false,
      samplesTruncated: true,
      truncated: true
    });
    expect(summary?.samples.matched.length).toBeLessThanOrEqual(50);
    expect(summary?.samples.feedOnly).toEqual([
      expect.objectContaining({ identityKey: "offer:feed-only" })
    ]);
    expect(summary?.samples.merchantOnly).toEqual([
      expect.objectContaining({ identityKey: "offer:merchant-only" })
    ]);
    expect(summary?.samples.ambiguous).toEqual([
      expect.objectContaining({ identityKey: "offer:dup", feedCount: 2, merchantCount: 2 })
    ]);

    const laterFeedSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-feed-later"
    );
    const laterMerchantSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-merchant-later"
    );
    await persistFeedCheckResult(
      laterFeedSnapshot.id,
      created.store.id,
      feedResult([feedItem("offer:later-only", "later-only")])
    );
    await persistMerchantCenterItemIssuesResult(
      laterMerchantSnapshot.id,
      created.store.id,
      merchantResult([merchantItem("offer:later-only", "later-only")])
    );

    await expect(
      getCrossSourceProductMatchSummary({
        feedSnapshotId: feedSnapshot.id,
        merchantSnapshotId: merchantSnapshot.id
      })
    ).resolves.toMatchObject({ matchedCount: 62, feedOnlyCount: 1, merchantOnlyCount: 1 });

    const partialMerchantSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-merchant-partial"
    );
    await persistMerchantCenterItemIssuesResult(
      partialMerchantSnapshot.id,
      created.store.id,
      merchantResult([merchantItem("offer:partial", "partial")], "partial")
    );
    await expect(
      getCrossSourceProductMatchSummary({
        feedSnapshotId: feedSnapshot.id,
        merchantSnapshotId: partialMerchantSnapshot.id
      })
    ).resolves.toMatchObject({
      comparable: false,
      incompatibilityReason: "source_check_incomplete",
      matchedCount: 0,
      feedOnlyCount: 0,
      merchantOnlyCount: 0,
      ambiguousCount: 0
    });

    const legacyIssueOnlySnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-merchant-legacy-issue-only"
    );
    const legacyIssueOnlyResult = merchantResult([
      merchantItem("offer:legacy-issue-only", "legacy-issue-only")
    ]);
    const legacyMetadata = { ...(legacyIssueOnlyResult.metadata ?? {}) };
    delete legacyMetadata.merchantProductIdentityVersion;
    delete legacyMetadata.merchantProductIdentityComplete;
    await persistMerchantCenterItemIssuesResult(
      legacyIssueOnlySnapshot.id,
      created.store.id,
      { ...legacyIssueOnlyResult, metadata: legacyMetadata }
    );
    await expect(
      getCrossSourceProductMatchSummary({
        feedSnapshotId: feedSnapshot.id,
        merchantSnapshotId: legacyIssueOnlySnapshot.id
      })
    ).resolves.toMatchObject({
      comparable: false,
      incompatibilityReason: "merchant_identity_inventory_missing"
    });

    const configurationSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-merchant-old-account"
    );
    await persistMerchantCenterItemIssuesResult(
      configurationSnapshot.id,
      created.store.id,
      merchantResult([merchantItem("offer:old-account", "old-account")], "success", "123")
    );
    await connectMerchantCenter(created.store.id, { merchantCenterAccountId: "456" });
    await expect(
      getCrossSourceProductMatchSummary({
        feedSnapshotId: feedSnapshot.id,
        merchantSnapshotId: configurationSnapshot.id
      })
    ).resolves.toMatchObject({
      comparable: false,
      incompatibilityReason: "merchant_configuration_mismatch"
    });
    await connectMerchantCenter(created.store.id, { merchantCenterAccountId: "123" });

    const isolated = await createStore({
      name: "Other store",
      domain: "https://cross-source-other.example.test",
      sitemapUrl: "https://cross-source-other.example.test/sitemap.xml",
      feedUrl: "https://cross-source-other.example.test/feed.xml",
      categoryUrls: ["https://cross-source-other.example.test/category"]
    });
    await connectMerchantCenter(isolated.store.id, { merchantCenterAccountId: "123" });
    const isolatedMerchantSnapshot = await createQueuedSnapshot(
      isolated.store.id,
      "normal_check",
      "cross-source-isolated-merchant"
    );
    await persistMerchantCenterItemIssuesResult(
      isolatedMerchantSnapshot.id,
      isolated.store.id,
      merchantResult([merchantItem("offer:isolated", "isolated")])
    );

    await expect(
      getCrossSourceProductMatchSummary({
        feedSnapshotId: feedSnapshot.id,
        merchantSnapshotId: isolatedMerchantSnapshot.id
      })
    ).resolves.toBeNull();

    expect(merchantItemIssuesConfigurationHash("123")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps the full Merchant inventory even when only a small subset has issues", async () => {
    const {
      connectMerchantCenter,
      createQueuedSnapshot,
      createStore,
      getCrossSourceProductMatchSummary,
      persistFeedCheckResult,
      persistMerchantCenterItemIssuesResult
    } = await import("@eim/db");

    const created = await createStore({
      name: "Cross-source full inventory store",
      domain: "https://cross-source-inventory.example.test",
      sitemapUrl: "https://cross-source-inventory.example.test/sitemap.xml",
      feedUrl: "https://cross-source-inventory.example.test/feed.xml",
      categoryUrls: ["https://cross-source-inventory.example.test/category"]
    });
    await connectMerchantCenter(created.store.id, { merchantCenterAccountId: "123" });

    const productIndexes = Array.from({ length: 100 }, (_, index) => index + 1);
    const feedItems = productIndexes.map((index) =>
      feedItem(`offer:inventory-${index}`, `inventory-${index}`)
    );
    const merchantItems = productIndexes.map((index) =>
      merchantItem(`offer:inventory-${index}`, `inventory-${index}`, undefined, index <= 2)
    );
    const feedSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-inventory-feed"
    );
    const merchantSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-inventory-merchant"
    );

    await persistFeedCheckResult(feedSnapshot.id, created.store.id, feedResult(feedItems));
    await persistMerchantCenterItemIssuesResult(
      merchantSnapshot.id,
      created.store.id,
      merchantResult(merchantItems)
    );

    await expect(
      getCrossSourceProductMatchSummary({
        feedSnapshotId: feedSnapshot.id,
        merchantSnapshotId: merchantSnapshot.id
      })
    ).resolves.toMatchObject({
      comparable: true,
      matchedCount: 100,
      feedOnlyCount: 0,
      merchantOnlyCount: 0,
      ambiguousCount: 0
    });

    const inspector = new Client({ connectionString: dbUrlWithSchema });
    await inspector.connect();
    const persisted = await inspector.query<{ identity_count: string; issue_count: string }>(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE metadata_json ->> 'merchantDataKind' = 'product_identity'
          )::text AS identity_count,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(merchant_issues_json) = 'array'
              AND jsonb_array_length(merchant_issues_json) > 0
          )::text AS issue_count
        FROM source_items
        WHERE snapshot_id = $1 AND source = 'merchant_center'
      `,
      [merchantSnapshot.id]
    );
    await inspector.end();
    expect(persisted.rows[0]).toEqual({ identity_count: "100", issue_count: "2" });

    const healthyFeedSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-inventory-feed-healthy"
    );
    const healthyMerchantSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-inventory-merchant-healthy"
    );
    await persistFeedCheckResult(
      healthyFeedSnapshot.id,
      created.store.id,
      feedResult(feedItems)
    );
    await persistMerchantCenterItemIssuesResult(
      healthyMerchantSnapshot.id,
      created.store.id,
      merchantResult(
        productIndexes.map((index) =>
          merchantItem(`offer:inventory-${index}`, `inventory-${index}`, undefined, false)
        )
      )
    );

    await expect(
      getCrossSourceProductMatchSummary({
        feedSnapshotId: healthyFeedSnapshot.id,
        merchantSnapshotId: healthyMerchantSnapshot.id
      })
    ).resolves.toMatchObject({
      comparable: true,
      matchedCount: 100,
      feedOnlyCount: 0,
      merchantOnlyCount: 0,
      ambiguousCount: 0
    });

    const healthyInspector = new Client({ connectionString: dbUrlWithSchema });
    await healthyInspector.connect();
    const healthyPersisted = await healthyInspector.query<{ identity_count: string; issue_count: string }>(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE metadata_json ->> 'merchantDataKind' = 'product_identity'
          )::text AS identity_count,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(merchant_issues_json) = 'array'
              AND jsonb_array_length(merchant_issues_json) > 0
          )::text AS issue_count
        FROM source_items
        WHERE snapshot_id = $1 AND source = 'merchant_center'
      `,
      [healthyMerchantSnapshot.id]
    );
    await healthyInspector.end();
    expect(healthyPersisted.rows[0]).toEqual({ identity_count: "100", issue_count: "0" });
  });

  it("uses unique offer IDs first and falls back to an unambiguous stable key", async () => {
    const {
      connectMerchantCenter,
      createQueuedSnapshot,
      createStore,
      getCrossSourceProductMatchSummary,
      persistFeedCheckResult,
      persistMerchantCenterItemIssuesResult
    } = await import("@eim/db");

    const created = await createStore({
      name: "Cross-source fallback store",
      domain: "https://cross-source-fallback.example.test",
      sitemapUrl: "https://cross-source-fallback.example.test/sitemap.xml",
      feedUrl: "https://cross-source-fallback.example.test/feed.xml",
      categoryUrls: ["https://cross-source-fallback.example.test/category"]
    });
    await connectMerchantCenter(created.store.id, { merchantCenterAccountId: "123" });

    const feedSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-fallback-feed"
    );
    const merchantSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-fallback-merchant"
    );
    await persistFeedCheckResult(
      feedSnapshot.id,
      created.store.id,
      feedResult([
        feedItem("offer:fallback-feed-offer", "feed-offer"),
        feedItem("offer:fallback-merchant-offer", undefined),
        feedItem("offer:offer-disagreement", "feed-offer-id"),
        feedItem(" Stable Fallback Duplicate ", undefined),
        feedItem("stable fallback duplicate", undefined),
        feedItem("stable merchant duplicate", undefined)
      ])
    );
    await persistMerchantCenterItemIssuesResult(
      merchantSnapshot.id,
      created.store.id,
      merchantResult([
        merchantItem("offer:fallback-feed-offer", undefined, undefined, false),
        merchantItem("offer:fallback-merchant-offer", "merchant-offer", undefined, false),
        merchantItem("offer:offer-disagreement", "merchant-offer-id", undefined, false),
        merchantItem("stable fallback duplicate", undefined, undefined, false),
        merchantItem(" Stable Merchant Duplicate ", undefined, undefined, false),
        merchantItem("stable merchant duplicate", undefined, undefined, false)
      ])
    );

    const summary = await getCrossSourceProductMatchSummary({
      feedSnapshotId: feedSnapshot.id,
      merchantSnapshotId: merchantSnapshot.id
    });

    expect(summary).toMatchObject({
      comparable: true,
      matchedCount: 2,
      feedOnlyCount: 1,
      merchantOnlyCount: 1,
      ambiguousCount: 2
    });
    expect(summary?.samples.matched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identityKey: "stable:offer:fallback-feed-offer" }),
        expect.objectContaining({ identityKey: "stable:offer:fallback-merchant-offer" })
      ])
    );
    expect(summary?.samples.feedOnly).toEqual([
      expect.objectContaining({ identityKey: "offer:feed-offer-id" })
    ]);
    expect(summary?.samples.merchantOnly).toEqual([
      expect.objectContaining({ identityKey: "offer:merchant-offer-id" })
    ]);
    expect(summary?.samples.ambiguous).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identityKey: "stable:stable fallback duplicate", feedCount: 2 }),
        expect.objectContaining({ identityKey: "stable:stable merchant duplicate", merchantCount: 2 })
      ])
    );
  });

  it("preserves Merchant resource multiplicity through collection, persistence, and mapping", async () => {
    const {
      connectMerchantCenter,
      createQueuedSnapshot,
      createStore,
      getCrossSourceProductMatchSummary,
      persistFeedCheckResult,
      persistMerchantCenterItemIssuesResult
    } = await import("@eim/db");
    const { collectFeed, collectMerchantCenterItemIssues } = await import("@eim/worker");

    const created = await createStore({
      name: "Cross-source resource multiplicity store",
      domain: "https://cross-source-resource-identity.example.test",
      sitemapUrl: "https://cross-source-resource-identity.example.test/sitemap.xml",
      feedUrl: "https://cross-source-resource-identity.example.test/feed.xml",
      categoryUrls: ["https://cross-source-resource-identity.example.test/category"]
    });
    await connectMerchantCenter(created.store.id, { merchantCenterAccountId: "123" });

    const feedSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-resource-identity-feed"
    );
    const merchantSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-resource-identity-merchant"
    );
    const collectedFeed = await collectFeed({
      url: "https://cross-source-resource-identity.example.test/feed.xml",
      fetchImpl: async () =>
        new Response(`
          <rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
            <channel>
              <item>
                <g:id>SKU-1</g:id>
                <g:title>Feed SKU 1</g:title>
                <g:link>https://cross-source-resource-identity.example.test/products/sku-1</g:link>
              </item>
            </channel>
          </rss>
        `)
    });
    const collectedMerchant = await collectMerchantCenterItemIssues({
      storeId: created.store.id,
      accountId: "123",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            products: [
              merchantProviderProduct({
                name: "accounts/123/products/en~US~sku-1",
                offerId: "SKU-1",
                title: "English SKU 1",
                issueCode: "invalid_gtin"
              }),
              merchantProviderProduct({
                name: "accounts/123/products/de~DE~sku-1",
                offerId: "SKU-1",
                title: "German SKU 1",
                issueCode: "missing_price"
              })
            ]
          }),
          { status: 200 }
        ),
      dependencies: merchantCollectorDependencies()
    });

    expect(collectedMerchant).toMatchObject({ status: "success", totalItemsSeen: 2 });
    expect(collectedMerchant.items).toHaveLength(2);
    expect(new Set(collectedMerchant.items.map((item) => item.stableKey)).size).toBe(2);

    await persistFeedCheckResult(feedSnapshot.id, created.store.id, collectedFeed);
    await persistMerchantCenterItemIssuesResult(
      merchantSnapshot.id,
      created.store.id,
      collectedMerchant
    );

    const inspector = new Client({ connectionString: dbUrlWithSchema });
    await inspector.connect();
    const persisted = await inspector.query<{
      identity_count: string;
      distinct_stable_key_count: string;
      single_issue_identity_count: string;
    }>(
      `
        SELECT
          COUNT(*)::text AS identity_count,
          COUNT(DISTINCT stable_key)::text AS distinct_stable_key_count,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(merchant_issues_json) = 'array'
              AND jsonb_array_length(merchant_issues_json) = 1
          )::text AS single_issue_identity_count
        FROM source_items
        WHERE snapshot_id = $1
          AND source = 'merchant_center'
          AND metadata_json ->> 'merchantDataKind' = 'product_identity'
      `,
      [merchantSnapshot.id]
    );
    await inspector.end();
    expect(persisted.rows[0]).toEqual({
      identity_count: "2",
      distinct_stable_key_count: "2",
      single_issue_identity_count: "2"
    });

    await expect(
      getCrossSourceProductMatchSummary({
        feedSnapshotId: feedSnapshot.id,
        merchantSnapshotId: merchantSnapshot.id
      })
    ).resolves.toMatchObject({
      comparable: true,
      matchedCount: 0,
      feedOnlyCount: 0,
      merchantOnlyCount: 0,
      ambiguousCount: 1,
      samples: {
        ambiguous: [
          expect.objectContaining({
            identityKey: "offer:sku-1",
            feedCount: 1,
            merchantCount: 2
          })
        ]
      }
    });
  });

  it("matches equivalent feed and Merchant offer-ID whitespace through both collectors", async () => {
    const {
      connectMerchantCenter,
      createQueuedSnapshot,
      createStore,
      getCrossSourceProductMatchSummary,
      persistFeedCheckResult,
      persistMerchantCenterItemIssuesResult
    } = await import("@eim/db");
    const { collectFeed, collectMerchantCenterItemIssues } = await import("@eim/worker");

    const created = await createStore({
      name: "Cross-source offer whitespace store",
      domain: "https://cross-source-offer-whitespace.example.test",
      sitemapUrl: "https://cross-source-offer-whitespace.example.test/sitemap.xml",
      feedUrl: "https://cross-source-offer-whitespace.example.test/feed.xml",
      categoryUrls: ["https://cross-source-offer-whitespace.example.test/category"]
    });
    await connectMerchantCenter(created.store.id, { merchantCenterAccountId: "123" });

    const feedSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-offer-whitespace-feed"
    );
    const merchantSnapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "cross-source-offer-whitespace-merchant"
    );
    const collectedFeed = await collectFeed({
      url: "https://cross-source-offer-whitespace.example.test/feed.xml",
      fetchImpl: async () =>
        new Response(`
          <rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
            <channel>
              <item>
                <g:id>  SKU\t  1  </g:id>
                <g:title>Whitespace SKU</g:title>
                <g:link>https://cross-source-offer-whitespace.example.test/products/sku-1</g:link>
              </item>
            </channel>
          </rss>
        `)
    });
    const collectedMerchant = await collectMerchantCenterItemIssues({
      storeId: created.store.id,
      accountId: "123",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            products: [
              merchantProviderProduct({
                name: "accounts/123/products/en~US~sku-1",
                offerId: "sku 1",
                title: "Merchant whitespace SKU"
              })
            ]
          }),
          { status: 200 }
        ),
      dependencies: merchantCollectorDependencies()
    });

    await persistFeedCheckResult(feedSnapshot.id, created.store.id, collectedFeed);
    await persistMerchantCenterItemIssuesResult(
      merchantSnapshot.id,
      created.store.id,
      collectedMerchant
    );

    await expect(
      getCrossSourceProductMatchSummary({
        feedSnapshotId: feedSnapshot.id,
        merchantSnapshotId: merchantSnapshot.id
      })
    ).resolves.toMatchObject({
      comparable: true,
      matchedCount: 1,
      feedOnlyCount: 0,
      merchantOnlyCount: 0,
      ambiguousCount: 0
    });
  });
});
