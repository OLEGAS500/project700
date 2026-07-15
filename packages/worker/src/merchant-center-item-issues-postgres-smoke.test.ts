import type { SourceCheckResult, SourceItemInput } from "@eim/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Client } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase =
  testDatabaseUrl && process.env.RUN_POSTGRES_TESTS === "1" ? describe : describe.skip;
const schemaName = `eim_merchant_issues_${Date.now()}_${Math.random().toString(16).slice(2)}`;

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

function item(stableKey: string, issueCodes: string | string[]): SourceItemInput {
  const codes = Array.isArray(issueCodes) ? issueCodes : [issueCodes];

  return {
    source: "merchant_center",
    stableKey,
    offerId: stableKey.replace("offer:", ""),
    title: `Product ${stableKey}`,
    merchantStatus: "disapproved",
    merchantIssues: codes.map((code) => ({
      code,
      severity: "disapproved",
      resolution: "merchant_action",
      attribute: "gtins",
      reportingContext: "shopping_ads",
      description: "Invalid product data",
      applicableCountries: ["US"]
    })),
    metadata: {
      merchantDataKind: "item_issues",
      productName: `accounts/123/products/${stableKey}`
    },
    rawHash: `${stableKey}:${codes.join(",")}`
  };
}

function feedItem(): SourceItemInput {
  return {
    source: "feed",
    stableKey: "offer:feed-only",
    offerId: "feed-only",
    title: "Feed product",
    rawHash: "feed-only-hash"
  };
}

function result(
  url: string,
  items: SourceItemInput[],
  overrides: Partial<SourceCheckResult> = {}
): SourceCheckResult {
  return {
    source: "merchant_center",
    url,
    status: "success",
    startedAt: "2026-07-15T12:00:00.000Z",
    finishedAt: "2026-07-15T12:00:01.000Z",
    durationMs: 1_000,
    itemsObserved: items.length,
    totalItemsSeen: items.length,
    skippedItems: 0,
    items,
    metadata: {
      merchantItemIssuesVersion: "v1",
      productsSeen: items.length,
      productsWithIssues: items.length,
      issuesObserved: items.length,
      pagination: { pagesFetched: 1, complete: true }
    },
    ...overrides
  };
}

describeIfDatabase("merchant center item issues postgres vertical slice", () => {
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
    const { applyMigrations } = await import("@eim/db");
    await applyMigrations(migrator);
    await migrator.end();
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin.end();
  });

  it("replaces issue products atomically and isolates stores", async () => {
    const {
      createQueuedSnapshot,
      createStore,
      persistMerchantCenterItemIssuesResult,
      persistSourceCheckResult
    } = await import("@eim/db");

    const firstStore = await createStore({
      name: "Merchant Issues Store One",
      domain: "https://merchant-issues-one.example.com",
      sitemapUrl: "https://merchant-issues-one.example.com/sitemap.xml",
      feedUrl: "https://merchant-issues-one.example.com/feed.xml",
      categoryUrls: ["https://merchant-issues-one.example.com/collections/all"]
    });
    const secondStore = await createStore({
      name: "Merchant Issues Store Two",
      domain: "https://merchant-issues-two.example.com",
      sitemapUrl: "https://merchant-issues-two.example.com/sitemap.xml",
      feedUrl: "https://merchant-issues-two.example.com/feed.xml",
      categoryUrls: ["https://merchant-issues-two.example.com/collections/all"]
    });

    const firstSnapshot = await createQueuedSnapshot(
      firstStore.store.id,
      "normal_check",
      "merchant-issues-replay-one"
    );
    await persistSourceCheckResult(
      firstSnapshot.id,
      firstStore.store.id,
      {
        source: "feed",
        url: "https://merchant-issues-one.example.com/feed.xml",
        status: "success",
        startedAt: "2026-07-15T12:00:00.000Z",
        finishedAt: "2026-07-15T12:00:01.000Z",
        durationMs: 1_000,
        itemsObserved: 1,
        items: [feedItem()],
        metadata: {}
      }
    );

    const issuesUrl = "https://merchantapi.googleapis.com/products/v1/accounts/123/products";
    await persistMerchantCenterItemIssuesResult(
      firstSnapshot.id,
      firstStore.store.id,
      result(issuesUrl, [
        item("offer:sku-1", ["invalid_gtin", "missing_brand"]),
        item("offer:sku-2", "missing_price")
      ])
    );
    await persistMerchantCenterItemIssuesResult(
      firstSnapshot.id,
      firstStore.store.id,
      result(issuesUrl, [item("offer:sku-1", "invalid_gtin"), item("offer:sku-3", "missing_link")], {
        status: "partial",
        errorCode: "merchant_center_products_pagination_http_error",
        errorMessage: "Merchant Center product pagination could not be completed."
      })
    );

    const afterPartial = new Client({ connectionString: dbUrlWithSchema });
    await afterPartial.connect();
    const preserved = await afterPartial.query<{ count: string }>(
      `
        SELECT COUNT(*) AS count
        FROM source_items
        WHERE snapshot_id = $1
          AND source = 'merchant_center'
      `,
      [firstSnapshot.id]
    );
    expect(Number(preserved.rows[0].count)).toBe(3);

    const preservedSkuOne = await afterPartial.query<{ merchant_issues_json: unknown }>(
      `
        SELECT merchant_issues_json
        FROM source_items
        WHERE snapshot_id = $1 AND stable_key = 'offer:sku-1'
      `,
      [firstSnapshot.id]
    );
    expect(preservedSkuOne.rows[0].merchant_issues_json).toEqual([
      expect.objectContaining({ code: "invalid_gtin" }),
      expect.objectContaining({ code: "missing_brand" })
    ]);
    await afterPartial.end();

    await persistMerchantCenterItemIssuesResult(
      firstSnapshot.id,
      firstStore.store.id,
      result(issuesUrl, [item("offer:sku-1", "invalid_gtin")])
    );

    const secondSnapshot = await createQueuedSnapshot(
      secondStore.store.id,
      "normal_check",
      "merchant-issues-replay-two"
    );
    await persistMerchantCenterItemIssuesResult(
      secondSnapshot.id,
      secondStore.store.id,
      result(issuesUrl, [item("offer:sku-1", "invalid_gtin")])
    );

    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();
    const items = await client.query<{
      store_id: string;
      stable_key: string;
      merchant_issues_json: unknown;
      source: string;
    }>(
      `
        SELECT store_id, stable_key, merchant_issues_json, source
        FROM source_items
        WHERE stable_key IN ('offer:sku-1', 'offer:sku-2', 'offer:sku-3', 'offer:feed-only')
        ORDER BY store_id, stable_key
      `
    );
    await client.end();

    expect(items.rows).toHaveLength(3);
    expect(items.rows.filter((row) => row.source === "merchant_center")).toHaveLength(2);
    expect(items.rows.filter((row) => row.stable_key === "offer:sku-2")).toHaveLength(0);
    expect(items.rows.filter((row) => row.stable_key === "offer:sku-3")).toHaveLength(0);
    expect(items.rows.filter((row) => row.stable_key === "offer:sku-1")).toHaveLength(2);
    expect(items.rows.find((row) => row.stable_key === "offer:sku-1")?.merchant_issues_json).toEqual([
      expect.objectContaining({ code: "invalid_gtin" })
    ]);
  });
});
