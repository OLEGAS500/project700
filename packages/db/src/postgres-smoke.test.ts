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
  markAlertDeliveryPermanentFailed,
  markAlertDeliverySent
} from "./alert-delivery-jobs";
import { getAlertEventPayloadByEventId } from "./alert-event-payloads";
import { getAlertPreferences, updateAlertPreferences } from "./alert-preferences";
import {
  getDashboardIncidentDetail,
  getDashboardStoreSummary,
  listDashboardIncidents,
  listDashboardStoreSummaries
} from "./dashboard";
import {
  disableEmailDestination,
  getEmailDestination,
  upsertEmailDestination
} from "./email-destinations";
import {
  connectMerchantCenter,
  disconnectMerchantCenter,
  getMerchantCenterConnection,
  MerchantCenterStoreNotFoundError
} from "./merchant-center";
import {
  claimMerchantCenterOAuthRefresh,
  completeMerchantCenterOAuthAuthorization,
  completeMerchantCenterOAuthRefresh,
  consumeMerchantCenterOAuthState,
  createMerchantCenterOAuthState,
  getMerchantCenterOAuthCredentials,
  getMerchantCenterOAuthStatus,
  MerchantCenterOAuthCredentialLeaseLostError,
  MerchantCenterOAuthRefreshInProgressError,
  MerchantCenterOAuthStateInvalidError
} from "./merchant-center-oauth";
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
  getActiveMaintenanceWindow,
  MaintenanceWindowConflictError
} from "./maintenance-windows";
import { createStore, DuplicateStoreDomainError } from "./stores";
import {
  captureSnapshotThresholds,
  getStoreThresholds,
  updateStoreThresholds
} from "./thresholds";
import {
  disableTelegramDestination,
  getTelegramDestination,
  upsertTelegramDestination
} from "./telegram-destinations";

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
    expect(Number(counts.rows[0].alert_preferences)).toBe(6);
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
    expect(secondRun.skipped).toEqual([
      "0001_initial.sql",
      "0002_alert_delivery_worker.sql",
      "0003_alert_event_payloads.sql",
      "0004_telegram_destinations.sql",
      "0005_email_destinations.sql",
      "0006_alert_payload_versions.sql",
      "0007_dashboard_read_models.sql",
      "0008_merchant_center_oauth.sql"
    ]);
    expect(migrations.rows.map((migration) => migration.name)).toEqual([
      "0001_initial.sql",
      "0002_alert_delivery_worker.sql",
      "0003_alert_event_payloads.sql",
      "0004_telegram_destinations.sql",
      "0005_email_destinations.sql",
      "0006_alert_payload_versions.sql",
      "0007_dashboard_read_models.sql",
      "0008_merchant_center_oauth.sql"
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

  it("stores and clears Merchant Center account connections without credentials", async () => {
    const created = await createStore({
      name: "Merchant Connection Store",
      domain: "https://merchant-connection.example.com",
      sitemapUrl: "https://merchant-connection.example.com/sitemap.xml",
      feedUrl: "https://merchant-connection.example.com/feed.xml",
      categoryUrls: ["https://merchant-connection.example.com/collections/all"]
    });

    await expect(getMerchantCenterConnection(created.store.id)).resolves.toEqual({
      storeId: created.store.id,
      merchantCenterAccountId: null,
      connected: false
    });

    const connected = await connectMerchantCenter(created.store.id, {
      merchantCenterAccountId: " 123456789 "
    });
    expect(connected).toEqual({
      storeId: created.store.id,
      merchantCenterAccountId: "123456789",
      connected: true
    });

    const reconnected = await connectMerchantCenter(created.store.id, {
      merchantCenterAccountId: "987654321"
    });
    expect(reconnected).toMatchObject({
      storeId: created.store.id,
      merchantCenterAccountId: "987654321",
      connected: true
    });

    const disconnected = await disconnectMerchantCenter(created.store.id);
    expect(disconnected).toEqual({
      storeId: created.store.id,
      merchantCenterAccountId: null,
      connected: false
    });

    await expect(
      connectMerchantCenter("70000000-0000-4000-8000-000000000099", {
        merchantCenterAccountId: "123456789"
      })
    ).rejects.toBeInstanceOf(MerchantCenterStoreNotFoundError);
  });

  it("stores encrypted OAuth credentials, consumes state once, and fences refresh", async () => {
    const previousEncryptionKey = process.env.MERCHANT_CENTER_CREDENTIALS_ENCRYPTION_KEY;
    process.env.MERCHANT_CENTER_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

    try {
      const created = await createStore({
        name: "Merchant OAuth Store",
        domain: "https://merchant-oauth.example.com",
        sitemapUrl: "https://merchant-oauth.example.com/sitemap.xml",
        feedUrl: "https://merchant-oauth.example.com/feed.xml",
        categoryUrls: ["https://merchant-oauth.example.com/collections/all"]
      });

      const stateHash = "a".repeat(64);
      await createMerchantCenterOAuthState(created.store.id, {
        stateHash,
        redirectUri: "https://app.example.com/oauth/callback",
        expiresAt: new Date(Date.now() + 60_000)
      });
      await expect(consumeMerchantCenterOAuthState(stateHash)).resolves.toMatchObject({
        storeId: created.store.id,
        redirectUri: "https://app.example.com/oauth/callback"
      });
      await expect(consumeMerchantCenterOAuthState(stateHash)).rejects.toThrow();

      const credentialsInput = {
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        tokenType: "Bearer",
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: ["scope-a", "scope-b"],
        metadata: { provider: "google", authorization: "oauth2" }
      };
      const connected = await completeMerchantCenterOAuthAuthorization(stateHash, credentialsInput);
      expect(connected).toMatchObject({
        storeId: created.store.id,
        hasAccessToken: true,
        hasRefreshToken: true,
        credentialsVersion: 1,
        refreshInProgress: false
      });

      const stateAfterCompletion = await new Client({ connectionString: dbUrlWithSchema });
      await stateAfterCompletion.connect();
      const completedStateRows = await stateAfterCompletion.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM merchant_center_oauth_states WHERE state_hash = $1",
        [stateHash]
      );
      await stateAfterCompletion.end();
      expect(completedStateRows.rows[0]).toEqual({ count: "0" });

      const client = new Client({ connectionString: dbUrlWithSchema });
      await client.connect();
      const encrypted = await client.query<{
        encrypted_access_token: string;
        encrypted_refresh_token: string;
      }>(
        `
          SELECT encrypted_access_token, encrypted_refresh_token
          FROM merchant_center_oauth_credentials
          WHERE store_id = $1
        `,
        [created.store.id]
      );
      await client.end();

      expect(encrypted.rows[0].encrypted_access_token).not.toContain("access-secret");
      expect(encrypted.rows[0].encrypted_refresh_token).not.toContain("refresh-secret");
      await expect(getMerchantCenterOAuthCredentials(created.store.id)).resolves.toMatchObject({
        hasAccessToken: true,
        hasRefreshToken: true,
        scopes: ["scope-a", "scope-b"]
      });
      await expect(getMerchantCenterOAuthStatus(created.store.id)).resolves.toMatchObject({
        storeId: created.store.id,
        credentials: { credentialsVersion: 1 }
      });

      const lockId = "70000000-0000-4000-8000-000000000002";
      await expect(claimMerchantCenterOAuthRefresh(created.store.id, lockId)).resolves.toMatchObject({
        accessToken: "access-secret",
        refreshToken: "refresh-secret"
      });
      await expect(
        claimMerchantCenterOAuthRefresh(
          created.store.id,
          "70000000-0000-4000-8000-000000000003"
        )
      ).rejects.toBeInstanceOf(MerchantCenterOAuthRefreshInProgressError);

      const expiredLeaseClient = new Client({ connectionString: dbUrlWithSchema });
      await expiredLeaseClient.connect();
      await expiredLeaseClient.query(
        `
          UPDATE merchant_center_oauth_credentials
          SET refresh_lock_expires_at = clock_timestamp() - INTERVAL '1 second'
          WHERE store_id = $1
        `,
        [created.store.id]
      );
      await expiredLeaseClient.end();

      await expect(getMerchantCenterOAuthStatus(created.store.id)).resolves.toMatchObject({
        credentials: { refreshInProgress: false }
      });

      const reclaimedLockId = "70000000-0000-4000-8000-000000000004";
      await expect(
        claimMerchantCenterOAuthRefresh(created.store.id, reclaimedLockId)
      ).resolves.toMatchObject({ accessToken: "access-secret" });

      await expect(
        completeMerchantCenterOAuthRefresh(created.store.id, reclaimedLockId, {
          accessToken: "new-access-secret",
          refreshToken: "refresh-secret",
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() + 7_200_000),
          scopes: ["scope-a"],
          metadata: { provider: "google", authorization: "oauth2" }
        })
      ).resolves.toMatchObject({ credentialsVersion: 2, refreshInProgress: false });
      await expect(
        completeMerchantCenterOAuthRefresh(created.store.id, lockId, {
          accessToken: "stale-access",
          refreshToken: "refresh-secret",
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() + 3_600_000),
          scopes: ["scope-a"],
          metadata: { provider: "google" }
        })
      ).rejects.toBeInstanceOf(MerchantCenterOAuthCredentialLeaseLostError);

      await disconnectMerchantCenter(created.store.id);
      const statusAfterDisconnect = await getMerchantCenterOAuthStatus(created.store.id);
      expect(statusAfterDisconnect).toEqual({ storeId: created.store.id, credentials: null });

      const clientAfterDisconnect = new Client({ connectionString: dbUrlWithSchema });
      await clientAfterDisconnect.connect();
      const removedOAuthRows = await clientAfterDisconnect.query<{
        states: string;
        credentials: string;
      }>(
        `
          SELECT
            (SELECT COUNT(*) FROM merchant_center_oauth_states WHERE store_id = $1) AS states,
            (SELECT COUNT(*) FROM merchant_center_oauth_credentials WHERE store_id = $1) AS credentials
        `,
        [created.store.id]
      );
      await clientAfterDisconnect.end();
      expect(removedOAuthRows.rows[0]).toEqual({ states: "0", credentials: "0" });

      const disconnectStateHash = "b".repeat(64);
      await createMerchantCenterOAuthState(created.store.id, {
        stateHash: disconnectStateHash,
        redirectUri: "https://app.example.com/oauth/callback",
        expiresAt: new Date(Date.now() + 60_000)
      });
      await expect(consumeMerchantCenterOAuthState(disconnectStateHash)).resolves.toMatchObject({
        storeId: created.store.id
      });
      await disconnectMerchantCenter(created.store.id);

      await expect(
        completeMerchantCenterOAuthAuthorization(disconnectStateHash, credentialsInput)
      ).rejects.toBeInstanceOf(MerchantCenterOAuthStateInvalidError);
      await expect(getMerchantCenterOAuthStatus(created.store.id)).resolves.toEqual({
        storeId: created.store.id,
        credentials: null
      });

      const clientAfterRace = new Client({ connectionString: dbUrlWithSchema });
      await clientAfterRace.connect();
      const raceRows = await clientAfterRace.query<{
        states: string;
        credentials: string;
        account_id: string | null;
      }>(
        `
          SELECT
            (SELECT COUNT(*) FROM merchant_center_oauth_states WHERE store_id = $1) AS states,
            (SELECT COUNT(*) FROM merchant_center_oauth_credentials WHERE store_id = $1) AS credentials,
            merchant_center_account_id AS account_id
          FROM stores
          WHERE id = $1
        `,
        [created.store.id]
      );
      await clientAfterRace.end();
      expect(raceRows.rows[0]).toEqual({ states: "0", credentials: "0", account_id: null });
    } finally {
      if (previousEncryptionKey === undefined) {
        delete process.env.MERCHANT_CENTER_CREDENTIALS_ENCRYPTION_KEY;
      } else {
        process.env.MERCHANT_CENTER_CREDENTIALS_ENCRYPTION_KEY = previousEncryptionKey;
      }
    }
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
  }, 30_000);

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

  it("enforces the maintenance cancellation lifecycle in PostgreSQL", async () => {
    const created = await createStore({
      name: "Maintenance Lifecycle Store",
      domain: "https://maintenance-lifecycle.example.com",
      sitemapUrl: "https://maintenance-lifecycle.example.com/sitemap.xml",
      feedUrl: "https://maintenance-lifecycle.example.com/feed.xml",
      categoryUrls: ["https://maintenance-lifecycle.example.com/collections/all"]
    });
    const activeRange = {
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 60_000).toISOString()
    };
    const upcomingRange = {
      startsAt: new Date(Date.now() + 120_000).toISOString(),
      endsAt: new Date(Date.now() + 180_000).toISOString()
    };
    const completedRange = {
      startsAt: new Date(Date.now() - 180_000).toISOString(),
      endsAt: new Date(Date.now() - 120_000).toISOString()
    };

    const active = await createMaintenanceWindow(created.store.id, {
      ...activeRange,
      reason: "Active lifecycle window",
      createdBy: "smoke"
    });
    const upcoming = await createMaintenanceWindow(created.store.id, {
      ...upcomingRange,
      reason: "Upcoming lifecycle window",
      createdBy: "smoke"
    });
    const completed = await createMaintenanceWindow(created.store.id, {
      ...completedRange,
      reason: "Completed lifecycle window",
      createdBy: "smoke"
    });
    const cancelled = await createMaintenanceWindow(created.store.id, {
      ...activeRange,
      reason: "Cancelled lifecycle window",
      createdBy: "smoke"
    });

    await expect(cancelMaintenanceWindow(created.store.id, active.id)).resolves.toMatchObject({
      id: active.id
    });
    await expect(cancelMaintenanceWindow(created.store.id, upcoming.id)).resolves.toMatchObject({
      id: upcoming.id
    });
    await cancelMaintenanceWindow(created.store.id, cancelled.id);

    await expect(cancelMaintenanceWindow(created.store.id, completed.id)).rejects.toBeInstanceOf(
      MaintenanceWindowConflictError
    );
    await expect(cancelMaintenanceWindow(created.store.id, cancelled.id)).rejects.toBeInstanceOf(
      MaintenanceWindowConflictError
    );

    const checkClient = new Client({ connectionString: dbUrlWithSchema });
    await checkClient.connect();
    const rows = await checkClient.query<{ id: string; cancelled_at: Date | null }>(
      `
        SELECT id, cancelled_at
        FROM maintenance_windows
        WHERE id = ANY($1::uuid[])
      `,
      [[active.id, upcoming.id, completed.id, cancelled.id]]
    );
    await checkClient.end();

    const cancelledAtById = new Map(rows.rows.map((row) => [row.id, row.cancelled_at]));
    expect(cancelledAtById.get(active.id)).not.toBeNull();
    expect(cancelledAtById.get(upcoming.id)).not.toBeNull();
    expect(cancelledAtById.get(completed.id)).toBeNull();
    expect(cancelledAtById.get(cancelled.id)).not.toBeNull();
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
      mutedIncidentTypes: ["source_health"],
      worseningAffectedCountPercent: 0.33333,
      worseningSeverityIncrease: false
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
      preferences: {
        telegramEnabled: true,
        mutedIncidentTypes: ["source_health"],
        worseningAffectedCountPercent: 0.33333,
        worseningSeverityIncrease: false
      }
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

  it("freezes one canonical alert payload per event for both delivery channels", async () => {
    const created = await createStore({
      name: "Immutable Alert Payload Store",
      domain: "https://immutable-alert-payload.example.com",
      sitemapUrl: "https://immutable-alert-payload.example.com/sitemap.xml",
      feedUrl: "https://immutable-alert-payload.example.com/feed.xml",
      categoryUrls: ["https://immutable-alert-payload.example.com/collections/all"]
    });
    await updateAlertPreferences(created.store.id, {
      telegramEnabled: true,
      notifyOnRecovery: true
    });
    const client = await (await import("./client")).getPool().connect();

    try {
      const incident = await client.query<{ id: string }>(
        `
          INSERT INTO incidents (
            store_id, severity, type, title, summary, likely_source,
            confidence_score, evidence_json, affected_count, before_value,
            after_value, status
          )
          VALUES (
            $1, 'critical', 'catalog_drop', 'Catalog drop detected',
            'The feed count fell below its active baseline.', 'feed', 0.86,
            $2::jsonb, 210, 1000, 790, 'open'
          )
          RETURNING id
        `,
        [
          created.store.id,
          JSON.stringify([
            "Category and sitemap counts remained stable.",
            "The feed count dropped by 21 percent."
          ])
        ]
      );
      const incidentId = incident.rows[0].id;
      const sampleItems = Array.from({ length: 12 }, (_, index) => ({
        stableKey: `offer-${index}`,
        offerId: `offer-${index}`,
        url: `https://immutable-alert-payload.example.com/products/${index}`,
        title: `Product ${index}`
      }));
      await client.query(
        `
          INSERT INTO incident_signals (
            incident_id, source, metric, before_value, after_value,
            change_abs, change_pct, sample_items_json
          )
          VALUES ($1, 'feed', 'product_count', 1000, 790, 210, 0.21, $2::jsonb)
        `,
        [incidentId, JSON.stringify(sampleItems)]
      );
      const openedEvent = await insertAlertTestEvent(
        client,
        incidentId,
        created.store.id,
        "immutable-opened"
      );
      await client.query(
        "UPDATE incident_events SET metadata_json = $2::jsonb WHERE id = $1",
        [openedEvent, JSON.stringify({ reason: "confirmation_matched_drop" })]
      );

      const openedDeliveries = await createAlertDeliveriesForIncidentEvent(client, {
        incidentId,
        eventId: openedEvent,
        alertType: "incident_opened"
      });
      await createAlertDeliveriesForIncidentEvent(client, {
        incidentId,
        eventId: openedEvent,
        alertType: "incident_opened"
      });
      const frozenPayload = await getAlertEventPayloadByEventId(openedEvent, client);
      const payloadCount = await client.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM alert_event_payloads WHERE incident_event_id = $1",
        [openedEvent]
      );

      expect(openedDeliveries).toHaveLength(2);
      expect(new Set(openedDeliveries.map((delivery) => delivery.eventId))).toEqual(
        new Set([openedEvent])
      );
      expect(Number(payloadCount.rows[0].count)).toBe(1);
      expect(frozenPayload?.payload).toMatchObject({
        version: "v1",
        alertType: "incident_opened",
        incident: {
          title: "Catalog drop detected",
          affectedCount: 210,
          confidenceScore: 0.86
        },
        event: { id: openedEvent, reason: "confirmation_matched_drop" },
        metrics: [
          {
            name: "product_count",
            beforeValue: "1000",
            afterValue: "790",
            unit: "products"
          }
        ]
      });
      expect(frozenPayload?.payload.samples).toHaveLength(8);

      await client.query(
        `
          UPDATE incidents
          SET title = 'Mutated incident title',
              summary = 'Mutated after the event.',
              affected_count = 1,
              confidence_score = 0.1
          WHERE id = $1
        `,
        [incidentId]
      );
      await client.query(
        "UPDATE incident_signals SET after_value = 999, sample_items_json = '[]'::jsonb WHERE incident_id = $1",
        [incidentId]
      );
      await createAlertDeliveriesForIncidentEvent(client, {
        incidentId,
        eventId: openedEvent,
        alertType: "incident_opened"
      });
      await expect(
        createAlertDeliveriesForIncidentEvent(client, {
          incidentId,
          eventId: openedEvent,
          alertType: "incident_resolved"
        })
      ).rejects.toThrow("already exists with different identity");
      await expect(getAlertEventPayloadByEventId(openedEvent, client)).resolves.toEqual(
        frozenPayload
      );

      const worsenedEvent = await insertAlertTestEvent(
        client,
        incidentId,
        created.store.id,
        "immutable-worsened"
      );
      await createAlertDeliveriesForIncidentEvent(client, {
        incidentId,
        eventId: worsenedEvent,
        alertType: "incident_worsened"
      });
      await client.query(
        "UPDATE incidents SET status = 'resolved', summary = 'Feed count returned to normal.' WHERE id = $1",
        [incidentId]
      );
      const resolvedEvent = await insertAlertTestEvent(
        client,
        incidentId,
        created.store.id,
        "immutable-resolved"
      );
      await createAlertDeliveriesForIncidentEvent(client, {
        incidentId,
        eventId: resolvedEvent,
        alertType: "incident_resolved"
      });

      const [worsenedPayload, resolvedPayload] = await Promise.all([
        getAlertEventPayloadByEventId(worsenedEvent, client),
        getAlertEventPayloadByEventId(resolvedEvent, client)
      ]);
      expect(worsenedPayload?.payload.alertType).toBe("incident_worsened");
      expect(resolvedPayload?.payload).toMatchObject({
        alertType: "incident_resolved",
        incident: { status: "resolved", summary: "Feed count returned to normal." }
      });
      expect(worsenedPayload?.payload.event.id).not.toBe(resolvedPayload?.payload.event.id);
    } finally {
      client.release();
    }
  });

  it("resolves Telegram destinations and terminally fails configuration errors", async () => {
    const configuredStore = await createStore({
      name: "Configured Telegram Store",
      domain: "https://configured-telegram.example.com",
      sitemapUrl: "https://configured-telegram.example.com/sitemap.xml",
      feedUrl: "https://configured-telegram.example.com/feed.xml",
      categoryUrls: ["https://configured-telegram.example.com/collections/all"]
    });
    const unconfiguredStore = await createStore({
      name: "Unconfigured Telegram Store",
      domain: "https://unconfigured-telegram.example.com",
      sitemapUrl: "https://unconfigured-telegram.example.com/sitemap.xml",
      feedUrl: "https://unconfigured-telegram.example.com/feed.xml",
      categoryUrls: ["https://unconfigured-telegram.example.com/collections/all"]
    });
    await updateAlertPreferences(configuredStore.store.id, { telegramEnabled: true });
    const client = await (await import("./client")).getPool().connect();

    try {
      const createdDestination = await upsertTelegramDestination(
        configuredStore.store.id,
        {
          chatId: "-1001234567890",
          threadId: 42,
          displayName: "SEO Alerts",
          enabled: true
        },
        client
      );
      const updatedDestination = await upsertTelegramDestination(
        configuredStore.store.id,
        {
          chatId: "-1001234567890",
          threadId: 43,
          displayName: "Operations Alerts",
          enabled: true
        },
        client
      );

      expect(updatedDestination).toMatchObject({
        id: createdDestination.id,
        storeId: configuredStore.store.id,
        chatId: "-1001234567890",
        threadId: 43,
        displayName: "Operations Alerts",
        enabled: true,
        verifiedAt: null
      });
      await expect(
        getTelegramDestination(unconfiguredStore.store.id, client)
      ).resolves.toBeNull();

      await Promise.all([
        upsertTelegramDestination(configuredStore.store.id, {
          chatId: "-1001111111111",
          threadId: 11,
          displayName: "Concurrent A",
          enabled: true
        }),
        upsertTelegramDestination(configuredStore.store.id, {
          chatId: "-1002222222222",
          threadId: 22,
          displayName: "Concurrent B",
          enabled: true
        })
      ]);
      const destinationCount = await client.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM telegram_destinations WHERE store_id = $1",
        [configuredStore.store.id]
      );
      expect(Number(destinationCount.rows[0].count)).toBe(1);

      const activeDestination = await upsertTelegramDestination(
        configuredStore.store.id,
        {
          chatId: "-1009876543210",
          threadId: 77,
          displayName: "Delivery Target",
          enabled: true
        },
        client
      );
      await client.query(
        `
          UPDATE alert_deliveries
          SET status = 'sent', sent_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE status = 'pending'
        `
      );

      const configuredDelivery = await createPendingDelivery(
        client,
        configuredStore.store.id,
        "configured-telegram",
        "telegram"
      );
      await markOtherChannelSent(client, configuredDelivery.incidentEventId, "telegram");
      const { runAlertDeliveryBatch } = await import("@eim/worker");
      let telegramSendCount = 0;
      const configuredBatch = await runAlertDeliveryBatch({
        channel: "telegram",
        workerId: "configured-telegram-worker",
        sender: {
          async send(message) {
            telegramSendCount += 1;
            expect(message).toMatchObject({
              deliveryId: configuredDelivery.id,
              channel: "telegram",
              destination: { chatId: "-1009876543210", threadId: 77 },
              content: { parseMode: "HTML", text: expect.any(String) }
            });
            return { providerMessageId: "fake-telegram-message" };
          }
        }
      });
      expect(configuredBatch).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });
      expect(telegramSendCount).toBe(1);

      const emailDestination = await upsertEmailDestination(
        unconfiguredStore.store.id,
        {
          recipientEmails: ["alerts@example.com", "operations@example.com"],
          enabled: true
        },
        client
      );
      const emailDelivery = await createPendingDelivery(
        client,
        unconfiguredStore.store.id,
        "email-without-telegram",
        "email"
      );
      const emailBatch = await runAlertDeliveryBatch({
        channel: "email",
        workerId: "email-without-telegram-worker",
        sender: {
          async send(message) {
            expect(message).toMatchObject({
              deliveryId: emailDelivery.id,
              channel: "email",
              destination: { recipientEmails: ["alerts@example.com", "operations@example.com"] },
              content: { subject: expect.any(String), text: expect.any(String) }
            });
            return { providerMessageId: "fake-email-message" };
          }
        }
      });
      expect(emailBatch).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });
      expect(emailDestination.enabled).toBe(true);

      await updateAlertPreferences(unconfiguredStore.store.id, { telegramEnabled: true });
      const missingDestinationDelivery = await createPendingDelivery(
        client,
        unconfiguredStore.store.id,
        "missing-telegram",
        "telegram"
      );
      await markOtherChannelSent(client, missingDestinationDelivery.incidentEventId, "telegram");
      const missingBatch = await runAlertDeliveryBatch({
        channel: "telegram",
        workerId: "missing-telegram-worker",
        sender: {
          async send() {
            throw new Error("sender must not run without a destination");
          }
        }
      });
      expect(missingBatch).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });

      const disabledDestination = await disableTelegramDestination(
        configuredStore.store.id,
        client
      );
      const disabledDelivery = await createPendingDelivery(
        client,
        configuredStore.store.id,
        "disabled-telegram",
        "telegram"
      );
      await markOtherChannelSent(client, disabledDelivery.incidentEventId, "telegram");
      const disabledBatch = await runAlertDeliveryBatch({
        channel: "telegram",
        workerId: "disabled-telegram-worker",
        sender: {
          async send() {
            throw new Error("sender must not run for a disabled destination");
          }
        }
      });
      expect(disabledBatch).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });
      expect(disabledDestination).toMatchObject({
        id: activeDestination.id,
        enabled: false,
        disabledAt: expect.any(String)
      });

      const configurationFailures = await client.query<{
        id: string;
        status: string;
        attempt_count: number;
        last_error: string;
      }>(
        `
          SELECT id, status, attempt_count, last_error
          FROM alert_deliveries
          WHERE id = ANY($1::uuid[])
          ORDER BY last_error
        `,
        [[missingDestinationDelivery.id, disabledDelivery.id]]
      );
      expect(configurationFailures.rows).toEqual([
        {
          id: disabledDelivery.id,
          status: "failed",
          attempt_count: 1,
          last_error: "telegram_destination_disabled"
        },
        {
          id: missingDestinationDelivery.id,
          status: "failed",
          attempt_count: 1,
          last_error: "telegram_destination_missing"
        }
      ]);
      await expect(
        claimDueAlertDeliveries({
          channel: "telegram",
          workerId: "configuration-retry-worker"
        })
      ).resolves.toEqual([]);

      const tokenColumns = await client.query<{ count: string }>(
        `
          SELECT COUNT(*) AS count
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'telegram_destinations'
            AND column_name ILIKE '%token%'
        `
      );
      expect(Number(tokenColumns.rows[0].count)).toBe(0);
      await expect(
        getTelegramDestination(configuredStore.store.id, client)
      ).resolves.toMatchObject({ id: activeDestination.id, enabled: false });
    } finally {
      client.release();
    }
  });

  it("resolves email destinations and terminally fails configuration errors", async () => {
    const configuredStore = await createStore({
      name: "Configured Email Store",
      domain: "https://configured-email.example.com",
      sitemapUrl: "https://configured-email.example.com/sitemap.xml",
      feedUrl: "https://configured-email.example.com/feed.xml",
      categoryUrls: ["https://configured-email.example.com/collections/all"]
    });
    const unconfiguredStore = await createStore({
      name: "Unconfigured Email Store",
      domain: "https://unconfigured-email.example.com",
      sitemapUrl: "https://unconfigured-email.example.com/sitemap.xml",
      feedUrl: "https://unconfigured-email.example.com/feed.xml",
      categoryUrls: ["https://unconfigured-email.example.com/collections/all"]
    });
    const client = await (await import("./client")).getPool().connect();

    try {
      await expect(getEmailDestination(unconfiguredStore.store.id, client)).resolves.toBeNull();
      const createdDestination = await upsertEmailDestination(
        configuredStore.store.id,
        { recipientEmails: ["alerts@example.com"], enabled: true },
        client
      );
      const updatedDestination = await upsertEmailDestination(
        configuredStore.store.id,
        { recipientEmails: ["alerts@example.com", "ops@example.com"], enabled: true },
        client
      );
      expect(updatedDestination).toMatchObject({
        id: createdDestination.id,
        storeId: configuredStore.store.id,
        recipientEmails: ["alerts@example.com", "ops@example.com"],
        enabled: true,
        disabledAt: null
      });

      const disabledViaUpsert = await upsertEmailDestination(
        configuredStore.store.id,
        { recipientEmails: ["alerts@example.com", "ops@example.com"], enabled: false },
        client
      );
      expect(disabledViaUpsert).toMatchObject({
        id: createdDestination.id,
        enabled: false,
        disabledAt: expect.any(String)
      });

      const reenabledViaUpsert = await upsertEmailDestination(
        configuredStore.store.id,
        { recipientEmails: ["alerts@example.com", "ops@example.com"], enabled: true },
        client
      );
      expect(reenabledViaUpsert).toMatchObject({
        id: createdDestination.id,
        enabled: true,
        disabledAt: null
      });

      await Promise.all([
        upsertEmailDestination(configuredStore.store.id, {
          recipientEmails: ["concurrent-a@example.com"],
          enabled: true
        }),
        upsertEmailDestination(configuredStore.store.id, {
          recipientEmails: ["concurrent-b@example.com"],
          enabled: true
        })
      ]);
      const destinationCount = await client.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM email_destinations WHERE store_id = $1",
        [configuredStore.store.id]
      );
      expect(Number(destinationCount.rows[0].count)).toBe(1);

      const activeDestination = await upsertEmailDestination(
        configuredStore.store.id,
        { recipientEmails: ["delivery@example.com"], enabled: true },
        client
      );
      await client.query(
        `
          UPDATE alert_deliveries
          SET status = 'sent', sent_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE status = 'pending'
        `
      );

      const configuredDelivery = await createPendingDelivery(
        client,
        configuredStore.store.id,
        "configured-email",
        "email"
      );
      const { runAlertDeliveryBatch } = await import("@eim/worker");
      const configuredBatch = await runAlertDeliveryBatch({
        channel: "email",
        workerId: "configured-email-worker",
        sender: {
          async send(message) {
            expect(message).toMatchObject({
              deliveryId: configuredDelivery.id,
              channel: "email",
              destination: { recipientEmails: ["delivery@example.com"] },
              content: { subject: expect.any(String), text: expect.any(String) }
            });
            return { providerMessageId: "fake-email-message" };
          }
        }
      });
      expect(configuredBatch).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });

      const missingDelivery = await createPendingDelivery(
        client,
        unconfiguredStore.store.id,
        "missing-email",
        "email"
      );
      const missingBatch = await runAlertDeliveryBatch({
        channel: "email",
        workerId: "missing-email-worker",
        sender: {
          async send() {
            throw new Error("sender must not run without an email destination");
          }
        }
      });
      expect(missingBatch).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });

      const disabledDestination = await disableEmailDestination(configuredStore.store.id, client);
      const disabledDelivery = await createPendingDelivery(
        client,
        configuredStore.store.id,
        "disabled-email",
        "email"
      );
      const disabledBatch = await runAlertDeliveryBatch({
        channel: "email",
        workerId: "disabled-email-worker",
        sender: {
          async send() {
            throw new Error("sender must not run for a disabled email destination");
          }
        }
      });
      expect(disabledBatch).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });
      expect(disabledDestination).toMatchObject({
        id: activeDestination.id,
        enabled: false,
        disabledAt: expect.any(String)
      });

      const configurationFailures = await client.query<{
        id: string;
        status: string;
        attempt_count: number;
        last_error: string;
      }>(
        `
          SELECT id, status, attempt_count, last_error
          FROM alert_deliveries
          WHERE id = ANY($1::uuid[])
          ORDER BY last_error
        `,
        [[missingDelivery.id, disabledDelivery.id]]
      );
      expect(configurationFailures.rows).toEqual([
        {
          id: disabledDelivery.id,
          status: "failed",
          attempt_count: 1,
          last_error: "email_destination_disabled"
        },
        {
          id: missingDelivery.id,
          status: "failed",
          attempt_count: 1,
          last_error: "email_destination_missing"
        }
      ]);
      await expect(
        claimDueAlertDeliveries({ channel: "email", workerId: "email-configuration-retry" })
      ).resolves.toEqual([]);

      const secretColumns = await client.query<{ count: string }>(
        `
          SELECT COUNT(*) AS count
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'email_destinations'
            AND (column_name ILIKE '%token%' OR column_name ILIKE '%key%' OR column_name ILIKE '%secret%')
        `
      );
      expect(Number(secretColumns.rows[0].count)).toBe(0);
      await expect(getEmailDestination(configuredStore.store.id, client)).resolves.toMatchObject({
        id: activeDestination.id,
        enabled: false
      });
    } finally {
      client.release();
    }
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
    await upsertEmailDestination(created.store.id, {
      recipientEmails: ["worker@example.com"],
      enabled: true
    });
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
        expect.objectContaining({
          id: leaseDelivery.id,
          attemptCount: 1,
          lockedBy: "worker-a",
          payload: expect.objectContaining({ version: "v1" })
        })
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
      const failurePayloadBefore = await getAlertEventPayloadByEventId(
        workerFailure.incidentEventId,
        client
      );
      const { runAlertDeliveryBatch } = await import("@eim/worker");
      const batch = await runAlertDeliveryBatch({
        channel: "email",
        workerId: "batch-worker",
        sender: {
          async send(message) {
            expect(message.channel).toBe("email");
            expect(message.content).toEqual(
              expect.objectContaining({ subject: expect.any(String), text: expect.any(String) })
            );
            if (message.deliveryId === workerFailure.id) throw new Error("temporary batch failure");
            if (message.deliveryId !== workerDelivery.id) throw new Error("unexpected delivery");
            return { providerMessageId: "batch-provider-message" };
          }
        }
      });
      expect(batch).toEqual({ claimed: 2, sent: 1, retried: 1, failed: 0 });
      await expect(
        getAlertEventPayloadByEventId(workerFailure.incidentEventId, client)
      ).resolves.toEqual(failurePayloadBefore);
    } finally {
      client.release();
    }
  });

  it("delivers Telegram alerts with provider retry and permanent-failure semantics", async () => {
    const created = await createStore({
      name: "Telegram Transport Store",
      domain: "https://telegram-transport.example.com",
      sitemapUrl: "https://telegram-transport.example.com/sitemap.xml",
      feedUrl: "https://telegram-transport.example.com/feed.xml",
      categoryUrls: ["https://telegram-transport.example.com/collections/all"]
    });
    await updateAlertPreferences(created.store.id, { telegramEnabled: true });
    const client = await (await import("./client")).getPool().connect();
    const botToken = "123456:postgres-smoke-secret";

    try {
      await upsertTelegramDestination(created.store.id, {
        chatId: "-1007654321000",
        threadId: 15,
        displayName: "Transport Smoke",
        enabled: true
      });
      await client.query(
        `
          UPDATE alert_deliveries
          SET status = 'sent', sent_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE status = 'pending'
        `
      );

      const { createTelegramTransport, runAlertDeliveryBatch } = await import("@eim/worker");
      const successful = await createPendingDelivery(
        client,
        created.store.id,
        "telegram-transport-success",
        "telegram"
      );
      await markOtherChannelSent(client, successful.incidentEventId, "telegram");
      const successBatch = await runAlertDeliveryBatch({
        channel: "telegram",
        workerId: "telegram-success-worker",
        sender: createTelegramTransport({
          botToken,
          fetchImpl: async () =>
            new Response(JSON.stringify({ ok: true, result: { message_id: 901 } }), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
        })
      });
      expect(successBatch).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });
      await expectAlertDeliveryState(client, successful.id, {
        status: "sent",
        providerMessageId: "-1007654321000:901",
        lastError: null
      });

      const transient = await createPendingDelivery(
        client,
        created.store.id,
        "telegram-transport-transient",
        "telegram"
      );
      await markOtherChannelSent(client, transient.incidentEventId, "telegram");
      const transientBatch = await runAlertDeliveryBatch({
        channel: "telegram",
        workerId: "telegram-transient-worker",
        sender: createTelegramTransport({
          botToken,
          fetchImpl: async () =>
            new Response(JSON.stringify({ ok: false, description: "Telegram unavailable" }), {
              status: 500
            })
        })
      });
      expect(transientBatch).toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0 });
      await expectAlertDeliveryState(client, transient.id, {
        status: "pending",
        providerMessageId: null,
        lastError: "telegram_server_error: Telegram unavailable"
      });

      const rateLimited = await createPendingDelivery(
        client,
        created.store.id,
        "telegram-transport-rate-limit",
        "telegram"
      );
      await markOtherChannelSent(client, rateLimited.incidentEventId, "telegram");
      const rateLimitBatch = await runAlertDeliveryBatch({
        channel: "telegram",
        workerId: "telegram-rate-limit-worker",
        sender: createTelegramTransport({
          botToken,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                ok: false,
                error_code: 429,
                description: "Too Many Requests",
                parameters: { retry_after: 120 }
              }),
              { status: 429 }
            )
        })
      });
      expect(rateLimitBatch).toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0 });
      const retryAfter = await client.query<{
        delay_seconds: string;
        status: string;
      }>(
        `
          SELECT
            EXTRACT(EPOCH FROM (next_attempt_at - updated_at))::text AS delay_seconds,
            status::text
          FROM alert_deliveries
          WHERE id = $1
        `,
        [rateLimited.id]
      );
      expect(retryAfter.rows[0].status).toBe("pending");
      expect(Number(retryAfter.rows[0].delay_seconds)).toBeGreaterThanOrEqual(119.9);
      expect(Number(retryAfter.rows[0].delay_seconds)).toBeLessThanOrEqual(120.1);

      const permanent = await createPendingDelivery(
        client,
        created.store.id,
        "telegram-transport-permanent",
        "telegram"
      );
      await markOtherChannelSent(client, permanent.incidentEventId, "telegram");
      const permanentBatch = await runAlertDeliveryBatch({
        channel: "telegram",
        workerId: "telegram-permanent-worker",
        sender: createTelegramTransport({
          botToken,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                ok: false,
                error_code: 400,
                description: "Bad Request: chat not found"
              }),
              { status: 400 }
            )
        })
      });
      expect(permanentBatch).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });
      await expectAlertDeliveryState(client, permanent.id, {
        status: "failed",
        providerMessageId: null,
        lastError: "telegram_chat_not_found: Bad Request: chat not found"
      });

      const persistedErrors = await client.query<{ last_error: string | null }>(
        "SELECT last_error FROM alert_deliveries WHERE id = ANY($1::uuid[])",
        [[transient.id, rateLimited.id, permanent.id]]
      );
      expect(persistedErrors.rows.every((row) => !row.last_error?.includes(botToken))).toBe(true);
    } finally {
      client.release();
    }
  });

  it("delivers Resend email alerts with idempotency, retry, and safe permanent failures", async () => {
    const created = await createStore({
      name: "Resend Transport Store",
      domain: "https://resend-transport.example.com",
      sitemapUrl: "https://resend-transport.example.com/sitemap.xml",
      feedUrl: "https://resend-transport.example.com/feed.xml",
      categoryUrls: ["https://resend-transport.example.com/collections/all"]
    });
    const client = await (await import("./client")).getPool().connect();
    const apiKey = "re_postgres_smoke_secret";

    try {
      await upsertEmailDestination(created.store.id, {
        recipientEmails: ["ops@resend-transport.example.com"],
        enabled: true
      });
      await client.query(
        `
          UPDATE alert_deliveries
          SET status = 'sent', sent_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE status = 'pending'
        `
      );

      const { createResendEmailTransport, runAlertDeliveryBatch } = await import("@eim/worker");
      const idempotencyKeys: string[] = [];
      const successful = await createPendingDelivery(
        client,
        created.store.id,
        "resend-transport-success",
        "email"
      );
      await markOtherChannelSent(client, successful.incidentEventId, "email");
      const successBatch = await runAlertDeliveryBatch({
        channel: "email",
        workerId: "resend-success-worker",
        sender: createResendEmailTransport({
          apiKey,
          fromAddress: "alerts@resend-transport.example.com",
          fromName: "EIM Alerts",
          fetchImpl: async (_url, init) => {
            idempotencyKeys.push(
              String((init?.headers as Record<string, string>)["idempotency-key"])
            );
            return new Response(JSON.stringify({ id: "re_success_901" }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
        })
      });
      expect(successBatch).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });
      expect(idempotencyKeys).toEqual([`eim-delivery-${successful.id}`]);
      await expectAlertDeliveryState(client, successful.id, {
        status: "sent",
        providerMessageId: "re_success_901",
        lastError: null
      });

      const transient = await createPendingDelivery(
        client,
        created.store.id,
        "resend-transport-transient",
        "email"
      );
      await markOtherChannelSent(client, transient.incidentEventId, "email");
      const transientBatch = await runAlertDeliveryBatch({
        channel: "email",
        workerId: "resend-transient-worker",
        sender: createResendEmailTransport({
          apiKey,
          fromAddress: "alerts@resend-transport.example.com",
          fromName: null,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                name: "rate_limit_exceeded",
                message: `Retry ${apiKey} at https://api.resend.com/emails`
              }),
              {
                status: 429,
                headers: {
                  "content-type": "application/json",
                  "retry-after": "120"
                }
              }
            )
        })
      });
      expect(transientBatch).toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0 });
      const retryAfter = await client.query<{
        delay_seconds: string;
        status: string;
        last_error: string | null;
      }>(
        `
          SELECT
            EXTRACT(EPOCH FROM (next_attempt_at - updated_at))::text AS delay_seconds,
            status::text,
            last_error
          FROM alert_deliveries
          WHERE id = $1
        `,
        [transient.id]
      );
      expect(retryAfter.rows[0].status).toBe("pending");
      expect(Number(retryAfter.rows[0].delay_seconds)).toBeGreaterThanOrEqual(119.9);
      expect(Number(retryAfter.rows[0].delay_seconds)).toBeLessThanOrEqual(120.1);
      expect(retryAfter.rows[0].last_error).toContain("resend_rate_limited");
      expect(retryAfter.rows[0].last_error).not.toContain(apiKey);
      expect(retryAfter.rows[0].last_error).not.toContain("api.resend.com");

      const retryKeys: string[] = [];
      const retryBodies: string[] = [];
      const replay = await createPendingDelivery(
        client,
        created.store.id,
        "resend-transport-replay",
        "email"
      );
      await markOtherChannelSent(client, replay.incidentEventId, "email");
      const retryingTransport = createResendEmailTransport({
        apiKey,
        fromAddress: "alerts@resend-transport.example.com",
        fromName: null,
        fetchImpl: async (_url, init) => {
          retryKeys.push(String((init?.headers as Record<string, string>)["idempotency-key"]));
          retryBodies.push(String(init?.body));
          return retryKeys.length === 1
            ? new Response(JSON.stringify({ name: "application_error", message: "Retry" }), {
                status: 500,
                headers: { "content-type": "application/json" }
              })
            : new Response(JSON.stringify({ id: "re_replayed_902" }), {
                status: 200,
                headers: { "content-type": "application/json" }
              });
        }
      });
      const firstReplayBatch = await runAlertDeliveryBatch({
        channel: "email",
        workerId: "resend-replay-worker",
        sender: retryingTransport
      });
      expect(firstReplayBatch).toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0 });
      await client.query(
        "UPDATE alert_deliveries SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [replay.id]
      );
      const secondReplayBatch = await runAlertDeliveryBatch({
        channel: "email",
        workerId: "resend-replay-worker",
        sender: retryingTransport
      });
      expect(secondReplayBatch).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });
      expect(retryKeys).toEqual([`eim-delivery-${replay.id}`, `eim-delivery-${replay.id}`]);
      expect(retryBodies).toHaveLength(2);
      expect(retryBodies[0]).toBe(retryBodies[1]);

      const permanent = await createPendingDelivery(
        client,
        created.store.id,
        "resend-transport-permanent",
        "email"
      );
      await markOtherChannelSent(client, permanent.incidentEventId, "email");
      const permanentBatch = await runAlertDeliveryBatch({
        channel: "email",
        workerId: "resend-permanent-worker",
        sender: createResendEmailTransport({
          apiKey,
          fromAddress: "alerts@resend-transport.example.com",
          fromName: null,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({ name: "invalid_api_key", message: `Invalid ${apiKey}` }),
              { status: 403, headers: { "content-type": "application/json" } }
            )
        })
      });
      expect(permanentBatch).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1 });
      await expectAlertDeliveryState(client, permanent.id, {
        status: "failed",
        providerMessageId: null,
        lastError: "resend_authentication_failed: Invalid [REDACTED]"
      });
    } finally {
      client.release();
    }
  });

  it("terminally fails malformed immutable payloads without sending or waiting for lease expiry", async () => {
    const created = await createStore({
      name: "Payload Failure Store",
      domain: "https://payload-failure.example.com",
      sitemapUrl: "https://payload-failure.example.com/sitemap.xml",
      feedUrl: "https://payload-failure.example.com/feed.xml",
      categoryUrls: ["https://payload-failure.example.com/collections/all"]
    });
    const client = await (await import("./client")).getPool().connect();

    try {
      await upsertEmailDestination(created.store.id, {
        recipientEmails: ["ops@payload-failure.example.com"],
        enabled: true
      });
      await client.query(
        `
          UPDATE alert_deliveries
          SET status = 'sent', sent_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE status = 'pending'
        `
      );

      const missing = await createPendingDelivery(
        client,
        created.store.id,
        "payload-missing",
        "email"
      );
      const invalid = await createPendingDelivery(
        client,
        created.store.id,
        "payload-invalid",
        "email"
      );
      const unsupported = await createPendingDelivery(
        client,
        created.store.id,
        "payload-v999",
        "email"
      );
      const valid = await createPendingDelivery(client, created.store.id, "payload-valid", "email");
      await Promise.all([
        markOtherChannelSent(client, missing.incidentEventId, "email"),
        markOtherChannelSent(client, invalid.incidentEventId, "email"),
        markOtherChannelSent(client, unsupported.incidentEventId, "email"),
        markOtherChannelSent(client, valid.incidentEventId, "email")
      ]);
      await client.query(
        "DELETE FROM alert_event_payloads WHERE incident_event_id = $1",
        [missing.incidentEventId]
      );
      await client.query(
        "UPDATE alert_event_payloads SET payload_json = $2::jsonb WHERE incident_event_id = $1",
        [invalid.incidentEventId, JSON.stringify({ rawPayload: "do-not-persist" })]
      );
      await client.query(
        "UPDATE alert_event_payloads SET payload_version = 'v999' WHERE incident_event_id = $1",
        [unsupported.incidentEventId]
      );

      const { runAlertDeliveryBatch } = await import("@eim/worker");
      const sentDeliveryIds: string[] = [];
      const batch = await runAlertDeliveryBatch({
        channel: "email",
        workerId: "payload-failure-worker",
        sender: {
          async send(message) {
            sentDeliveryIds.push(message.deliveryId);
            return { providerMessageId: "valid-payload-provider-id" };
          }
        }
      });
      expect(batch).toEqual({ claimed: 4, sent: 1, retried: 0, failed: 3 });
      expect(sentDeliveryIds).toEqual([valid.id]);

      const failedStates = await client.query<{
        id: string;
        status: string;
        last_error: string | null;
        locked_by: string | null;
        locked_at: Date | null;
        lease_expires_at: Date | null;
      }>(
        `
          SELECT id, status::text, last_error, locked_by, locked_at, lease_expires_at
          FROM alert_deliveries
          WHERE id = ANY($1::uuid[])
          ORDER BY id
        `,
        [[missing.id, invalid.id, unsupported.id]]
      );
      expect(failedStates.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: missing.id,
            status: "failed",
            last_error: "payload_missing",
            locked_by: null,
            locked_at: null,
            lease_expires_at: null
          }),
          expect.objectContaining({
            id: invalid.id,
            status: "failed",
            last_error: "payload_validation_failed",
            locked_by: null,
            locked_at: null,
            lease_expires_at: null
          }),
          expect.objectContaining({
            id: unsupported.id,
            status: "failed",
            last_error: "unsupported_payload_version",
            locked_by: null,
            locked_at: null,
            lease_expires_at: null
          })
        ])
      );
      expect(failedStates.rows.every((row) => !row.last_error?.includes("do-not-persist"))).toBe(
        true
      );
      await expectAlertDeliveryState(client, valid.id, {
        status: "sent",
        providerMessageId: "valid-payload-provider-id",
        lastError: null
      });

      const stale = await createPendingDelivery(
        client,
        created.store.id,
        "payload-stale-worker",
        "email"
      );
      await markOtherChannelSent(client, stale.incidentEventId, "email");
      await client.query(
        "DELETE FROM alert_event_payloads WHERE incident_event_id = $1",
        [stale.incidentEventId]
      );
      const firstClaim = await claimDueAlertDeliveries({
        channel: "email",
        workerId: "payload-old-worker",
        limit: 1
      });
      expect(firstClaim).toEqual([
        expect.objectContaining({
          id: stale.id,
          attemptCount: 1,
          payloadStatus: "payload_missing"
        })
      ]);
      await client.query(
        "UPDATE alert_deliveries SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [stale.id]
      );
      const reclaimed = await claimDueAlertDeliveries({
        channel: "email",
        workerId: "payload-new-worker",
        limit: 1
      });
      expect(reclaimed).toEqual([
        expect.objectContaining({
          id: stale.id,
          attemptCount: 2,
          payloadStatus: "payload_missing"
        })
      ]);
      await expect(
        markAlertDeliveryPermanentFailed({
          deliveryId: stale.id,
          workerId: "payload-old-worker",
          claimedAttemptCount: 1,
          errorCode: "payload_missing"
        })
      ).resolves.toBeNull();
      await expect(
        markAlertDeliveryPermanentFailed({
          deliveryId: stale.id,
          workerId: "payload-new-worker",
          claimedAttemptCount: 2,
          errorCode: "payload_missing"
        })
      ).resolves.toMatchObject({ status: "failed", attemptCount: 2 });
    } finally {
      client.release();
    }
  });

  it("builds dashboard store summaries without dropping empty stores or stale source checks", async () => {
    const observed = await createStore({
      name: "Dashboard Observed Store",
      domain: "https://dashboard-observed.example.com",
      sitemapUrl: "https://dashboard-observed.example.com/sitemap.xml",
      feedUrl: "https://dashboard-observed.example.com/feed.xml",
      categoryUrls: ["https://dashboard-observed.example.com/collections/all"]
    });
    const empty = await createStore({
      name: "Dashboard Empty Store",
      domain: "https://dashboard-empty.example.com",
      sitemapUrl: "https://dashboard-empty.example.com/sitemap.xml",
      feedUrl: "https://dashboard-empty.example.com/feed.xml",
      categoryUrls: ["https://dashboard-empty.example.com/collections/all"]
    });
    const client = await (await import("./client")).getPool().connect();

    try {
      const olderSnapshot = await insertDashboardSnapshot(client, observed.store.id, "older");
      const newerSnapshot = await insertDashboardSnapshot(client, observed.store.id, "newer");
      await insertDashboardSourceCheck(client, {
        snapshotId: olderSnapshot,
        storeId: observed.store.id,
        source: "feed",
        status: "source_unavailable",
        observedCount: 99,
        secondsAgo: 120
      });
      await insertDashboardSourceCheck(client, {
        snapshotId: newerSnapshot,
        storeId: observed.store.id,
        source: "feed",
        status: "success",
        observedCount: 101,
        secondsAgo: 30
      });
      await insertDashboardSourceCheck(client, {
        snapshotId: newerSnapshot,
        storeId: observed.store.id,
        source: "sitemap",
        status: "partial",
        observedCount: 103,
        secondsAgo: 20
      });

      await insertDashboardIncident(client, {
        storeId: observed.store.id,
        severity: "critical",
        type: "catalog_drop",
        status: "open",
        likelySource: "feed_or_publication",
        title: "Critical dashboard incident",
        updatedAt: new Date(Date.now() - 10_000)
      });
      await insertDashboardIncident(client, {
        storeId: observed.store.id,
        severity: "warning",
        type: "source_divergence",
        status: "acknowledged",
        likelySource: "feed",
        title: "Acknowledged dashboard incident",
        updatedAt: new Date(Date.now() - 9_000)
      });
      await insertDashboardIncident(client, {
        storeId: observed.store.id,
        severity: "warning",
        type: "seo_regression",
        status: "recovering",
        likelySource: "product_page",
        title: "Recovering dashboard incident",
        updatedAt: new Date(Date.now() - 8_000)
      });
      await insertDashboardIncident(client, {
        storeId: observed.store.id,
        severity: "critical",
        type: "source_health",
        status: "resolved",
        likelySource: "feed",
        title: "Resolved dashboard incident",
        updatedAt: new Date(Date.now() - 7_000)
      });
      await insertDashboardIncident(client, {
        storeId: observed.store.id,
        severity: "warning",
        type: "source_health",
        status: "ignored",
        likelySource: "feed",
        title: "Ignored dashboard incident",
        updatedAt: new Date(Date.now() - 6_000)
      });

      const summaries = await listDashboardStoreSummaries();
      const observedSummary = summaries.find((store) => store.id === observed.store.id);
      const emptySummary = summaries.find((store) => store.id === empty.store.id);

      expect(observedSummary).toMatchObject({
        incidents: { open: 2, critical: 1, high: 2, recovering: 1 },
        baseline: { status: "learning", updatedAt: null }
      });
      expect(observedSummary?.lastCheckedAt).toBeTruthy();
      expect(observedSummary?.sources).toHaveLength(5);
      expect(observedSummary?.sources.find((source) => source.source === "feed")).toMatchObject({
        status: "success",
        observedCount: 101
      });
      expect(observedSummary?.sources.find((source) => source.source === "sitemap")).toMatchObject({
        status: "partial",
        observedCount: 103
      });
      expect(emptySummary).toMatchObject({
        incidents: { open: 0, critical: 0, high: 0, recovering: 0 },
        lastCheckedAt: null
      });
      expect(emptySummary?.sources).toHaveLength(5);
      expect(emptySummary?.sources.every((source) => source.status === null)).toBe(true);
      await expect(getDashboardStoreSummary(observed.store.id)).resolves.toMatchObject({
        id: observed.store.id
      });
      await expect(
        getDashboardStoreSummary("00000000-0000-0000-0000-000000000099")
      ).resolves.toBeNull();
    } finally {
      client.release();
    }
  });

  it("lists dashboard incidents with keyset pagination and exposes a redacted detail model", async () => {
    const primary = await createStore({
      name: "Dashboard Incident Store",
      domain: "https://dashboard-incidents.example.com",
      sitemapUrl: "https://dashboard-incidents.example.com/sitemap.xml",
      feedUrl: "https://dashboard-incidents.example.com/feed.xml",
      categoryUrls: ["https://dashboard-incidents.example.com/collections/all"]
    });
    const other = await createStore({
      name: "Dashboard Other Store",
      domain: "https://dashboard-other.example.com",
      sitemapUrl: "https://dashboard-other.example.com/sitemap.xml",
      feedUrl: "https://dashboard-other.example.com/feed.xml",
      categoryUrls: ["https://dashboard-other.example.com/collections/all"]
    });
    const client = await (await import("./client")).getPool().connect();

    try {
      const baseTime = Date.now();
      const target = await insertDashboardIncident(client, {
        storeId: primary.store.id,
        severity: "critical",
        type: "catalog_drop",
        status: "open",
        likelySource: "feed_or_publication",
        title: "Target dashboard incident",
        updatedAt: new Date(baseTime - 3_000)
      });
      const productPageIncident = await insertDashboardIncident(client, {
        storeId: primary.store.id,
        severity: "warning",
        type: "seo_regression",
        status: "recovering",
        likelySource: "product_page",
        title: "Product page dashboard incident",
        updatedAt: new Date(baseTime - 2_000)
      });
      const latest = await insertDashboardIncident(client, {
        storeId: primary.store.id,
        severity: "warning",
        type: "source_health",
        status: "acknowledged",
        likelySource: "feed",
        title: "Latest dashboard incident",
        updatedAt: new Date(baseTime - 1_000)
      });
      await insertDashboardIncident(client, {
        storeId: other.store.id,
        severity: "critical",
        type: "catalog_drop",
        status: "open",
        likelySource: "feed",
        title: "Other store incident",
        updatedAt: new Date(baseTime)
      });

      const sampleItems = Array.from({ length: 25 }, (_, index) => ({
        stableKey: `dashboard-sku-${index}`,
        offerId: `dashboard-offer-${index}`,
        title: `Dashboard product ${index}`,
        url: `https://dashboard-incidents.example.com/products/${index}`,
        chatId: "must-not-be-exposed"
      }));
      await client.query(
        `
          INSERT INTO incident_signals (
            incident_id, source, metric, before_value, after_value,
            change_abs, change_pct, sample_items_json
          )
          VALUES ($1, 'feed', 'product_count', 1000, 700, 300, 0.3, $2::jsonb)
        `,
        [target, JSON.stringify(sampleItems)]
      );
      const alertEventId = await insertAlertTestEvent(
        client,
        target,
        primary.store.id,
        "dashboard-detail"
      );
      await client.query(
        "UPDATE incident_events SET metadata_json = $2::jsonb WHERE id = $1",
        [alertEventId, JSON.stringify({ reason: "dashboard_test_reason" })]
      );
      await createAlertDeliveriesForIncidentEvent(client, {
        incidentId: target,
        eventId: alertEventId,
        alertType: "incident_opened"
      });
      await client.query(
        `
          UPDATE alert_deliveries
          SET attempt_count = 2,
              last_error = 'resend_authentication_failed: RESEND_API_KEY=secret@example.com',
              status = 'failed',
              failed_at = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE incident_event_id = $1
            AND channel = 'email'
        `,
        [alertEventId]
      );
      await addIncidentComment(target, {
        actor: "dashboard-operator@example.com",
        body: "Dashboard detail comment"
      });

      const firstPage = await listDashboardIncidents({ storeId: primary.store.id, limit: 1 });
      const secondPage = await listDashboardIncidents({
        storeId: primary.store.id,
        limit: 1,
        cursor: firstPage.nextCursor ?? undefined
      });
      expect(firstPage.incidents.map((incident) => incident.id)).toEqual([latest]);
      expect(secondPage.incidents.map((incident) => incident.id)).toEqual([productPageIncident]);
      expect(new Set([...firstPage.incidents, ...secondPage.incidents].map((incident) => incident.id)).size).toBe(2);

      await expect(
        listDashboardIncidents({
          storeId: primary.store.id,
          status: "open",
          severity: "critical",
          type: "catalog_drop",
          likelySource: "feed_or_publication"
        })
      ).resolves.toMatchObject({ incidents: [expect.objectContaining({ id: target })] });
      await expect(
        listDashboardIncidents({ storeId: primary.store.id, likelySource: "product_page" })
      ).resolves.toMatchObject({
        incidents: [expect.objectContaining({ id: productPageIncident })]
      });

      const detail = await getDashboardIncidentDetail(target);
      expect(detail?.incident).toMatchObject({ id: target, storeId: primary.store.id });
      expect(detail?.store).toMatchObject({ id: primary.store.id });
      expect(detail?.timeline).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: alertEventId,
            reason: "dashboard_test_reason",
            fromStatus: null,
            toStatus: "open"
          })
        ])
      );
      expect(detail?.signals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "product_count",
            metric: "product_count",
            source: "feed",
            evidence: { sampleCount: 25 }
          })
        ])
      );
      expect(detail?.comments).toEqual(
        expect.arrayContaining([expect.objectContaining({ body: "Dashboard detail comment" })])
      );
      expect(detail?.alertDeliveries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channel: "email",
            attemptCount: 2,
            lastErrorCode: "resend_authentication_failed"
          })
        ])
      );
      expect(detail?.samples).toHaveLength(20);
      expect(detail?.samples[0]).toEqual({
        stableKey: "dashboard-sku-0",
        offerId: "dashboard-offer-0",
        title: "Dashboard product 0",
        url: "https://dashboard-incidents.example.com/products/0"
      });
      const serializedDetail = JSON.stringify(detail);
      expect(serializedDetail).not.toContain("RESEND_API_KEY");
      expect(serializedDetail).not.toContain("secret@example.com");
      expect(serializedDetail).not.toContain("dashboard-operator@example.com");
      expect(serializedDetail).not.toContain("must-not-be-exposed");
      await expect(
        getDashboardIncidentDetail("00000000-0000-0000-0000-000000000098")
      ).resolves.toBeNull();
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

async function insertDashboardSnapshot(
  client: pg.PoolClient,
  storeId: string,
  suffix: string
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO snapshots (
        store_id,
        status,
        baseline_role,
        started_at,
        finished_at,
        idempotency_key
      )
      VALUES ($1, 'completed', 'normal_check', clock_timestamp(), clock_timestamp(), $2)
      RETURNING id
    `,
    [storeId, `dashboard-${suffix}-${storeId}`]
  );
  return result.rows[0].id;
}

async function insertDashboardSourceCheck(
  client: pg.PoolClient,
  input: {
    snapshotId: string;
    storeId: string;
    source: "category" | "product_page" | "sitemap" | "feed" | "merchant_center";
    status:
      | "success"
      | "partial"
      | "timeout"
      | "blocked"
      | "authentication_failed"
      | "parse_failed"
      | "source_unavailable";
    observedCount: number;
    secondsAgo: number;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO source_checks (
        snapshot_id,
        store_id,
        source,
        check_key,
        status,
        started_at,
        finished_at,
        duration_ms,
        items_observed
      )
      VALUES (
        $1,
        $2,
        $3,
        'dashboard',
        $4,
        clock_timestamp() - ($6 * interval '1 second') - interval '1 second',
        clock_timestamp() - ($6 * interval '1 second'),
        1000,
        $5
      )
    `,
    [
      input.snapshotId,
      input.storeId,
      input.source,
      input.status,
      input.observedCount,
      input.secondsAgo
    ]
  );
}

async function insertDashboardIncident(
  client: pg.PoolClient,
  input: {
    storeId: string;
    severity: "critical" | "warning" | "info";
    type:
      | "catalog_drop"
      | "source_divergence"
      | "seo_regression"
      | "price_availability_mismatch"
      | "source_health";
    status: "open" | "investigating" | "acknowledged" | "recovering" | "resolved" | "ignored";
    likelySource:
      | "feed"
      | "sitemap"
      | "category"
      | "product_page"
      | "merchant_center"
      | "feed_or_publication"
      | "feed_or_storefront_product_data"
      | "site_template_or_deployment"
      | null;
    title: string;
    updatedAt: Date;
  }
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO incidents (
        store_id,
        severity,
        type,
        title,
        summary,
        likely_source,
        status,
        first_detected_at,
        last_seen_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $8)
      RETURNING id
    `,
    [
      input.storeId,
      input.severity,
      input.type,
      input.title,
      `${input.title} summary`,
      input.likelySource,
      input.status,
      input.updatedAt
    ]
  );
  return result.rows[0].id;
}

async function markOtherChannelSent(
  client: pg.PoolClient,
  incidentEventId: string,
  retainedChannel: "email" | "telegram"
): Promise<void> {
  await client.query(
    `
      UPDATE alert_deliveries
      SET status = 'sent',
          sent_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE incident_event_id = $1
        AND channel <> $2
        AND status = 'pending'
    `,
    [incidentEventId, retainedChannel]
  );
}

async function expectAlertDeliveryState(
  client: pg.PoolClient,
  deliveryId: string,
  expected: {
    status: string;
    providerMessageId: string | null;
    lastError: string | null;
  }
): Promise<void> {
  const result = await client.query<{
    status: string;
    provider_message_id: string | null;
    last_error: string | null;
  }>(
    `
      SELECT status::text, provider_message_id, last_error
      FROM alert_deliveries
      WHERE id = $1
    `,
    [deliveryId]
  );
  expect(result.rows[0]).toEqual({
    status: expected.status,
    provider_message_id: expected.providerMessageId,
    last_error: expected.lastError
  });
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
