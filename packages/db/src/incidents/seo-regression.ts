import { createBaselineConfigHash } from "@eim/core";
import { createIncidentOpenedAlertDelivery } from "../alerts";
import { getPool, withTransaction } from "../client";
import { captureSnapshotThresholds } from "../thresholds";
import { upsertIncidentSignal } from "./signals";

type SeoSampleManifest = {
  sampleStrategy?: string;
  selectedCount?: number;
  selectedUrlsHash?: string;
  productPageParserVersion?: string;
  normalizationVersion?: string;
  schemaValidationVersion?: string;
};

type SeoSnapshotContext = {
  snapshotId: string;
  storeId: string;
  manifest: SeoSampleManifest;
  comparableChecks: number;
  failedChecks: number;
};

type SeoObservationRow = {
  stable_key: string;
  url: string | null;
  title: string | null;
  http_status: number | null;
  indexability: string | null;
  canonical_state: string | null;
  schema_valid_enough: boolean | null;
};

type SeoSignalEvaluation = {
  metric: "noindex" | "canonical_away" | "schema_missing" | "http_error";
  beforeValue: number;
  afterValue: number;
  changeAbs: number;
  changePct: number;
  affectedItems: Array<{ url: string | null; title: string | null }>;
};

export async function createOrUpdateSeoRegressionIncident(
  storeId: string,
  snapshotId: string
): Promise<string | null> {
  const current = await getSeoSnapshotContext(storeId, snapshotId);
  const capturedThresholds = await captureSnapshotThresholds(storeId, snapshotId);

  if (!current || !isSeoSnapshotComparable(current)) {
    return null;
  }

  const previous = await getPreviousComparableSeoSnapshot(storeId, current);

  if (!previous) {
    return null;
  }

  const observations = await getSeoObservationPairs(previous.snapshotId, snapshotId);

  if (
    observations.commonCount < 20 ||
    observations.coverage < capturedThresholds.thresholds.seoCoverageMinimum
  ) {
    return null;
  }

  const signals = evaluateSeoSignals(observations.rows);

  if (signals.length === 0) {
    return null;
  }

  const affectedCount = Math.max(...signals.map((signal) => signal.changeAbs));
  const configurationHash = createSeoRegressionConfigHash(current.manifest);
  const evidence = [
    `sample strategy: ${current.manifest.sampleStrategy}`,
    `selected URLs hash: ${current.manifest.selectedUrlsHash}`,
    `current selected count: ${current.manifest.selectedCount}`,
    `common comparable URLs: ${observations.commonCount}`,
    `coverage: ${(observations.coverage * 100).toFixed(1)}%`,
    `minimum coverage: ${(capturedThresholds.thresholds.seoCoverageMinimum * 100).toFixed(1)}%`,
    `product-page parser version: ${current.manifest.productPageParserVersion}`,
    `normalization version: ${current.manifest.normalizationVersion}`,
    `schema validation version: ${current.manifest.schemaValidationVersion}`
  ];
  const summary = signals
    .map((signal) => seoSignalSummary(signal))
    .join("; ");
  const confidenceScore = signals.length >= 2 ? 0.7 : 0.55;

  return withTransaction(async (client) => {
    const incident = await client.query<{ id: string }>(
      `
        WITH existing AS (
          SELECT id
          FROM incidents
          WHERE store_id = $1
            AND type = 'seo_regression'
            AND configuration_hash = $5
            AND status IN ('open', 'investigating', 'acknowledged')
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        ),
        updated AS (
          UPDATE incidents
          SET opened_snapshot_id = $2,
              summary = $3,
              evidence_json = $4,
              affected_count = $6,
              confidence_score = $7,
              last_seen_at = now(),
              updated_at = now()
          WHERE id IN (SELECT id FROM existing)
          RETURNING id
        ),
        inserted AS (
          INSERT INTO incidents (
            store_id,
            opened_snapshot_id,
            severity,
            type,
            title,
            summary,
            likely_source,
            confidence_score,
          evidence_json,
          thresholds_json,
            affected_count,
            configuration_hash,
            first_detected_at,
            last_seen_at,
            status
          )
          SELECT
            $1,
            $2,
            'warning',
            'seo_regression',
            'Product-page SEO regression',
            $3,
            'site_template_or_deployment',
            $7,
            $4,
            $8,
            $6,
            $5,
            now(),
            now(),
            'open'
          WHERE NOT EXISTS (SELECT 1 FROM updated)
          RETURNING id
        )
        SELECT id FROM updated
        UNION ALL
        SELECT id FROM inserted
        LIMIT 1
      `,
      [
        storeId,
        snapshotId,
        summary,
        JSON.stringify(evidence),
        configurationHash,
        affectedCount,
        confidenceScore,
        JSON.stringify({
          seoCoverageMinimum: capturedThresholds.thresholds.seoCoverageMinimum,
          thresholdVersion: capturedThresholds.thresholdVersion,
          thresholdConfigurationHash: capturedThresholds.configurationHash
        })
      ]
    );
    const incidentId = incident.rows[0].id;

    for (const signal of signals) {
      await upsertIncidentSignal(client, {
        incidentId,
        source: "product_page",
        metric: signal.metric,
        beforeValue: signal.beforeValue,
        afterValue: signal.afterValue,
        changeAbs: signal.changeAbs,
        changePct: signal.changePct,
        sampleItems: signal.affectedItems.slice(0, 10)
      });
    }
    await createIncidentOpenedAlertDelivery(client, { incidentId, storeId, snapshotId });

    return incidentId;
  });
}

async function getSeoSnapshotContext(
  storeId: string,
  snapshotId: string
): Promise<SeoSnapshotContext | null> {
  const result = await getPool().query<{
    snapshot_id: string;
    store_id: string;
    sample_manifest_json: SeoSampleManifest;
    comparable_checks: string;
    failed_checks: string;
  }>(
    `
      SELECT
        snapshots.id AS snapshot_id,
        snapshots.store_id,
        snapshots.sample_manifest_json,
        COUNT(source_checks.id) FILTER (
          WHERE source_checks.status IN ('success', 'partial')
        ) AS comparable_checks,
        COUNT(source_checks.id) FILTER (
          WHERE source_checks.status NOT IN ('success', 'partial')
        ) AS failed_checks
      FROM snapshots
      LEFT JOIN source_checks
        ON source_checks.snapshot_id = snapshots.id
       AND source_checks.source = 'product_page'
      WHERE snapshots.store_id = $1
        AND snapshots.id = $2
      GROUP BY snapshots.id
      LIMIT 1
    `,
    [storeId, snapshotId]
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    snapshotId: row.snapshot_id,
    storeId: row.store_id,
    manifest: row.sample_manifest_json ?? {},
    comparableChecks: Number(row.comparable_checks),
    failedChecks: Number(row.failed_checks)
  };
}

function isSeoSnapshotComparable(context: SeoSnapshotContext): boolean {
  const selectedCount = Number(context.manifest.selectedCount ?? 0);
  const totalChecks = context.comparableChecks + context.failedChecks;
  const comparableRatio = totalChecks === 0 ? 0 : context.comparableChecks / totalChecks;

  return Boolean(
    context.manifest.sampleStrategy === "stable_hash_v1" &&
      context.manifest.productPageParserVersion === "product_page_parser_v1" &&
      context.manifest.normalizationVersion === "product_page_normalizer_v1" &&
      context.manifest.schemaValidationVersion === "schema_valid_enough_v1" &&
      context.manifest.selectedUrlsHash &&
      selectedCount >= 20 &&
      context.comparableChecks >= 20 &&
      comparableRatio >= 0.8
  );
}

async function getPreviousComparableSeoSnapshot(
  storeId: string,
  current: SeoSnapshotContext
): Promise<SeoSnapshotContext | null> {
  const result = await getPool().query<{ id: string }>(
    `
      SELECT id
      FROM snapshots
      WHERE store_id = $1
        AND id <> $2
        AND sample_manifest_json->>'sampleStrategy' = $3
        AND sample_manifest_json->>'selectedUrlsHash' = $4
        AND sample_manifest_json->>'productPageParserVersion' = $5
        AND sample_manifest_json->>'normalizationVersion' = $6
        AND sample_manifest_json->>'schemaValidationVersion' = $7
        AND (sample_manifest_json->>'selectedCount')::int >= 20
        AND finished_at < (
          SELECT finished_at
          FROM snapshots
          WHERE id = $2
        )
      ORDER BY finished_at DESC
      LIMIT 1
    `,
    [
      storeId,
      current.snapshotId,
      current.manifest.sampleStrategy,
      current.manifest.selectedUrlsHash,
      current.manifest.productPageParserVersion,
      current.manifest.normalizationVersion,
      current.manifest.schemaValidationVersion
    ]
  );
  const previousId = result.rows[0]?.id;

  if (!previousId) {
    return null;
  }

  const previous = await getSeoSnapshotContext(storeId, previousId);

  return previous && isSeoSnapshotComparable(previous) ? previous : null;
}

async function getSeoObservationPairs(
  previousSnapshotId: string,
  currentSnapshotId: string
): Promise<{
  rows: Array<{
    previous: SeoObservationRow;
    current: SeoObservationRow;
  }>;
  commonCount: number;
  coverage: number;
}> {
  const result = await getPool().query<{
    stable_key: string;
    previous_url: string | null;
    previous_title: string | null;
    previous_http_status: number | null;
    previous_indexability: string | null;
    previous_canonical_state: string | null;
    previous_schema_valid_enough: boolean | null;
    current_url: string | null;
    current_title: string | null;
    current_http_status: number | null;
    current_indexability: string | null;
    current_canonical_state: string | null;
    current_schema_valid_enough: boolean | null;
    previous_count: string;
    current_count: string;
  }>(
    `
      WITH previous_items AS (
        SELECT *
        FROM source_items
        WHERE snapshot_id = $1
          AND source = 'storefront'
          AND metadata_json->>'checkedAsProductPage' = 'true'
      ),
      current_items AS (
        SELECT *
        FROM source_items
        WHERE snapshot_id = $2
          AND source = 'storefront'
          AND metadata_json->>'checkedAsProductPage' = 'true'
      ),
      counts AS (
        SELECT
          (SELECT COUNT(*) FROM previous_items) AS previous_count,
          (SELECT COUNT(*) FROM current_items) AS current_count
      )
      SELECT
        previous_items.stable_key,
        previous_items.url AS previous_url,
        previous_items.title AS previous_title,
        previous_items.http_status AS previous_http_status,
        previous_items.indexability AS previous_indexability,
        previous_items.metadata_json #>> '{productPage,canonicalState}' AS previous_canonical_state,
        COALESCE(
          (previous_items.metadata_json #>> '{productPage,schemaValidEnough}')::boolean,
          previous_items.schema_present
        ) AS previous_schema_valid_enough,
        current_items.url AS current_url,
        current_items.title AS current_title,
        current_items.http_status AS current_http_status,
        current_items.indexability AS current_indexability,
        current_items.metadata_json #>> '{productPage,canonicalState}' AS current_canonical_state,
        COALESCE(
          (current_items.metadata_json #>> '{productPage,schemaValidEnough}')::boolean,
          current_items.schema_present
        ) AS current_schema_valid_enough,
        counts.previous_count,
        counts.current_count
      FROM previous_items
      JOIN current_items ON current_items.stable_key = previous_items.stable_key
      CROSS JOIN counts
      ORDER BY previous_items.stable_key
    `,
    [previousSnapshotId, currentSnapshotId]
  );
  const previousCount = Number(result.rows[0]?.previous_count ?? 0);
  const currentCount = Number(result.rows[0]?.current_count ?? 0);
  const denominator = Math.min(previousCount, currentCount) || 1;

  return {
    rows: result.rows.map((row) => ({
      previous: {
        stable_key: row.stable_key,
        url: row.previous_url,
        title: row.previous_title,
        http_status: row.previous_http_status,
        indexability: row.previous_indexability,
        canonical_state: row.previous_canonical_state,
        schema_valid_enough: row.previous_schema_valid_enough
      },
      current: {
        stable_key: row.stable_key,
        url: row.current_url,
        title: row.current_title,
        http_status: row.current_http_status,
        indexability: row.current_indexability,
        canonical_state: row.current_canonical_state,
        schema_valid_enough: row.current_schema_valid_enough
      }
    })),
    commonCount: result.rows.length,
    coverage: result.rows.length / denominator
  };
}

function evaluateSeoSignals(
  rows: Array<{ previous: SeoObservationRow; current: SeoObservationRow }>
): SeoSignalEvaluation[] {
  return [
    evaluateSeoSignal(
      rows,
      "noindex",
      (row) => row.previous.indexability !== "noindex" && row.current.indexability === "noindex",
      5,
      0.05
    ),
    evaluateSeoSignal(
      rows,
      "canonical_away",
      (row) => row.previous.canonical_state === "self" && row.current.canonical_state === "different",
      5,
      0.05
    ),
    evaluateSeoSignal(
      rows,
      "schema_missing",
      (row) => row.previous.schema_valid_enough === true && row.current.schema_valid_enough !== true,
      5,
      0.1
    ),
    evaluateSeoSignal(
      rows,
      "http_error",
      (row) => isHealthyHttp(row.previous.http_status) && isHttpError(row.current.http_status),
      5,
      0.1
    )
  ].filter((signal): signal is SeoSignalEvaluation => signal !== null);
}

function evaluateSeoSignal(
  rows: Array<{ previous: SeoObservationRow; current: SeoObservationRow }>,
  metric: SeoSignalEvaluation["metric"],
  predicate: (row: { previous: SeoObservationRow; current: SeoObservationRow }) => boolean,
  minAffected: number,
  minRatio: number
): SeoSignalEvaluation | null {
  const affected = rows.filter(predicate);
  const ratio = rows.length === 0 ? 0 : affected.length / rows.length;

  if (affected.length < minAffected || ratio < minRatio) {
    return null;
  }

  return {
    metric,
    beforeValue: 0,
    afterValue: affected.length,
    changeAbs: affected.length,
    changePct: ratio,
    affectedItems: affected.map((row) => ({
      url: row.current.url,
      title: row.current.title
    }))
  };
}

function isHealthyHttp(status: number | null): boolean {
  return typeof status === "number" && status >= 200 && status < 400;
}

function isHttpError(status: number | null): boolean {
  return typeof status === "number" && status >= 400;
}

function seoSignalSummary(signal: SeoSignalEvaluation): string {
  if (signal.metric === "noindex") {
    return `${signal.changeAbs} pages became noindex`;
  }
  if (signal.metric === "canonical_away") {
    return `${signal.changeAbs} pages changed canonical away from self`;
  }
  if (signal.metric === "schema_missing") {
    return `Product schema disappeared from ${signal.changeAbs} pages`;
  }

  return `${signal.changeAbs} previously healthy pages now return HTTP errors`;
}

function createSeoRegressionConfigHash(manifest: SeoSampleManifest): string {
  return createBaselineConfigHash({
    rule: "seo_regression",
    sampleStrategy: manifest.sampleStrategy,
    selectedUrlsHash: manifest.selectedUrlsHash,
    productPageParserVersion: manifest.productPageParserVersion,
    normalizationVersion: manifest.normalizationVersion,
    schemaValidationVersion: manifest.schemaValidationVersion
  });
}
