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
  title = `Merchant ${stableKey}`
): SourceItemInput {
  return {
    source: "merchant_center",
    stableKey,
    offerId,
    title,
    merchantStatus: "disapproved",
    merchantIssues: [
      {
        code: "invalid_gtin",
        severity: "error",
        attribute: "gtin"
      }
    ],
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
    itemsObserved: items.length,
    totalItemsSeen: items.length,
    skippedItems: status === "success" ? 0 : 1,
    items,
    errorCode: status === "success" ? undefined : "merchant_center_partial",
    errorMessage: status === "success" ? undefined : "Merchant snapshot was partial.",
    metadata: {
      merchantItemIssuesVersion: "v1",
      merchantItemIssuesConfigurationHash: merchantConfigurationHash(accountId),
      merchantDataKind: "item_issues"
    }
  };
}

function merchantConfigurationHash(accountId: string): string {
  return merchantItemIssuesConfigurationHash(accountId);
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
});
