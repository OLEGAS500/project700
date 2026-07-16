import type { SourceCheckResult, SourceItemInput } from "@eim/core";
import {
  closePool,
  confirmBaselineMetric,
  confirmFeedCatalogDropCandidate,
  connectMerchantCenter,
  createOrUpdateFeedSourceHealthIncident,
  createQueuedSnapshot,
  createStore,
  evaluateFeedCatalogDropCandidate,
  getIncidentDetail,
  getPool,
  listIncidents,
  merchantItemIssuesConfigurationHash,
  persistFeedCheckResult,
  persistMerchantCenterItemIssuesResult,
  persistSourceCheckResult,
  recalculateFeedProductCountBaseline,
  updateCatalogDropRecovery,
  withTransaction
} from "@eim/db";

const fixtureVersion = "v01-demo-acceptance-v1";
const fixtureAccountId = "991001";
const mainDomain = "https://v01-demo-catalog-drop.example.test";
const sourceHealthDomain = "https://v01-demo-source-health.example.test";
const fixtureDomains = [mainDomain, sourceHealthDomain];
const defaultWebBaseUrl = "http://localhost:3000";
const baselineCount = 642;
const merchantBaselineApproved = 620;
const dropCategoryCount = 17;
const dropFeedCount = 21;
const dropMerchantApproved = 30;
const actorId = "00000000-0000-0000-0000-0000000000d1";

type Command = "seed" | "recovering" | "resolved" | "cleanup";

type FixtureStore = {
  storeId: string;
  incidentId: string;
  firstDropSnapshotId: string;
  confirmationSnapshotId: string;
};

type FixtureClock = {
  at: (minuteOffset: number) => string;
};

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required for the v0.1 demo fixture.");
  }

  const command = parseCommand(process.argv.slice(2));
  if (command === "cleanup") {
    const removed = await cleanupWithIsolationAssertion();
    console.log(`v0.1 demo fixture cleanup complete; removed stores: ${removed}.`);
    return;
  }

  if (command === "seed") {
    const removed = await cleanupWithIsolationAssertion();
    const clock = createFixtureClock();
    const mainStore = await seedMainStore(clock);
    const sourceHealthStore = await seedSourceHealthStore(clock);
    await assertSeedAcceptance(mainStore, sourceHealthStore.storeId);
    printSeedSummary(mainStore, sourceHealthStore);
    console.log(`Previous fixture stores removed: ${removed}`);
    return;
  }

  if (command === "recovering") {
    await advanceRecovery("recovering");
    return;
  }

  await advanceRecovery("resolved");
}

function parseCommand(args: string[]): Command {
  const command = args[0] ?? "seed";
  if (["seed", "recovering", "resolved", "cleanup"].includes(command) && args.length === 1) {
    return command as Command;
  }
  throw new Error(
    "Usage: tsx scripts/seed-v01-demo.ts [seed|recovering|resolved|cleanup]"
  );
}

function createFixtureClock(): FixtureClock {
  // Every check in a single command is derived from this runtime base and is deliberately in the past.
  const base = Date.now() - 60 * 60 * 1_000;
  return {
    at(minuteOffset: number): string {
      return new Date(base + minuteOffset * 60 * 1_000).toISOString();
    }
  };
}

async function seedMainStore(clock: FixtureClock): Promise<FixtureStore> {
  const created = await createStore({
    name: "v0.1 Demo — Feed × Merchant catalog drop",
    domain: mainDomain,
    sitemapUrl: `${mainDomain}/sitemap.xml`,
    feedUrl: `${mainDomain}/feed.xml`,
    categoryUrls: [`${mainDomain}/collections/all`]
  });
  await connectMerchantCenter(created.store.id, { merchantCenterAccountId: fixtureAccountId });

  for (let index = 0; index < 7; index += 1) {
    const snapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      `${fixtureVersion}:main:baseline:${index}`
    );
    const at = clock.at(index);
    await persistStableStorefrontContext(snapshot.id, created.store.id, mainDomain, baselineCount, at);
    await persistFeedCheckResult(
      snapshot.id,
      created.store.id,
      feedResult(mainDomain, [], baselineCount, at)
    );
    await persistSourceCheckResult(
      snapshot.id,
      created.store.id,
      merchantStatusResult(merchantBaselineApproved, merchantBaselineApproved, at)
    );
    await persistMerchantCenterItemIssuesResult(
      snapshot.id,
      created.store.id,
      merchantIdentityResult(merchantInventoryItems(), at)
    );
  }

  const baseline = requireValue(
    await recalculateFeedProductCountBaseline(created.store.id),
    "The fixture did not create a feed baseline metric."
  );
  await confirmBaselineMetric(baseline.id, actorId);

  const firstDrop = await createQueuedSnapshot(
    created.store.id,
    "normal_check",
    `${fixtureVersion}:main:first-drop`
  );
  const dropAt = clock.at(10);
  await persistStableStorefrontContext(firstDrop.id, created.store.id, mainDomain, dropCategoryCount, dropAt);
  await persistFeedCheckResult(
    firstDrop.id,
    created.store.id,
    feedResult(mainDomain, feedItems(dropFeedCount), dropFeedCount, dropAt)
  );
  await persistSourceCheckResult(
    firstDrop.id,
    created.store.id,
    merchantStatusResult(dropMerchantApproved, merchantBaselineApproved, dropAt)
  );
  await persistMerchantCenterItemIssuesResult(
    firstDrop.id,
    created.store.id,
    merchantIdentityResult(merchantInventoryItems(), dropAt)
  );

  const candidate = requireValue(
    await evaluateFeedCatalogDropCandidate(created.store.id, firstDrop.id),
    "The feed drop did not create a pending candidate."
  );
  assert(candidate.status === "pending_confirmation", "The feed drop did not create a pending candidate.");

  const confirmation = await createQueuedSnapshot(
    created.store.id,
    "confirmation_check",
    `${fixtureVersion}:main:confirmation`
  );
  await persistFeedCheckResult(
    confirmation.id,
    created.store.id,
    feedResult(mainDomain, feedItems(dropFeedCount), dropFeedCount, clock.at(11))
  );
  const confirmed = await confirmFeedCatalogDropCandidate(candidate.id, confirmation.id);
  const incidentId = requireValue(
    confirmed.incidentId,
    "The confirmation did not create a catalog-drop incident."
  );

  return {
    storeId: created.store.id,
    incidentId,
    firstDropSnapshotId: firstDrop.id,
    confirmationSnapshotId: confirmation.id
  };
}

async function seedSourceHealthStore(clock: FixtureClock): Promise<{ storeId: string; incidentId: string }> {
  const created = await createStore({
    name: "v0.1 Demo — Feed source health",
    domain: sourceHealthDomain,
    sitemapUrl: `${sourceHealthDomain}/sitemap.xml`,
    feedUrl: `${sourceHealthDomain}/feed.xml`,
    categoryUrls: [`${sourceHealthDomain}/collections/all`]
  });

  const healthy = await createQueuedSnapshot(
    created.store.id,
    "normal_check",
    `${fixtureVersion}:source-health:healthy`
  );
  await persistStableStorefrontContext(
    healthy.id,
    created.store.id,
    sourceHealthDomain,
    baselineCount,
    clock.at(20)
  );
  await persistFeedCheckResult(
    healthy.id,
    created.store.id,
    feedResult(sourceHealthDomain, [], baselineCount, clock.at(20))
  );
  await createOrUpdateFeedSourceHealthIncident(created.store.id, healthy.id);

  let incidentId: string | null = null;
  for (let index = 1; index <= 2; index += 1) {
    const snapshot = await createQueuedSnapshot(
      created.store.id,
      "normal_check",
      `${fixtureVersion}:source-health:unavailable:${index}`
    );
    const at = clock.at(20 + index);
    await persistStableStorefrontContext(snapshot.id, created.store.id, sourceHealthDomain, baselineCount, at);
    await persistFeedCheckResult(snapshot.id, created.store.id, sourceUnavailableFeedResult(sourceHealthDomain, at));
    assert(
      (await evaluateFeedCatalogDropCandidate(created.store.id, snapshot.id)) === null,
      "A source-unavailable feed check must not create a catalog-drop candidate."
    );
    const current = await createOrUpdateFeedSourceHealthIncident(created.store.id, snapshot.id);
    if (index === 1) {
      assert(current === null, "One source-unavailable result must not open source health at the default threshold.");
    } else {
      incidentId = current;
    }
  }

  return {
    storeId: created.store.id,
    incidentId: requireValue(
      incidentId,
      "Two source-unavailable checks did not open a source-health incident."
    )
  };
}

async function advanceRecovery(target: "recovering" | "resolved"): Promise<void> {
  const mainStore = await getFixtureMainStore();
  const clock = createFixtureClock();
  const isFirstHealthyCheck = target === "recovering";
  const idempotencyKey = `${fixtureVersion}:main:recovery:${isFirstHealthyCheck ? "one" : "two"}`;
  const snapshot = await createQueuedSnapshot(mainStore.storeId, "normal_check", idempotencyKey);
  await persistFeedCheckResult(
    snapshot.id,
    mainStore.storeId,
    feedResult(mainDomain, [], baselineCount, clock.at(30))
  );

  const before = requireValue(
    await getIncidentDetail(mainStore.incidentId),
    "The seeded catalog-drop incident is unavailable."
  );
  if (target === "recovering") {
    assert(
      before.status === "open" || before.status === "recovering",
      `Expected an open or recovering catalog-drop incident, received ${before.status}.`
    );
  } else {
    assert(
      before.status === "recovering" || before.status === "resolved",
      `Run advance:v01-demo:recovering before resolving; current status is ${before.status}.`
    );
  }

  const eventsBefore = await lifecycleEventCounts(mainStore.incidentId);
  const transitions = await updateCatalogDropRecovery(mainStore.storeId, snapshot.id);
  const after = requireValue(
    await getIncidentDetail(mainStore.incidentId),
    "The catalog-drop incident disappeared during recovery."
  );

  if (target === "recovering") {
    assert(after.status === "recovering", "The first healthy feed check did not move the incident to recovering.");
    assert(
      transitions.some((transition) => transition.transition === "recovering_started" || transition.transition === "no_change"),
      "Recovery did not report a recovering transition or an idempotent no-change result."
    );
    await assertRecoveryEvents(mainStore.incidentId, 1, 0, eventsBefore);
    console.log(`v0.1 demo catalog-drop incident is recovering: ${mainStore.incidentId}`);
    return;
  }

  assert(after.status === "resolved", "The second healthy feed check did not resolve the incident.");
  assert(
    transitions.length === 0 || transitions.some((transition) => transition.transition === "resolved" || transition.transition === "no_change"),
    "Resolution did not report a resolved transition or an idempotent no-change result."
  );
  await assertRecoveryEvents(mainStore.incidentId, 1, 1, eventsBefore);
  console.log(`v0.1 demo catalog-drop incident is resolved: ${mainStore.incidentId}`);
}

async function getFixtureMainStore(): Promise<{ storeId: string; incidentId: string }> {
  const store = await getPool().query<{ id: string }>("SELECT id FROM stores WHERE domain = $1", [mainDomain]);
  const storeId = requireValue(
    store.rows[0]?.id,
    "Fixture not found. Run npm run seed:v01-demo first."
  );
  const incidents = await listIncidents({ storeId });
  const incident = requireValue(
    incidents.find((entry) => entry.type === "catalog_drop"),
    "Fixture has no catalog-drop incident. Run npm run seed:v01-demo again."
  );
  return { storeId, incidentId: incident.id };
}

async function assertSeedAcceptance(mainStore: FixtureStore, sourceHealthStoreId: string): Promise<void> {
  const mainDetail = requireValue(
    await getIncidentDetail(mainStore.incidentId),
    "Catalog-drop detail model is unavailable."
  );
  assert(mainDetail.type === "catalog_drop", "Expected one catalog-drop incident.");
  assert(mainDetail.status === "open", "The confirmed catalog-drop incident must be open before recovery.");
  assert(mainDetail.severity === "critical", "The fixture catalog-drop incident must be critical.");
  assert(mainDetail.affectedCount === 621, `Expected affectedCount 621, received ${mainDetail.affectedCount}.`);
  assert(mainDetail.confidenceScore === 0.95, "Correlation must raise confidence to 0.95.");
  assert(mainDetail.likelySource === "feed_or_publication", "Unexpected catalog-drop likely source.");

  const baseline = await getPool().query<{
    sample_count: number;
    median_value: string;
    status: string;
  }>(
    "SELECT sample_count, median_value, status FROM baseline_metrics WHERE id = $1",
    [mainDetail.baselineMetricId]
  );
  assert(baseline.rows[0]?.sample_count === 7, "Feed baseline must contain seven observations.");
  assert(Number(baseline.rows[0]?.median_value) === baselineCount, "Feed baseline median must be 642.");
  assert(baseline.rows[0]?.status === "active", "Feed baseline must be confirmed and active.");

  const firstDropChecks = await getPool().query<{
    source: string;
    status: string;
    items_observed: number;
    metadata_json: Record<string, unknown>;
  }>(
    `
      SELECT source, status, items_observed, metadata_json
      FROM source_checks
      WHERE snapshot_id = $1
      ORDER BY source, check_key
    `,
    [mainStore.firstDropSnapshotId]
  );
  assert(firstDropChecks.rows.length === 5, "Drop snapshot must include category, sitemap, Feed, and two Merchant checks.");
  assert(firstDropChecks.rows.every((check) => check.status === "success"), "All drop-snapshot checks must succeed.");
  assert(
    firstDropChecks.rows.some((check) => check.source === "category" && check.items_observed === dropCategoryCount),
    "Drop category count must be 17."
  );
  assert(
    firstDropChecks.rows.some((check) => check.source === "sitemap" && check.items_observed === baselineCount),
    "Drop sitemap count must remain 642."
  );
  assert(
    firstDropChecks.rows.some((check) => check.source === "feed" && check.items_observed === dropFeedCount),
    "Drop Feed count must be 21."
  );
  assert(
    firstDropChecks.rows.some(
      (check) =>
        check.source === "merchant_center" &&
        (check.metadata_json.merchantStatusCounts as Record<string, unknown> | undefined)?.approved ===
          dropMerchantApproved
    ),
    "Drop Merchant approved count must be 30."
  );
  const identityCount = await getPool().query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM source_items
      WHERE snapshot_id = $1
        AND source = 'merchant_center'
        AND metadata_json ->> 'merchantDataKind' = 'product_identity'
    `,
    [mainStore.firstDropSnapshotId]
  );
  assert(identityCount.rows[0]?.count === "620", "Drop snapshot Merchant identity inventory must contain 620 products.");

  const signal = (source: string, metric: string) =>
    mainDetail.signals.find((entry) => entry.source === source && entry.metric === metric);
  const feedSignal = signal("feed", "product_count");
  const merchantSignal = signal("merchant_center", "approved_product_count");
  const mappingSignal = signal("feed_vs_merchant_center", "merchant_inventory_missing_from_feed");
  assert(feedSignal?.beforeValue === baselineCount && feedSignal.afterValue === dropFeedCount, "Feed signal must be 642 → 21.");
  assert(
    merchantSignal?.beforeValue === merchantBaselineApproved && merchantSignal.afterValue === dropMerchantApproved,
    "Merchant signal must be 620 → 30."
  );
  assert(mappingSignal?.beforeValue === 21 && mappingSignal.afterValue === 599, "Mapping signal must describe 21 matched and 599 Merchant-only products.");
  assert(mainDetail.signals.length === 3, "The immutable opened incident must contain exactly three signals.");
  assert(
    (mappingSignal?.sampleItems.length ?? 0) > 0 && (mappingSignal?.sampleItems.length ?? 0) <= 20,
    "Mapping evidence must be present and bounded."
  );

  const correlation = mainDetail.events.filter(
    (event) => event.eventType === "feed_merchant_correlation_confirmed"
  );
  assert(correlation.length === 1, "Expected exactly one Feed × Merchant correlation event.");
  assert(
    correlation[0]?.snapshotId === mainStore.firstDropSnapshotId,
    "Correlation must be bound to the first immutable drop snapshot."
  );
  const mapping = correlation[0]?.metadata.mapping as Record<string, unknown> | undefined;
  assert(mapping?.matchedCount === 21, "Correlation mapping must report 21 matches.");
  assert(mapping?.feedOnlyCount === 0, "Correlation mapping must report zero feed-only products.");
  assert(mapping?.merchantOnlyCount === 599, "Correlation mapping must report 599 Merchant-only products.");
  assert(mapping?.ambiguousCount === 0, "Correlation mapping must report zero ambiguous products.");
  assert(mapping?.reconciledFeedCount === 21, "Correlation mapping must reconcile all 21 feed products.");
  assert(correlation[0]?.metadata.merchantBaselineSampleCount === 7, "Correlation must use seven Merchant baseline observations.");

  const opened = requireValue(
    mainDetail.events.find((event) => event.eventType === "incident_opened"),
    "The immutable incident_opened event is missing."
  );
  const payload = await getPool().query<{ payload_json: Record<string, unknown> }>(
    `
      SELECT alert_event_payloads.payload_json
      FROM alert_event_payloads
      WHERE incident_event_id = $1
    `,
    [opened.id]
  );
  assert(payload.rows.length === 1, "The opened incident must have one immutable alert payload.");
  const payloadJson = JSON.stringify(payload.rows[0]?.payload_json);
  const payloadIncident = payload.rows[0]?.payload_json.incident as Record<string, unknown> | undefined;
  const payloadMetrics = payload.rows[0]?.payload_json.metrics;
  const payloadSamples = payload.rows[0]?.payload_json.samples;
  assert(payloadIncident?.confidenceScore === 0.95, "Opened alert payload must retain .95 confidence.");
  assert(Array.isArray(payloadMetrics) && payloadMetrics.length === 3, "Opened alert payload must retain three signals.");
  assert(
    Array.isArray(payloadSamples) && payloadSamples.length > 0 && payloadSamples.length <= 8,
    "Opened alert payload samples must be present and bounded."
  );
  assert(payloadJson.includes("approved_product_count"), "Opened alert payload is missing Merchant evidence.");
  assert(payloadJson.includes("merchant_inventory_missing_from_feed"), "Opened alert payload is missing mapping evidence.");
  assertNoRawProviderData(payloadJson, "opened alert payload");
  assertNoRawProviderData(JSON.stringify(correlation[0]?.metadata), "correlation event");

  const candidate = await getPool().query<{
    status: string;
    first_snapshot_id: string;
    confirmation_snapshot_id: string | null;
  }>(
    "SELECT status, first_snapshot_id, confirmation_snapshot_id FROM incident_candidates WHERE id = $1",
    [await candidateIdForIncident(mainDetail.id)]
  );
  assert(candidate.rows[0]?.status === "confirmed", "The catalog-drop candidate must be confirmed.");
  assert(candidate.rows[0]?.first_snapshot_id === mainStore.firstDropSnapshotId, "Candidate first snapshot changed.");
  assert(
    candidate.rows[0]?.confirmation_snapshot_id === mainStore.confirmationSnapshotId,
    "Candidate confirmation snapshot changed."
  );

  const mainIncidents = await listIncidents({ storeId: mainStore.storeId });
  assert(mainIncidents.filter((incident) => incident.type === "catalog_drop").length === 1, "Fixture created more than one catalog-drop incident.");
  assert(mainIncidents.every((incident) => incident.type !== "merchant_item_issues"), "Fixture must not create a Merchant-only incident type.");

  const sourceIncidents = await listIncidents({ storeId: sourceHealthStoreId });
  const sourceHealth = sourceIncidents.filter((incident) => incident.type === "source_health");
  assert(sourceHealth.length === 1, "Expected exactly one Feed source-health incident.");
  assert(sourceHealth[0]?.status === "open", "Source-health incident should remain open in the demo seed.");
  assert(
    sourceHealth[0]?.summary.toLowerCase().includes("source status: source_unavailable"),
    "Source-health wording must identify the Feed as source_unavailable."
  );
  assert(!sourceHealth[0]?.summary.toLowerCase().includes("products disappeared"), "Source-health wording must not claim product loss.");
  assert(sourceIncidents.every((incident) => incident.type !== "catalog_drop"), "Source failure must not create a catalog-drop incident.");
  const sourceEvents = await getIncidentDetail(sourceHealth[0]!.id);
  assert(
    sourceEvents?.events.filter((event) => event.eventType === "incident_opened").length === 1,
    "Source-health incident must have one opened event."
  );
  const unavailableChecks = await getPool().query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM source_checks
      WHERE store_id = $1
        AND source = 'feed'
        AND status = 'source_unavailable'
        AND http_status = 503
    `,
    [sourceHealthStoreId]
  );
  assert(unavailableChecks.rows[0]?.count === "2", "Source-health fixture must persist two Feed HTTP 503 checks.");
  const healthyCompanions = await getPool().query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM source_checks
      WHERE store_id = $1
        AND source IN ('category', 'sitemap')
        AND status = 'success'
    `,
    [sourceHealthStoreId]
  );
  assert(healthyCompanions.rows[0]?.count === "6", "Category and sitemap must stay healthy for all source-health snapshots.");
  const sourceCandidates = await getPool().query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM incident_candidates WHERE store_id = $1 AND type = 'catalog_drop'",
    [sourceHealthStoreId]
  );
  assert(sourceCandidates.rows[0]?.count === "0", "Source failure must not create a catalog-drop candidate.");
}

async function candidateIdForIncident(incidentId: string): Promise<string> {
  const result = await getPool().query<{ catalog_drop_candidate_id: string | null }>(
    "SELECT catalog_drop_candidate_id FROM incidents WHERE id = $1",
    [incidentId]
  );
  return requireValue(
    result.rows[0]?.catalog_drop_candidate_id,
    "Catalog-drop incident is missing its candidate binding."
  );
}

async function lifecycleEventCounts(incidentId: string): Promise<{ healthy: number; resolved: number }> {
  const result = await getPool().query<{ event_type: string; count: string }>(
    `
      SELECT event_type, COUNT(*)::text AS count
      FROM incident_events
      WHERE incident_id = $1
        AND event_type IN ('catalog_drop_recovery_healthy', 'catalog_drop_resolved')
      GROUP BY event_type
    `,
    [incidentId]
  );
  return {
    healthy: Number(result.rows.find((row) => row.event_type === "catalog_drop_recovery_healthy")?.count ?? 0),
    resolved: Number(result.rows.find((row) => row.event_type === "catalog_drop_resolved")?.count ?? 0)
  };
}

async function assertRecoveryEvents(
  incidentId: string,
  expectedHealthy: number,
  expectedResolved: number,
  before: { healthy: number; resolved: number }
): Promise<void> {
  const after = await lifecycleEventCounts(incidentId);
  assert(after.healthy === expectedHealthy, `Expected ${expectedHealthy} recovery-healthy event, received ${after.healthy}.`);
  assert(after.resolved === expectedResolved, `Expected ${expectedResolved} resolved event, received ${after.resolved}.`);
  assert(after.healthy >= before.healthy && after.resolved >= before.resolved, "Recovery event counts must not decrease.");
  const recoveryChecks = await getPool().query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM source_checks
      JOIN snapshots ON snapshots.id = source_checks.snapshot_id
      JOIN stores ON stores.id = snapshots.store_id
      WHERE stores.domain = $1
        AND snapshots.idempotency_key LIKE $2
        AND source_checks.source = 'merchant_center'
    `,
    [mainDomain, `${fixtureVersion}:main:recovery:%`]
  );
  assert(recoveryChecks.rows[0]?.count === "0", "Catalog-drop recovery must remain feed-only.");
}

async function cleanupWithIsolationAssertion(): Promise<number> {
  const before = await unrelatedStoreCount();
  const removed = await cleanupFixture();
  const after = await unrelatedStoreCount();
  assert(before === after, "Fixture cleanup touched an unrelated store.");
  const remaining = await getPool().query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM stores WHERE domain = ANY($1::text[])",
    [fixtureDomains]
  );
  assert(remaining.rows[0]?.count === "0", "Fixture cleanup left a fixture store behind.");
  return removed;
}

async function unrelatedStoreCount(): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM stores WHERE domain <> ALL($1::text[])",
    [fixtureDomains]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function cleanupFixture(): Promise<number> {
  return withTransaction(async (client) => {
    await client.query(
      `
        DELETE FROM alert_event_payloads
        WHERE store_id = ANY(SELECT id FROM stores WHERE domain = ANY($1::text[]))
      `,
      [fixtureDomains]
    );
    await client.query(
      `
        DELETE FROM alert_deliveries
        WHERE store_id = ANY(SELECT id FROM stores WHERE domain = ANY($1::text[]))
      `,
      [fixtureDomains]
    );
    const removed = await client.query<{ id: string }>(
      "DELETE FROM stores WHERE domain = ANY($1::text[]) RETURNING id",
      [fixtureDomains]
    );
    return removed.rows.length;
  });
}

async function persistStableStorefrontContext(
  snapshotId: string,
  storeId: string,
  domain: string,
  categoryCount: number,
  at: string
): Promise<void> {
  await persistSourceCheckResult(snapshotId, storeId, categoryResult(domain, categoryCount, at));
  await persistSourceCheckResult(snapshotId, storeId, sitemapResult(domain, baselineCount, at));
}

function categoryResult(domain: string, itemsObserved: number, at: string): SourceCheckResult {
  return {
    source: "category",
    url: `${domain}/collections/all`,
    status: "success",
    startedAt: at,
    finishedAt: plusSecond(at),
    durationMs: 1_000,
    itemsObserved,
    totalItemsSeen: itemsObserved,
    skippedItems: 0,
    items: []
  };
}

function sitemapResult(domain: string, itemsObserved: number, at: string): SourceCheckResult {
  return {
    source: "sitemap",
    url: `${domain}/sitemap.xml`,
    status: "success",
    startedAt: at,
    finishedAt: plusSecond(at),
    durationMs: 1_000,
    itemsObserved,
    totalItemsSeen: itemsObserved,
    skippedItems: 0,
    items: []
  };
}

function feedResult(
  domain: string,
  items: SourceItemInput[],
  itemsObserved: number,
  at: string
): SourceCheckResult {
  return {
    source: "feed",
    url: `${domain}/feed.xml`,
    status: "success",
    startedAt: at,
    finishedAt: plusSecond(at),
    durationMs: 1_000,
    itemsObserved,
    totalItemsSeen: itemsObserved,
    skippedItems: 0,
    items
  };
}

function sourceUnavailableFeedResult(domain: string, at: string): SourceCheckResult {
  return {
    source: "feed",
    url: `${domain}/feed.xml`,
    status: "source_unavailable",
    startedAt: at,
    finishedAt: plusSecond(at),
    durationMs: 1_000,
    httpStatus: 503,
    itemsObserved: 0,
    totalItemsSeen: 0,
    skippedItems: 0,
    items: [],
    errorCode: "fixture_feed_http_503",
    errorMessage: "Fixture feed source unavailable (HTTP 503).",
    errorSamples: ["HTTP 503"]
  };
}

function merchantStatusResult(approved: number, total: number, at: string): SourceCheckResult {
  return {
    source: "merchant_center",
    url: `https://merchantapi.googleapis.com/issueresolution/v1/accounts/${fixtureAccountId}/aggregateProductStatuses`,
    status: "success",
    startedAt: at,
    finishedAt: plusSecond(at),
    durationMs: 1_000,
    itemsObserved: total,
    totalItemsSeen: 1,
    skippedItems: 0,
    items: [],
    metadata: {
      merchantStatusAggregationVersion: "v1",
      merchantCenterConfigurationHash: merchantItemIssuesConfigurationHash(fixtureAccountId),
      merchantStatusCounts: {
        total,
        approved,
        pending: total - approved,
        disapproved: 0
      }
    }
  };
}

function merchantIdentityResult(items: SourceItemInput[], at: string): SourceCheckResult {
  return {
    source: "merchant_center",
    url: `https://merchantapi.googleapis.com/products/v1/accounts/${fixtureAccountId}/products`,
    status: "success",
    startedAt: at,
    finishedAt: plusSecond(at),
    durationMs: 1_000,
    itemsObserved: 0,
    totalItemsSeen: items.length,
    skippedItems: 0,
    items,
    metadata: {
      merchantItemIssuesVersion: "v1",
      merchantProductIdentityVersion: "v1",
      merchantProductIdentityComplete: true,
      merchantItemIssuesConfigurationHash: merchantItemIssuesConfigurationHash(fixtureAccountId),
      productsSeen: items.length,
      productsWithIssues: 0,
      issuesObserved: 0,
      pagination: { pagesFetched: 1, complete: true }
    }
  };
}

function feedItems(count: number): SourceItemInput[] {
  return Array.from({ length: count }, (_, index) => {
    const productNumber = index + 1;
    return {
      source: "feed",
      stableKey: `feed:demo-sku-${productNumber}`,
      offerId: `SKU ${productNumber}`,
      title: `Demo feed product ${productNumber}`,
      url: `${mainDomain}/products/${productNumber}`,
      rawHash: `${fixtureVersion}:feed:${productNumber}`
    };
  });
}

function merchantInventoryItems(): SourceItemInput[] {
  const matched = Array.from({ length: dropFeedCount }, (_, index) => {
    const productNumber = index + 1;
    return {
      source: "merchant_center" as const,
      stableKey: `merchant:demo-sku-${productNumber}`,
      offerId: ` sku ${productNumber} `,
      title: `Demo Merchant product ${productNumber}`,
      merchantStatus: "approved" as const,
      rawHash: `${fixtureVersion}:merchant:matched:${productNumber}`
    };
  });
  const merchantOnly = Array.from({ length: merchantBaselineApproved - dropFeedCount }, (_, index) => {
    const productNumber = dropFeedCount + index + 1;
    return {
      source: "merchant_center" as const,
      stableKey: `merchant:demo-only-${productNumber}`,
      offerId: `Merchant only ${productNumber}`,
      title: `Demo Merchant-only product ${productNumber}`,
      merchantStatus: "approved" as const,
      rawHash: `${fixtureVersion}:merchant:only:${productNumber}`
    };
  });
  return [...matched, ...merchantOnly];
}

function plusSecond(iso: string): string {
  return new Date(Date.parse(iso) + 1_000).toISOString();
}

function assertNoRawProviderData(value: string, location: string): void {
  const normalized = value.toLowerCase();
  assert(!normalized.includes("merchantapi.googleapis.com"), `${location} leaked a Merchant provider URL.`);
  assert(!normalized.includes("oauth"), `${location} leaked OAuth material.`);
  assert(!normalized.includes("access_token"), `${location} leaked an access token field.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireValue<T>(value: T, message: string): NonNullable<T> {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function printSeedSummary(
  mainStore: FixtureStore,
  sourceHealthStore: { storeId: string; incidentId: string }
): void {
  const webBaseUrl = (process.env.WEB_BASE_URL?.trim() || defaultWebBaseUrl).replace(/\/$/, "");
  console.log("v0.1 reproducible demo fixture is ready.");
  console.log(`Fixture version: ${fixtureVersion}`);
  console.log(`Catalog-drop store: ${mainStore.storeId}`);
  console.log(`Catalog-drop incident: ${mainStore.incidentId}`);
  console.log(`Catalog-drop incident URL: ${webBaseUrl}/incidents/${mainStore.incidentId}`);
  console.log(`Dashboard URL: ${webBaseUrl}/dashboard`);
  console.log(`First drop snapshot: ${mainStore.firstDropSnapshotId}`);
  console.log(`Confirmation snapshot: ${mainStore.confirmationSnapshotId}`);
  console.log(`Source-health store: ${sourceHealthStore.storeId}`);
  console.log(`Source-health incident: ${sourceHealthStore.incidentId}`);
  console.log("Next: npm run advance:v01-demo:recovering, then npm run advance:v01-demo:resolved.");
  console.log("Cleanup: npm run cleanup:v01-demo");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "v0.1 demo fixture operation failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
