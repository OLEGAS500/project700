import type { CreateStoreInput, Store } from "@eim/core";
import type { IncidentType } from "@eim/core";
import { normalizeDomain } from "@eim/core";
import type pg from "pg";
import { withTransaction } from "./client";
import { createDefaultAlertPreferences } from "./alert-preferences";
import { createDefaultStoreThresholds } from "./thresholds";

type StoreRow = {
  id: string;
  name: string;
  domain: string;
  sitemap_url: string;
  feed_url: string;
  merchant_center_account_id: string | null;
  baseline_status: Store["baselineStatus"];
  baseline_confirmed_at: Date | null;
  created_at: Date;
};

type StoreSummaryRow = StoreRow & {
  latest_snapshot_status: string | null;
  latest_snapshot_created_at: Date | null;
  open_incident_count: string;
  category_count: string;
};

export type StoreSummary = Store & {
  latestSnapshotStatus: string | null;
  latestSnapshotCreatedAt: string | null;
  openIncidentCount: number;
  categoryCount: number;
};

export type MonitoredCategoryRecord = {
  id: string;
  storeId: string;
  url: string;
  name: string | null;
  criticality: number;
};

export type CreatedStoreResult = {
  store: Store;
  snapshotId: string;
};

const defaultIncidentTypes: IncidentType[] = [
  "catalog_drop",
  "source_divergence",
  "seo_regression",
  "price_availability_mismatch",
  "source_health"
];

export class DuplicateStoreDomainError extends Error {
  constructor(domain: string) {
    super(`Store already exists for domain ${domain}`);
    this.name = "DuplicateStoreDomainError";
  }
}

function mapStore(row: StoreRow): Store {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    sitemapUrl: row.sitemap_url,
    feedUrl: row.feed_url,
    merchantCenterAccountId: row.merchant_center_account_id,
    baselineStatus: row.baseline_status,
    baselineConfirmedAt: row.baseline_confirmed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString()
  };
}

function mapStoreSummary(row: StoreSummaryRow): StoreSummary {
  return {
    ...mapStore(row),
    latestSnapshotStatus: row.latest_snapshot_status,
    latestSnapshotCreatedAt: row.latest_snapshot_created_at?.toISOString() ?? null,
    openIncidentCount: Number(row.open_incident_count),
    categoryCount: Number(row.category_count)
  };
}

export async function createStore(input: CreateStoreInput): Promise<CreatedStoreResult> {
  const normalizedDomain = normalizeDomain(input.domain);

  return withTransaction(async (client) => {
    let storeResult: pg.QueryResult<StoreRow>;

    try {
      storeResult = await client.query<StoreRow>(
        `
          INSERT INTO stores (name, domain, sitemap_url, feed_url, baseline_status)
          VALUES ($1, $2, $3, $4, 'learning')
          RETURNING *
        `,
        [input.name, normalizedDomain, input.sitemapUrl, input.feedUrl]
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateStoreDomainError(normalizedDomain);
      }
      throw error;
    }

    const store = storeResult.rows[0];

    await createDefaultStoreThresholds(client, store.id);
    await createDefaultAlertPreferences(client, store.id);

    for (const [index, url] of input.categoryUrls.entries()) {
      await client.query(
        `
          INSERT INTO monitored_categories (store_id, url, name, criticality)
          VALUES ($1, $2, $3, $4)
        `,
        [store.id, url, `Category ${index + 1}`, 3]
      );
    }

    for (const incidentType of defaultIncidentTypes) {
      await client.query(
        `
          INSERT INTO alert_preferences (store_id, incident_type)
          VALUES ($1, $2)
        `,
        [store.id, incidentType]
      );
    }

    const snapshotResult = await client.query<{ id: string }>(
      `
        INSERT INTO snapshots (store_id, status, baseline_role, idempotency_key)
        VALUES ($1, 'queued', 'candidate', $2)
        RETURNING id
      `,
      [store.id, `store-created:${store.id}:baseline-candidate`]
    );

    return {
      store: mapStore(store),
      snapshotId: snapshotResult.rows[0].id
    };
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

export async function listStores(client?: pg.Pool | pg.PoolClient): Promise<StoreSummary[]> {
  const executor = client ?? (await import("./client")).getPool();
  const result = await executor.query<StoreSummaryRow>(`
    SELECT
      stores.*,
      latest.status::text AS latest_snapshot_status,
      latest.created_at AS latest_snapshot_created_at,
      COUNT(DISTINCT incidents.id) FILTER (
        WHERE incidents.status IN ('open', 'investigating', 'acknowledged', 'recovering')
      ) AS open_incident_count,
      COUNT(DISTINCT monitored_categories.id) AS category_count
    FROM stores
    LEFT JOIN LATERAL (
      SELECT status, created_at
      FROM snapshots
      WHERE snapshots.store_id = stores.id
      ORDER BY created_at DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN incidents ON incidents.store_id = stores.id
    LEFT JOIN monitored_categories ON monitored_categories.store_id = stores.id
    GROUP BY stores.id, latest.status, latest.created_at
    ORDER BY stores.created_at DESC
  `);

  return result.rows.map(mapStoreSummary);
}

export async function getStore(id: string): Promise<StoreSummary | null> {
  const result = await (await import("./client")).getPool().query<StoreSummaryRow>(
    `
      SELECT
        stores.*,
        latest.status::text AS latest_snapshot_status,
        latest.created_at AS latest_snapshot_created_at,
        COUNT(DISTINCT incidents.id) FILTER (
          WHERE incidents.status IN ('open', 'investigating', 'acknowledged', 'recovering')
        ) AS open_incident_count,
        COUNT(DISTINCT monitored_categories.id) AS category_count
      FROM stores
      LEFT JOIN LATERAL (
        SELECT status, created_at
        FROM snapshots
        WHERE snapshots.store_id = stores.id
        ORDER BY created_at DESC
        LIMIT 1
      ) latest ON true
      LEFT JOIN incidents ON incidents.store_id = stores.id
      LEFT JOIN monitored_categories ON monitored_categories.store_id = stores.id
      WHERE stores.id = $1
      GROUP BY stores.id, latest.status, latest.created_at
    `,
    [id]
  );

  return result.rows[0] ? mapStoreSummary(result.rows[0]) : null;
}

export async function listMonitoredCategories(
  storeId: string,
  client?: pg.Pool | pg.PoolClient
): Promise<MonitoredCategoryRecord[]> {
  const executor = client ?? (await import("./client")).getPool();
  const result = await executor.query<{
    id: string;
    store_id: string;
    url: string;
    name: string | null;
    criticality: number;
  }>(
    `
      SELECT id, store_id, url, name, criticality
      FROM monitored_categories
      WHERE store_id = $1
      ORDER BY created_at ASC
    `,
    [storeId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    storeId: row.store_id,
    url: row.url,
    name: row.name,
    criticality: row.criticality
  }));
}
