import {
  createBaselineConfigHash,
  detectFeedCatalogDrop,
  detectMatchedStorefrontFeedLoss
} from "@eim/core";
import type pg from "pg";
import { createIncidentOpenedAlertDelivery } from "../alerts";
import { getPool, withTransaction } from "../client";
import { captureSnapshotThresholds, type CapturedSnapshotThresholds } from "../thresholds";
import {
  mapCandidate,
  upsertCatalogDropCandidate,
  type IncidentCandidateRecord
} from "./candidates";
export { confirmFeedCatalogDropCandidate } from "./confirmation";
export {
  claimDueIncidentConfirmationCandidates,
  markIncidentConfirmationAttemptFailed,
  type DueIncidentConfirmationCandidate
} from "./confirmation-jobs";
import {
  evaluatePriceAvailabilitySignals,
  priceAvailabilitySignalSummary,
  type PriceAvailabilityMatchRow
} from "./price-availability";
import { upsertIncidentSignal } from "./signals";
export { createOrUpdateSeoRegressionIncident } from "./seo-regression";
export { createOrUpdateFeedSourceHealthIncident } from "./source-health";
export {
  acknowledgeIncident,
  addIncidentComment,
  getIncidentDetail,
  ignoreIncident,
  IncidentActionConflictError,
  IncidentNotFoundError,
  listIncidents,
  type IncidentCommentRecord,
  type IncidentDetail,
  type IncidentEventRecord,
  type IncidentRecord,
  type IncidentSignalRecord
} from "./actions";
export {
  updateCatalogDropRecovery,
  updatePriceAvailabilityRecovery,
  updateSeoRegressionRecovery,
  updateSourceDivergenceRecovery,
  type CatalogDropRecoveryResult
} from "./recovery";

type BaselineRow = {
  id: string;
  baseline_version: number;
  configuration_hash: string;
  median_value: string;
  status: "learning" | "ready_for_confirmation" | "active" | "stale" | "relearning";
};

type SnapshotFeedRow = {
  snapshot_id: string;
  store_id: string;
  feed_product_count: number | null;
  baseline_role: string;
  finished_at: Date | null;
  feed_url: string;
  feed_check_status: "success" | "partial" | "timeout" | "blocked" | "authentication_failed" | "parse_failed" | "source_unavailable" | null;
};

type SourceDivergenceContextRow = {
  snapshot_id: string;
  store_id: string;
  feed_url: string;
  feed_check_status: "success" | "partial" | "timeout" | "blocked" | "authentication_failed" | "parse_failed" | "source_unavailable" | null;
  category_check_count: string;
  all_category_checks_success: boolean | null;
  matched_storefront_count: string;
  missing_from_feed_count: string;
};

type PriceAvailabilityThresholds = {
  minimumAffectedCount: number;
  minimumAffectedRatio: number;
  minimumComparableMatches: number;
  priceTolerance: {
    absolute: number;
    relative: number;
  };
  allowedMatchMethods: Array<"offer_id" | "normalized_url" | "canonical_url">;
  matchingVersion: string;
  priceNormalizationVersion: string;
  availabilityNormalizationVersion: string;
  currencyRules: string;
  thresholdVersion: number;
  thresholdConfigurationHash: string;
};

type PriceAvailabilityEvaluation = {
  comparable: boolean;
  rows: PriceAvailabilityMatchRow[];
  signals: ReturnType<typeof evaluatePriceAvailabilitySignals>;
  significant: boolean;
  affectedCount: number;
  totalAffected: number;
  affectedRatio: number;
  configurationHash: string;
  thresholds: PriceAvailabilityThresholds;
  evidence: string[];
  summary: string;
};

type PriceAvailabilityDebounceCandidateRow = {
  id: string;
  first_snapshot_id: string;
  last_snapshot_id: string;
};

export type { IncidentCandidateRecord } from "./candidates";

export async function evaluateFeedCatalogDropCandidate(
  storeId: string,
  snapshotId: string
): Promise<IncidentCandidateRecord | null> {
  const context = await getFeedIncidentContext(storeId, snapshotId);

  if (!context || !context.baseline || !context.snapshot) {
    return null;
  }

  if (
    context.baseline.status !== "active" ||
    context.snapshot.baseline_role === "confirmation_check" ||
    context.snapshot.feed_product_count === null ||
    context.snapshot.feed_check_status !== "success" ||
    context.configurationHash !== context.baseline.configuration_hash
  ) {
    return null;
  }

  const decision = detectFeedCatalogDrop({
    currentCount: Number(context.snapshot.feed_product_count),
    baselineMedian: Number(context.baseline.median_value),
    ...(await getSnapshotRuleThresholds(storeId, snapshotId))
  });

  if (!decision.isDrop) {
    return null;
  }

  const evidence = [
    `feed product count dropped ${(decision.changePct * 100).toFixed(1)}%`,
    `baseline version ${context.baseline.baseline_version}`,
    `baseline median ${Number(context.baseline.median_value)}`
  ];
  const capturedThresholds = await captureSnapshotThresholds(storeId, snapshotId);
  const thresholds = {
    percentThreshold: capturedThresholds.thresholds.catalogDropPercentage,
    absoluteThreshold: capturedThresholds.thresholds.catalogDropAbsolute,
    thresholdVersion: capturedThresholds.thresholdVersion,
    thresholdConfigurationHash: capturedThresholds.configurationHash
  };

  const candidate = await upsertCatalogDropCandidate(getPool(), {
      storeId,
      baselineMetricId: context.baseline.id,
      baselineVersion: context.baseline.baseline_version,
      baselineMedian: context.baseline.median_value,
      configurationHash: context.baseline.configuration_hash,
      firstSnapshotId: snapshotId,
      observedValue: Number(context.snapshot.feed_product_count),
      changeAbs: decision.changeAbs,
      changePct: decision.changePct,
      evidence,
      thresholds
    });

  return mapCandidate(candidate);
}

export async function createOrUpdateSourceDivergenceIncident(
  storeId: string,
  snapshotId: string
): Promise<string | null> {
  const context = await getSourceDivergenceContext(storeId, snapshotId);

  if (
    !context ||
    context.feed_check_status !== "success" ||
    Number(context.category_check_count) === 0 ||
    context.all_category_checks_success !== true
  ) {
    return null;
  }

  const matchedStorefrontCount = Number(context.matched_storefront_count);
  const missingFromFeedCount = Number(context.missing_from_feed_count);
  const capturedThresholds = await captureSnapshotThresholds(storeId, snapshotId);
  const decision = detectMatchedStorefrontFeedLoss({
    matchedStorefrontCount,
    missingFromFeedCount,
    percentThreshold: capturedThresholds.thresholds.sourceDivergencePercentage,
    absoluteThreshold: capturedThresholds.thresholds.sourceDivergenceAbsolute
  });

  if (!decision.isDrop) {
    return null;
  }

  const configurationHash = createSourceDivergenceConfigHash(context.feed_url);
  const thresholds = {
    percentThreshold: capturedThresholds.thresholds.sourceDivergencePercentage,
    absoluteThreshold: capturedThresholds.thresholds.sourceDivergenceAbsolute,
    matchMethods: ["normalized_url", "canonical_url", "offer_id"],
    matchingVersion: "source_matches_v1",
    normalizationVersion: "product_key_v1",
    thresholdVersion: capturedThresholds.thresholdVersion,
    thresholdConfigurationHash: capturedThresholds.configurationHash
  };
  const evidence = [
    "feed source check completed successfully",
    "complete category storefront checks completed successfully",
    `matched storefront products: ${matchedStorefrontCount}`,
    `matched storefront products missing from feed: ${missingFromFeedCount}`,
    `matched item loss ratio: ${(decision.changePct * 100).toFixed(1)}%`
  ];
  const summary = `${missingFromFeedCount} matched storefront products are missing from the feed.`;

  const result = await withTransaction(async (client) => {
    const incident = await client.query<{ id: string }>(
      `
        WITH existing AS (
          SELECT id
          FROM incidents
          WHERE store_id = $1
            AND type = 'source_divergence'
            AND configuration_hash = $6
            AND status IN ('open', 'investigating', 'acknowledged')
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        ),
        updated AS (
          UPDATE incidents
          SET opened_snapshot_id = $2,
              summary = $3,
              likely_source = 'feed',
              confidence_score = 0.75,
              evidence_json = $4,
              affected_count = $5,
              thresholds_json = $7,
              before_value = $8,
              after_value = $9,
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
            affected_count,
            configuration_hash,
            thresholds_json,
            before_value,
            after_value,
            first_detected_at,
            last_seen_at,
            status
          )
          SELECT
            $1,
            $2,
            'warning',
            'source_divergence',
            'Matched storefront products missing from feed',
            $3,
            'feed',
            0.75,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
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
        decision.changeAbs,
        configurationHash,
        JSON.stringify(thresholds),
        matchedStorefrontCount,
        missingFromFeedCount
      ]
    );
    const incidentId = incident.rows[0].id;

    await upsertIncidentSignal(client, {
      incidentId,
      source: "feed_vs_storefront",
      metric: "matched_storefront_missing_from_feed",
      beforeValue: matchedStorefrontCount,
      afterValue: missingFromFeedCount,
      changeAbs: decision.changeAbs,
      changePct: decision.changePct
    });
    await createIncidentOpenedAlertDelivery(client, { incidentId, storeId, snapshotId });

    return incidentId;
  });

  return result;
}

export async function createOrUpdatePriceAvailabilityMismatchIncident(
  storeId: string,
  snapshotId: string
): Promise<string | null> {
  const evaluation = await evaluatePriceAvailabilitySnapshot(storeId, snapshotId);

  if (!evaluation.comparable) {
    return null;
  }

  const fingerprint = buildPriceAvailabilityDebounceFingerprint(
    storeId,
    evaluation.configurationHash
  );

  return withTransaction(async (client) => {
    await lockPriceAvailabilityDebounceFingerprint(client, fingerprint);

    if (!evaluation.significant) {
      await dismissPriceAvailabilityDebounceCandidate(
        client,
        fingerprint,
        snapshotId,
        "healthy_comparable_snapshot"
      );
      return null;
    }

    const existingIncidentId = await getActivePriceAvailabilityIncidentId(
      client,
      storeId,
      evaluation.configurationHash
    );

    if (existingIncidentId) {
      await updatePriceAvailabilityIncident(
        client,
        existingIncidentId,
        snapshotId,
        evaluation
      );
      await createIncidentOpenedAlertDelivery(client, {
        incidentId: existingIncidentId,
        storeId,
        snapshotId
      });
      return existingIncidentId;
    }

    const candidate = await upsertPriceAvailabilityDebounceCandidate(
      client,
      fingerprint,
      storeId,
      snapshotId,
      evaluation
    );

    const confirmedElsewhereIncidentId = await getActivePriceAvailabilityIncidentId(
      client,
      storeId,
      evaluation.configurationHash
    );

    if (confirmedElsewhereIncidentId) {
      await dismissPriceAvailabilityDebounceCandidate(
        client,
        fingerprint,
        snapshotId,
        "duplicate_after_concurrent_confirmation"
      );
      await updatePriceAvailabilityIncident(
        client,
        confirmedElsewhereIncidentId,
        snapshotId,
        evaluation
      );
      await createIncidentOpenedAlertDelivery(client, {
        incidentId: confirmedElsewhereIncidentId,
        storeId,
        snapshotId
      });
      return confirmedElsewhereIncidentId;
    }

    if (candidate.first_snapshot_id === snapshotId) {
      return null;
    }

    const incidentId = await insertPriceAvailabilityIncident(
      client,
      storeId,
      snapshotId,
      evaluation
    );
    await client.query(
      `
        UPDATE incident_debounce_candidates
        SET status = 'confirmed',
            status_reason = 'consecutive_mismatch_confirmed',
            confirmed_incident_id = $3,
            updated_at = now()
        WHERE id = $1
          AND status = 'pending'
          AND last_snapshot_id = $2
      `,
      [candidate.id, snapshotId, incidentId]
    );
    await createIncidentOpenedAlertDelivery(client, { incidentId, storeId, snapshotId });

    return incidentId;
  });
}

async function lockPriceAvailabilityDebounceFingerprint(
  client: pg.PoolClient,
  fingerprint: string
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [fingerprint]
  );
}

async function getFeedIncidentContext(storeId: string, snapshotId: string): Promise<{
  baseline: BaselineRow | null;
  snapshot: SnapshotFeedRow | null;
  configurationHash: string;
} | null> {
  const snapshot = await getSnapshotFeedRow(storeId, snapshotId);

  if (!snapshot) {
    return null;
  }

  const configurationHash = createFeedConfigHash(snapshot.feed_url);
  const baseline = await getPool().query<BaselineRow>(
    `
      SELECT *
      FROM baseline_metrics
      WHERE store_id = $1
        AND source = 'feed'
        AND metric = 'product_count'
        AND scope = 'main-feed'
        AND valid_to IS NULL
      ORDER BY baseline_version DESC
      LIMIT 1
    `,
    [storeId]
  );

  return {
    baseline: baseline.rows[0] ?? null,
    snapshot,
    configurationHash
  };
}

async function getSnapshotFeedRow(
  storeId: string,
  snapshotId: string,
  client: pg.Pool | pg.PoolClient = getPool()
): Promise<SnapshotFeedRow | null> {
  const result = await client.query<SnapshotFeedRow>(
    `
      SELECT
        snapshots.id AS snapshot_id,
        snapshots.store_id,
        snapshots.feed_product_count,
        snapshots.baseline_role,
        snapshots.finished_at,
        stores.feed_url,
        source_checks.status AS feed_check_status
      FROM snapshots
      JOIN stores ON stores.id = snapshots.store_id
      LEFT JOIN source_checks ON source_checks.snapshot_id = snapshots.id
        AND source_checks.source = 'feed'
      WHERE snapshots.store_id = $1
        AND snapshots.id = $2
      ORDER BY source_checks.finished_at DESC NULLS LAST
      LIMIT 1
    `,
    [storeId, snapshotId]
  );

  return result.rows[0] ?? null;
}

async function getActiveFeedBaseline(
  storeId: string,
  client: pg.Pool | pg.PoolClient = getPool()
): Promise<BaselineRow | null> {
  const result = await client.query<BaselineRow>(
    `
      SELECT *
      FROM baseline_metrics
      WHERE store_id = $1
        AND source = 'feed'
        AND metric = 'product_count'
        AND scope = 'main-feed'
        AND valid_to IS NULL
        AND status = 'active'
      ORDER BY baseline_version DESC
      LIMIT 1
    `,
    [storeId]
  );

  return result.rows[0] ?? null;
}

async function getSourceDivergenceContext(
  storeId: string,
  snapshotId: string
): Promise<SourceDivergenceContextRow | null> {
  const result = await getPool().query<SourceDivergenceContextRow>(
    `
      SELECT
        snapshots.id AS snapshot_id,
        snapshots.store_id,
        stores.feed_url,
        feed_check.status AS feed_check_status,
        COUNT(category_checks.id) AS category_check_count,
        BOOL_AND(category_checks.status = 'success') AS all_category_checks_success,
        (
          SELECT COUNT(DISTINCT storefront_item_id)
          FROM source_matches
          WHERE source_matches.snapshot_id = snapshots.id
            AND source_matches.store_id = snapshots.store_id
            AND source_matches.storefront_item_id IS NOT NULL
        ) AS matched_storefront_count,
        (
          SELECT COUNT(DISTINCT storefront_item_id)
          FROM source_matches
          WHERE source_matches.snapshot_id = snapshots.id
            AND source_matches.store_id = snapshots.store_id
            AND source_matches.storefront_item_id IS NOT NULL
            AND source_matches.feed_item_id IS NULL
        ) AS missing_from_feed_count
      FROM snapshots
      JOIN stores ON stores.id = snapshots.store_id
      LEFT JOIN source_checks feed_check
        ON feed_check.snapshot_id = snapshots.id
       AND feed_check.source = 'feed'
      LEFT JOIN source_checks category_checks
        ON category_checks.snapshot_id = snapshots.id
       AND category_checks.source = 'category'
      WHERE snapshots.store_id = $1
        AND snapshots.id = $2
      GROUP BY snapshots.id, stores.feed_url, feed_check.status
      LIMIT 1
    `,
    [storeId, snapshotId]
  );

  return result.rows[0] ?? null;
}

async function evaluatePriceAvailabilitySnapshot(
  storeId: string,
  snapshotId: string
): Promise<PriceAvailabilityEvaluation> {
  const capturedThresholds = await captureSnapshotThresholds(storeId, snapshotId);
  const thresholds = getPriceAvailabilityThresholds(capturedThresholds);
  const configurationHash = createPriceAvailabilityConfigHash();
  const rows = await getPriceAvailabilityMatchRows(storeId, snapshotId);
  const signals = evaluatePriceAvailabilitySignals(rows, {
    minimumAffectedCount: thresholds.minimumAffectedCount,
    minimumAffectedRatio: thresholds.minimumAffectedRatio,
    priceTolerance: thresholds.priceTolerance
  });
  const totalAffected = new Set(
    signals.flatMap((signal) =>
      signal.affectedItems.map((item) => `${item.url ?? ""}:${item.title ?? ""}`)
    )
  ).size;
  const affectedRatio = rows.length === 0 ? 0 : totalAffected / rows.length;
  const affectedCount =
    signals.length === 0 ? 0 : Math.max(...signals.map((signal) => signal.count));
  const comparable = rows.length >= thresholds.minimumComparableMatches;
  const significant =
    comparable &&
    signals.length > 0 &&
    totalAffected >= thresholds.minimumAffectedCount &&
    affectedRatio >= thresholds.minimumAffectedRatio;
  const evidence = [
    `matched comparable products: ${rows.length}`,
    `minimum comparable matches: ${thresholds.minimumComparableMatches}`,
    `minimum affected products: ${thresholds.minimumAffectedCount}`,
    `minimum affected ratio: ${(thresholds.minimumAffectedRatio * 100).toFixed(1)}%`,
    `match methods: ${thresholds.allowedMatchMethods.join(", ")}`,
    `price tolerance: absolute >= ${thresholds.priceTolerance.absolute} and relative >= ${(thresholds.priceTolerance.relative * 100).toFixed(3)}%`,
    "availability values normalized to in_stock/out_of_stock/preorder/backorder/unknown",
    `configuration hash: ${configurationHash}`
  ];

  return {
    comparable,
    rows,
    signals,
    significant,
    affectedCount,
    totalAffected,
    affectedRatio,
    configurationHash,
    thresholds,
    evidence,
    summary: signals.map(priceAvailabilitySignalSummary).join("; ")
  };
}

async function getPriceAvailabilityMatchRows(
  storeId: string,
  snapshotId: string
): Promise<PriceAvailabilityMatchRow[]> {
  const sourceState = await getPool().query<{ comparable: boolean }>(
    `
      SELECT
        EXISTS (
          SELECT 1
          FROM source_checks
          WHERE store_id = $1
            AND snapshot_id = $2
            AND source = 'feed'
            AND status = 'success'
        )
        AND EXISTS (
          SELECT 1
          FROM source_checks
          WHERE store_id = $1
            AND snapshot_id = $2
            AND source = 'product_page'
            AND status = 'success'
        ) AS comparable
    `,
    [storeId, snapshotId]
  );

  if (!sourceState.rows[0]?.comparable) {
    return [];
  }

  const result = await getPool().query<PriceAvailabilityMatchRow>(
    `
      SELECT
        source_matches.match_method,
        source_matches.match_confidence,
        source_matches.matched_key,
        feed_items.url AS feed_url,
        feed_items.title AS feed_title,
        feed_items.price AS feed_price,
        feed_items.currency AS feed_currency,
        feed_items.availability AS feed_availability,
        storefront_items.url AS storefront_url,
        storefront_items.title AS storefront_title,
        storefront_items.price AS storefront_price,
        storefront_items.currency AS storefront_currency,
        storefront_items.availability AS storefront_availability
      FROM source_matches
      JOIN source_items feed_items ON feed_items.id = source_matches.feed_item_id
      JOIN source_items storefront_items ON storefront_items.id = source_matches.storefront_item_id
      WHERE source_matches.store_id = $1
        AND source_matches.snapshot_id = $2
        AND source_matches.match_method IN ('offer_id', 'normalized_url', 'canonical_url')
        AND source_matches.match_confidence >= 0.9
    `,
    [storeId, snapshotId]
  );

  return result.rows;
}

async function getActivePriceAvailabilityIncidentId(
  client: pg.PoolClient,
  storeId: string,
  configurationHash: string
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM incidents
      WHERE store_id = $1
        AND type = 'price_availability_mismatch'
        AND configuration_hash = $2
        AND status IN ('open', 'investigating', 'acknowledged', 'recovering')
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [storeId, configurationHash]
  );

  return result.rows[0]?.id ?? null;
}

async function upsertPriceAvailabilityDebounceCandidate(
  client: pg.PoolClient,
  fingerprint: string,
  storeId: string,
  snapshotId: string,
  evaluation: PriceAvailabilityEvaluation
): Promise<PriceAvailabilityDebounceCandidateRow> {
  const result = await client.query<PriceAvailabilityDebounceCandidateRow>(
    `
      INSERT INTO incident_debounce_candidates (
        store_id,
        type,
        scope_key,
        configuration_hash,
        fingerprint,
        first_snapshot_id,
        last_snapshot_id,
        first_affected_count,
        last_affected_count,
        status,
        status_reason,
        evidence_json,
        thresholds_json
      )
      VALUES (
        $1,
        'price_availability_mismatch',
        'feed_vs_storefront.product_data',
        $2,
        $3,
        $4,
        $4,
        $5,
        $5,
        'pending',
        'awaiting_second_comparable_mismatch',
        $6,
        $7
      )
      ON CONFLICT (fingerprint) WHERE status = 'pending'
      DO UPDATE SET
        last_snapshot_id = EXCLUDED.last_snapshot_id,
        last_affected_count = EXCLUDED.last_affected_count,
        evidence_json = EXCLUDED.evidence_json,
        thresholds_json = EXCLUDED.thresholds_json,
        updated_at = now()
      RETURNING id, first_snapshot_id, last_snapshot_id
    `,
    [
      storeId,
      evaluation.configurationHash,
      fingerprint,
      snapshotId,
      evaluation.affectedCount,
      JSON.stringify(evaluation.evidence),
      JSON.stringify(evaluation.thresholds)
    ]
  );

  return result.rows[0];
}

async function dismissPriceAvailabilityDebounceCandidate(
  client: pg.PoolClient,
  fingerprint: string,
  snapshotId: string,
  reason: string
): Promise<void> {
  await client.query(
    `
      UPDATE incident_debounce_candidates
      SET status = 'dismissed',
          status_reason = $3,
          last_snapshot_id = $2,
          updated_at = now()
      WHERE fingerprint = $1
        AND status = 'pending'
    `,
    [fingerprint, snapshotId, reason]
  );
}

async function insertPriceAvailabilityIncident(
  client: pg.PoolClient,
  storeId: string,
  snapshotId: string,
  evaluation: PriceAvailabilityEvaluation
): Promise<string> {
  const incident = await client.query<{ id: string }>(
    `
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
        affected_count,
        configuration_hash,
        thresholds_json,
        first_detected_at,
        last_seen_at,
        status
      )
      VALUES (
        $1,
        $2,
        'warning',
        'price_availability_mismatch',
        'Product data mismatch',
        $3,
        'feed_or_storefront_product_data',
        0.72,
        $4,
        $5,
        $6,
        $7,
        now(),
        now(),
        'open'
      )
      RETURNING id
    `,
    [
      storeId,
      snapshotId,
      evaluation.summary,
      JSON.stringify(evaluation.evidence),
      evaluation.affectedCount,
      evaluation.configurationHash,
      JSON.stringify(evaluation.thresholds)
    ]
  );
  const incidentId = incident.rows[0].id;

  await persistPriceAvailabilitySignals(client, incidentId, evaluation);

  return incidentId;
}

async function updatePriceAvailabilityIncident(
  client: pg.PoolClient,
  incidentId: string,
  snapshotId: string,
  evaluation: PriceAvailabilityEvaluation
): Promise<void> {
  await client.query(
    `
      UPDATE incidents
      SET opened_snapshot_id = $2,
          summary = $3,
          evidence_json = $4,
          affected_count = $5,
          thresholds_json = $6,
          last_seen_at = now(),
          updated_at = now()
      WHERE id = $1
    `,
    [
      incidentId,
      snapshotId,
      evaluation.summary,
      JSON.stringify(evaluation.evidence),
      evaluation.affectedCount,
      JSON.stringify(evaluation.thresholds)
    ]
  );
  await persistPriceAvailabilitySignals(client, incidentId, evaluation);
}

async function persistPriceAvailabilitySignals(
  client: pg.PoolClient,
  incidentId: string,
  evaluation: PriceAvailabilityEvaluation
): Promise<void> {
  for (const signal of evaluation.signals) {
    await upsertIncidentSignal(client, {
      incidentId,
      source: "feed_vs_storefront",
      metric: signal.metric,
      afterValue: signal.count,
      changeAbs: signal.count,
      changePct: signal.ratio,
      sampleItems: signal.affectedItems.slice(0, 10)
    });
  }
}

function createFeedConfigHash(feedUrl: string): string {
  return createBaselineConfigHash({
    source: "feed",
    metric: "product_count",
    feedUrl,
    collectorVersion: "feed_v1",
    normalizationVersion: "product_count_v1"
  });
}

function createSourceDivergenceConfigHash(feedUrl: string): string {
  return createBaselineConfigHash({
    rule: "source_divergence",
    scope: "matched_storefront_missing_from_feed",
    feedUrl,
    matchVersion: "source_matches_v1",
    normalizationVersion: "product_key_v1"
  });
}

function createPriceAvailabilityConfigHash(): string {
  return createBaselineConfigHash({
    rule: "price_availability_mismatch",
    matchVersion: "source_matches_v1",
    priceNormalizationVersion: "effective_decimal_price_v1",
    availabilityNormalizationVersion: "availability_enum_v1"
  });
}

function buildPriceAvailabilityDebounceFingerprint(
  storeId: string,
  configurationHash: string
): string {
  return [
    storeId,
    "price_availability_mismatch",
    "feed_vs_storefront.product_data",
    configurationHash
  ].join(":");
}

function getPriceAvailabilityThresholds(
  captured: CapturedSnapshotThresholds
): PriceAvailabilityThresholds {
  return {
    minimumAffectedCount: captured.thresholds.minimumMismatchCount,
    minimumAffectedRatio: captured.thresholds.minimumMismatchRatio,
    minimumComparableMatches: 20,
    priceTolerance: {
      absolute: captured.thresholds.priceMismatchTolerance.absolute,
      relative: captured.thresholds.priceMismatchTolerance.relative
    },
    allowedMatchMethods: ["offer_id", "normalized_url", "canonical_url"],
    matchingVersion: "source_matches_v1",
    priceNormalizationVersion: "effective_decimal_price_v1",
    availabilityNormalizationVersion: "availability_enum_v1",
    currencyRules: "same_currency_required",
    thresholdVersion: captured.thresholdVersion,
    thresholdConfigurationHash: captured.configurationHash
  };
}

async function getSnapshotRuleThresholds(
  storeId: string,
  snapshotId: string
): Promise<{ percentThreshold: number; absoluteThreshold: number }> {
  const captured = await captureSnapshotThresholds(storeId, snapshotId);
  return {
    percentThreshold: captured.thresholds.catalogDropPercentage,
    absoluteThreshold: captured.thresholds.catalogDropAbsolute
  };
}
