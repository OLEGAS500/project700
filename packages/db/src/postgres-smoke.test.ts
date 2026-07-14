import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  confirmBaselineMetric,
  listBaselineMetrics,
  recalculateFeedProductCountBaseline
} from "./baselines";
import {
  createAlertDeliveriesForIncidentEvent,
  createIncidentOpenedAlertDelivery
} from "./alerts";
import {
  claimDueAlertDeliveries,
  markAlertDeliveryAttemptFailed,
  markAlertDeliverySent
} from "./alert-delivery-jobs";
import { getAlertPreferences, updateAlertPreferences } from "./alert-preferences";
import { applyMigrations } from "./migrations";
import {
  acknowledgeIncident,
  addIncidentComment,
  claimDueIncidentConfirmationCandidates,
  confirmFeedCatalogDropCandidate,
  createOrUpdateFeedSourceHealthIncident,
  createOrUpdatePriceAvailabilityMismatchIncident,
  createOrUpdateSeoRegressionIncident,
  createOrUpdateSourceDivergenceIncident,
  evaluateFeedCatalogDropCandidate,
  getIncidentDetail,
  ignoreIncident,
  IncidentActionConflictError,
  listIncidents,
  updateCatalogDropRecovery,
  updatePriceAvailabilityRecovery,
  updateSeoRegressionRecovery,
  updateSourceDivergenceRecovery
} from "./incidents";
import {
  cancelMaintenanceWindow,
  createMaintenanceWindow,
  getActiveMaintenanceWindow
} from "./maintenance-windows";
import { createStore, DuplicateStoreDomainError } from "./stores";
import {
  captureSnapshotThresholds,
  getStoreThresholds,
  updateStoreThresholds
} from "./thresholds";

const { Client } = pg;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase =
  testDatabaseUrl && process.env.RUN_POSTGRES_TESTS === "1" ? describe : describe.skip;
const schemaName = `eim_smoke_${Date.now()}_${Math.random()
  .toString(16)
  .slice(2)}`;

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

describeIfDatabase("postgres smoke", () => {
  const admin = new Client({ connectionString: testDatabaseUrl });
  let dbUrlWithSchema: string;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schemaName}`);

    dbUrlWithSchema = withSearchPath(testDatabaseUrl!, schemaName);
    process.env.DATABASE_URL = dbUrlWithSchema;

    const migrator = new Client({ connectionString: dbUrlWithSchema });
    await migrator.connect();
    await applyMigrations(migrator);
    await migrator.end();
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin.end();
  });

  it("creates store, defaults, baseline snapshot, and rejects duplicate domains", async () => {
    const result = await createStore({
      name: "Smoke Store",
      domain: "https://EXAMPLE.com/products?ignored=true",
      sitemapUrl: "https://example.com/sitemap.xml",
      feedUrl: "https://example.com/feed.xml",
      categoryUrls: [
        "https://example.com/collections/shoes",
        "https://example.com/collections/bags"
      ]
    });

    expect(result.store.baselineStatus).toBe("learning");
    expect(result.store.domain).toBe("https://example.com");
    expect(result.snapshotId).toBeTruthy();

    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();

    const counts = await client.query<{
      stores: string;
      categories: string;
      alert_preferences: string;
      store_alert_preferences: string;
      snapshots: string;
    }>(
      `
        SELECT
          (SELECT COUNT(*) FROM stores) AS stores,
          (SELECT COUNT(*) FROM monitored_categories) AS categories,
          (SELECT COUNT(*) FROM alert_preferences) AS alert_preferences,
          (SELECT COUNT(*) FROM store_alert_preferences) AS store_alert_preferences,
          (SELECT COUNT(*) FROM snapshots WHERE baseline_role = 'candidate') AS snapshots
      `
    );

    await client.end();

    expect(Number(counts.rows[0].stores)).toBe(1);
    expect(Number(counts.rows[0].categories)).toBe(2);
    expect(Number(counts.rows[0].alert_preferences)).toBe(5);
    expect(Number(counts.rows[0].store_alert_preferences)).toBe(1);
    expect(Number(counts.rows[0].snapshots)).toBe(1);

    await expect(() =>
      createStore({
        name: "Duplicate Store",
        domain: "https://example.com",
        sitemapUrl: "https://example.com/other-sitemap.xml",
        feedUrl: "https://example.com/other-feed.xml",
        categoryUrls: ["https://example.com/collections/other"]
      })
    ).rejects.toBeInstanceOf(DuplicateStoreDomainError);
  });

  it("applies each migration once and records its checksum", async () => {
    const migrator = new Client({ connectionString: dbUrlWithSchema });
    await migrator.connect();
    const secondRun = await applyMigrations(migrator);
    const migrations = await migrator.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name"
    );
    await migrator.end();

    expect(secondRun.applied).toEqual([]);
    expect(secondRun.skipped).toEqual(["0001_initial.sql", "0002_alert_delivery_worker.sql"]);
    expect(migrations.rows.map((migration) => migration.name)).toEqual([
      "0001_initial.sql",
      "0002_alert_delivery_worker.sql"
    ]);
    expect(migrations.rows.every((migration) => migration.checksum.length === 64)).toBe(true);
  });

  it("rolls back onboarding when category creation fails", async () => {
    await expect(() =>
      createStore({
        name: "Rollback Store",
        domain: "https://rollback.example.com",
        sitemapUrl: "https://rollback.example.com/sitemap.xml",
        feedUrl: "https://rollback.example.com/feed.xml",
        categoryUrls: [
          "https://rollback.example.com/collections/shoes",
          "https://rollback.example.com/collections/shoes"
        ]
      })
    ).rejects.toThrow();

    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();
    const result = await client.query<{ count: string }>(
      "SELECT COUNT(*) FROM stores WHERE domain = 'https://rollback.example.com'"
    );
    await client.end();

    expect(Number(result.rows[0].count)).toBe(0);
  });

  it("recalculates, confirms, and invalidates feed product count baseline", async () => {
    const created = await createStore({
      name: "Baseline Store",
      domain: "https://baseline.example.com",
      sitemapUrl: "https://baseline.example.com/sitemap.xml",
      feedUrl: "https://baseline.example.com/feed.xml",
      categoryUrls: ["https://baseline.example.com/collections/all"]
    });

    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();

    for (let index = 0; index < 7; index += 1) {
      await insertFeedObservation(client, created.store.id, 640 + index, index + 1);
    }

    await client.end();

    const ready = await recalculateFeedProductCountBaseline(created.store.id);

    expect(ready).toMatchObject({
      source: "feed",
      metric: "product_count",
      scope: "main-feed",
      status: "ready_for_confirmation",
      sampleCount: 7,
      medianValue: 643
    });

    const confirmed = await confirmBaselineMetric(
      ready!.id,
      "00000000-0000-0000-0000-000000000001"
    );

    expect(confirmed.status).toBe("active");
    expect(confirmed.confirmedByUserId).toBe("00000000-0000-0000-0000-000000000001");

    const changedClient = new Client({ connectionString: dbUrlWithSchema });
    await changedClient.connect();
    await changedClient.query("UPDATE stores SET feed_url = $2 WHERE id = $1", [
      created.store.id,
      "https://baseline.example.com/new-feed.xml"
    ]);
    await insertFeedObservation(changedClient, created.store.id, 800, 8);
    await changedClient.end();

    const relearning = await recalculateFeedProductCountBaseline(created.store.id);
    const activeRows = await listBaselineMetrics(created.store.id);

    expect(relearning).toMatchObject({
      status: "relearning",
      baselineVersion: 2,
      sampleCount: 1,
      medianValue: 800
    });
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].id).toBe(relearning!.id);
  });

  it("creates, dismisses, and confirms feed catalog drop candidates", async () => {
    const created = await createStore({
      name: "Incident Store",
      domain: "https://incident.example.com",
      sitemapUrl: "https://incident.example.com/sitemap.xml",
      feedUrl: "https://incident.example.com/feed.xml",
      categoryUrls: ["https://incident.example.com/collections/all"]
    });
    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();

    for (let index = 0; index < 7; index += 1) {
      await insertFeedObservation(client, created.store.id, 1000, index + 1);
    }
    await client.end();

    const ready = await recalculateFeedProductCountBaseline(created.store.id);
    await confirmBaselineMetric(ready!.id, "00000000-0000-0000-0000-000000000002");

    const dropClient = new Client({ connectionString: dbUrlWithSchema });
    await dropClient.connect();
    const dropSnapshotId = await insertFeedObservation(
      dropClient,
      created.store.id,
      790,
      20
    );
    await dropClient.end();

    const candidate = await evaluateFeedCatalogDropCandidate(
      created.store.id,
      dropSnapshotId
    );

    expect(candidate).toMatchObject({
      status: "pending_confirmation",
      beforeValue: 1000,
      observedValue: 790,
      baselineVersion: 1
    });

    const recoveredClient = new Client({ connectionString: dbUrlWithSchema });
    await recoveredClient.connect();
    const recoveredSnapshotId = await insertFeedObservation(
      recoveredClient,
      created.store.id,
      998,
      21
    );
    await recoveredClient.end();

    const dismissed = await confirmFeedCatalogDropCandidate(
      candidate!.id,
      recoveredSnapshotId
    );

    expect(dismissed).toMatchObject({
      incidentId: null,
      candidate: expect.objectContaining({
        status: "dismissed"
      })
    });

    const secondDropClient = new Client({ connectionString: dbUrlWithSchema });
    await secondDropClient.connect();
    const secondDropSnapshotId = await insertFeedObservation(
      secondDropClient,
      created.store.id,
      790,
      22
    );
    const confirmSnapshotId = await insertFeedObservation(
      secondDropClient,
      created.store.id,
      788,
      23
    );
    await secondDropClient.end();

    const secondCandidate = await evaluateFeedCatalogDropCandidate(
      created.store.id,
      secondDropSnapshotId
    );
    const dueClient = new Client({ connectionString: dbUrlWithSchema });
    await dueClient.connect();
    await dueClient.query(
      `
        UPDATE incident_candidates
        SET confirmation_due_at = now() - interval '1 minute',
            locked_at = NULL
        WHERE id = $1
      `,
      [secondCandidate!.id]
    );
    await dueClient.end();

    const dueCandidates = await claimDueIncidentConfirmationCandidates(5, "worker-a");
    expect(dueCandidates.map((due) => due.candidateId)).toContain(secondCandidate!.id);
    expect(dueCandidates.find((due) => due.candidateId === secondCandidate!.id)).toMatchObject({
      attemptCount: 1,
      lockedBy: "worker-a"
    });
    const lockedCandidates = await claimDueIncidentConfirmationCandidates(5, "worker-b");
    expect(lockedCandidates.map((due) => due.candidateId)).not.toContain(secondCandidate!.id);

    const leaseClient = new Client({ connectionString: dbUrlWithSchema });
    await leaseClient.connect();
    await leaseClient.query(
      `
        UPDATE incident_candidates
        SET locked_at = now() - interval '20 minutes'
        WHERE id = $1
      `,
      [secondCandidate!.id]
    );
    await leaseClient.end();

    const reclaimed = await claimDueIncidentConfirmationCandidates(5, "worker-b");
    expect(reclaimed.find((due) => due.candidateId === secondCandidate!.id)).toMatchObject({
      attemptCount: 2,
      lockedBy: "worker-b"
    });

    const confirmed = await confirmFeedCatalogDropCandidate(
      secondCandidate!.id,
      confirmSnapshotId
    );
    const confirmedAgain = await confirmFeedCatalogDropCandidate(
      secondCandidate!.id,
      confirmSnapshotId
    );

    expect(confirmed.incidentId).toBeTruthy();
    expect(confirmed.candidate.status).toBe("confirmed");
    expect(confirmedAgain.incidentId).toBe(confirmed.incidentId);

    const signalClient = new Client({ connectionString: dbUrlWithSchema });
    await signalClient.connect();
    const signalCount = await signalClient.query<{ count: string }>(
      "SELECT COUNT(*) FROM incident_signals WHERE incident_id = $1",
      [confirmed.incidentId]
    );
    await signalClient.end();

    expect(Number(signalCount.rows[0].count)).toBe(1);

    const afterIncident = await recalculateFeedProductCountBaseline(created.store.id);
    expect(afterIncident?.medianValue).toBe(1000);
    expect(afterIncident?.sampleCount).toBe(7);
  });

  it("stops retrying confirmation candidates after max attempts", async () => {
    const created = await createStore({
      name: "Attempt Limit Store",
      domain: "https://attempt-limit.example.com",
      sitemapUrl: "https://attempt-limit.example.com/sitemap.xml",
      feedUrl: "https://attempt-limit.example.com/feed.xml",
      categoryUrls: ["https://attempt-limit.example.com/collections/all"]
    });
    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();

    for (let index = 0; index < 7; index += 1) {
      await insertFeedObservation(client, created.store.id, 1000, 30 + index);
    }
    await client.end();

    const ready = await recalculateFeedProductCountBaseline(created.store.id);
    await confirmBaselineMetric(ready!.id, "00000000-0000-0000-0000-000000000004");

    const dropClient = new Client({ connectionString: dbUrlWithSchema });
    await dropClient.connect();
    const dropSnapshotId = await insertFeedObservation(
      dropClient,
      created.store.id,
      790,
      38
    );
    await dropClient.end();

    const candidate = await evaluateFeedCatalogDropCandidate(
      created.store.id,
      dropSnapshotId
    );
    const attemptsClient = new Client({ connectionString: dbUrlWithSchema });
    await attemptsClient.connect();
    await attemptsClient.query(
      `
        UPDATE incident_candidates
        SET confirmation_due_at = now() - interval '1 minute',
            attempt_count = 5,
            locked_at = NULL
        WHERE id = $1
      `,
      [candidate!.id]
    );
    await attemptsClient.end();

    const claimed = await claimDueIncidentConfirmationCandidates(5, "worker-c", 5);
    expect(claimed.map((due) => due.candidateId)).not.toContain(candidate!.id);

    const statusClient = new Client({ connectionString: dbUrlWithSchema });
    await statusClient.connect();
    const status = await statusClient.query<{
      status: string;
      status_reason: string;
      locked_at: Date | null;
      locked_by: string | null;
    }>(
      "SELECT status, status_reason, locked_at, locked_by FROM incident_candidates WHERE id = $1",
      [candidate!.id]
    );
    await statusClient.end();

    expect(status.rows[0]).toMatchObject({
      status: "source_failure",
      status_reason: "confirmation_attempts_exhausted",
      locked_at: null,
      locked_by: null
    });
  });

  it("recovers catalog-drop incidents after two consecutive healthy checks", async () => {
    const created = await createStore({
      name: "Recovery Store",
      domain: "https://recovery.example.com",
      sitemapUrl: "https://recovery.example.com/sitemap.xml",
      feedUrl: "https://recovery.example.com/feed.xml",
      categoryUrls: ["https://recovery.example.com/collections/all"]
    });
    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();

    for (let index = 0; index < 7; index += 1) {
      await insertFeedObservation(client, created.store.id, 1000, 100 + index);
    }
    await client.end();

    const ready = await recalculateFeedProductCountBaseline(created.store.id);
    await confirmBaselineMetric(ready!.id, "00000000-0000-0000-0000-000000000009");

    const dropClient = new Client({ connectionString: dbUrlWithSchema });
    await dropClient.connect();
    const dropSnapshotId = await insertFeedObservation(dropClient, created.store.id, 790, 108);
    const confirmSnapshotId = await insertFeedObservation(dropClient, created.store.id, 788, 109);
    await dropClient.end();

    const candidate = await evaluateFeedCatalogDropCandidate(created.store.id, dropSnapshotId);
    const confirmed = await confirmFeedCatalogDropCandidate(candidate!.id, confirmSnapshotId);

    expect(confirmed.incidentId).toBeTruthy();

    const staleClient = new Client({ connectionString: dbUrlWithSchema });
    await staleClient.connect();
    await staleClient.query("UPDATE baseline_metrics SET status = 'stale' WHERE id = $1", [
      ready!.id
    ]);
    const staleHealthySnapshotId = await insertFeedObservation(
      staleClient,
      created.store.id,
      1000,
      110
    );
    await staleClient.end();

    await expect(
      updateCatalogDropRecovery(created.store.id, staleHealthySnapshotId)
    ).resolves.toEqual([]);

    const reactivateClient = new Client({ connectionString: dbUrlWithSchema });
    await reactivateClient.connect();
    await reactivateClient.query("UPDATE baseline_metrics SET status = 'active' WHERE id = $1", [
      ready!.id
    ]);
    const partialSnapshotId = await insertFeedObservation(
      reactivateClient,
      created.store.id,
      1000,
      111,
      "partial"
    );
    const firstHealthySnapshotId = await insertFeedObservation(
      reactivateClient,
      created.store.id,
      1000,
      112
    );
    const recoveryDropSnapshotId = await insertFeedObservation(
      reactivateClient,
      created.store.id,
      790,
      113
    );
    const secondFirstHealthySnapshotId = await insertFeedObservation(
      reactivateClient,
      created.store.id,
      1001,
      114
    );
    const secondHealthySnapshotId = await insertFeedObservation(
      reactivateClient,
      created.store.id,
      999,
      115
    );
    await reactivateClient.end();

    await expect(
      updateCatalogDropRecovery(created.store.id, partialSnapshotId)
    ).resolves.toEqual([]);

    const firstHealthy = await updateCatalogDropRecovery(
      created.store.id,
      firstHealthySnapshotId
    );
    expect(firstHealthy).toEqual([
      {
        incidentId: confirmed.incidentId,
        status: "recovering",
        transition: "recovering_started"
      }
    ]);

    const sameSnapshotAgain = await updateCatalogDropRecovery(
      created.store.id,
      firstHealthySnapshotId
    );
    expect(sameSnapshotAgain).toEqual([
      {
        incidentId: confirmed.incidentId,
        status: "recovering",
        transition: "no_change"
      }
    ]);

    const reopened = await updateCatalogDropRecovery(
      created.store.id,
      recoveryDropSnapshotId
    );
    expect(reopened).toEqual([
      {
        incidentId: confirmed.incidentId,
        status: "open",
        transition: "reopened"
      }
    ]);

    await expect(
      updateCatalogDropRecovery(created.store.id, secondFirstHealthySnapshotId)
    ).resolves.toEqual([
      {
        incidentId: confirmed.incidentId,
        status: "recovering",
        transition: "recovering_started"
      }
    ]);

    await expect(
      updateCatalogDropRecovery(created.store.id, secondHealthySnapshotId)
    ).resolves.toEqual([
      {
        incidentId: confirmed.incidentId,
        status: "resolved",
        transition: "resolved"
      }
    ]);

    await expect(
      updateCatalogDropRecovery(created.store.id, secondHealthySnapshotId)
    ).resolves.toEqual([]);

    const statusClient = new Client({ connectionString: dbUrlWithSchema });
    await statusClient.connect();
    const incident = await statusClient.query<{
      status: string;
      closed_snapshot_id: string | null;
      resolved_at: Date | null;
    }>("SELECT status, closed_snapshot_id, resolved_at FROM incidents WHERE id = $1", [
      confirmed.incidentId
    ]);
    const events = await statusClient.query<{ event_type: string; count: string }>(
      `
        SELECT event_type, COUNT(*) AS count
        FROM incident_events
        WHERE incident_id = $1
        GROUP BY event_type
        ORDER BY event_type
      `,
      [confirmed.incidentId]
    );
    await statusClient.end();

    expect(incident.rows[0]).toMatchObject({
      status: "resolved",
      closed_snapshot_id: secondHealthySnapshotId
    });
    expect(incident.rows[0].resolved_at).toBeTruthy();
    expect(events.rows).toEqual([
      { event_type: "alert_suppressed", count: "4" },
      { event_type: "catalog_drop_recovery_healthy", count: "2" },
      { event_type: "catalog_drop_reopened", count: "1" },
      { event_type: "catalog_drop_resolved", count: "1" },
      { event_type: "incident_opened", count: "1" }
    ]);

    const afterResolved = await recalculateFeedProductCountBaseline(created.store.id);
    expect(afterResolved?.sampleCount).toBeGreaterThan(7);
  });

  it("expires candidates when confirmation is late or configuration changes", async () => {
    const created = await createStore({
      name: "Candidate Expiry Store",
      domain: "https://candidate-expiry.example.com",
      sitemapUrl: "https://candidate-expiry.example.com/sitemap.xml",
      feedUrl: "https://candidate-expiry.example.com/feed.xml",
      categoryUrls: ["https://candidate-expiry.example.com/collections/all"]
    });
    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();

    for (let index = 0; index < 7; index += 1) {
      await insertFeedObservation(client, created.store.id, 1000, 60 + index);
    }
    await client.end();

    const ready = await recalculateFeedProductCountBaseline(created.store.id);
    await confirmBaselineMetric(ready!.id, "00000000-0000-0000-0000-000000000003");

    const expiredClient = new Client({ connectionString: dbUrlWithSchema });
    await expiredClient.connect();
    const expiredDropSnapshotId = await insertFeedObservation(
      expiredClient,
      created.store.id,
      790,
      80
    );
    const expiredConfirmSnapshotId = await insertFeedObservation(
      expiredClient,
      created.store.id,
      790,
      81
    );
    await expiredClient.end();

    const expiredCandidate = await evaluateFeedCatalogDropCandidate(
      created.store.id,
      expiredDropSnapshotId
    );
    const expireUpdateClient = new Client({ connectionString: dbUrlWithSchema });
    await expireUpdateClient.connect();
    await expireUpdateClient.query(
      "UPDATE incident_candidates SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [expiredCandidate!.id]
    );
    await expireUpdateClient.end();

    const expired = await confirmFeedCatalogDropCandidate(
      expiredCandidate!.id,
      expiredConfirmSnapshotId
    );
    expect(expired).toMatchObject({
      incidentId: null,
      candidate: expect.objectContaining({
        status: "expired",
        statusReason: "confirmation_window_expired"
      })
    });

    const configClient = new Client({ connectionString: dbUrlWithSchema });
    await configClient.connect();
    const configDropSnapshotId = await insertFeedObservation(
      configClient,
      created.store.id,
      790,
      82
    );
    const configConfirmSnapshotId = await insertFeedObservation(
      configClient,
      created.store.id,
      790,
      83
    );
    await configClient.end();

    const configCandidate = await evaluateFeedCatalogDropCandidate(
      created.store.id,
      configDropSnapshotId
    );
    const changedClient = new Client({ connectionString: dbUrlWithSchema });
    await changedClient.connect();
    await changedClient.query("UPDATE stores SET feed_url = $2 WHERE id = $1", [
      created.store.id,
      "https://candidate-expiry.example.com/changed-feed.xml"
    ]);
    await changedClient.end();

    const invalidated = await confirmFeedCatalogDropCandidate(
      configCandidate!.id,
      configConfirmSnapshotId
    );
    expect(invalidated).toMatchObject({
      incidentId: null,
      candidate: expect.objectContaining({
        status: "expired",
        statusReason: "confirmation_configuration_changed"
      })
    });
  });

  it("creates source-health incidents using debounce rules for feed source failures", async () => {
    const created = await createStore({
      name: "Source Health Store",
      domain: "https://source-health.example.com",
      sitemapUrl: "https://source-health.example.com/sitemap.xml",
      feedUrl: "https://source-health.example.com/feed.xml",
      categoryUrls: ["https://source-health.example.com/collections/all"]
    });
    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();
    const firstUnavailableSnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      0,
      40,
      "source_unavailable"
    );
    const secondUnavailableSnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      0,
      41,
      "source_unavailable"
    );
    const authFailureSnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      0,
      42,
      "authentication_failed"
    );
    const recoverySnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      640,
      43,
      "success"
    );
    const failureWhileRecoveringSnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      0,
      44,
      "authentication_failed"
    );
    const secondRecoveryStartSnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      641,
      45,
      "success"
    );
    const resolvedSnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      642,
      46,
      "success"
    );
    await client.end();

    await expect(
      createOrUpdateFeedSourceHealthIncident(
        created.store.id,
        firstUnavailableSnapshotId
      )
    ).resolves.toBeNull();

    const debouncedIncidentId = await createOrUpdateFeedSourceHealthIncident(
      created.store.id,
      secondUnavailableSnapshotId
    );
    const authIncidentId = await createOrUpdateFeedSourceHealthIncident(
      created.store.id,
      authFailureSnapshotId
    );
    const recoveryEvidenceIncidentId = await createOrUpdateFeedSourceHealthIncident(
      created.store.id,
      recoverySnapshotId
    );
    const reopenedIncidentId = await createOrUpdateFeedSourceHealthIncident(
      created.store.id,
      failureWhileRecoveringSnapshotId
    );
    const secondRecoveryIncidentId = await createOrUpdateFeedSourceHealthIncident(
      created.store.id,
      secondRecoveryStartSnapshotId
    );
    const resolvedIncidentId = await createOrUpdateFeedSourceHealthIncident(
      created.store.id,
      resolvedSnapshotId
    );

    expect(debouncedIncidentId).toBeTruthy();
    expect(authIncidentId).toBe(debouncedIncidentId);
    expect(recoveryEvidenceIncidentId).toBe(debouncedIncidentId);
    expect(reopenedIncidentId).toBe(debouncedIncidentId);
    expect(secondRecoveryIncidentId).toBe(debouncedIncidentId);
    expect(resolvedIncidentId).toBe(debouncedIncidentId);

    const recoveryClient = new Client({ connectionString: dbUrlWithSchema });
    await recoveryClient.connect();
    const recoverySignals = await recoveryClient.query<{ count: string }>(
      `
        SELECT COUNT(*)
        FROM incident_signals
        WHERE incident_id = $1
          AND metric = 'source_check_success'
      `,
      [debouncedIncidentId]
    );
    const incident = await recoveryClient.query<{ status: string; closed_snapshot_id: string | null }>(
      "SELECT status, closed_snapshot_id FROM incidents WHERE id = $1",
      [debouncedIncidentId]
    );
    const events = await recoveryClient.query<{ event_type: string; count: string }>(
      `
        SELECT event_type, COUNT(*) AS count
        FROM incident_events
        WHERE incident_id = $1
        GROUP BY event_type
        ORDER BY event_type
      `,
      [debouncedIncidentId]
    );
    await recoveryClient.end();

    expect(Number(recoverySignals.rows[0].count)).toBe(1);
    expect(incident.rows[0]).toMatchObject({
      status: "resolved",
      closed_snapshot_id: resolvedSnapshotId
    });
    expect(events.rows).toEqual([
      { event_type: "alert_suppressed", count: "4" },
      { event_type: "incident_opened", count: "1" },
      { event_type: "source_health_recovery_healthy", count: "2" },
      { event_type: "source_health_reopened", count: "1" },
      { event_type: "source_health_resolved", count: "1" }
    ]);
  });

  it("resets feed source-health debounce after success or configuration change", async () => {
    const created = await createStore({
      name: "Source Health Reset Store",
      domain: "https://source-health-reset.example.com",
      sitemapUrl: "https://source-health-reset.example.com/sitemap.xml",
      feedUrl: "https://source-health-reset.example.com/feed.xml",
      categoryUrls: ["https://source-health-reset.example.com/collections/all"]
    });
    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();
    const timeoutSnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      0,
      44,
      "timeout"
    );
    const successSnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      640,
      45,
      "success"
    );
    const timeoutAfterSuccessSnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      0,
      46,
      "timeout"
    );
    await client.query("UPDATE stores SET feed_url = $2 WHERE id = $1", [
      created.store.id,
      "https://source-health-reset.example.com/new-feed.xml"
    ]);
    const timeoutAfterConfigChangeSnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      0,
      47,
      "timeout"
    );
    await client.end();

    await expect(
      createOrUpdateFeedSourceHealthIncident(created.store.id, timeoutSnapshotId)
    ).resolves.toBeNull();
    await expect(
      createOrUpdateFeedSourceHealthIncident(created.store.id, successSnapshotId)
    ).resolves.toBeNull();
    await expect(
      createOrUpdateFeedSourceHealthIncident(
        created.store.id,
        timeoutAfterSuccessSnapshotId
      )
    ).resolves.toBeNull();
    await expect(
      createOrUpdateFeedSourceHealthIncident(
        created.store.id,
        timeoutAfterConfigChangeSnapshotId
      )
    ).resolves.toBeNull();
  });

  it("creates source-divergence incidents only from complete source observations", async () => {
    const created = await createStore({
      name: "Divergence Store",
      domain: "https://divergence.example.com",
      sitemapUrl: "https://divergence.example.com/sitemap.xml",
      feedUrl: "https://divergence.example.com/feed.xml",
      categoryUrls: ["https://divergence.example.com/collections/all"]
    });
    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();

    const partialSnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      500,
      50
    );
    await insertCategoryObservation(client, created.store.id, partialSnapshotId, "partial", 360);

    const completeSnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      500,
      51
    );
    await insertCategoryObservation(client, created.store.id, completeSnapshotId, "success", 360);
    await insertStorefrontFeedMatches(client, created.store.id, completeSnapshotId, 360, 82);

    const firstHealthySnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      500,
      52
    );
    await insertCategoryObservation(client, created.store.id, firstHealthySnapshotId, "success", 360);
    await insertStorefrontFeedMatches(client, created.store.id, firstHealthySnapshotId, 360, 8);

    const returnedSnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      500,
      53
    );
    await insertCategoryObservation(client, created.store.id, returnedSnapshotId, "success", 360);
    await insertStorefrontFeedMatches(client, created.store.id, returnedSnapshotId, 360, 82);

    const secondFirstHealthySnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      500,
      54
    );
    await insertCategoryObservation(client, created.store.id, secondFirstHealthySnapshotId, "success", 360);
    await insertStorefrontFeedMatches(client, created.store.id, secondFirstHealthySnapshotId, 360, 7);

    const secondHealthySnapshotId = await insertFeedObservation(
      client,
      created.store.id,
      500,
      55
    );
    await insertCategoryObservation(client, created.store.id, secondHealthySnapshotId, "success", 360);
    await insertStorefrontFeedMatches(client, created.store.id, secondHealthySnapshotId, 360, 6);
    await client.end();

    await expect(
      createOrUpdateSourceDivergenceIncident(created.store.id, partialSnapshotId)
    ).resolves.toBeNull();

    const incidentId = await createOrUpdateSourceDivergenceIncident(
      created.store.id,
      completeSnapshotId
    );

    expect(incidentId).toBeTruthy();

    await expect(
      updateSourceDivergenceRecovery(created.store.id, firstHealthySnapshotId)
    ).resolves.toEqual([
      {
        incidentId,
        status: "recovering",
        transition: "recovering_started"
      }
    ]);

    await expect(
      updateSourceDivergenceRecovery(created.store.id, firstHealthySnapshotId)
    ).resolves.toEqual([
      {
        incidentId,
        status: "recovering",
        transition: "no_change"
      }
    ]);

    await expect(
      updateSourceDivergenceRecovery(created.store.id, returnedSnapshotId)
    ).resolves.toEqual([
      {
        incidentId,
        status: "open",
        transition: "reopened"
      }
    ]);

    await expect(
      updateSourceDivergenceRecovery(created.store.id, secondFirstHealthySnapshotId)
    ).resolves.toEqual([
      {
        incidentId,
        status: "recovering",
        transition: "recovering_started"
      }
    ]);

    await expect(
      updateSourceDivergenceRecovery(created.store.id, secondHealthySnapshotId)
    ).resolves.toEqual([
      {
        incidentId,
        status: "resolved",
        transition: "resolved"
      }
    ]);

    const checkClient = new Client({ connectionString: dbUrlWithSchema });
    await checkClient.connect();
    const incident = await checkClient.query<{
      type: string;
      severity: string;
      likely_source: string;
      affected_count: number;
      summary: string;
      status: string;
      closed_snapshot_id: string | null;
    }>(
      `
        SELECT type,
               severity,
               likely_source,
               affected_count,
               summary,
               status,
               closed_snapshot_id
        FROM incidents
        WHERE id = $1
      `,
      [incidentId]
    );
    const signals = await checkClient.query<{ count: string }>(
      "SELECT COUNT(*) FROM incident_signals WHERE incident_id = $1",
      [incidentId]
    );
    const events = await checkClient.query<{ event_type: string; count: string }>(
      `
        SELECT event_type, COUNT(*) AS count
        FROM incident_events
        WHERE incident_id = $1
        GROUP BY event_type
        ORDER BY event_type
      `,
      [incidentId]
    );
    await checkClient.end();

    expect(incident.rows[0]).toMatchObject({
      type: "source_divergence",
      severity: "warning",
      likely_source: "feed",
      affected_count: 82,
      summary: "82 matched storefront products are missing from the feed.",
      status: "resolved",
      closed_snapshot_id: secondHealthySnapshotId
    });
    expect(Number(signals.rows[0].count)).toBe(1);
    expect(events.rows).toEqual([
      { event_type: "alert_suppressed", count: "4" },
      { event_type: "incident_opened", count: "1" },
      { event_type: "source_divergence_recovery_healthy", count: "2" },
      { event_type: "source_divergence_reopened", count: "1" },
      { event_type: "source_divergence_resolved", count: "1" }
    ]);
  });

  it("creates one grouped SEO regression incident for compatible product-page samples", async () => {
    const created = await createStore({
      name: "SEO Regression Store",
      domain: "https://seo-regression.example.com",
      sitemapUrl: "https://seo-regression.example.com/sitemap.xml",
      feedUrl: "https://seo-regression.example.com/feed.xml",
      categoryUrls: ["https://seo-regression.example.com/collections/all"]
    });
    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();
    const urls = Array.from({ length: 25 }, (_, index) =>
      `https://seo-regression.example.com/products/${index}`
    );
    const previousSnapshotId = await insertSeoSnapshot(
      client,
      created.store.id,
      90,
      urls,
      {}
    );
    const currentSnapshotId = await insertSeoSnapshot(
      client,
      created.store.id,
      91,
      urls,
      {
        noindex: new Set([0, 1, 2, 3, 4, 5]),
        canonicalDifferent: new Set([0, 1, 2, 3, 4, 5]),
        schemaMissing: new Set([0, 1, 2, 3, 4, 5]),
        httpError: new Set([6, 7, 8, 9, 10])
      }
    );
    const firstHealthySnapshotId = await insertSeoSnapshot(
      client,
      created.store.id,
      92,
      urls,
      {}
    );
    const returnedSnapshotId = await insertSeoSnapshot(
      client,
      created.store.id,
      93,
      urls,
      {
        noindex: new Set([0, 1, 2, 3, 4, 5])
      }
    );
    const secondFirstHealthySnapshotId = await insertSeoSnapshot(
      client,
      created.store.id,
      94,
      urls,
      {}
    );
    const secondHealthySnapshotId = await insertSeoSnapshot(
      client,
      created.store.id,
      95,
      urls,
      {}
    );
    await client.end();

    const incidentId = await createOrUpdateSeoRegressionIncident(
      created.store.id,
      currentSnapshotId
    );

    expect(incidentId).toBeTruthy();

    await expect(
      updateSeoRegressionRecovery(created.store.id, firstHealthySnapshotId)
    ).resolves.toEqual([
      {
        incidentId,
        status: "recovering",
        transition: "recovering_started"
      }
    ]);

    await expect(
      updateSeoRegressionRecovery(created.store.id, returnedSnapshotId)
    ).resolves.toEqual([
      {
        incidentId,
        status: "open",
        transition: "reopened"
      }
    ]);

    await expect(
      updateSeoRegressionRecovery(created.store.id, secondFirstHealthySnapshotId)
    ).resolves.toEqual([
      {
        incidentId,
        status: "recovering",
        transition: "recovering_started"
      }
    ]);

    await expect(
      updateSeoRegressionRecovery(created.store.id, secondHealthySnapshotId)
    ).resolves.toEqual([
      {
        incidentId,
        status: "resolved",
        transition: "resolved"
      }
    ]);

    await expect(
      updateSeoRegressionRecovery(created.store.id, returnedSnapshotId)
    ).resolves.toEqual([]);

    const checkClient = new Client({ connectionString: dbUrlWithSchema });
    await checkClient.connect();
    const incident = await checkClient.query<{
      type: string;
      title: string;
      likely_source: string;
      affected_count: number;
      summary: string;
      status: string;
      closed_snapshot_id: string | null;
    }>(
      `
        SELECT type,
               title,
               likely_source,
               affected_count,
               summary,
               status,
               closed_snapshot_id
        FROM incidents
        WHERE id = $1
      `,
      [incidentId]
    );
    const signals = await checkClient.query<{ metric: string; count: string }>(
      `
        SELECT metric, COUNT(*) AS count
        FROM incident_signals
        WHERE incident_id = $1
        GROUP BY metric
        ORDER BY metric
      `,
      [incidentId]
    );
    const events = await checkClient.query<{ event_type: string; count: string }>(
      `
        SELECT event_type, COUNT(*) AS count
        FROM incident_events
        WHERE incident_id = $1
        GROUP BY event_type
        ORDER BY event_type
      `,
      [incidentId]
    );
    await checkClient.end();

    expect(previousSnapshotId).toBeTruthy();
    expect(incident.rows[0]).toMatchObject({
      type: "seo_regression",
      title: "Product-page SEO regression",
      likely_source: "site_template_or_deployment",
      affected_count: 6,
      status: "resolved",
      closed_snapshot_id: secondHealthySnapshotId
    });
    expect(incident.rows[0].summary).toContain("6 pages became noindex");
    expect(signals.rows.map((row) => row.metric)).toEqual([
      "canonical_away",
      "http_error",
      "noindex",
      "schema_missing"
    ]);
    expect(events.rows).toEqual([
      { event_type: "alert_suppressed", count: "4" },
      { event_type: "incident_opened", count: "1" },
      { event_type: "seo_regression_recovery_healthy", count: "2" },
      { event_type: "seo_regression_reopened", count: "1" },
      { event_type: "seo_regression_resolved", count: "1" }
    ]);
  });

  it("does not create SEO regression incidents for incompatible samples", async () => {
    const created = await createStore({
      name: "SEO Incompatible Store",
      domain: "https://seo-incompatible.example.com",
      sitemapUrl: "https://seo-incompatible.example.com/sitemap.xml",
      feedUrl: "https://seo-incompatible.example.com/feed.xml",
      categoryUrls: ["https://seo-incompatible.example.com/collections/all"]
    });
    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();
    const previousUrls = Array.from({ length: 25 }, (_, index) =>
      `https://seo-incompatible.example.com/products/${index}`
    );
    const currentUrls = Array.from({ length: 25 }, (_, index) =>
      `https://seo-incompatible.example.com/products/new-${index}`
    );
    await insertSeoSnapshot(client, created.store.id, 92, previousUrls, {});
    const currentSnapshotId = await insertSeoSnapshot(
      client,
      created.store.id,
      93,
      currentUrls,
      {
        noindex: new Set([0, 1, 2, 3, 4, 5])
      }
    );
    await client.end();

    await expect(
      createOrUpdateSeoRegressionIncident(created.store.id, currentSnapshotId)
    ).resolves.toBeNull();
  });

  it("debounces, opens, and recovers grouped price/availability mismatch incidents", async () => {
    const created = await createStore({
      name: "Price Mismatch Store",
      domain: "https://price-mismatch.example.com",
      sitemapUrl: "https://price-mismatch.example.com/sitemap.xml",
      feedUrl: "https://price-mismatch.example.com/feed.xml",
      categoryUrls: ["https://price-mismatch.example.com/collections/all"]
    });
    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();
    const firstMismatchSnapshotId = await insertPriceAvailabilitySnapshot(client, created.store.id, {
      mismatchCount: 6,
      matchMethod: "offer_id",
      dayOffset: 94
    });
    const healthyBetweenSnapshotId = await insertPriceAvailabilitySnapshot(client, created.store.id, {
      mismatchCount: 0,
      matchMethod: "offer_id",
      dayOffset: 95
    });
    const secondFirstMismatchSnapshotId = await insertPriceAvailabilitySnapshot(client, created.store.id, {
      mismatchCount: 6,
      matchMethod: "offer_id",
      dayOffset: 96
    });
    const secondMismatchSnapshotId = await insertPriceAvailabilitySnapshot(client, created.store.id, {
      mismatchCount: 6,
      matchMethod: "offer_id",
      dayOffset: 97
    });
    const firstHealthySnapshotId = await insertPriceAvailabilitySnapshot(client, created.store.id, {
      mismatchCount: 0,
      matchMethod: "offer_id",
      dayOffset: 98
    });
    const availabilityStillMismatchSnapshotId = await insertPriceAvailabilitySnapshot(client, created.store.id, {
      mismatchCount: 0,
      availabilityMismatchCount: 6,
      matchMethod: "offer_id",
      dayOffset: 99
    });
    const secondFirstHealthySnapshotId = await insertPriceAvailabilitySnapshot(client, created.store.id, {
      mismatchCount: 0,
      matchMethod: "offer_id",
      dayOffset: 100
    });
    const secondHealthySnapshotId = await insertPriceAvailabilitySnapshot(client, created.store.id, {
      mismatchCount: 0,
      matchMethod: "offer_id",
      dayOffset: 101
    });
    await client.end();

    const incidentId = await createOrUpdatePriceAvailabilityMismatchIncident(
      created.store.id,
      firstMismatchSnapshotId
    );

    expect(incidentId).toBeNull();

    await expect(
      createOrUpdatePriceAvailabilityMismatchIncident(
        created.store.id,
        healthyBetweenSnapshotId
      )
    ).resolves.toBeNull();

    await expect(
      createOrUpdatePriceAvailabilityMismatchIncident(
        created.store.id,
        secondFirstMismatchSnapshotId
      )
    ).resolves.toBeNull();

    const [confirmedIncidentId, concurrentIncidentId] = await Promise.all([
      createOrUpdatePriceAvailabilityMismatchIncident(
        created.store.id,
        secondMismatchSnapshotId
      ),
      createOrUpdatePriceAvailabilityMismatchIncident(
        created.store.id,
        secondMismatchSnapshotId
      )
    ]);

    expect(confirmedIncidentId).toBeTruthy();
    expect(concurrentIncidentId).toBe(confirmedIncidentId);

    const configClient = new Client({ connectionString: dbUrlWithSchema });
    await configClient.connect();
    const originalConfiguration = await configClient.query<{ configuration_hash: string }>(
      "SELECT configuration_hash FROM incidents WHERE id = $1",
      [confirmedIncidentId]
    );
    await configClient.query(
      "UPDATE incidents SET configuration_hash = 'stale-price-availability-config' WHERE id = $1",
      [confirmedIncidentId]
    );
    await configClient.end();

    await expect(
      updatePriceAvailabilityRecovery(created.store.id, firstHealthySnapshotId)
    ).resolves.toEqual([]);

    const restoreConfigClient = new Client({ connectionString: dbUrlWithSchema });
    await restoreConfigClient.connect();
    await restoreConfigClient.query(
      "UPDATE incidents SET configuration_hash = $2 WHERE id = $1",
      [confirmedIncidentId, originalConfiguration.rows[0].configuration_hash]
    );
    await restoreConfigClient.end();

    await expect(
      updatePriceAvailabilityRecovery(created.store.id, firstHealthySnapshotId)
    ).resolves.toEqual([
      {
        incidentId: confirmedIncidentId,
        status: "recovering",
        transition: "recovering_started"
      }
    ]);

    await expect(
      updatePriceAvailabilityRecovery(created.store.id, availabilityStillMismatchSnapshotId)
    ).resolves.toEqual([
      {
        incidentId: confirmedIncidentId,
        status: "open",
        transition: "reopened"
      }
    ]);

    await expect(
      updatePriceAvailabilityRecovery(created.store.id, secondFirstHealthySnapshotId)
    ).resolves.toEqual([
      {
        incidentId: confirmedIncidentId,
        status: "recovering",
        transition: "recovering_started"
      }
    ]);

    await expect(
      updatePriceAvailabilityRecovery(created.store.id, secondHealthySnapshotId)
    ).resolves.toEqual([
      {
        incidentId: confirmedIncidentId,
        status: "resolved",
        transition: "resolved"
      }
    ]);

    const checkClient = new Client({ connectionString: dbUrlWithSchema });
    await checkClient.connect();
    const incident = await checkClient.query<{
      type: string;
      title: string;
      affected_count: number;
      summary: string;
      status: string;
      closed_snapshot_id: string | null;
    }>(
      `
        SELECT type, title, affected_count, summary, status, closed_snapshot_id
        FROM incidents
        WHERE id = $1
      `,
      [confirmedIncidentId]
    );
    const signals = await checkClient.query<{ metric: string }>(
      `
        SELECT metric
        FROM incident_signals
        WHERE incident_id = $1
        ORDER BY metric
      `,
      [confirmedIncidentId]
    );
    const candidates = await checkClient.query<{ status: string; count: string }>(
      `
        SELECT status, COUNT(*) AS count
        FROM incident_debounce_candidates
        WHERE store_id = $1
          AND type = 'price_availability_mismatch'
        GROUP BY status
        ORDER BY status
      `,
      [created.store.id]
    );
    const events = await checkClient.query<{ event_type: string; count: string }>(
      `
        SELECT event_type, COUNT(*) AS count
        FROM incident_events
        WHERE incident_id = $1
        GROUP BY event_type
        ORDER BY event_type
      `,
      [confirmedIncidentId]
    );
    await checkClient.end();

    expect(incident.rows[0]).toMatchObject({
      type: "price_availability_mismatch",
      title: "Product data mismatch",
      affected_count: 6,
      status: "resolved",
      closed_snapshot_id: secondHealthySnapshotId
    });
    expect(incident.rows[0].summary).toContain("6 products have different effective prices");
    expect(incident.rows[0].summary).toContain("6 products have different availability");
    expect(signals.rows.map((row) => row.metric)).toEqual([
      "availability_mismatch_count",
      "price_mismatch_count"
    ]);
    expect(candidates.rows).toEqual([
      { status: "confirmed", count: "1" },
      { status: "dismissed", count: "1" }
    ]);
    expect(events.rows).toEqual([
      { event_type: "alert_suppressed", count: "4" },
      { event_type: "incident_opened", count: "1" },
      { event_type: "price_availability_recovery_healthy", count: "2" },
      { event_type: "price_availability_reopened", count: "1" },
      { event_type: "price_availability_resolved", count: "1" }
    ]);
  });

  it("does not create price/availability mismatch incidents from fallback matches", async () => {
    const created = await createStore({
      name: "Fallback Mismatch Store",
      domain: "https://fallback-mismatch.example.com",
      sitemapUrl: "https://fallback-mismatch.example.com/sitemap.xml",
      feedUrl: "https://fallback-mismatch.example.com/feed.xml",
      categoryUrls: ["https://fallback-mismatch.example.com/collections/all"]
    });
    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();
    const snapshotId = await insertPriceAvailabilitySnapshot(client, created.store.id, {
      mismatchCount: 20,
      matchMethod: "fallback"
    });
    await client.end();

    await expect(
      createOrUpdatePriceAvailabilityMismatchIncident(created.store.id, snapshotId)
    ).resolves.toBeNull();
  });

  it("records idempotent user actions and comments in the incident timeline", async () => {
    const created = await createStore({
      name: "Incident Actions Store",
      domain: "https://incident-actions.example.com",
      sitemapUrl: "https://incident-actions.example.com/sitemap.xml",
      feedUrl: "https://incident-actions.example.com/feed.xml",
      categoryUrls: ["https://incident-actions.example.com/collections/all"]
    });
    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO incidents (
          store_id,
          severity,
          type,
          title,
          summary,
          status
        )
        VALUES ($1, 'warning', 'source_health', 'Feed source could not be verified', 'Feed timed out.', 'open')
        RETURNING id
      `,
      [created.store.id]
    );
    await client.end();

    const incidentId = inserted.rows[0].id;
    const acknowledgements = await Promise.all([
      acknowledgeIncident(incidentId, {
        actor: "olga@example.com",
        comment: "Investigating with the client."
      }),
      acknowledgeIncident(incidentId, {
        actor: "olga@example.com",
        comment: "Investigating with the client."
      })
    ]);

    expect(acknowledgements.map((incident) => incident.status)).toEqual([
      "acknowledged",
      "acknowledged"
    ]);

    const comment = await addIncidentComment(incidentId, {
      actor: "max@example.com",
      body: "Feed provider confirmed a transient outage."
    });
    expect(comment.actor).toBe("max@example.com");

    await expect(
      ignoreIncident(incidentId, {
        actor: "olga@example.com",
        reason: "Confirmed maintenance window"
      })
    ).resolves.toMatchObject({ status: "ignored", ignoredReason: "Confirmed maintenance window" });

    await expect(
      ignoreIncident(incidentId, {
        actor: "olga@example.com",
        reason: "A repeated request must be idempotent"
      })
    ).resolves.toMatchObject({ status: "ignored", ignoredReason: "Confirmed maintenance window" });

    await expect(
      acknowledgeIncident(incidentId, { actor: "olga@example.com" })
    ).rejects.toBeInstanceOf(IncidentActionConflictError);

    const detail = await getIncidentDetail(incidentId);
    const ignored = await listIncidents({ storeId: created.store.id, status: "ignored" });

    expect(detail).toMatchObject({ id: incidentId, status: "ignored" });
    expect(detail?.comments).toHaveLength(2);
    expect(detail?.events.map((event) => event.eventType)).toEqual([
      "incident_acknowledged",
      "incident_commented",
      "incident_commented",
      "incident_ignored"
    ]);
    expect(ignored.map((incident) => incident.id)).toContain(incidentId);
  });

  it("suppresses durable alert delivery during maintenance without stopping incident lifecycle", async () => {
    const created = await createStore({
      name: "Maintenance Store",
      domain: "https://maintenance.example.com",
      sitemapUrl: "https://maintenance.example.com/sitemap.xml",
      feedUrl: "https://maintenance.example.com/feed.xml",
      categoryUrls: ["https://maintenance.example.com/collections/all"]
    });
    const outside = await createStore({
      name: "Outside Maintenance Store",
      domain: "https://outside-maintenance.example.com",
      sitemapUrl: "https://outside-maintenance.example.com/sitemap.xml",
      feedUrl: "https://outside-maintenance.example.com/feed.xml",
      categoryUrls: ["https://outside-maintenance.example.com/collections/all"]
    });
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 60_000).toISOString();
    await createMaintenanceWindow(created.store.id, {
      startsAt,
      endsAt,
      reason: "Theme deployment",
      createdBy: "olga@example.com"
    });
    const secondWindow = await createMaintenanceWindow(created.store.id, {
      startsAt,
      endsAt,
      reason: "Feed refresh",
      createdBy: "max@example.com"
    });

    const failureClient = new Client({ connectionString: dbUrlWithSchema });
    await failureClient.connect();
    const failedSnapshotId = await insertFeedObservation(
      failureClient,
      created.store.id,
      0,
      130,
      "authentication_failed"
    );
    await failureClient.end();

    const incidentId = await createOrUpdateFeedSourceHealthIncident(
      created.store.id,
      failedSnapshotId
    );
    await createOrUpdateFeedSourceHealthIncident(created.store.id, failedSnapshotId);
    await acknowledgeIncident(incidentId!, { actor: "olga@example.com" });

    const recoveryClient = new Client({ connectionString: dbUrlWithSchema });
    await recoveryClient.connect();
    const healthySnapshotId = await insertFeedObservation(
      recoveryClient,
      created.store.id,
      1000,
      131,
      "success"
    );
    await recoveryClient.end();
    await createOrUpdateFeedSourceHealthIncident(created.store.id, healthySnapshotId);

    const cancelledWindow = await createMaintenanceWindow(outside.store.id, {
      startsAt,
      endsAt,
      reason: "Cancelled maintenance",
      createdBy: "olga@example.com"
    });
    await cancelMaintenanceWindow(outside.store.id, cancelledWindow.id);

    const outsideClient = new Client({ connectionString: dbUrlWithSchema });
    await outsideClient.connect();
    const outsideSnapshotId = await insertFeedObservation(
      outsideClient,
      outside.store.id,
      0,
      130,
      "authentication_failed"
    );
    await outsideClient.end();
    const outsideIncidentId = await createOrUpdateFeedSourceHealthIncident(
      outside.store.id,
      outsideSnapshotId
    );

    const boundaryWindow = await createMaintenanceWindow(outside.store.id, {
      startsAt: "2026-08-01T10:00:00.000Z",
      endsAt: "2026-08-01T11:00:00.000Z",
      reason: "Boundary check",
      createdBy: "max@example.com"
    });
    const pool = (await import("./client")).getPool();
    await expect(
      getActiveMaintenanceWindow(pool, outside.store.id, new Date(boundaryWindow.startsAt))
    ).resolves.toMatchObject({ id: boundaryWindow.id });
    await expect(
      getActiveMaintenanceWindow(pool, outside.store.id, new Date(boundaryWindow.endsAt))
    ).resolves.toBeNull();

    const checkClient = new Client({ connectionString: dbUrlWithSchema });
    await checkClient.connect();
    const suppressed = await checkClient.query<{
      status: string;
      maintenance_window_id: string | null;
      count: string;
    }>(
      `
        SELECT status, maintenance_window_id, COUNT(*) AS count
        FROM alert_deliveries
        WHERE incident_id = $1
        GROUP BY status, maintenance_window_id
      `,
      [incidentId]
    );
    const pending = await checkClient.query<{ status: string; count: string }>(
      `
        SELECT status, COUNT(*) AS count
        FROM alert_deliveries
        WHERE incident_id = $1
        GROUP BY status
        ORDER BY status
      `,
      [outsideIncidentId]
    );
    const timeline = await checkClient.query<{ event_type: string; count: string }>(
      `
        SELECT event_type, COUNT(*) AS count
        FROM incident_events
        WHERE incident_id = $1
        GROUP BY event_type
        ORDER BY event_type
      `,
      [incidentId]
    );
    const incident = await checkClient.query<{ status: string }>(
      "SELECT status FROM incidents WHERE id = $1",
      [incidentId]
    );
    await checkClient.end();

    expect(suppressed.rows).toEqual(
      expect.arrayContaining([
        { status: "suppressed", maintenance_window_id: secondWindow.id, count: "1" },
        { status: "suppressed", maintenance_window_id: null, count: "1" }
      ])
    );
    expect(pending.rows).toEqual([
      { status: "pending", count: "1" },
      { status: "suppressed", count: "1" }
    ]);
    expect(timeline.rows).toEqual([
      { event_type: "alert_suppressed", count: "2" },
      { event_type: "incident_acknowledged", count: "1" },
      { event_type: "incident_opened", count: "1" },
      { event_type: "source_health_recovery_healthy", count: "1" }
    ]);
    expect(incident.rows[0].status).toBe("recovering");
  });

  it("versions threshold settings and freezes them on the first evaluation of each snapshot", async () => {
    const created = await createStore({
      name: "Threshold Store",
      domain: "https://thresholds.example.com",
      sitemapUrl: "https://thresholds.example.com/sitemap.xml",
      feedUrl: "https://thresholds.example.com/feed.xml",
      categoryUrls: ["https://thresholds.example.com/collections/all"]
    });
    const defaults = await getStoreThresholds(created.store.id);
    const firstUpdate = await updateStoreThresholds(created.store.id, {
      catalogDropPercentage: 0.5,
      catalogDropAbsolute: 40,
      sourceHealthConsecutiveFailures: 3
    });

    const firstSnapshotClient = new Client({ connectionString: dbUrlWithSchema });
    await firstSnapshotClient.connect();
    const firstSnapshotId = await insertFeedObservation(
      firstSnapshotClient,
      created.store.id,
      900,
      150
    );
    await firstSnapshotClient.end();
    const capturedFirst = await captureSnapshotThresholds(created.store.id, firstSnapshotId);

    await updateStoreThresholds(created.store.id, {
      catalogDropPercentage: 0.3
    });
    const replayedFirst = await captureSnapshotThresholds(created.store.id, firstSnapshotId);

    const secondSnapshotClient = new Client({ connectionString: dbUrlWithSchema });
    await secondSnapshotClient.connect();
    const secondSnapshotId = await insertFeedObservation(
      secondSnapshotClient,
      created.store.id,
      900,
      151
    );
    await secondSnapshotClient.end();
    const capturedSecond = await captureSnapshotThresholds(created.store.id, secondSnapshotId);

    await Promise.all([
      updateStoreThresholds(created.store.id, { sourceDivergenceAbsolute: 30 }),
      updateStoreThresholds(created.store.id, { minimumMismatchCount: 9 })
    ]);
    const current = await getStoreThresholds(created.store.id);

    expect(defaults.thresholdVersion).toBe(1);
    expect(firstUpdate.thresholdVersion).toBe(2);
    expect(firstUpdate.configurationHash).not.toBe(defaults.configurationHash);
    expect(capturedFirst).toMatchObject({
      thresholdVersion: 2,
      configurationHash: firstUpdate.configurationHash,
      thresholds: {
        catalogDropPercentage: 0.5,
        catalogDropAbsolute: 40,
        sourceHealthConsecutiveFailures: 3
      }
    });
    expect(replayedFirst).toEqual(capturedFirst);
    expect(capturedSecond.thresholdVersion).toBe(3);
    expect(capturedSecond.thresholds.catalogDropPercentage).toBe(0.3);
    expect(current).toMatchObject({
      thresholdVersion: 5,
      thresholds: {
        sourceDivergenceAbsolute: 30,
        minimumMismatchCount: 9
      }
    });

    const sourceHealthClient = new Client({ connectionString: dbUrlWithSchema });
    await sourceHealthClient.connect();
    const timeoutOne = await insertFeedObservation(
      sourceHealthClient,
      created.store.id,
      0,
      160,
      "timeout"
    );
    const timeoutTwo = await insertFeedObservation(
      sourceHealthClient,
      created.store.id,
      0,
      161,
      "timeout"
    );
    const timeoutThree = await insertFeedObservation(
      sourceHealthClient,
      created.store.id,
      0,
      162,
      "timeout"
    );
    await sourceHealthClient.end();

    await expect(
      createOrUpdateFeedSourceHealthIncident(created.store.id, timeoutOne)
    ).resolves.toBeNull();
    await expect(
      createOrUpdateFeedSourceHealthIncident(created.store.id, timeoutTwo)
    ).resolves.toBeNull();
    await expect(
      createOrUpdateFeedSourceHealthIncident(created.store.id, timeoutThree)
    ).resolves.toBeTruthy();
  });

  it("versions alert preferences and creates idempotent per-channel delivery intents", async () => {
    const created = await createStore({
      name: "Alert Preferences Store",
      domain: "https://alert-preferences.example.com",
      sitemapUrl: "https://alert-preferences.example.com/sitemap.xml",
      feedUrl: "https://alert-preferences.example.com/feed.xml",
      categoryUrls: ["https://alert-preferences.example.com/collections/all"]
    });
    const alertClient = await (await import("./client")).getPool().connect();

    const insertedIncident = await alertClient.query<{ id: string }>(
      `
        INSERT INTO incidents (store_id, severity, type, title, summary, status)
        VALUES ($1, 'warning', 'source_health', 'Feed unavailable', 'Feed timed out.', 'open')
        RETURNING id
      `,
      [created.store.id]
    );
    const incidentId = insertedIncident.rows[0].id;

    const defaultPreferences = await getAlertPreferences(created.store.id, alertClient);
    const opened = await createIncidentOpenedAlertDelivery(alertClient, {
      incidentId,
      storeId: created.store.id,
      snapshotId: null
    });
    await createIncidentOpenedAlertDelivery(alertClient, {
      incidentId,
      storeId: created.store.id,
      snapshotId: null
    });

    expect(defaultPreferences).toMatchObject({
      alertPreferenceVersion: 1,
      preferences: { emailEnabled: true, telegramEnabled: false, notifyOnRecovery: false }
    });
    expect(opened).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "email",
          status: "pending",
          suppressionReason: null,
          alertPreferenceVersion: defaultPreferences.alertPreferenceVersion,
          alertPreferenceHash: defaultPreferences.configurationHash
        }),
        expect.objectContaining({
          channel: "telegram",
          status: "suppressed",
          suppressionReason: "channel_disabled",
          alertPreferenceVersion: defaultPreferences.alertPreferenceVersion,
          alertPreferenceHash: defaultPreferences.configurationHash
        })
      ])
    );
    await expect(
      alertClient.query("DELETE FROM incident_events WHERE id = $1", [opened[0].eventId])
    ).rejects.toThrow();

    await acknowledgeIncident(incidentId, { actor: "olga@example.com" });

    const muted = await updateAlertPreferences(created.store.id, {
      telegramEnabled: true,
      mutedIncidentTypes: ["source_health"]
    });
    const replayedOpened = await createIncidentOpenedAlertDelivery(alertClient, {
      incidentId,
      storeId: created.store.id,
      snapshotId: null
    });
    const isolated = await createStore({
      name: "Isolated Alert Preferences Store",
      domain: "https://isolated-alert-preferences.example.com",
      sitemapUrl: "https://isolated-alert-preferences.example.com/sitemap.xml",
      feedUrl: "https://isolated-alert-preferences.example.com/feed.xml",
      categoryUrls: ["https://isolated-alert-preferences.example.com/collections/all"]
    });
    const isolatedPreferences = await getAlertPreferences(isolated.store.id);
    const mutedEvent = await insertAlertTestEvent(alertClient, incidentId, created.store.id, "muted");
    const mutedDeliveries = await createAlertDeliveriesForIncidentEvent(alertClient, {
      incidentId,
      eventId: mutedEvent,
      alertType: "incident_worsened"
    });
    await createAlertDeliveriesForIncidentEvent(alertClient, {
      incidentId,
      eventId: mutedEvent,
      alertType: "incident_worsened"
    });

    expect(muted).toMatchObject({
      alertPreferenceVersion: 2,
      preferences: { telegramEnabled: true, mutedIncidentTypes: ["source_health"] }
    });
    expect(replayedOpened).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ alertPreferenceVersion: 1, alertPreferenceHash: defaultPreferences.configurationHash })
      ])
    );
    expect(isolatedPreferences).toMatchObject({
      alertPreferenceVersion: 1,
      preferences: { telegramEnabled: false, mutedIncidentTypes: [] }
    });
    expect(mutedDeliveries).toHaveLength(2);
    expect(mutedDeliveries.every((delivery) => delivery.suppressionReason === "incident_type_muted")).toBe(true);

    const concurrentEvent = await insertAlertTestEvent(
      alertClient,
      incidentId,
      created.store.id,
      "concurrent"
    );
    const pool = (await import("./client")).getPool();
    const [workerA, workerB] = await Promise.all([pool.connect(), pool.connect()]);
    try {
      const concurrentDeliveries = await Promise.all([
        createAlertDeliveriesForIncidentEvent(workerA, {
          incidentId,
          eventId: concurrentEvent,
          alertType: "incident_worsened"
        }),
        createAlertDeliveriesForIncidentEvent(workerB, {
          incidentId,
          eventId: concurrentEvent,
          alertType: "incident_worsened"
        })
      ]);
      expect(concurrentDeliveries.map((deliveries) => deliveries.length)).toEqual([2, 2]);
    } finally {
      workerA.release();
      workerB.release();
    }

    const recoveredPreferences = await updateAlertPreferences(created.store.id, {
      mutedIncidentTypes: [],
      notifyOnRecovery: true
    });
    const recoveryEvent = await insertAlertTestEvent(alertClient, incidentId, created.store.id, "recovered");
    const recoveryDeliveries = await createAlertDeliveriesForIncidentEvent(alertClient, {
      incidentId,
      eventId: recoveryEvent,
      alertType: "incident_resolved"
    });

    expect(recoveredPreferences).toMatchObject({
      alertPreferenceVersion: 3,
      preferences: { notifyOnRecovery: true, telegramEnabled: true }
    });
    expect(recoveryDeliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "email", status: "pending" }),
        expect.objectContaining({ channel: "telegram", status: "pending" })
      ])
    );

    await createMaintenanceWindow(created.store.id, {
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 60_000).toISOString(),
      reason: "Feed maintenance",
      createdBy: "olga@example.com"
    });
    await updateAlertPreferences(created.store.id, { mutedIncidentTypes: ["source_health"] });
    const maintenanceMutedEvent = await insertAlertTestEvent(
      alertClient,
      incidentId,
      created.store.id,
      "maintenance-muted"
    );
    const maintenanceMutedDeliveries = await createAlertDeliveriesForIncidentEvent(alertClient, {
      incidentId,
      eventId: maintenanceMutedEvent,
      alertType: "incident_opened"
    });
    await createAlertDeliveriesForIncidentEvent(alertClient, {
      incidentId,
      eventId: maintenanceMutedEvent,
      alertType: "incident_opened"
    });

    const deliveryCounts = await alertClient.query<{ channel: string; count: string }>(
      `
        SELECT channel, COUNT(*) AS count
        FROM alert_deliveries
        WHERE incident_id = $1
        GROUP BY channel
        ORDER BY channel
      `,
      [incidentId]
    );
    alertClient.release();

    expect(maintenanceMutedDeliveries).toHaveLength(2);
    expect(
      maintenanceMutedDeliveries.every(
        (delivery) => delivery.suppressionReason === "incident_type_muted"
      )
    ).toBe(true);
    expect(deliveryCounts.rows).toEqual([
      { channel: "email", count: "5" },
      { channel: "telegram", count: "5" }
    ]);
  });

  it("claims alert deliveries with leases, fencing, retries, and channel isolation", async () => {
    const created = await createStore({
      name: "Alert Delivery Worker Store",
      domain: "https://alert-delivery-worker.example.com",
      sitemapUrl: "https://alert-delivery-worker.example.com/sitemap.xml",
      feedUrl: "https://alert-delivery-worker.example.com/feed.xml",
      categoryUrls: ["https://alert-delivery-worker.example.com/collections/all"]
    });
    await updateAlertPreferences(created.store.id, { telegramEnabled: true });
    const pool = (await import("./client")).getPool();
    const client = await pool.connect();

    try {
      await client.query(
        `
          UPDATE alert_deliveries
          SET status = 'sent',
              sent_at = clock_timestamp(),
              locked_at = NULL,
              locked_by = NULL,
              lease_expires_at = NULL,
              updated_at = clock_timestamp()
          WHERE status = 'pending'
        `
      );
      const leaseDelivery = await createPendingDelivery(client, created.store.id, "lease", "email");
      await updateAlertPreferences(created.store.id, { mutedIncidentTypes: ["source_health"] });
      await createPendingDelivery(client, created.store.id, "suppressed", "email");
      await updateAlertPreferences(created.store.id, { mutedIncidentTypes: [] });

      const initialClaim = await claimDueAlertDeliveries({
        channel: "email",
        workerId: "worker-a",
        limit: 10,
        leaseSeconds: 300
      });
      expect(initialClaim).toEqual([
        expect.objectContaining({ id: leaseDelivery.id, attemptCount: 1, lockedBy: "worker-a" })
      ]);
      await expect(
        claimDueAlertDeliveries({ channel: "email", workerId: "worker-b", limit: 10 })
      ).resolves.toEqual([]);

      await client.query(
        "UPDATE alert_deliveries SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [leaseDelivery.id]
      );
      const reclaimed = await claimDueAlertDeliveries({
        channel: "email",
        workerId: "worker-b",
        limit: 10
      });
      expect(reclaimed).toEqual([
        expect.objectContaining({ id: leaseDelivery.id, attemptCount: 2, lockedBy: "worker-b" })
      ]);
      await expect(
        markAlertDeliverySent({
          deliveryId: leaseDelivery.id,
          workerId: "worker-a",
          claimedAttemptCount: 1,
          providerMessageId: "stale-message"
        })
      ).resolves.toBeNull();
      const sent = await markAlertDeliverySent({
        deliveryId: leaseDelivery.id,
        workerId: "worker-b",
        claimedAttemptCount: 2,
        providerMessageId: "provider-message-1"
      });
      expect(sent).toMatchObject({ status: "sent", attemptCount: 2, providerMessageId: "provider-message-1" });
      await expect(
        markAlertDeliverySent({
          deliveryId: leaseDelivery.id,
          workerId: "worker-b",
          claimedAttemptCount: 2,
          providerMessageId: "ignored-on-replay"
        })
      ).resolves.toMatchObject({ status: "sent", providerMessageId: "provider-message-1" });

      const telegramClaim = await claimDueAlertDeliveries({
        channel: "telegram",
        workerId: "telegram-worker",
        limit: 10
      });
      expect(telegramClaim).toEqual([
        expect.objectContaining({ incidentEventId: leaseDelivery.incidentEventId, channel: "telegram" })
      ]);
      await markAlertDeliverySent({
        deliveryId: telegramClaim[0].id,
        workerId: "telegram-worker",
        claimedAttemptCount: telegramClaim[0].attemptCount,
        providerMessageId: "telegram-message-1"
      });

      const retryDelivery = await createPendingDelivery(client, created.store.id, "retry", "email");
      const firstRetryClaim = await claimDueAlertDeliveries({
        channel: "email",
        workerId: "retry-worker",
        maxAttempts: 2
      });
      expect(firstRetryClaim).toEqual([
        expect.objectContaining({ id: retryDelivery.id, attemptCount: 1 })
      ]);
      const retried = await markAlertDeliveryAttemptFailed({
        deliveryId: retryDelivery.id,
        workerId: "retry-worker",
        claimedAttemptCount: 1,
        error: new Error("temporary provider outage"),
        maxAttempts: 2
      });
      expect(retried).toMatchObject({ status: "pending", attemptCount: 1, lastError: "temporary provider outage" });
      const retryTiming = await client.query<{ scheduled: boolean }>(
        "SELECT next_attempt_at >= clock_timestamp() + interval '59 seconds' AS scheduled FROM alert_deliveries WHERE id = $1",
        [retryDelivery.id]
      );
      expect(retryTiming.rows[0].scheduled).toBe(true);
      await client.query(
        "UPDATE alert_deliveries SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [retryDelivery.id]
      );
      const secondRetryClaim = await claimDueAlertDeliveries({
        channel: "email",
        workerId: "retry-worker",
        maxAttempts: 2
      });
      expect(secondRetryClaim).toEqual([
        expect.objectContaining({ id: retryDelivery.id, attemptCount: 2 })
      ]);
      await expect(
        markAlertDeliveryAttemptFailed({
          deliveryId: retryDelivery.id,
          workerId: "retry-worker",
          claimedAttemptCount: 2,
          error: "permanent provider outage",
          maxAttempts: 2
        })
      ).resolves.toMatchObject({ status: "failed", attemptCount: 2, failedAt: expect.any(String) });
      await expect(
        claimDueAlertDeliveries({ channel: "email", workerId: "retry-worker", maxAttempts: 2 })
      ).resolves.toEqual([]);

      const firstConcurrent = await createPendingDelivery(client, created.store.id, "concurrent-one", "email");
      const secondConcurrent = await createPendingDelivery(client, created.store.id, "concurrent-two", "email");
      const [claimedByA, claimedByB] = await Promise.all([
        claimDueAlertDeliveries({ channel: "email", workerId: "concurrent-a", limit: 1 }),
        claimDueAlertDeliveries({ channel: "email", workerId: "concurrent-b", limit: 1 })
      ]);
      const concurrentIds = [claimedByA[0]?.id, claimedByB[0]?.id].sort();
      expect(concurrentIds).toEqual([firstConcurrent.id, secondConcurrent.id].sort());

      const workerDelivery = await createPendingDelivery(client, created.store.id, "worker", "email");
      const workerFailure = await createPendingDelivery(client, created.store.id, "worker-failure", "email");
      const { runAlertDeliveryBatch } = await import("@eim/worker");
      const batch = await runAlertDeliveryBatch({
        channel: "email",
        workerId: "batch-worker",
        sender: {
          async send(delivery) {
            if (delivery.id === workerFailure.id) throw new Error("temporary batch failure");
            if (delivery.id !== workerDelivery.id) throw new Error("unexpected delivery");
            return { providerMessageId: "batch-provider-message" };
          }
        }
      });
      expect(batch).toEqual({ claimed: 2, sent: 1, retried: 1, failed: 0 });
    } finally {
      client.release();
    }
  });
});

async function createPendingDelivery(
  client: pg.PoolClient,
  storeId: string,
  suffix: string,
  channel: "email" | "telegram"
): Promise<{ id: string; incidentEventId: string }> {
  const incident = await client.query<{ id: string }>(
    `
      INSERT INTO incidents (store_id, severity, type, title, summary, status)
      VALUES ($1, 'warning', 'source_health', 'Feed unavailable', 'Alert delivery worker smoke.', 'open')
      RETURNING id
    `,
    [storeId]
  );
  const eventId = await insertAlertTestEvent(client, incident.rows[0].id, storeId, `delivery-${suffix}`);
  const deliveries = await createAlertDeliveriesForIncidentEvent(client, {
    incidentId: incident.rows[0].id,
    eventId,
    alertType: "incident_opened"
  });
  const delivery = deliveries.find((item) => item.channel === channel);
  if (!delivery) throw new Error(`Missing ${channel} delivery for ${suffix}`);
  return { id: delivery.id, incidentEventId: delivery.eventId };
}

async function insertAlertTestEvent(
  client: pg.PoolClient,
  incidentId: string,
  storeId: string,
  suffix: string
): Promise<string> {
  const event = await client.query<{ id: string }>(
    `
      INSERT INTO incident_events (incident_id, store_id, event_type, to_status, message, metadata_json)
      VALUES ($1, $2, $3, 'open', 'Alert preference smoke event.', '{}'::jsonb)
      RETURNING id
    `,
    [incidentId, storeId, `alert_preference_${suffix}`]
  );
  return event.rows[0].id;
}

async function insertFeedObservation(
  client: pg.Client,
  storeId: string,
  feedProductCount: number,
  dayOffset: number,
  sourceCheckStatus: "success" | "partial" | "timeout" | "blocked" | "authentication_failed" | "parse_failed" | "source_unavailable" = "success"
): Promise<string> {
  const snapshot = await client.query<{ id: string }>(
    `
      INSERT INTO snapshots (
        store_id,
        status,
        baseline_role,
        feed_product_count,
        started_at,
        finished_at,
        idempotency_key
      )
      VALUES (
        $1,
        'completed',
        'normal_check',
        $2,
        TIMESTAMPTZ '2026-07-01 00:00:00+00' + ($3::int * INTERVAL '1 day'),
        TIMESTAMPTZ '2026-07-01 00:05:00+00' + ($3::int * INTERVAL '1 day'),
        $4
      )
      RETURNING id
    `,
    [storeId, feedProductCount, dayOffset, `baseline-test-${storeId}-${dayOffset}`]
  );

  await client.query(
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
        items_observed
      )
      VALUES (
        $1,
        $2,
        'feed',
        $3,
        (SELECT feed_url FROM stores WHERE id = $2),
        $6,
        TIMESTAMPTZ '2026-07-01 00:00:00+00' + ($4::int * INTERVAL '1 day'),
        TIMESTAMPTZ '2026-07-01 00:05:00+00' + ($4::int * INTERVAL '1 day'),
        300000,
        $5
      )
    `,
    [
      snapshot.rows[0].id,
      storeId,
      `feed-${dayOffset}`,
      dayOffset,
      feedProductCount,
      sourceCheckStatus
    ]
  );

  return snapshot.rows[0].id;
}

async function insertSeoSnapshot(
  client: pg.Client,
  storeId: string,
  dayOffset: number,
  urls: string[],
  regressions: {
    noindex?: Set<number>;
    canonicalDifferent?: Set<number>;
    schemaMissing?: Set<number>;
    httpError?: Set<number>;
  }
): Promise<string> {
  const selectedUrlsHash = `test-hash:${urls.join("|")}`;
  const snapshot = await client.query<{ id: string }>(
    `
      INSERT INTO snapshots (
        store_id,
        status,
        baseline_role,
        started_at,
        finished_at,
        sample_manifest_json,
        idempotency_key
      )
      VALUES (
        $1,
        'completed',
        'normal_check',
        TIMESTAMPTZ '2026-07-01 00:00:00+00' + ($2::int * INTERVAL '1 day'),
        TIMESTAMPTZ '2026-07-01 00:05:00+00' + ($2::int * INTERVAL '1 day'),
        $3,
        $4
      )
      RETURNING id
    `,
    [
      storeId,
      dayOffset,
      JSON.stringify({
        sampleStrategy: "stable_hash_v1",
        productPageParserVersion: "product_page_parser_v1",
        normalizationVersion: "product_page_normalizer_v1",
        schemaValidationVersion: "schema_valid_enough_v1",
        requestedSampleSize: urls.length,
        selectedCount: urls.length,
        selectedUrlsHash,
        selectedUrls: urls
      }),
      `seo-test-${storeId}-${dayOffset}`
    ]
  );

  for (const [index, url] of urls.entries()) {
    const noindex = regressions.noindex?.has(index) ?? false;
    const canonicalDifferent = regressions.canonicalDifferent?.has(index) ?? false;
    const schemaMissing = regressions.schemaMissing?.has(index) ?? false;
    const httpError = regressions.httpError?.has(index) ?? false;
    const canonicalState = canonicalDifferent ? "different" : "self";
    const httpStatus = httpError ? 404 : 200;
    const indexability = noindex ? "noindex" : "indexable";
    const schemaValidEnough = !schemaMissing;

    await client.query(
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
          http_status,
          items_observed
        )
        VALUES (
          $1,
          $2,
          'product_page',
          $3,
          $4,
          $5,
          TIMESTAMPTZ '2026-07-01 00:00:00+00' + ($6::int * INTERVAL '1 day'),
          TIMESTAMPTZ '2026-07-01 00:05:00+00' + ($6::int * INTERVAL '1 day'),
          1000,
          $7,
          1
        )
      `,
      [
        snapshot.rows[0].id,
        storeId,
        url,
        url,
        httpError ? "partial" : "success",
        dayOffset,
        httpStatus
      ]
    );

    await client.query(
      `
        INSERT INTO source_items (
          snapshot_id,
          store_id,
          source,
          stable_key,
          url,
          title,
          http_status,
          indexability,
          canonical_url,
          schema_present,
          metadata_json,
          raw_hash
        )
        VALUES (
          $1,
          $2,
          'storefront',
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11
        )
      `,
      [
        snapshot.rows[0].id,
        storeId,
        `url:${url}`,
        url,
        `Product ${index}`,
        httpStatus,
        indexability,
        canonicalDifferent ? `${url}?variant=canonical-away` : url,
        schemaValidEnough,
        JSON.stringify({
          checkedAsProductPage: true,
          productPage: {
            canonicalState,
            schemaValidEnough,
            finalUrl: url
          }
        }),
        `seo-hash-${dayOffset}-${index}`
      ]
    );
  }

  return snapshot.rows[0].id;
}

async function insertPriceAvailabilitySnapshot(
  client: pg.Client,
  storeId: string,
  options: {
    mismatchCount: number;
    availabilityMismatchCount?: number;
    matchMethod: "offer_id" | "normalized_url" | "canonical_url" | "fallback";
    dayOffset?: number;
    feedStatus?: "success" | "partial" | "timeout" | "blocked" | "authentication_failed" | "parse_failed" | "source_unavailable";
    productPageStatus?: "success" | "partial" | "timeout" | "blocked" | "authentication_failed" | "parse_failed" | "source_unavailable";
  }
): Promise<string> {
  const total = 25;
  const dayOffset = options.dayOffset ?? 94;
  const feedStatus = options.feedStatus ?? "success";
  const productPageStatus = options.productPageStatus ?? "success";
  const snapshot = await client.query<{ id: string }>(
    `
      INSERT INTO snapshots (
        store_id,
        status,
        baseline_role,
        started_at,
        finished_at,
        idempotency_key
      )
      VALUES (
        $1,
        'completed',
        'normal_check',
        TIMESTAMPTZ '2026-07-01 00:00:00+00' + ($2::int * INTERVAL '1 day'),
        TIMESTAMPTZ '2026-07-01 00:05:00+00' + ($2::int * INTERVAL '1 day'),
        $3
      )
      RETURNING id
    `,
    [
      storeId,
      dayOffset,
      `price-availability-${storeId}-${options.matchMethod}-${dayOffset}`
    ]
  );

  await client.query(
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
        items_observed
      )
      VALUES
        ($1, $2, 'feed', 'feed', (SELECT feed_url FROM stores WHERE id = $2), $4, now(), now(), 1000, $3),
        ($1, $2, 'product_page', 'product-page-sample', 'https://price-mismatch.example.com/products', $5, now(), now(), 1000, $3)
    `,
    [snapshot.rows[0].id, storeId, total, feedStatus, productPageStatus]
  );

  for (let index = 0; index < total; index += 1) {
    const priceMismatched = index < options.mismatchCount;
    const availabilityMismatched = index < (options.availabilityMismatchCount ?? options.mismatchCount);
    const feedPrice = priceMismatched ? "10.00" : "20.00";
    const storefrontPrice = priceMismatched ? "11.00" : "20.00";
    const feedAvailability = availabilityMismatched ? "out_of_stock" : "in_stock";
    const storefrontAvailability = "in_stock";
    const productUrl = `https://price-mismatch.example.com/products/${index}`;
    const feedItem = await client.query<{ id: string }>(
      `
        INSERT INTO source_items (
          snapshot_id,
          store_id,
          source,
          stable_key,
          offer_id,
          url,
          title,
          price,
          currency,
          availability,
          raw_hash
        )
        VALUES ($1, $2, 'feed', $3, $4, $5, $6, $7, 'USD', $8, $9)
        RETURNING id
      `,
      [
        snapshot.rows[0].id,
        storeId,
        `feed-${index}`,
        `sku-${index}`,
        productUrl,
        `Product ${index}`,
        feedPrice,
        feedAvailability,
        `feed-price-hash-${index}`
      ]
    );
    const storefrontItem = await client.query<{ id: string }>(
      `
        INSERT INTO source_items (
          snapshot_id,
          store_id,
          source,
          stable_key,
          url,
          title,
          price,
          currency,
          availability,
          raw_hash
        )
        VALUES ($1, $2, 'storefront', $3, $4, $5, $6, 'USD', $7, $8)
        RETURNING id
      `,
      [
        snapshot.rows[0].id,
        storeId,
        `storefront-${index}`,
        productUrl,
        `Product ${index}`,
        storefrontPrice,
        storefrontAvailability,
        `storefront-price-hash-${index}`
      ]
    );

    await client.query(
      `
        INSERT INTO source_matches (
          snapshot_id,
          store_id,
          matched_key,
          match_method,
          match_confidence,
          feed_item_id,
          storefront_item_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        snapshot.rows[0].id,
        storeId,
        `price-match-${index}`,
        options.matchMethod,
        options.matchMethod === "fallback" ? 0.5 : 0.98,
        feedItem.rows[0].id,
        storefrontItem.rows[0].id
      ]
    );
  }

  return snapshot.rows[0].id;
}

async function insertCategoryObservation(
  client: pg.Client,
  storeId: string,
  snapshotId: string,
  status: "success" | "partial",
  itemsObserved: number
): Promise<void> {
  await client.query(
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
        metadata_json
      )
      VALUES (
        $1,
        $2,
        'category',
        'category-all',
        'https://divergence.example.com/collections/all',
        $3,
        now(),
        now(),
        1000,
        $4,
        $5
      )
    `,
    [
      snapshotId,
      storeId,
      status,
      itemsObserved,
      JSON.stringify({
        paginationComplete: status === "success",
        truncated: false,
        confidence: status === "success" ? 0.95 : 0.4
      })
    ]
  );
}

async function insertStorefrontFeedMatches(
  client: pg.Client,
  storeId: string,
  snapshotId: string,
  matchedStorefrontCount: number,
  missingFromFeedCount: number
): Promise<void> {
  const matchedInFeedCount = matchedStorefrontCount - missingFromFeedCount;

  for (let index = 0; index < matchedStorefrontCount; index += 1) {
    const storefrontItem = await client.query<{ id: string }>(
      `
        INSERT INTO source_items (
          snapshot_id,
          store_id,
          source,
          stable_key,
          url,
          raw_hash
        )
        VALUES ($1, $2, 'storefront', $3, $4, $5)
        RETURNING id
      `,
      [
        snapshotId,
        storeId,
        `storefront-${index}`,
        `https://divergence.example.com/products/${index}`,
        `hash-${index}`
      ]
    );

    let feedItemId: string | null = null;

    if (index < matchedInFeedCount) {
      const feedItem = await client.query<{ id: string }>(
        `
          INSERT INTO source_items (
            snapshot_id,
            store_id,
            source,
            stable_key,
            url,
            raw_hash
          )
          VALUES ($1, $2, 'feed', $3, $4, $5)
          RETURNING id
        `,
        [
          snapshotId,
          storeId,
          `feed-${index}`,
          `https://divergence.example.com/products/${index}`,
          `feed-hash-${index}`
        ]
      );
      feedItemId = feedItem.rows[0].id;
    }

    await client.query(
      `
        INSERT INTO source_matches (
          snapshot_id,
          store_id,
          matched_key,
          match_method,
          match_confidence,
          feed_item_id,
          storefront_item_id
        )
        VALUES ($1, $2, $3, 'normalized_url', 0.95, $4, $5)
      `,
      [
        snapshotId,
        storeId,
        `url:https://divergence.example.com/products/${index}`,
        feedItemId,
        storefrontItem.rows[0].id
      ]
    );
  }
}
