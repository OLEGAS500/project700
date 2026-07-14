import type { BaselineStatus, SourceCheckSource, SourceCheckStatus } from "@eim/core";
import { getPool } from "../client";

type DashboardStoreRow = {
  id: string;
  name: string;
  domain: string;
  baseline_status: BaselineStatus;
  baseline_updated_at: Date | null;
  open_incident_count: string;
  critical_incident_count: string;
  high_incident_count: string;
  recovering_incident_count: string;
  last_checked_at: Date | null;
  source: SourceCheckSource;
  source_status: SourceCheckStatus | null;
  source_observed_count: number | null;
  source_checked_at: Date | null;
};

export type DashboardStoreSource = {
  source: SourceCheckSource;
  status: SourceCheckStatus | null;
  observedCount: number | null;
  checkedAt: string | null;
};

export type DashboardStoreSummary = {
  id: string;
  name: string;
  domain: string;
  incidents: {
    open: number;
    critical: number;
    high: number;
    recovering: number;
  };
  sources: DashboardStoreSource[];
  baseline: {
    status: BaselineStatus | null;
    updatedAt: string | null;
  };
  lastCheckedAt: string | null;
};

export async function listDashboardStoreSummaries(): Promise<DashboardStoreSummary[]> {
  return queryDashboardStoreSummaries(null);
}

export async function getDashboardStoreSummary(
  storeId: string
): Promise<DashboardStoreSummary | null> {
  const summaries = await queryDashboardStoreSummaries(storeId);
  return summaries[0] ?? null;
}

async function queryDashboardStoreSummaries(
  storeId: string | null
): Promise<DashboardStoreSummary[]> {
  const result = await getPool().query<DashboardStoreRow>(
    `
      WITH selected_stores AS (
        SELECT id, name, domain, baseline_status, created_at
        FROM stores
        WHERE ($1::uuid IS NULL OR id = $1)
      ),
      source_types(source) AS (
        VALUES
          ('sitemap'::source_check_source),
          ('feed'::source_check_source),
          ('category'::source_check_source),
          ('product_page'::source_check_source),
          ('merchant_center'::source_check_source)
      ),
      latest_source_checks AS (
        SELECT DISTINCT ON (source_checks.store_id, source_checks.source)
          source_checks.store_id,
          source_checks.source,
          source_checks.status,
          source_checks.items_observed,
          source_checks.finished_at,
          source_checks.created_at,
          source_checks.id
        FROM source_checks
        JOIN selected_stores ON selected_stores.id = source_checks.store_id
        ORDER BY
          source_checks.store_id,
          source_checks.source,
          source_checks.finished_at DESC,
          source_checks.created_at DESC,
          source_checks.id DESC
      ),
      incident_counts AS (
        SELECT
          incidents.store_id,
          COUNT(*) FILTER (
            WHERE incidents.status IN ('open', 'investigating', 'acknowledged')
          ) AS open_incident_count,
          COUNT(*) FILTER (
            WHERE incidents.status IN ('open', 'investigating', 'acknowledged', 'recovering')
              AND incidents.severity = 'critical'
          ) AS critical_incident_count,
          COUNT(*) FILTER (
            WHERE incidents.status IN ('open', 'investigating', 'acknowledged', 'recovering')
              AND incidents.severity = 'warning'
          ) AS high_incident_count,
          COUNT(*) FILTER (WHERE incidents.status = 'recovering') AS recovering_incident_count
        FROM incidents
        JOIN selected_stores ON selected_stores.id = incidents.store_id
        GROUP BY incidents.store_id
      ),
      latest_baselines AS (
        SELECT DISTINCT ON (baseline_metrics.store_id)
          baseline_metrics.store_id,
          baseline_metrics.updated_at,
          baseline_metrics.id
        FROM baseline_metrics
        JOIN selected_stores ON selected_stores.id = baseline_metrics.store_id
        ORDER BY baseline_metrics.store_id, baseline_metrics.updated_at DESC, baseline_metrics.id DESC
      ),
      last_checks AS (
        SELECT source_checks.store_id, MAX(source_checks.finished_at) AS last_checked_at
        FROM source_checks
        JOIN selected_stores ON selected_stores.id = source_checks.store_id
        GROUP BY source_checks.store_id
      )
      SELECT
        selected_stores.id,
        selected_stores.name,
        selected_stores.domain,
        selected_stores.baseline_status,
        latest_baselines.updated_at AS baseline_updated_at,
        COALESCE(incident_counts.open_incident_count, 0)::text AS open_incident_count,
        COALESCE(incident_counts.critical_incident_count, 0)::text AS critical_incident_count,
        COALESCE(incident_counts.high_incident_count, 0)::text AS high_incident_count,
        COALESCE(incident_counts.recovering_incident_count, 0)::text AS recovering_incident_count,
        last_checks.last_checked_at,
        source_types.source,
        latest_source_checks.status AS source_status,
        latest_source_checks.items_observed AS source_observed_count,
        latest_source_checks.finished_at AS source_checked_at
      FROM selected_stores
      CROSS JOIN source_types
      LEFT JOIN latest_source_checks
        ON latest_source_checks.store_id = selected_stores.id
       AND latest_source_checks.source = source_types.source
      LEFT JOIN incident_counts ON incident_counts.store_id = selected_stores.id
      LEFT JOIN latest_baselines ON latest_baselines.store_id = selected_stores.id
      LEFT JOIN last_checks ON last_checks.store_id = selected_stores.id
      ORDER BY selected_stores.created_at DESC, selected_stores.id DESC, source_types.source ASC
    `,
    [storeId]
  );

  const summaries = new Map<string, DashboardStoreSummary>();

  for (const row of result.rows) {
    let summary = summaries.get(row.id);
    if (!summary) {
      summary = {
        id: row.id,
        name: row.name,
        domain: row.domain,
        incidents: {
          open: Number(row.open_incident_count),
          critical: Number(row.critical_incident_count),
          high: Number(row.high_incident_count),
          recovering: Number(row.recovering_incident_count)
        },
        sources: [],
        baseline: {
          status: row.baseline_status,
          updatedAt: row.baseline_updated_at?.toISOString() ?? null
        },
        lastCheckedAt: row.last_checked_at?.toISOString() ?? null
      };
      summaries.set(row.id, summary);
    }

    summary.sources.push({
      source: row.source,
      status: row.source_status,
      observedCount: row.source_observed_count,
      checkedAt: row.source_checked_at?.toISOString() ?? null
    });
  }

  return [...summaries.values()];
}
