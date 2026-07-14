import {
  calculateBaseline,
  createBaselineConfigHash,
  type BaselineCalculation,
  type BaselineMetricStatus,
  type BaselineObservation
} from "@eim/core";
import type pg from "pg";
import { getPool, withTransaction } from "./client";

const feedProductCountMetric = {
  source: "feed",
  metric: "product_count",
  scope: "main-feed"
} as const;

type BaselineMetricRow = {
  id: string;
  store_id: string;
  metric: string;
  source: string;
  scope: string;
  status: BaselineMetricStatus;
  baseline_version: number;
  configuration_hash: string;
  median_value: string;
  min_value: string | null;
  max_value: string | null;
  p10_value: string | null;
  p90_value: string | null;
  sample_count: number;
  window_start_at: Date;
  window_end_at: Date;
  valid_from: Date;
  valid_to: Date | null;
  confirmed_by_user_id: string | null;
  confirmed_at: Date | null;
  last_recalculated_at: Date;
};

export type BaselineMetricRecord = {
  id: string;
  storeId: string;
  metric: string;
  source: string;
  scope: string;
  status: BaselineMetricStatus;
  baselineVersion: number;
  configurationHash: string;
  medianValue: number;
  minValue: number | null;
  maxValue: number | null;
  p10Value: number | null;
  p90Value: number | null;
  sampleCount: number;
  windowStartAt: string;
  windowEndAt: string;
  validFrom: string;
  validTo: string | null;
  confirmedByUserId: string | null;
  confirmedAt: string | null;
  lastRecalculatedAt: string;
};

type FeedObservationRow = {
  snapshot_id: string;
  feed_product_count: number;
  finished_at: Date;
  feed_url: string;
  source_check_status: "success" | "partial" | "timeout" | "blocked" | "authentication_failed" | "parse_failed" | "source_unavailable";
};

export async function recalculateFeedProductCountBaseline(
  storeId: string
): Promise<BaselineMetricRecord | null> {
  const observations = await listFeedProductCountObservations(storeId);

  if (observations.length === 0) {
    return null;
  }

  return withTransaction(async (client) => {
    const currentResult = await client.query<BaselineMetricRow>(
      `
        SELECT *
        FROM baseline_metrics
        WHERE store_id = $1
          AND source = $2
          AND metric = $3
          AND scope = $4
          AND valid_to IS NULL
        ORDER BY baseline_version DESC
        LIMIT 1
      `,
      [storeId, feedProductCountMetric.source, feedProductCountMetric.metric, feedProductCountMetric.scope]
    );
    const current = currentResult.rows[0];
    const latestConfigHash = observations[observations.length - 1].configurationHash;
    const configChanged = current && current.configuration_hash !== latestConfigHash;

    if (
      current &&
      current.status === "active" &&
      !configChanged &&
      (await shouldFreezeFeedProductCountBaseline(client, storeId))
    ) {
      return mapBaselineMetric(current);
    }

    if (configChanged) {
      await client.query(
        `
          UPDATE baseline_metrics
          SET status = 'stale', valid_to = now(), updated_at = now()
          WHERE id = $1
        `,
        [current.id]
      );
    }

    const eligibleObservations =
      current && current.status === "active" && !configChanged
        ? observations.filter((observation) =>
            isInsideActiveBaselineGuardrails(observation.value, Number(current.median_value))
          )
        : observations;

    const calculation = calculateBaseline({
      observations: eligibleObservations,
      wasConfirmed: Boolean(current && !configChanged && current.confirmed_at)
    });

    if (!calculation) {
      return null;
    }

    const baselineVersion = configChanged ? current.baseline_version + 1 : current?.baseline_version ?? 1;
    const status: BaselineMetricStatus = configChanged && calculation.status === "learning" ? "relearning" : calculation.status;

    if (current && !configChanged) {
      const updated = await client.query<BaselineMetricRow>(
        `
          UPDATE baseline_metrics
          SET
            status = $2,
            configuration_hash = $3,
            median_value = $4,
            min_value = $5,
            max_value = $6,
            p10_value = $7,
            p90_value = $8,
            sample_count = $9,
            window_start_at = $10,
            window_end_at = $11,
            last_recalculated_at = now(),
            updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [
          current.id,
          status,
          calculation.configurationHash,
          calculation.medianValue,
          calculation.minValue,
          calculation.maxValue,
          calculation.p10Value,
          calculation.p90Value,
          calculation.sampleCount,
          calculation.windowStartAt,
          calculation.windowEndAt
        ]
      );

      return mapBaselineMetric(updated.rows[0]);
    }

    const inserted = await client.query<BaselineMetricRow>(
      `
        INSERT INTO baseline_metrics (
          store_id,
          source,
          metric,
          scope,
          status,
          baseline_version,
          configuration_hash,
          median_value,
          min_value,
          max_value,
          p10_value,
          p90_value,
          sample_count,
          window_start_at,
          window_end_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *
      `,
      [
        storeId,
        feedProductCountMetric.source,
        feedProductCountMetric.metric,
        feedProductCountMetric.scope,
        status,
        baselineVersion,
        calculation.configurationHash,
        calculation.medianValue,
        calculation.minValue,
        calculation.maxValue,
        calculation.p10Value,
        calculation.p90Value,
        calculation.sampleCount,
        calculation.windowStartAt,
        calculation.windowEndAt
      ]
    );

    return mapBaselineMetric(inserted.rows[0]);
  });
}

export function isInsideActiveBaselineGuardrails(value: number, median: number): boolean {
  const changeAbs = Math.abs(median - value);
  const changePct = median === 0 ? 0 : changeAbs / median;

  return changePct < 0.2 || changeAbs < 20;
}

async function shouldFreezeFeedProductCountBaseline(
  client: pg.PoolClient,
  storeId: string
): Promise<boolean> {
  const result = await client.query<{ should_freeze: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM incident_candidates
        WHERE store_id = $1
          AND type = 'catalog_drop'
          AND scope_key = 'feed.product_count'
          AND status = 'pending_confirmation'
      )
      OR EXISTS (
        SELECT 1
        FROM incidents
        WHERE store_id = $1
          AND type IN ('catalog_drop', 'source_health')
          AND status IN ('open', 'investigating', 'acknowledged', 'recovering')
      ) AS should_freeze
    `,
    [storeId]
  );

  return result.rows[0]?.should_freeze ?? false;
}

export async function confirmBaselineMetric(
  baselineMetricId: string,
  userId: string
): Promise<BaselineMetricRecord> {
  const result = await getPool().query<BaselineMetricRow>(
    `
      UPDATE baseline_metrics
      SET
        status = 'active',
        confirmed_by_user_id = $2,
        confirmed_at = now(),
        updated_at = now()
      WHERE id = $1
        AND valid_to IS NULL
      RETURNING *
    `,
    [baselineMetricId, userId]
  );

  if (!result.rows[0]) {
    throw new Error(`Baseline metric ${baselineMetricId} was not found`);
  }

  return mapBaselineMetric(result.rows[0]);
}

export async function listBaselineMetrics(storeId: string): Promise<BaselineMetricRecord[]> {
  const result = await getPool().query<BaselineMetricRow>(
    `
      SELECT *
      FROM baseline_metrics
      WHERE store_id = $1
        AND valid_to IS NULL
      ORDER BY source, metric, scope
    `,
    [storeId]
  );

  return result.rows.map(mapBaselineMetric);
}

async function listFeedProductCountObservations(
  storeId: string
): Promise<BaselineObservation[]> {
  const result = await getPool().query<FeedObservationRow>(
    `
      SELECT
        snapshots.id AS snapshot_id,
        snapshots.feed_product_count,
        snapshots.finished_at,
        COALESCE(source_checks.url, stores.feed_url) AS feed_url,
        source_checks.status AS source_check_status
      FROM snapshots
      JOIN stores ON stores.id = snapshots.store_id
      JOIN source_checks ON source_checks.snapshot_id = snapshots.id
        AND source_checks.source = 'feed'
      WHERE snapshots.store_id = $1
        AND snapshots.feed_product_count IS NOT NULL
        AND snapshots.finished_at IS NOT NULL
      ORDER BY snapshots.finished_at ASC
    `,
    [storeId]
  );

  return result.rows.map((row) => ({
    snapshotId: row.snapshot_id,
    value: Number(row.feed_product_count),
    observedAt: row.finished_at.toISOString(),
    comparable: row.source_check_status === "success",
    configurationHash: createBaselineConfigHash({
      source: "feed",
      metric: "product_count",
      feedUrl: row.feed_url,
      collectorVersion: "feed_v1",
      normalizationVersion: "product_count_v1"
    })
  }));
}

function mapBaselineMetric(row: BaselineMetricRow): BaselineMetricRecord {
  return {
    id: row.id,
    storeId: row.store_id,
    metric: row.metric,
    source: row.source,
    scope: row.scope,
    status: row.status,
    baselineVersion: row.baseline_version,
    configurationHash: row.configuration_hash,
    medianValue: Number(row.median_value),
    minValue: row.min_value === null ? null : Number(row.min_value),
    maxValue: row.max_value === null ? null : Number(row.max_value),
    p10Value: row.p10_value === null ? null : Number(row.p10_value),
    p90Value: row.p90_value === null ? null : Number(row.p90_value),
    sampleCount: row.sample_count,
    windowStartAt: row.window_start_at.toISOString(),
    windowEndAt: row.window_end_at.toISOString(),
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to?.toISOString() ?? null,
    confirmedByUserId: row.confirmed_by_user_id,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    lastRecalculatedAt: row.last_recalculated_at.toISOString()
  };
}
