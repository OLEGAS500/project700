import {
  calculateBaseline,
  detectFeedCatalogDrop,
  detectMatchedStorefrontFeedLoss,
  type BaselineObservation,
  type SourceCheckStatus
} from "@eim/core";
import type pg from "pg";
import {
  getCrossSourceProductMatchSummary,
  type CrossSourceProductMatchSummary,
  type ProductMatchSample
} from "../dashboard/cross-source-product-mapping";
import { getCandidateForConfirmation, type CandidateRow } from "./candidates";
import { merchantItemIssuesConfigurationHash } from "./merchant-item-issues";
import { upsertIncidentSignal } from "./signals";

const merchantStatusAggregationVersion = "v1";
const merchantItemIssuesVersion = "v1";
const merchantProductIdentityVersion = "v1";
const merchantItemIssuesCheckKey = "merchant_center:item_issues";
const merchantBaselineMinimumSamples = 7;
const merchantBaselineMaximumSamples = 14;
const maximumEvidenceSamples = 20;
const correlatedCatalogDropConfidence = 0.95;

type CorrelationSnapshotRow = {
  snapshot_id: string;
  store_id: string;
  created_at: Date;
  snapshot_status: "queued" | "running" | "completed" | "partial" | "failed";
  feed_product_count: number | null;
  merchant_center_account_id: string | null;
};

type SourceCheckRow = {
  id: string;
  source: string;
  check_key: string;
  status: SourceCheckStatus;
  finished_at: Date | null;
  metadata_json: Record<string, unknown>;
};

type MerchantBaselineRow = {
  snapshot_id: string;
  observed_at: Date;
  metadata_json: Record<string, unknown>;
};

type CorrelationIncidentRow = {
  id: string;
  store_id: string;
  status: string;
};

type CorrelatedMappingEvaluation = {
  reason: "correlated";
  identityDecision: Extract<
    ReturnType<typeof detectMatchedStorefrontFeedLoss>,
    { isDrop: true }
  >;
};

type MappingEvaluation =
  | CorrelatedMappingEvaluation
  | {
      reason: Exclude<FeedMerchantCorrelationResult["reason"], "correlated">;
    };

type FeedMerchantCorrelationInput = {
  incidentId: string;
  candidateId: string;
};

export type FeedMerchantCorrelationResult = {
  correlated: boolean;
  reason:
    | "correlated"
    | "already_recorded"
    | "candidate_context_unavailable"
    | "incident_unavailable"
    | "captured_thresholds_invalid"
    | "snapshot_or_configuration_unavailable"
    | "source_checks_incomplete"
    | "merchant_baseline_unavailable"
    | "merchant_approved_drop_not_confirmed"
    | "mapping_incompatible"
    | "mapping_ambiguous"
    | "mapping_truncated"
    | "mapping_feed_count_mismatch"
    | "mapping_identity_loss_not_confirmed"
    | "mapping_has_no_merchant_only_products"
    | "feed_drop_not_confirmed";
};

export async function applyFeedMerchantCorrelation(
  client: pg.PoolClient,
  input: FeedMerchantCorrelationInput
): Promise<FeedMerchantCorrelationResult> {
  const candidate = await getCandidateForConfirmation(client, input.candidateId);
  if (
    !candidate ||
    candidate.type !== "catalog_drop" ||
    !candidate.confirmation_snapshot_id ||
    (candidate.status !== "pending_confirmation" && candidate.status !== "confirmed")
  ) {
    return { correlated: false, reason: "candidate_context_unavailable" };
  }

  const incidentRow = await lockCorrelationIncident(client, input.incidentId, candidate);
  if (!incidentRow || incidentRow.status === "ignored" || incidentRow.status === "resolved") {
    return { correlated: false, reason: "incident_unavailable" };
  }

  const existingEvent = await client.query<{ id: string }>(
    `
      SELECT id
      FROM incident_events
      WHERE incident_id = $1
        AND event_type = 'feed_merchant_correlation_confirmed'
      LIMIT 1
    `,
    [incidentRow.id]
  );
  if (existingEvent.rows[0]) {
    return { correlated: true, reason: "already_recorded" };
  }

  const thresholds = readCapturedThresholds(candidate.thresholds_json);
  if (!thresholds) {
    return { correlated: false, reason: "captured_thresholds_invalid" };
  }

  const snapshot = await lockCorrelationSnapshot(
    client,
    candidate.store_id,
    candidate.first_snapshot_id
  );
  if (
    !snapshot ||
    snapshot.snapshot_status !== "completed" ||
    !snapshot.merchant_center_account_id
  ) {
    return { correlated: false, reason: "snapshot_or_configuration_unavailable" };
  }

  const configurationHash = merchantItemIssuesConfigurationHash(
    snapshot.merchant_center_account_id
  );
  const checks = await lockCorrelationSourceChecks(
    client,
    candidate.store_id,
    candidate.first_snapshot_id
  );
  const correlationChecks = getCompleteCorrelationChecks(checks, configurationHash);
  if (!correlationChecks) {
    return { correlated: false, reason: "source_checks_incomplete" };
  }

  const currentFeedCount = readNonNegativeInteger(snapshot.feed_product_count);
  const currentMerchantApprovedCount = readMerchantApprovedCount(
    correlationChecks.statusCheck.metadata_json
  );
  if (currentFeedCount === null || currentMerchantApprovedCount === null) {
    return { correlated: false, reason: "snapshot_or_configuration_unavailable" };
  }

  const feedDecision = detectFeedCatalogDrop({
    currentCount: currentFeedCount,
    baselineMedian: Number(candidate.baseline_median),
    percentThreshold: thresholds.percentThreshold,
    absoluteThreshold: thresholds.absoluteThreshold
  });
  if (!feedDecision.isDrop) {
    return { correlated: false, reason: "feed_drop_not_confirmed" };
  }

  const merchantBaselineRows = await lockMerchantApprovedBaselineRows(client, {
    storeId: candidate.store_id,
    observedSnapshotId: candidate.first_snapshot_id,
    observedStatusCheckAt: correlationChecks.statusCheck.finished_at,
    observedSnapshotCreatedAt: snapshot.created_at,
    observedStatusCheckId: correlationChecks.statusCheck.id,
    configurationHash
  });
  const merchantBaselineObservations: BaselineObservation[] = [];
  for (const row of merchantBaselineRows) {
    const approvedCount = readMerchantApprovedCount(row.metadata_json);
    if (approvedCount === null) {
      return { correlated: false, reason: "merchant_baseline_unavailable" };
    }
    merchantBaselineObservations.push({
      snapshotId: row.snapshot_id,
      value: approvedCount,
      observedAt: row.observed_at.toISOString(),
      comparable: true,
      configurationHash
    });
  }
  const merchantBaseline = calculateBaseline({
    observations: merchantBaselineObservations,
    minSamples: merchantBaselineMinimumSamples,
    maxSamples: merchantBaselineMaximumSamples
  });
  if (!merchantBaseline || merchantBaseline.status === "learning") {
    return { correlated: false, reason: "merchant_baseline_unavailable" };
  }

  const merchantDecision = detectFeedCatalogDrop({
    currentCount: currentMerchantApprovedCount,
    baselineMedian: merchantBaseline.medianValue,
    percentThreshold: thresholds.percentThreshold,
    absoluteThreshold: thresholds.absoluteThreshold
  });
  if (!merchantDecision.isDrop) {
    return { correlated: false, reason: "merchant_approved_drop_not_confirmed" };
  }

  const mapping = await getCrossSourceProductMatchSummary({
    feedSnapshotId: candidate.first_snapshot_id,
    merchantSnapshotId: candidate.first_snapshot_id
  });
  const mappingEvaluation = evaluateMapping(mapping, currentFeedCount, thresholds);
  if (mappingEvaluation.reason !== "correlated" || !mapping) {
    return { correlated: false, reason: mappingEvaluation.reason };
  }

  const mappingSamples = mapEvidenceSamples(mapping.samples.merchantOnly);
  const evidence = {
    reason: "complete comparable Merchant approved-product decline corroborated feed catalog drop",
    feedBaselineMedian: Number(candidate.baseline_median),
    feedCurrentCount: currentFeedCount,
    feedChangeAbs: feedDecision.changeAbs,
    feedChangePct: feedDecision.changePct,
    merchantApprovedBaseline: merchantBaseline.medianValue,
    merchantApprovedCurrent: currentMerchantApprovedCount,
    merchantApprovedChangeAbs: merchantDecision.changeAbs,
    merchantApprovedChangePct: merchantDecision.changePct,
    merchantBaselineSampleCount: merchantBaseline.sampleCount,
    merchantConfigurationHash: configurationHash,
    mapping: {
      matchedCount: mapping.matchedCount,
      feedOnlyCount: mapping.feedOnlyCount,
      merchantOnlyCount: mapping.merchantOnlyCount,
      ambiguousCount: mapping.ambiguousCount,
      reconciledFeedCount: mapping.matchedCount + mapping.feedOnlyCount,
      identityLoss: {
        matchedMerchantInventory: mapping.matchedCount,
        missingFromFeedCount: mapping.merchantOnlyCount,
        changeAbs: mappingEvaluation.identityDecision.changeAbs,
        changePct: mappingEvaluation.identityDecision.changePct
      }
    },
    thresholds: {
      percentThreshold: thresholds.percentThreshold,
      absoluteThreshold: thresholds.absoluteThreshold
    }
  };
  const event = await client.query<{ id: string }>(
    `
      INSERT INTO incident_events (
        incident_id,
        store_id,
        snapshot_id,
        event_type,
        from_status,
        to_status,
        message,
        metadata_json,
        created_at
      )
      VALUES ($1, $2, $3, 'feed_merchant_correlation_confirmed', $4, $4, $5, $6::jsonb, clock_timestamp())
      ON CONFLICT (incident_id)
      WHERE event_type = 'feed_merchant_correlation_confirmed'
      DO NOTHING
      RETURNING id
    `,
    [
      incidentRow.id,
      incidentRow.store_id,
      candidate.first_snapshot_id,
      incidentRow.status,
      "Complete Merchant Center evidence corroborated the feed catalog drop.",
      JSON.stringify(evidence)
    ]
  );
  if (!event.rows[0]) {
    return { correlated: true, reason: "already_recorded" };
  }

  await client.query(
    `
      UPDATE incidents
      SET confidence_score = GREATEST(COALESCE(confidence_score, 0), $2),
          evidence_json = CASE
            WHEN jsonb_typeof(evidence_json) = 'array' THEN evidence_json || $3::jsonb
            ELSE $3::jsonb
          END,
          updated_at = now()
      WHERE id = $1
    `,
    [
      incidentRow.id,
      correlatedCatalogDropConfidence,
      JSON.stringify([
        "A complete Merchant Center approved-product decline corroborated this feed catalog drop.",
        "The immutable cross-source mapping contained no ambiguous product identities."
      ])
    ]
  );
  await upsertIncidentSignal(client, {
    incidentId: incidentRow.id,
    source: "merchant_center",
    metric: "approved_product_count",
    beforeValue: merchantBaseline.medianValue,
    afterValue: currentMerchantApprovedCount,
    changeAbs: merchantDecision.changeAbs,
    changePct: merchantDecision.changePct
  });
  await upsertIncidentSignal(client, {
    incidentId: incidentRow.id,
    source: "feed_vs_merchant_center",
    metric: "merchant_inventory_missing_from_feed",
    beforeValue: mapping.matchedCount,
    afterValue: mapping.merchantOnlyCount,
    changeAbs: mappingEvaluation.identityDecision.changeAbs,
    changePct: mappingEvaluation.identityDecision.changePct,
    sampleItems: mappingSamples
  });

  return { correlated: true, reason: "correlated" };
}

async function lockCorrelationIncident(
  client: pg.PoolClient,
  incidentId: string,
  candidate: CandidateRow
): Promise<CorrelationIncidentRow | null> {
  const result = await client.query<CorrelationIncidentRow>(
    `
      SELECT id, store_id, status::text
      FROM incidents
      WHERE id = $1
        AND catalog_drop_candidate_id = $2
        AND store_id = $3
        AND type = 'catalog_drop'
        AND baseline_metric_id = $4
        AND baseline_version = $5
        AND baseline_median = $6
        AND configuration_hash = $7
        AND before_value = $8
        AND thresholds_json = $9::jsonb
        AND opened_snapshot_id = $10
      FOR UPDATE
    `,
    [
      incidentId,
      candidate.id,
      candidate.store_id,
      candidate.baseline_metric_id,
      candidate.baseline_version,
      candidate.baseline_median,
      candidate.configuration_hash,
      candidate.before_value,
      JSON.stringify(candidate.thresholds_json),
      candidate.confirmation_snapshot_id
    ]
  );

  return result.rows[0] ?? null;
}

async function lockCorrelationSnapshot(
  client: pg.PoolClient,
  storeId: string,
  snapshotId: string
): Promise<CorrelationSnapshotRow | null> {
  const result = await client.query<CorrelationSnapshotRow>(
    `
      SELECT
        snapshots.id AS snapshot_id,
        snapshots.store_id,
        snapshots.created_at,
        snapshots.status::text AS snapshot_status,
        snapshots.feed_product_count,
        stores.merchant_center_account_id
      FROM snapshots
      JOIN stores ON stores.id = snapshots.store_id
      WHERE snapshots.id = $2
        AND snapshots.store_id = $1
      FOR UPDATE OF snapshots, stores
    `,
    [storeId, snapshotId]
  );

  return result.rows[0] ?? null;
}

async function lockCorrelationSourceChecks(
  client: pg.PoolClient,
  storeId: string,
  snapshotId: string
): Promise<SourceCheckRow[]> {
  const result = await client.query<SourceCheckRow>(
    `
      SELECT id, source::text, check_key, status::text, finished_at, metadata_json
      FROM source_checks
      WHERE snapshot_id = $2
        AND store_id = $1
        AND source IN ('feed', 'merchant_center')
      FOR UPDATE
    `,
    [storeId, snapshotId]
  );

  return result.rows;
}

function getCompleteCorrelationChecks(
  checks: SourceCheckRow[],
  configurationHash: string
): { statusCheck: SourceCheckRow & { finished_at: Date } } | null {
  const feedChecks = checks.filter((check) => check.source === "feed" && check.status === "success");
  const statusChecks = checks.filter((check) =>
    check.source === "merchant_center" &&
    check.status === "success" &&
    readText(check.metadata_json.merchantStatusAggregationVersion) === merchantStatusAggregationVersion &&
    readText(check.metadata_json.merchantCenterConfigurationHash) === configurationHash
  );
  const identityChecks = checks.filter((check) =>
    check.source === "merchant_center" &&
    check.check_key === merchantItemIssuesCheckKey &&
    check.status === "success" &&
    readText(check.metadata_json.merchantItemIssuesVersion) === merchantItemIssuesVersion &&
    readText(check.metadata_json.merchantProductIdentityVersion) === merchantProductIdentityVersion &&
    check.metadata_json.merchantProductIdentityComplete === true &&
    readText(check.metadata_json.merchantItemIssuesConfigurationHash) === configurationHash
  );

  if (
    feedChecks.length !== 1 ||
    statusChecks.length !== 1 ||
    identityChecks.length !== 1
  ) {
    return null;
  }

  const statusCheck = statusChecks[0];
  if (!statusCheck || !isValidDate(statusCheck.finished_at)) return null;

  return { statusCheck: { ...statusCheck, finished_at: statusCheck.finished_at } };
}

async function lockMerchantApprovedBaselineRows(
  client: pg.PoolClient,
  input: {
    storeId: string;
    observedSnapshotId: string;
    observedStatusCheckAt: Date;
    observedSnapshotCreatedAt: Date;
    observedStatusCheckId: string;
    configurationHash: string;
  }
): Promise<MerchantBaselineRow[]> {
  const result = await client.query<MerchantBaselineRow>(
    `
      WITH comparable_observations AS (
        SELECT DISTINCT ON (snapshots.id)
          snapshots.id AS snapshot_id,
          snapshots.created_at AS snapshot_created_at,
          status_check.id AS status_check_id,
          identity_check.id AS identity_check_id,
          status_check.finished_at AS observed_at
        FROM snapshots
        JOIN source_checks AS status_check
          ON status_check.snapshot_id = snapshots.id
         AND status_check.store_id = snapshots.store_id
         AND status_check.source = 'merchant_center'
         AND status_check.status = 'success'
         AND status_check.metadata_json ->> 'merchantStatusAggregationVersion' = $2
         AND status_check.metadata_json ->> 'merchantCenterConfigurationHash' = $3
        JOIN source_checks AS identity_check
          ON identity_check.snapshot_id = snapshots.id
         AND identity_check.store_id = snapshots.store_id
         AND identity_check.source = 'merchant_center'
         AND identity_check.check_key = $4
         AND identity_check.status = 'success'
         AND identity_check.metadata_json ->> 'merchantItemIssuesVersion' = $5
         AND identity_check.metadata_json ->> 'merchantProductIdentityVersion' = $6
         AND identity_check.metadata_json ->> 'merchantItemIssuesConfigurationHash' = $3
         AND identity_check.metadata_json ->> 'merchantProductIdentityComplete' = 'true'
        WHERE snapshots.store_id = $1
          AND snapshots.id <> $7
          AND snapshots.status = 'completed'
          AND status_check.finished_at IS NOT NULL
          AND (status_check.finished_at, snapshots.created_at, status_check.id) <
            ($8::timestamptz, $9::timestamptz, $10::uuid)
        ORDER BY snapshots.id, status_check.finished_at DESC, status_check.id DESC
      ),
      bounded_observations AS (
        SELECT *
        FROM comparable_observations
        ORDER BY observed_at DESC, snapshot_created_at DESC, status_check_id DESC
        LIMIT $11
      )
      SELECT
        snapshots.id AS snapshot_id,
        status_check.finished_at AS observed_at,
        status_check.metadata_json
      FROM bounded_observations
      JOIN snapshots ON snapshots.id = bounded_observations.snapshot_id
      JOIN source_checks AS status_check
        ON status_check.id = bounded_observations.status_check_id
      JOIN source_checks AS identity_check
        ON identity_check.id = bounded_observations.identity_check_id
      ORDER BY
        bounded_observations.observed_at DESC,
        bounded_observations.snapshot_created_at DESC,
        bounded_observations.status_check_id DESC
      FOR SHARE OF snapshots, status_check, identity_check
    `,
    [
      input.storeId,
      merchantStatusAggregationVersion,
      input.configurationHash,
      merchantItemIssuesCheckKey,
      merchantItemIssuesVersion,
      merchantProductIdentityVersion,
      input.observedSnapshotId,
      input.observedStatusCheckAt,
      input.observedSnapshotCreatedAt,
      input.observedStatusCheckId,
      merchantBaselineMaximumSamples
    ]
  );

  return result.rows;
}

function evaluateMapping(
  mapping: CrossSourceProductMatchSummary | null,
  currentFeedCount: number,
  thresholds: { percentThreshold: number; absoluteThreshold: number }
): MappingEvaluation {
  if (!mapping || !mapping.comparable) return { reason: "mapping_incompatible" };
  if (mapping.ambiguousCount > 0) return { reason: "mapping_ambiguous" };
  if (mapping.countsTruncated) return { reason: "mapping_truncated" };
  if (mapping.matchedCount + mapping.feedOnlyCount !== currentFeedCount) {
    return { reason: "mapping_feed_count_mismatch" };
  }
  if (mapping.merchantOnlyCount === 0) {
    return { reason: "mapping_has_no_merchant_only_products" };
  }

  const identityDecision = detectMatchedStorefrontFeedLoss({
    matchedStorefrontCount: mapping.matchedCount,
    missingFromFeedCount: mapping.merchantOnlyCount,
    percentThreshold: thresholds.percentThreshold,
    absoluteThreshold: thresholds.absoluteThreshold
  });
  if (!identityDecision.isDrop) {
    return { reason: "mapping_identity_loss_not_confirmed" };
  }

  return { reason: "correlated", identityDecision };
}

function mapEvidenceSamples(samples: ProductMatchSample[]): Array<{
  stableKey: string | null;
  offerId: string | null;
  title: string | null;
}> {
  return samples.slice(0, maximumEvidenceSamples).map((sample) => {
    const side = sample.merchant ?? sample.feed;
    return {
      stableKey: side?.stableKey ?? null,
      offerId: side?.offerId ?? null,
      title: side?.title ?? null
    };
  });
}

function readCapturedThresholds(
  thresholds: Record<string, unknown> | null | undefined
): { percentThreshold: number; absoluteThreshold: number } | null {
  const percentThreshold = thresholds?.percentThreshold;
  const absoluteThreshold = thresholds?.absoluteThreshold;
  if (
    typeof percentThreshold !== "number" ||
    !Number.isFinite(percentThreshold) ||
    percentThreshold < 0 ||
    percentThreshold > 1 ||
    typeof absoluteThreshold !== "number" ||
    !Number.isSafeInteger(absoluteThreshold) ||
    absoluteThreshold < 1
  ) {
    return null;
  }

  return { percentThreshold, absoluteThreshold };
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readMerchantApprovedCount(metadata: Record<string, unknown>): number | null {
  const counts = metadata.merchantStatusCounts;
  if (!isRecord(counts)) return null;

  const total = readNonNegativeInteger(counts.total);
  const approved = readNonNegativeInteger(counts.approved);
  const pending = readNonNegativeInteger(counts.pending);
  const disapproved = readNonNegativeInteger(counts.disapproved);
  if (
    total === null ||
    approved === null ||
    pending === null ||
    disapproved === null ||
    total !== approved + pending + disapproved
  ) {
    return null;
  }

  return approved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isValidDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}
