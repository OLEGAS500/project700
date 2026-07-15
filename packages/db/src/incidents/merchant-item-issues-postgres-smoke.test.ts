import type { SourceCheckResult, SourceItemInput } from "@eim/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Client } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase =
  testDatabaseUrl && process.env.RUN_POSTGRES_TESTS === "1" ? describe : describe.skip;
const schemaName = `eim_merchant_incidents_${Date.now()}_${Math.random().toString(16).slice(2)}`;

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

function issueItem(stableKey: string, code: string, severity = "error"): SourceItemInput {
  return {
    source: "merchant_center",
    stableKey,
    offerId: stableKey.replace("offer:", ""),
    title: `Product ${stableKey}`,
    merchantStatus: "disapproved",
    merchantIssues: [
      {
        code,
        severity,
        resolution: "merchant_action",
        attribute: "gtin",
        reportingContext: "shopping_ads",
        description: "Invalid product data",
        applicableCountries: ["US"]
      }
    ],
    metadata: {
      merchantDataKind: "item_issues",
      productName: `accounts/123/products/${stableKey}`
    },
    rawHash: `${stableKey}:${code}:${severity}`
  };
}

function issueResult(
  items: SourceItemInput[],
  status: SourceCheckResult["status"] = "success"
): SourceCheckResult {
  return {
    source: "merchant_center",
    url: "https://merchantapi.googleapis.com/products/v1/accounts/123/products",
    status,
    startedAt: "2026-07-15T12:00:00.000Z",
    finishedAt: "2026-07-15T12:00:01.000Z",
    durationMs: 1_000,
    itemsObserved: items.length,
    totalItemsSeen: items.length,
    skippedItems: status === "success" ? 0 : 1,
    items,
    errorCode: status === "success" ? undefined : "merchant_center_products_pagination_http_error",
    errorMessage: status === "success" ? undefined : "Merchant Center product pagination was incomplete.",
    metadata: {
      merchantItemIssuesVersion: "v1",
      productsSeen: items.length,
      productsWithIssues: items.length,
      issuesObserved: items.length,
      pagination: { pagesFetched: 1, complete: status === "success" }
    }
  };
}

describeIfDatabase("merchant item issue incident rule", () => {
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

  it("debounces, groups, exposes evidence, and recovers only after two healthy checks", async () => {
    const {
      connectMerchantCenter,
      createOrUpdateMerchantItemIssuesIncident,
      createQueuedSnapshot,
      createStore,
      getDashboardIncidentDetail,
      persistMerchantCenterItemIssuesResult,
      updateMerchantItemIssuesRecovery
    } = await import("@eim/db");

    const created = await createStore({
      name: "Merchant Issue Incident Store",
      domain: "https://merchant-issue-incidents.example.com",
      sitemapUrl: "https://merchant-issue-incidents.example.com/sitemap.xml",
      feedUrl: "https://merchant-issue-incidents.example.com/feed.xml",
      categoryUrls: ["https://merchant-issue-incidents.example.com/collections/all"]
    });
    await connectMerchantCenter(created.store.id, { merchantCenterAccountId: "123" });

    const first = await createQueuedSnapshot(created.store.id, "normal_check", "merchant-issue-first");
    await persistMerchantCenterItemIssuesResult(
      first.id,
      created.store.id,
      issueResult([issueItem("offer:sku-1", "invalid_gtin")])
    );
    await expect(createOrUpdateMerchantItemIssuesIncident(created.store.id, first.id)).resolves.toBeNull();

    const partial = await createQueuedSnapshot(created.store.id, "normal_check", "merchant-issue-partial");
    await persistMerchantCenterItemIssuesResult(
      partial.id,
      created.store.id,
      issueResult([issueItem("offer:sku-1", "invalid_gtin")], "partial")
    );
    await expect(createOrUpdateMerchantItemIssuesIncident(created.store.id, partial.id)).resolves.toBeNull();

    const second = await createQueuedSnapshot(created.store.id, "normal_check", "merchant-issue-second");
    await persistMerchantCenterItemIssuesResult(
      second.id,
      created.store.id,
      issueResult([issueItem("offer:sku-1", "invalid_gtin"), issueItem("offer:sku-2", "missing_brand")])
    );
    const incidentId = await createOrUpdateMerchantItemIssuesIncident(created.store.id, second.id);
    expect(incidentId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(createOrUpdateMerchantItemIssuesIncident(created.store.id, second.id)).resolves.toBe(incidentId);

    const detail = await getDashboardIncidentDetail(incidentId!);
    expect(detail?.incident).toMatchObject({
      type: "merchant_item_issues",
      severity: "critical",
      affectedCount: 2,
      likelySource: "merchant_center"
    });
    expect(detail?.signals).toEqual([
      expect.objectContaining({ source: "merchant_center", metric: "item_level_issues" })
    ]);
    expect(detail?.samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stableKey: "offer:sku-1",
          issueCode: "invalid_gtin",
          issueSeverity: "error",
          affectedAttribute: "gtin"
        })
      ])
    );

    const healthyFirst = await createQueuedSnapshot(created.store.id, "normal_check", "merchant-issue-healthy-1");
    await persistMerchantCenterItemIssuesResult(
      healthyFirst.id,
      created.store.id,
      issueResult([])
    );
    await expect(createOrUpdateMerchantItemIssuesIncident(created.store.id, healthyFirst.id)).resolves.toBeNull();
    await expect(updateMerchantItemIssuesRecovery(created.store.id, healthyFirst.id)).resolves.toEqual([
      expect.objectContaining({ incidentId, transition: "recovering_started", status: "recovering" })
    ]);

    const healthySecond = await createQueuedSnapshot(created.store.id, "normal_check", "merchant-issue-healthy-2");
    await persistMerchantCenterItemIssuesResult(
      healthySecond.id,
      created.store.id,
      issueResult([])
    );
    await expect(createOrUpdateMerchantItemIssuesIncident(created.store.id, healthySecond.id)).resolves.toBeNull();
    await expect(updateMerchantItemIssuesRecovery(created.store.id, healthySecond.id)).resolves.toEqual([
      expect.objectContaining({ incidentId, transition: "resolved", status: "resolved" })
    ]);

    const verifier = new Client({ connectionString: dbUrlWithSchema });
    await verifier.connect();
    const check = await verifier.query<{ status: string; count: string }>(
      `
        SELECT
          (SELECT status::text FROM incidents WHERE id = $1) AS status,
          (SELECT COUNT(*) FROM incidents WHERE store_id = $2 AND type = 'merchant_item_issues') AS count
      `,
      [incidentId, created.store.id]
    );
    await verifier.end();
    expect(check.rows[0]).toEqual({ status: "resolved", count: "1" });
  });

  it("keeps debounce candidates and incidents isolated by store", async () => {
    const {
      connectMerchantCenter,
      createOrUpdateMerchantItemIssuesIncident,
      createQueuedSnapshot,
      createStore,
      persistMerchantCenterItemIssuesResult
    } = await import("@eim/db");

    const first = await createStore({
      name: "Merchant Issue Isolation One",
      domain: "https://merchant-issue-isolation-one.example.com",
      sitemapUrl: "https://merchant-issue-isolation-one.example.com/sitemap.xml",
      feedUrl: "https://merchant-issue-isolation-one.example.com/feed.xml",
      categoryUrls: ["https://merchant-issue-isolation-one.example.com/collections/all"]
    });
    const second = await createStore({
      name: "Merchant Issue Isolation Two",
      domain: "https://merchant-issue-isolation-two.example.com",
      sitemapUrl: "https://merchant-issue-isolation-two.example.com/sitemap.xml",
      feedUrl: "https://merchant-issue-isolation-two.example.com/feed.xml",
      categoryUrls: ["https://merchant-issue-isolation-two.example.com/collections/all"]
    });
    await connectMerchantCenter(first.store.id, { merchantCenterAccountId: "123" });
    await connectMerchantCenter(second.store.id, { merchantCenterAccountId: "456" });

    for (const [storeId, suffix] of [
      [first.store.id, "one"],
      [second.store.id, "two"]
    ] as const) {
      const initial = await createQueuedSnapshot(storeId, "normal_check", `merchant-issue-${suffix}-1`);
      await persistMerchantCenterItemIssuesResult(
        initial.id,
        storeId,
        issueResult([issueItem("offer:sku-1", "invalid_gtin")])
      );
      await createOrUpdateMerchantItemIssuesIncident(storeId, initial.id);

      const confirmation = await createQueuedSnapshot(storeId, "normal_check", `merchant-issue-${suffix}-2`);
      await persistMerchantCenterItemIssuesResult(
        confirmation.id,
        storeId,
        issueResult([issueItem("offer:sku-1", "invalid_gtin")])
      );
      await createOrUpdateMerchantItemIssuesIncident(storeId, confirmation.id);
    }

    const verifier = new Client({ connectionString: dbUrlWithSchema });
    await verifier.connect();
    const counts = await verifier.query<{ store_id: string; count: string }>(
      `
        SELECT store_id, COUNT(*) AS count
        FROM incidents
        WHERE type = 'merchant_item_issues'
          AND store_id IN ($1, $2)
        GROUP BY store_id
        ORDER BY store_id
      `,
      [first.store.id, second.store.id]
    );
    await verifier.end();
    expect(counts.rows).toHaveLength(2);
    expect(counts.rows.every((row) => row.count === "1")).toBe(true);
    expect(new Set(counts.rows.map((row) => row.store_id)).size).toBe(2);
  });

  it("does not turn a concurrent partial upsert into a business incident", async () => {
    const {
      connectMerchantCenter,
      createOrUpdateMerchantItemIssuesIncident,
      createQueuedSnapshot,
      createStore,
      persistMerchantCenterItemIssuesResult
    } = await import("@eim/db");

    const created = await createStore({
      name: "Merchant Issue Race Store",
      domain: "https://merchant-issue-race.example.com",
      sitemapUrl: "https://merchant-issue-race.example.com/sitemap.xml",
      feedUrl: "https://merchant-issue-race.example.com/feed.xml",
      categoryUrls: ["https://merchant-issue-race.example.com/collections/all"]
    });
    await connectMerchantCenter(created.store.id, { merchantCenterAccountId: "789" });

    const snapshot = await createQueuedSnapshot(created.store.id, "normal_check", "merchant-issue-race");
    await persistMerchantCenterItemIssuesResult(
      snapshot.id,
      created.store.id,
      issueResult([issueItem("offer:race", "invalid_gtin")])
    );

    const blocker = new Client({ connectionString: dbUrlWithSchema });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      `
        SELECT id
        FROM source_checks
        WHERE snapshot_id = $1
          AND store_id = $2
          AND source = 'merchant_center'
          AND metadata_json ->> 'merchantItemIssuesVersion' = 'v1'
        FOR UPDATE
      `,
      [snapshot.id, created.store.id]
    );

    const evaluation = createOrUpdateMerchantItemIssuesIncident(created.store.id, snapshot.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const partialUpsert = persistMerchantCenterItemIssuesResult(
      snapshot.id,
      created.store.id,
      issueResult([issueItem("offer:race", "invalid_gtin")], "partial")
    );

    await blocker.query("COMMIT");
    await blocker.end();
    await evaluation;
    await partialUpsert;

    const after = new Client({ connectionString: dbUrlWithSchema });
    await after.connect();
    const state = await after.query<{ check_status: string; incidents: string; candidates: string }>(
      `
        SELECT
          (
            SELECT status::text
            FROM source_checks
            WHERE snapshot_id = $1
              AND source = 'merchant_center'
              AND metadata_json ->> 'merchantItemIssuesVersion' = 'v1'
          ) AS check_status,
          (SELECT COUNT(*) FROM incidents WHERE store_id = $2 AND type = 'merchant_item_issues') AS incidents,
          (
            SELECT COUNT(*)
            FROM incident_debounce_candidates
            WHERE store_id = $2 AND type = 'merchant_item_issues' AND status = 'pending'
          ) AS candidates
      `,
      [snapshot.id, created.store.id]
    );
    await after.end();

    expect(state.rows[0].check_status).toBe("partial");
    expect(state.rows[0].incidents).toBe("0");
    expect(Number(state.rows[0].candidates)).toBeLessThanOrEqual(1);

    await expect(createOrUpdateMerchantItemIssuesIncident(created.store.id, snapshot.id)).resolves.toBeNull();
  });
});
