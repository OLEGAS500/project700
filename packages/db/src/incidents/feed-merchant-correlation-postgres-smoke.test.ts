import type { SourceCheckResult, SourceItemInput } from "@eim/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "../client";
import { applyFeedMerchantCorrelation } from "./feed-merchant-correlation";
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

function feedItems(count: number, start = 1): SourceItemInput[] {
  return Array.from({ length: count }, (_, index) => ({
    source: "feed" as const,
    stableKey: `feed:sku-${start + index}`,
    offerId: `SKU ${start + index}`,
    title: `Feed product ${start + index}`,
    url: `https://feed-merchant-correlation.example.test/products/${start + index}`,
    rawHash: `feed:${start + index}`
  }));
}

function merchantItems(count: number, start = 1): SourceItemInput[] {
  return Array.from({ length: count }, (_, index) => ({
    source: "merchant_center" as const,
    stableKey: `merchant:sku-${start + index}`,
    offerId: `sku ${start + index}`,
    title: `Merchant product ${start + index}`,
    merchantStatus: "approved",
    rawHash: `merchant:${start + index}`
  }));
}

function feedResult(
  items: SourceItemInput[],
  url = "https://feed-merchant-correlation.example.test/feed.xml",
  itemsObserved = items.length
): SourceCheckResult {
  return {
    source: "feed",
    url,
    status: "success",
    startedAt: "2026-07-16T12:00:00.000Z",
    finishedAt: "2026-07-16T12:00:01.000Z",
    durationMs: 1_000,
    itemsObserved,
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
  finishedAt?: string;
}): SourceCheckResult {
  const status = input.status ?? "success";
  const finishedAt = input.finishedAt ?? "2026-07-16T12:00:01.000Z";
  return {
    source: "merchant_center",
    url: `https://merchantapi.googleapis.com/issueresolution/v1/accounts/${input.accountId}/aggregateProductStatuses`,
    status,
    startedAt: "2026-07-16T12:00:00.000Z",
    finishedAt,
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
    const secondConfirmation = await db.createQueuedSnapshot(
      created.store.id,
      "confirmation_check",
      "feed-merchant-confirmation-replay"
    );
    await db.persistFeedCheckResult(
      secondConfirmation.id,
      created.store.id,
      feedResult(feedItems(68))
    );
    const confirmedAgain = await db.confirmFeedCatalogDropCandidate(
      candidate!.id,
      secondConfirmation.id
    );
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
      snapshot_id: string | null;
      metadata_json: Record<string, unknown>;
    }>(
      `
        SELECT event_type, snapshot_id, metadata_json
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
          before_value: "70",
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
        snapshot_id: observed.id,
        metadata_json: expect.objectContaining({
          merchantApprovedBaseline: 100,
          merchantApprovedCurrent: 70,
          merchantBaselineSampleCount: 7,
          mapping: expect.objectContaining({
            matchedCount: 70,
            merchantOnlyCount: 30,
            ambiguousCount: 0,
            reconciledFeedCount: 70,
            identityLoss: expect.objectContaining({ changeAbs: 30, changePct: 30 / 70 })
          })
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

  it("requires reconciled, threshold-sized Merchant identity-loss evidence", async () => {
    const smallIdentityLoss = await createCatalogDropScenario(db, {
      suffix: "small-identity-loss",
      accountId: "470",
      merchant: [...merchantItems(70), ...merchantItems(1, 71)]
    });
    const disjointIdentity = await createCatalogDropScenario(db, {
      suffix: "disjoint-identity",
      accountId: "471",
      merchant: merchantItems(100, 101)
    });
    const unreconciledFeedCount = await createCatalogDropScenario(db, {
      suffix: "unreconciled-feed-count",
      accountId: "472",
      feed: feedItems(69),
      feedItemsObserved: 70
    });

    for (const scenario of [smallIdentityLoss, disjointIdentity, unreconciledFeedCount]) {
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
      const confidence = await inspector.query<{ confidence_score: string }>(
        "SELECT confidence_score FROM incidents WHERE id = $1",
        [confirmed.incidentId]
      );
      await inspector.end();

      expect(correlation.rows[0]?.count).toBe("0");
      expect(Number(confidence.rows[0]?.confidence_score)).toBe(0.85);
    }
  });

  it("fences correlation to the immutable candidate context and records it once", async () => {
    const scenario = await createCatalogDropScenario(db, {
      suffix: "candidate-fence",
      accountId: "480"
    });
    const unrelatedSnapshot = await createComparableSnapshot(db, {
      storeId: scenario.storeId,
      accountId: "480",
      idempotencyKey: "candidate-fence-unrelated-snapshot",
      feed: feedItems(70),
      merchant: merchantItems(100),
      approvedCount: 70
    });

    const result = await withTransaction(async (client) => {
      await client.query(
        `
          UPDATE incident_candidates
          SET confirmation_snapshot_id = $2
          WHERE id = $1
        `,
        [scenario.candidateId, scenario.confirmationSnapshotId]
      );
      const inserted = await client.query<{ id: string }>(
        `
          INSERT INTO incidents (
            store_id,
            catalog_drop_candidate_id,
            baseline_metric_id,
            baseline_version,
            baseline_median,
            configuration_hash,
            before_value,
            after_value,
            thresholds_json,
            opened_snapshot_id,
            severity,
            type,
            title,
            summary,
            likely_source,
            confidence_score,
            evidence_json,
            affected_count,
            first_detected_at,
            last_seen_at,
            status
          )
          SELECT
            candidates.store_id,
            candidates.id,
            candidates.baseline_metric_id,
            candidates.baseline_version,
            candidates.baseline_median,
            candidates.configuration_hash,
            candidates.before_value,
            candidates.observed_value,
            $3::jsonb,
            $2,
            'critical',
            'catalog_drop',
            'Feed product catalog drop',
            'Manual candidate-fence correlation test.',
            'feed',
            0.85,
            '[]'::jsonb,
            GREATEST(0, (candidates.baseline_median - candidates.observed_value)::integer),
            clock_timestamp(),
            clock_timestamp(),
            'open'
          FROM incident_candidates AS candidates
          WHERE candidates.id = $1
          RETURNING id
        `,
        [
          scenario.candidateId,
          scenario.confirmationSnapshotId,
          JSON.stringify({ percentThreshold: 0.99, absoluteThreshold: 999 })
        ]
      );
      const incidentId = inserted.rows[0]!.id;
      const forged = await applyFeedMerchantCorrelation(client, {
        incidentId,
        candidateId: scenario.candidateId
      });
      const eventCountAfterForgery = await client.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count
          FROM incident_events
          WHERE incident_id = $1
            AND event_type = 'feed_merchant_correlation_confirmed'
        `,
        [incidentId]
      );
      await client.query(
        `
          UPDATE incidents
          SET thresholds_json = candidates.thresholds_json
          FROM incident_candidates AS candidates
          WHERE incidents.id = $1
            AND candidates.id = $2
        `,
        [incidentId, scenario.candidateId]
      );
      const first = await applyFeedMerchantCorrelation(client, {
        incidentId,
        candidateId: scenario.candidateId
      });
      const replay = await applyFeedMerchantCorrelation(client, {
        incidentId,
        candidateId: scenario.candidateId
      });

      return {
        incidentId,
        forged,
        eventCountAfterForgery: eventCountAfterForgery.rows[0]?.count,
        first,
        replay
      };
    });

    expect(result.forged).toEqual({ correlated: false, reason: "incident_unavailable" });
    expect(result.eventCountAfterForgery).toBe("0");
    expect(result.first).toEqual({ correlated: true, reason: "correlated" });
    expect(result.replay).toEqual({ correlated: true, reason: "already_recorded" });

    const inspector = new Client({ connectionString: dbUrlWithSchema });
    await inspector.connect();
    const events = await inspector.query<{ count: string; snapshot_id: string | null }>(
      `
        SELECT COUNT(*)::text AS count, MAX(snapshot_id::text) AS snapshot_id
        FROM incident_events
        WHERE incident_id = $1
          AND event_type = 'feed_merchant_correlation_confirmed'
      `,
      [result.incidentId]
    );
    const confidence = await inspector.query<{ confidence_score: string }>(
      "SELECT confidence_score FROM incidents WHERE id = $1",
      [result.incidentId]
    );
    await inspector.end();

    expect(events.rows[0]).toEqual({
      count: "1",
      snapshot_id: scenario.observedSnapshotId
    });
    expect(events.rows[0]?.snapshot_id).not.toBe(unrelatedSnapshot.id);
    expect(Number(confidence.rows[0]?.confidence_score)).toBe(0.95);
  });

  it("uses Merchant status completion time as the baseline cutoff", async () => {
    const scenario = await createCatalogDropScenario(db, {
      suffix: "late-status-baseline",
      accountId: "490"
    });
    const inspector = new Client({ connectionString: dbUrlWithSchema });
    await inspector.connect();
    const updated = await inspector.query<{ finished_at: Date }>(
      `
        UPDATE source_checks AS baseline_status
        SET finished_at = observed_status.finished_at + interval '1 hour'
        FROM source_checks AS observed_status
        WHERE baseline_status.snapshot_id = $1
          AND baseline_status.source = 'merchant_center'
          AND baseline_status.metadata_json ->> 'merchantStatusAggregationVersion' = 'v1'
          AND observed_status.snapshot_id = $2
          AND observed_status.source = 'merchant_center'
          AND observed_status.metadata_json ->> 'merchantStatusAggregationVersion' = 'v1'
        RETURNING baseline_status.finished_at
      `,
      [scenario.baselineSnapshotIds[0], scenario.observedSnapshotId]
    );
    await inspector.end();
    expect(updated.rows).toHaveLength(1);

    const confirmed = await db.confirmFeedCatalogDropCandidate(
      scenario.candidateId,
      scenario.confirmationSnapshotId
    );
    expect(confirmed.incidentId).toBeTruthy();

    const verifier = new Client({ connectionString: dbUrlWithSchema });
    await verifier.connect();
    const correlation = await verifier.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM incident_events
        WHERE incident_id = $1
          AND event_type = 'feed_merchant_correlation_confirmed'
      `,
      [confirmed.incidentId]
    );
    const confidence = await verifier.query<{ confidence_score: string }>(
      "SELECT confidence_score FROM incidents WHERE id = $1",
      [confirmed.incidentId]
    );
    await verifier.end();

    expect(correlation.rows[0]?.count).toBe("0");
    expect(Number(confidence.rows[0]?.confidence_score)).toBe(0.85);
  });

  it("uses at most one Merchant approved observation from each baseline snapshot", async () => {
    const scenario = await createCatalogDropScenario(db, {
      suffix: "duplicate-status-baseline",
      accountId: "491"
    });
    const inspector = new Client({ connectionString: dbUrlWithSchema });
    await inspector.connect();
    const removed = await inspector.query(
      `
        DELETE FROM source_checks
        WHERE snapshot_id = $1
          AND source = 'merchant_center'
          AND metadata_json ->> 'merchantStatusAggregationVersion' = 'v1'
      `,
      [scenario.baselineSnapshotIds[0]]
    );
    const duplicated = await inspector.query(
      `
        INSERT INTO source_checks (
          snapshot_id,
          store_id,
          source,
          check_key,
          url,
          status,
          started_at,
          finished_at,
          duration_ms,
          items_observed,
          total_items_seen,
          skipped_items,
          metadata_json
        )
        SELECT
          snapshot_id,
          store_id,
          source,
          check_key || ':duplicate-status',
          url,
          status,
          started_at,
          finished_at,
          duration_ms,
          items_observed,
          total_items_seen,
          skipped_items,
          metadata_json
        FROM source_checks
        WHERE snapshot_id = $1
          AND source = 'merchant_center'
          AND metadata_json ->> 'merchantStatusAggregationVersion' = 'v1'
      `,
      [scenario.baselineSnapshotIds[1]]
    );
    await inspector.end();
    expect(removed.rowCount).toBe(1);
    expect(duplicated.rowCount).toBe(1);

    const confirmed = await db.confirmFeedCatalogDropCandidate(
      scenario.candidateId,
      scenario.confirmationSnapshotId
    );
    expect(confirmed.incidentId).toBeTruthy();

    const verifier = new Client({ connectionString: dbUrlWithSchema });
    await verifier.connect();
    const correlation = await verifier.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM incident_events
        WHERE incident_id = $1
          AND event_type = 'feed_merchant_correlation_confirmed'
      `,
      [confirmed.incidentId]
    );
    await verifier.end();

    expect(correlation.rows[0]?.count).toBe("0");
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
    feedItemsObserved?: number;
    merchant: SourceItemInput[];
    approvedCount: number;
    merchantStatus?: SourceCheckResult["status"];
    merchantStatusFinishedAt?: string;
  }
) {
  const snapshot = await db.createQueuedSnapshot(input.storeId, "normal_check", input.idempotencyKey);
  await db.persistFeedCheckResult(
    snapshot.id,
    input.storeId,
    feedResult(input.feed, input.feedUrl, input.feedItemsObserved)
  );
  await db.persistSourceCheckResult(
    snapshot.id,
    input.storeId,
    merchantStatusResult({
      accountId: input.accountId,
      approved: input.approvedCount,
      total: input.merchant.length,
      status: input.merchantStatus,
      finishedAt: input.merchantStatusFinishedAt
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
    feed?: SourceItemInput[];
    feedItemsObserved?: number;
    merchant?: SourceItemInput[];
    merchantStatus?: SourceCheckResult["status"];
    approvedCount?: number;
  }
): Promise<{
  storeId: string;
  candidateId: string;
  observedSnapshotId: string;
  confirmationSnapshotId: string;
  baselineSnapshotIds: string[];
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

  const baselineSnapshotIds: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const baselineSnapshot = await createComparableSnapshot(db, {
      storeId: created.store.id,
      accountId: input.accountId,
      idempotencyKey: `${input.suffix}-baseline-${index}`,
      feed: feedItems(100),
      feedUrl: `${domain}/feed.xml`,
      merchant: merchantItems(100),
      approvedCount: 100
    });
    baselineSnapshotIds.push(baselineSnapshot.id);
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
    feed: input.feed ?? feedItems(70),
    feedUrl: `${domain}/feed.xml`,
    merchant: input.merchant ?? merchantItems(100),
    approvedCount: input.approvedCount ?? 70,
    feedItemsObserved: input.feedItemsObserved,
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
    confirmationSnapshotId: confirmation.id,
    baselineSnapshotIds
  };
}
