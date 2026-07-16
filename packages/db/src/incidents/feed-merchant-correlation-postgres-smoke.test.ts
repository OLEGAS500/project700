import type { SourceCheckResult, SourceItemInput } from "@eim/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { merchantItemIssuesConfigurationHash } from "./merchant-item-issues";

const { Client } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase =
  testDatabaseUrl && process.env.RUN_POSTGRES_TESTS === "1" ? describe : describe.skip;
const schemaName = `eim_feed_merchant_correlation_${Date.now()}_${Math.random()
  .toString(16)
  .slice(2)}`;

type Db = typeof import("@eim/db");

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

function feedItems(count: number): SourceItemInput[] {
  return Array.from({ length: count }, (_, index) => ({
    source: "feed" as const,
    stableKey: `feed:sku-${index + 1}`,
    offerId: `SKU ${index + 1}`,
    title: `Feed product ${index + 1}`,
    url: `https://feed-merchant-correlation.example.test/products/${index + 1}`,
    rawHash: `feed:${index + 1}`
  }));
}

function merchantItems(count: number): SourceItemInput[] {
  return Array.from({ length: count }, (_, index) => ({
    source: "merchant_center" as const,
    stableKey: `merchant:sku-${index + 1}`,
    offerId: `sku ${index + 1}`,
    title: `Merchant product ${index + 1}`,
    merchantStatus: "approved",
    rawHash: `merchant:${index + 1}`
  }));
}

function feedResult(
  items: SourceItemInput[],
  url = "https://feed-merchant-correlation.example.test/feed.xml"
): SourceCheckResult {
  return {
    source: "feed",
    url,
    status: "success",
    startedAt: "2026-07-16T12:00:00.000Z",
    finishedAt: "2026-07-16T12:00:01.000Z",
    durationMs: 1_000,
    itemsObserved: items.length,
    totalItemsSeen: items.length,
    skippedItems: 0,
    items
  };
}

function merchantStatusResult(input: {
  accountId: string;
  approved: number;
  total: number;
  status?: SourceCheckResult["status"];
}): SourceCheckResult {
  const status = input.status ?? "success";
  return {
    source: "merchant_center",
    url: `https://merchantapi.googleapis.com/issueresolution/v1/accounts/${input.accountId}/aggregateProductStatuses`,
    status,
    startedAt: "2026-07-16T12:00:00.000Z",
    finishedAt: "2026-07-16T12:00:01.000Z",
    durationMs: 1_000,
    itemsObserved: input.total,
    totalItemsSeen: 1,
    skippedItems: status === "success" ? 0 : 1,
    items: [],
    errorCode: status === "success" ? undefined : "merchant_center_partial_response",
    errorMessage: status === "success" ? undefined : "Merchant status data was incomplete.",
    metadata: {
      merchantStatusAggregationVersion: "v1",
      merchantCenterConfigurationHash: merchantItemIssuesConfigurationHash(input.accountId),
      merchantStatusCounts: {
        total: input.total,
        approved: input.approved,
        pending: input.total - input.approved,
        disapproved: 0
      }
    }
  };
}

function merchantIdentityResult(input: {
  accountId: string;
  items: SourceItemInput[];
  status?: SourceCheckResult["status"];
}): SourceCheckResult {
  const status = input.status ?? "success";
  return {
    source: "merchant_center",
    url: `https://merchantapi.googleapis.com/products/v1/accounts/${input.accountId}/products`,
    status,
    startedAt: "2026-07-16T12:00:00.000Z",
    finishedAt: "2026-07-16T12:00:01.000Z",
    durationMs: 1_000,
    itemsObserved: 0,
    totalItemsSeen: input.items.length,
    skippedItems: status === "success" ? 0 : 1,
    items: input.items,
    errorCode: status === "success" ? undefined : "merchant_center_partial_response",
    errorMessage: status === "success" ? undefined : "Merchant identity data was incomplete.",
    metadata: {
      merchantItemIssuesVersion: "v1",
      merchantProductIdentityVersion: "v1",
      merchantProductIdentityComplete: status === "success",
      merchantItemIssuesConfigurationHash: merchantItemIssuesConfigurationHash(input.accountId)
    }
  };
}

describeIfDatabase("feed and Merchant catalog-drop correlation", () => {
  const admin = new Client({ connectionString: testDatabaseUrl });
  let db: Db;
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

    db = await import("@eim/db");
  });

  afterAll(async () => {
    await db.closePool();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin.end();
  });

  it("correlates one confirmed catalog drop with complete Merchant evidence and preserves feed recovery", async () => {
    const created = await db.createStore({
      name: "Feed Merchant correlation store",
      domain: "https://feed-merchant-correlation.example.test",
      sitemapUrl: "https://feed-merchant-correlation.example.test/sitemap.xml",
      feedUrl: "https://feed-merchant-correlation.example.test/feed.xml",
      categoryUrls: ["https://feed-merchant-correlation.example.test/collections/all"]
    });
    await db.connectMerchantCenter(created.store.id, { merchantCenterAccountId: "123" });

    for (let index = 0; index < 7; index += 1) {
      await createComparableSnapshot(db, {
        storeId: created.store.id,
        accountId: "123",
        idempotencyKey: `feed-merchant-baseline-${index}`,
        feed: feedItems(100),
        merchant: merchantItems(100),
        approvedCount: 100
      });
    }

    const feedBaseline = await db.recalculateFeedProductCountBaseline(created.store.id);
    await db.confirmBaselineMetric(
      feedBaseline!.id,
      "00000000-0000-0000-0000-0000000000c1"
    );

    const observed = await createComparableSnapshot(db, {
      storeId: created.store.id,
      accountId: "123",
      idempotencyKey: "feed-merchant-drop",
      feed: feedItems(70),
      merchant: merchantItems(100),
      approvedCount: 70
    });
    // A stale status write for a different account can overwrite the snapshot convenience count.
    // Correlation must instead use the account-fenced status-check metadata for account 123.
    await db.persistSourceCheckResult(
      observed.id,
      created.store.id,
      merchantStatusResult({ accountId: "999", approved: 100, total: 100 })
    );
    const candidate = await db.evaluateFeedCatalogDropCandidate(created.store.id, observed.id);
    expect(candidate).toMatchObject({ status: "pending_confirmation" });

    const confirmation = await db.createQueuedSnapshot(
      created.store.id,
      "confirmation_check",
      "feed-merchant-confirmation"
    );
    await db.persistFeedCheckResult(confirmation.id, created.store.id, feedResult(feedItems(69)));

    const confirmed = await db.confirmFeedCatalogDropCandidate(candidate!.id, confirmation.id);
    expect(confirmed.incidentId).toBeTruthy();
    const confirmedAgain = await db.confirmFeedCatalogDropCandidate(candidate!.id, confirmation.id);
    expect(confirmedAgain.incidentId).toBe(confirmed.incidentId);

    const inspector = new Client({ connectionString: dbUrlWithSchema });
    await inspector.connect();
    const incident = await inspector.query<{
      confidence_score: string;
      evidence_json: unknown;
    }>(
      "SELECT confidence_score, evidence_json FROM incidents WHERE id = $1",
      [confirmed.incidentId]
    );
    const catalogDropCount = await inspector.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM incidents
        WHERE store_id = $1
          AND type = 'catalog_drop'
      `,
      [created.store.id]
    );
    const signals = await inspector.query<{
      source: string;
      metric: string;
      before_value: string | null;
      after_value: string | null;
      sample_items_json: unknown;
    }>(
      `
        SELECT source, metric, before_value, after_value, sample_items_json
        FROM incident_signals
        WHERE incident_id = $1
        ORDER BY source, metric
      `,
      [confirmed.incidentId]
    );
    const events = await inspector.query<{
      event_type: string;
      metadata_json: Record<string, unknown>;
    }>(
      `
        SELECT event_type, metadata_json
        FROM incident_events
        WHERE incident_id = $1
          AND event_type = 'feed_merchant_correlation_confirmed'
      `,
      [confirmed.incidentId]
    );
    const payload = await inspector.query<{ payload_json: Record<string, unknown> }>(
      `
        SELECT alert_event_payloads.payload_json
        FROM alert_event_payloads
        JOIN incident_events ON incident_events.id = alert_event_payloads.incident_event_id
        WHERE incident_events.incident_id = $1
          AND incident_events.event_type = 'incident_opened'
      `,
      [confirmed.incidentId]
    );
    await inspector.end();

    expect(incident.rows).toHaveLength(1);
    expect(catalogDropCount.rows[0]?.count).toBe("1");
    expect(Number(incident.rows[0]?.confidence_score)).toBe(0.95);
    expect(incident.rows[0]?.evidence_json).toEqual(
      expect.arrayContaining([
        "A complete Merchant Center approved-product decline corroborated this feed catalog drop."
      ])
    );
    expect(signals.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "merchant_center",
          metric: "approved_product_count",
          before_value: "100",
          after_value: "70"
        }),
        expect.objectContaining({
          source: "feed_vs_merchant_center",
          metric: "merchant_inventory_missing_from_feed",
          before_value: "100",
          after_value: "30"
        })
      ])
    );
    const mappingSignal = signals.rows.find(
      (signal) => signal.metric === "merchant_inventory_missing_from_feed"
    );
    expect(mappingSignal?.sample_items_json).toHaveLength(20);
    expect(events.rows).toEqual([
      expect.objectContaining({
        event_type: "feed_merchant_correlation_confirmed",
        metadata_json: expect.objectContaining({
          merchantApprovedBaseline: 100,
          merchantApprovedCurrent: 70,
          merchantBaselineSampleCount: 7,
          mapping: expect.objectContaining({ merchantOnlyCount: 30, ambiguousCount: 0 })
        })
      })
    ]);
    expect(payload.rows[0]?.payload_json).toMatchObject({
      incident: { confidenceScore: 0.95 },
      metrics: expect.arrayContaining([
        expect.objectContaining({ name: "approved_product_count" }),
        expect.objectContaining({
          name: "merchant_inventory_missing_from_feed",
          unit: "products"
        })
      ])
    });
    expect(JSON.stringify(events.rows)).not.toContain("merchantapi.googleapis.com");

    const healthy = await db.createQueuedSnapshot(
      created.store.id,
      "normal_check",
      "feed-merchant-recovery"
    );
    await db.persistFeedCheckResult(healthy.id, created.store.id, feedResult(feedItems(100)));
    await expect(db.updateCatalogDropRecovery(created.store.id, healthy.id)).resolves.toEqual([
      expect.objectContaining({
        incidentId: confirmed.incidentId,
        status: "recovering",
        transition: "recovering_started"
      })
    ]);
  });

  it("ignores partial, ambiguous, and configuration-incompatible Merchant evidence", async () => {
    const partial = await createCatalogDropScenario(db, {
      suffix: "partial",
      accountId: "234",
      merchantStatus: "partial"
    });
    const ambiguousMerchant: SourceItemInput[] = [
      ...merchantItems(100),
      {
        source: "merchant_center" as const,
        stableKey: "merchant:duplicate-sku-1",
        offerId: "sku 1",
        title: "Duplicate Merchant product",
        merchantStatus: "approved" as const,
        rawHash: "merchant:duplicate-sku-1"
      }
    ];
    const ambiguous = await createCatalogDropScenario(db, {
      suffix: "ambiguous",
      accountId: "345",
      merchant: ambiguousMerchant
    });
    const configuration = await createCatalogDropScenario(db, {
      suffix: "configuration",
      accountId: "456"
    });
    await db.connectMerchantCenter(configuration.storeId, { merchantCenterAccountId: "789" });

    for (const scenario of [partial, ambiguous, configuration]) {
      const confirmed = await db.confirmFeedCatalogDropCandidate(
        scenario.candidateId,
        scenario.confirmationSnapshotId
      );
      expect(confirmed.incidentId).toBeTruthy();

      const inspector = new Client({ connectionString: dbUrlWithSchema });
      await inspector.connect();
      const correlation = await inspector.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count
          FROM incident_events
          WHERE incident_id = $1
            AND event_type = 'feed_merchant_correlation_confirmed'
        `,
        [confirmed.incidentId]
      );
      const signals = await inspector.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count
          FROM incident_signals
          WHERE incident_id = $1
            AND source IN ('merchant_center', 'feed_vs_merchant_center')
        `,
        [confirmed.incidentId]
      );
      const confidence = await inspector.query<{ confidence_score: string }>(
        "SELECT confidence_score FROM incidents WHERE id = $1",
        [confirmed.incidentId]
      );
      await inspector.end();

      expect(correlation.rows[0]?.count).toBe("0");
      expect(signals.rows[0]?.count).toBe("0");
      expect(Number(confidence.rows[0]?.confidence_score)).toBe(0.85);
    }
  });

  it("serializes a current partial replacement before correlation reads the immutable snapshot", async () => {
    const scenario = await createCatalogDropScenario(db, {
      suffix: "concurrent-partial",
      accountId: "567"
    });
    const blocker = new Client({ connectionString: dbUrlWithSchema });
    await blocker.connect();

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM snapshots WHERE id = $1 FOR UPDATE", [
        scenario.observedSnapshotId
      ]);

      const confirmation = db.confirmFeedCatalogDropCandidate(
        scenario.candidateId,
        scenario.confirmationSnapshotId
      );
      await blocker.query(
        `
          UPDATE source_checks
          SET status = 'partial'
          WHERE snapshot_id = $1
            AND source = 'merchant_center'
            AND metadata_json ->> 'merchantStatusAggregationVersion' = 'v1'
        `,
        [scenario.observedSnapshotId]
      );
      await blocker.query("COMMIT");

      const confirmed = await confirmation;
      expect(confirmed.incidentId).toBeTruthy();

      const inspector = new Client({ connectionString: dbUrlWithSchema });
      await inspector.connect();
      const correlation = await inspector.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count
          FROM incident_events
          WHERE incident_id = $1
            AND event_type = 'feed_merchant_correlation_confirmed'
        `,
        [confirmed.incidentId]
      );
      await inspector.end();

      expect(correlation.rows[0]?.count).toBe("0");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });
});

async function createComparableSnapshot(
  db: Db,
  input: {
    storeId: string;
    accountId: string;
    idempotencyKey: string;
    feed: SourceItemInput[];
    feedUrl?: string;
    merchant: SourceItemInput[];
    approvedCount: number;
    merchantStatus?: SourceCheckResult["status"];
  }
) {
  const snapshot = await db.createQueuedSnapshot(input.storeId, "normal_check", input.idempotencyKey);
  await db.persistFeedCheckResult(
    snapshot.id,
    input.storeId,
    feedResult(input.feed, input.feedUrl)
  );
  await db.persistSourceCheckResult(
    snapshot.id,
    input.storeId,
    merchantStatusResult({
      accountId: input.accountId,
      approved: input.approvedCount,
      total: input.merchant.length,
      status: input.merchantStatus
    })
  );
  await db.persistMerchantCenterItemIssuesResult(
    snapshot.id,
    input.storeId,
    merchantIdentityResult({
      accountId: input.accountId,
      items: input.merchant
    })
  );
  return snapshot;
}

async function createCatalogDropScenario(
  db: Db,
  input: {
    suffix: string;
    accountId: string;
    merchant?: SourceItemInput[];
    merchantStatus?: SourceCheckResult["status"];
  }
): Promise<{
  storeId: string;
  candidateId: string;
  observedSnapshotId: string;
  confirmationSnapshotId: string;
}> {
  const domain = `https://feed-merchant-${input.suffix}.example.test`;
  const created = await db.createStore({
    name: `Feed Merchant ${input.suffix} store`,
    domain,
    sitemapUrl: `${domain}/sitemap.xml`,
    feedUrl: `${domain}/feed.xml`,
    categoryUrls: [`${domain}/collections/all`]
  });
  await db.connectMerchantCenter(created.store.id, {
    merchantCenterAccountId: input.accountId
  });

  for (let index = 0; index < 7; index += 1) {
    await createComparableSnapshot(db, {
      storeId: created.store.id,
      accountId: input.accountId,
      idempotencyKey: `${input.suffix}-baseline-${index}`,
      feed: feedItems(100),
      feedUrl: `${domain}/feed.xml`,
      merchant: merchantItems(100),
      approvedCount: 100
    });
  }

  const baseline = await db.recalculateFeedProductCountBaseline(created.store.id);
  await db.confirmBaselineMetric(
    baseline!.id,
    "00000000-0000-0000-0000-0000000000c2"
  );
  const observed = await createComparableSnapshot(db, {
    storeId: created.store.id,
    accountId: input.accountId,
    idempotencyKey: `${input.suffix}-drop`,
    feed: feedItems(70),
    feedUrl: `${domain}/feed.xml`,
    merchant: input.merchant ?? merchantItems(100),
    approvedCount: 70,
    merchantStatus: input.merchantStatus
  });
  const candidate = await db.evaluateFeedCatalogDropCandidate(created.store.id, observed.id);
  const confirmation = await db.createQueuedSnapshot(
    created.store.id,
    "confirmation_check",
    `${input.suffix}-confirmation`
  );
  await db.persistFeedCheckResult(
    confirmation.id,
    created.store.id,
    feedResult(feedItems(69), `${domain}/feed.xml`)
  );

  return {
    storeId: created.store.id,
    candidateId: candidate!.id,
    observedSnapshotId: observed.id,
    confirmationSnapshotId: confirmation.id
  };
}
