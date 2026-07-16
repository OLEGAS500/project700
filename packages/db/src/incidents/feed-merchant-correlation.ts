import {
  calculateBaseline,
  detectFeedCatalogDrop,
  type BaselineObservation,
  type SourceCheckStatus
} from "@eim/core";
import type pg from "pg";
import {
  getCrossSourceProductMatchSummary,
  type CrossSourceProductMatchSummary,
  type ProductMatchSample
} from "../dashboard/cross-source-product-mapping";
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
  source: string;
  check_key: string;
  status: SourceCheckStatus;
  metadata_json: Record<string, unknown>;
};

type MerchantBaselineRow = {
  snapshot_id: string;
  observed_at: Date;
  metadata_json: Record<string, unknown>;
};

export type FeedMerchantCorrelationInput = {
  incidentId: string;
  storeId: string;
  observedSnapshotId: string;
  feedBaselineMedian: number;
  thresholds: Record<string, unknown> | null | undefined;
};

export type FeedMerchantCorrelationResult = {
  correlated: boolean;
  reason:
    | "correlated"
    | "already_recorded"
    | "incident_unavailable"
    | "captured_thresholds_invalid"
    | "snapshot_or_configuration_unavailable"
    | "source_checks_incomplete"
    | "merchant_baseline_unavailable"
    | "merchant_approved_drop_not_confirmed"
    | "mapping_incompatible"
    | "mapping_ambiguous"
    | "mapping_truncated"
    | "mapping_has_no_merchant_only_products"
    | "feed_drop_not_confirmed";
};

export async function applyFeedMerchantCorrelation(
  client: pg.PoolClient,
  input: FeedMerchantCorrelationInput
): Promise<FeedMerchantCorrelationResult> {
  const thresholds = readCapturedThresholds(input.thresholds);
  if (!thresholds) {
    return { correlated: false, reason: "captured_thresholds_invalid" };
  }

  const snapshot = await lockCorrelationSnapshot(client, input.storeId, input.observedSnapshotId);
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
    input.storeId,
    input.observedSnapshotId
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
    baselineMedian: input.feedBaselineMedian,
    percentThreshold: thresholds.percentThreshold,
    absoluteThreshold: thresholds.absoluteThreshold
  });
  if (!feedDecision.isDrop) {
    return { correlated: false, reason: "feed_drop_not_confirmed" };
  }

  const merchantBaselineRows = await lockMerchantApprovedBaselineRows(client, {
    storeId: input.storeId,
    observedSnapshotId: input.observedSnapshotId,
    observedAt: snapshot.created_at,
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
    feedSnapshotId: input.observedSnapshotId,
    merchantSnapshotId: input.observedSnapshotId
  });
  const mappingDecision = evaluateMapping(mapping);
  if (mappingDecision !== "correlated" || !mapping) {
    return { correlated: false, reason: mappingDecision };
  }

  const incident = await client.query<{
    id: string;
    store_id: string;
    status: "open" | "investigating" | "acknowledged" | "recovering" | "resolved" | "ignored";
  }>(
    `
      SELECT id, store_id, status
      FROM incidents
      WHERE id = $1
        AND store_id = $2
        AND type = 'catalog_drop'
      FOR UPDATE
    `,
    [input.incidentId, input.storeId]
  );
  const incidentRow = incident.rows[0];
  if (!incidentRow || incidentRow.status === "ignored" || incidentRow.status === "resolved") {
    return { correlated: false, reason: "incident_unavailable" };
  }

  const mappingSamples = mapEvidenceSamples(mapping.samples.merchantOnly);
  const evidence = {
    reason: "complete comparable Merchant approved-product decline corroborated feed catalog drop",
    feedBaselineMedian: input.feedBaselineMedian,
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
      ambiguousCount: mapping.ambiguousCount
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
      ON CONFLICT (incident_id, event_type, snapshot_id)
      WHERE snapshot_id IS NOT NULL
      DO NOTHING
      RETURNING id
    `,
    [
      incidentRow.id,
      incidentRow.store_id,
      input.observedSnapshotId,
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
    beforeValue: mapping.matchedCount + mapping.merchantOnlyCount,
    afterValue: mapping.merchantOnlyCount,
    changeAbs: mapping.merchantOnlyCount,
    changePct:
      mapping.matchedCount + mapping.merchantOnlyCount === 0
        ? 0
        : mapping.merchantOnlyCount / (mapping.matchedCount + mapping.merchantOnlyCount),
    sampleItems: mappingSamples
  });

  return { correlated: true, reason: "correlated" };
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
      SELECT source::text, check_key, status::text, metadata_json
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
): { statusCheck: SourceCheckRow } | null {
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

  if (feedChecks.length !== 1 || statusChecks.length !== 1 || identityChecks.length !== 1) {
    return null;
  }

  return { statusCheck: statusChecks[0] };
}

async function lockMerchantApprovedBaselineRows(
  client: pg.PoolClient,
  input: {
    storeId: string;
    observedSnapshotId: string;
    observedAt: Date;
    configurationHash: string;
  }
): Promise<MerchantBaselineRow[]> {
  const result = await client.query<MerchantBaselineRow>(
    `
      SELECT
        snapshots.id AS snapshot_id,
        COALESCE(snapshots.finished_at, snapshots.created_at) AS observed_at,
        status_check.metadata_json
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
        AND (snapshots.created_at, snapshots.id) < ($8::timestamptz, $7::uuid)
      ORDER BY snapshots.created_at DESC, snapshots.id DESC
      LIMIT $9
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
      input.observedAt,
      merchantBaselineMaximumSamples
    ]
  );

  return result.rows;
}

function evaluateMapping(
  mapping: CrossSourceProductMatchSummary | null
): FeedMerchantCorrelationResult["reason"] {
  if (!mapping || !mapping.comparable) return "mapping_incompatible";
  if (mapping.ambiguousCount > 0) return "mapping_ambiguous";
  if (mapping.countsTruncated) return "mapping_truncated";
  if (mapping.merchantOnlyCount === 0) return "mapping_has_no_merchant_only_products";
  return "correlated";
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
