import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { Client } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase =
  testDatabaseUrl && process.env.RUN_POSTGRES_TESTS === "1" ? describe : describe.skip;
const schemaName = `eim_merchant_status_${Date.now()}_${Math.random()
  .toString(16)
  .slice(2)}`;

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

describeIfDatabase("merchant center status postgres vertical slice", () => {
  const admin = new Client({ connectionString: testDatabaseUrl });
  let dbUrlWithSchema: string;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousEncryptionKey = process.env.MERCHANT_CENTER_CREDENTIALS_ENCRYPTION_KEY;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schemaName}`);

    dbUrlWithSchema = withSearchPath(testDatabaseUrl!, schemaName);
    process.env.DATABASE_URL = dbUrlWithSchema;
    process.env.MERCHANT_CENTER_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString(
      "base64"
    );

    const migrator = new Client({ connectionString: dbUrlWithSchema });
    await migrator.connect();
    const { applyMigrations } = await import("@eim/db");
    await applyMigrations(migrator);
    await migrator.end();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousEncryptionKey === undefined) {
      delete process.env.MERCHANT_CENTER_CREDENTIALS_ENCRYPTION_KEY;
    } else {
      process.env.MERCHANT_CENTER_CREDENTIALS_ENCRYPTION_KEY = previousEncryptionKey;
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin.end();
  });

  it("persists aggregate counts and updates the same idempotent snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            aggregateProductStatuses: [
              {
                stats: {
                  activeCount: "7",
                  pendingCount: "2",
                  disapprovedCount: "1"
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const {
      connectMerchantCenter,
      createStore,
      merchantItemIssuesConfigurationHash,
      upsertMerchantCenterOAuthCredentials
    } = await import("@eim/db");
    const { runMerchantCenterStatusSnapshotForStore } = await import("@eim/worker");

    const created = await createStore({
      name: "Merchant Status Store",
      domain: "https://merchant-status.example.com",
      sitemapUrl: "https://merchant-status.example.com/sitemap.xml",
      feedUrl: "https://merchant-status.example.com/feed.xml",
      categoryUrls: ["https://merchant-status.example.com/collections/all"]
    });

    await connectMerchantCenter(created.store.id, {
      merchantCenterAccountId: "987654"
    });
    await upsertMerchantCenterOAuthCredentials(created.store.id, {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      scopes: ["https://www.googleapis.com/auth/content"],
      metadata: { fixture: "merchant-status" }
    });

    const first = await runMerchantCenterStatusSnapshotForStore(created.store.id);
    const second = await runMerchantCenterStatusSnapshotForStore(created.store.id);

    expect(first).toMatchObject({
      status: "completed",
      sourceCheckStatus: "success",
      merchantTotalCount: 10,
      merchantApprovedCount: 7,
      merchantPendingCount: 2,
      merchantDisapprovedCount: 1
    });
    expect(second.snapshotId).toBe(first.snapshotId);

    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();
    const snapshot = await client.query<{
      status: string;
      merchant_total_count: number;
      merchant_approved_count: number;
      merchant_pending_count: number;
      merchant_disapproved_count: number;
    }>(
      `
        SELECT
          status,
          merchant_total_count,
          merchant_approved_count,
          merchant_pending_count,
          merchant_disapproved_count
        FROM snapshots
        WHERE id = $1
      `,
      [first.snapshotId]
    );
    const checks = await client.query<{
      count: string;
      metadata_json: Record<string, unknown>;
    }>(
      `
        SELECT
          COUNT(*) AS count,
          (
            SELECT metadata_json
            FROM source_checks
            WHERE snapshot_id = $1 AND source = 'merchant_center'
            LIMIT 1
          ) AS metadata_json
        FROM source_checks
        WHERE snapshot_id = $1 AND source = 'merchant_center'
      `,
      [first.snapshotId]
    );
    await client.end();

    expect(snapshot.rows[0]).toMatchObject({
      status: "completed",
      merchant_total_count: 10,
      merchant_approved_count: 7,
      merchant_pending_count: 2,
      merchant_disapproved_count: 1
    });
    expect(Number(checks.rows[0].count)).toBe(1);
    expect(checks.rows[0].metadata_json).toMatchObject({
      merchantCenterConfigurationHash: merchantItemIssuesConfigurationHash("987654"),
      merchantStatusCounts: {
        total: 10,
        approved: 7,
        pending: 2,
        disapproved: 1
      }
    });
  });
});
