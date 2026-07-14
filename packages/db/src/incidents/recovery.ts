import { createHash } from "node:crypto";
import {
  createBaselineConfigHash,
  detectFeedCatalogDrop,
  detectMatchedStorefrontFeedLoss
} from "@eim/core";
import type pg from "pg";
import { createAlertDeliveriesForIncidentEvent } from "../alerts";
import { isInsideActiveBaselineGuardrails } from "../baselines";
import { getPool, withTransaction } from "../client";
import {
  evaluatePriceAvailabilitySignals,
  type PriceAvailabilityMatchRow
} from "./price-availability";

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

type SeoSampleManifest = {
  sampleStrategy?: string;
  selectedCount?: number;
  selectedUrlsHash?: string;
  productPageParserVersion?: string;
  normalizationVersion?: string;
  schemaValidationVersion?: string;
  selectedUrls?: string[];
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

type SeoSignalMetric = "noindex" | "canonical_away" | "schema_missing" | "http_error";

type SeoSignalEvaluation = {
  metric: SeoSignalMetric;
  beforeValue: number;
  afterValue: number;
  changeAbs: number;
  changePct: number;
};

type CatalogDropIncidentRow = {
  id: string;
  store_id: string;
  baseline_metric_id: string | null;
  baseline_version: number | null;
  baseline_median: string | null;
  configuration_hash: string | null;
  thresholds_json: {
    percentThreshold?: number;
    absoluteThreshold?: number;
  } | null;
  status: "open" | "investigating" | "acknowledged" | "recovering" | "resolved" | "ignored";
};

export type RecoverableIncidentRow = {
  id: string;
  store_id: string;
  status: "open" | "investigating" | "acknowledged" | "recovering" | "resolved" | "ignored";
};

type SourceDivergenceIncidentRow = RecoverableIncidentRow & {
  configuration_hash: string | null;
  thresholds_json: {
    absoluteThreshold?: number;
    percentThreshold?: number;
    matchMethods?: string[];
    matchingVersion?: string;
    normalizationVersion?: string;
  } | null;
};

type SeoRegressionIncidentRow = RecoverableIncidentRow & {
  opened_snapshot_id: string | null;
  configuration_hash: string | null;
  thresholds_json: {
    seoCoverageMinimum?: number;
  } | null;
};

type PriceAvailabilityIncidentRow = RecoverableIncidentRow & {
  configuration_hash: string | null;
  thresholds_json: {
    minimumAffectedCount?: number;
    minimumAffectedRatio?: number;
    minimumComparableMatches?: number;
    priceTolerance?: { absolute: number; relative: number };
    allowedMatchMethods?: Array<"offer_id" | "normalized_url" | "canonical_url">;
    matchingVersion?: string;
    priceNormalizationVersion?: string;
    availabilityNormalizationVersion?: string;
    currencyRules?: string;
  } | null;
};

export type RecoveryEvaluation = {
  comparable: boolean;
  healthy: boolean;
  reason: string;
  evidence: Record<string, unknown>;
};

type BaselineRow = {
  id: string;
  baseline_version: number;
  configuration_hash: string;
  median_value: string;
  status: "learning" | "ready_for_confirmation" | "active" | "stale" | "relearning";
};

export type CatalogDropRecoveryTransition =
  | "recovering_started"
  | "resolved"
  | "reopened"
  | "no_change";

export type CatalogDropRecoveryResult = {
  incidentId: string;
  status: CatalogDropIncidentRow["status"];
  transition: CatalogDropRecoveryTransition;
};

export async function updateCatalogDropRecovery(
  storeId: string,
  snapshotId: string
): Promise<CatalogDropRecoveryResult[]> {
  return withTransaction(async (client) => {
    const snapshot = await getSnapshotFeedRow(storeId, snapshotId, client);

    if (
      !snapshot ||
      snapshot.baseline_role === "confirmation_check" ||
      snapshot.feed_check_status !== "success" ||
      snapshot.feed_product_count === null
    ) {
      return [];
    }

    const incidents = await getRecoverableCatalogDropIncidents(storeId, client);
    const results: CatalogDropRecoveryResult[] = [];

    for (const incident of incidents) {
      const evaluation = await evaluateCatalogDropRecovery(incident, snapshot, client);

      if (!evaluation.comparable) {
        continue;
      }

      results.push(
        await applyRecoveryTransition(client, {
          incident,
          snapshotId: snapshot.snapshot_id,
          evaluation,
          eventPrefix: "catalog_drop",
          recoveringMessage: "Catalog-drop incident entered recovering after one healthy feed check.",
          resolvedMessage: "Catalog-drop incident resolved after a second consecutive healthy feed check.",
          reopenedMessage: "Catalog-drop recovery reset because the drop returned during recovery."
        })
      );
    }

    return results;
  });
}

export async function updateSourceDivergenceRecovery(
  storeId: string,
  snapshotId: string
): Promise<CatalogDropRecoveryResult[]> {
  return withTransaction(async (client) => {
    const context = await getSourceDivergenceContext(storeId, snapshotId, client);

    if (!context) {
      return [];
    }

    const incidents = await getRecoverableSourceDivergenceIncidents(storeId, client);
    const results: CatalogDropRecoveryResult[] = [];

    for (const incident of incidents) {
      const evaluation = evaluateSourceDivergenceRecovery(incident, context);

      if (!evaluation.comparable) {
        continue;
      }

      results.push(
        await applyRecoveryTransition(client, {
          incident,
          snapshotId,
          evaluation,
          eventPrefix: "source_divergence",
          recoveringMessage: "Source-divergence incident entered recovering after one healthy matched-source check.",
          resolvedMessage: "Source-divergence incident resolved after a second consecutive healthy matched-source check.",
          reopenedMessage: "Source-divergence recovery reset because matched storefront products are missing from the feed again."
        })
      );
    }

    return results;
  });
}

export async function updateSeoRegressionRecovery(
  storeId: string,
  snapshotId: string
): Promise<CatalogDropRecoveryResult[]> {
  return withTransaction(async (client) => {
    const current = await getSeoSnapshotContext(storeId, snapshotId, client);

    if (!current) {
      return [];
    }

    const incidents = await getRecoverableSeoRegressionIncidents(storeId, client);
    const results: CatalogDropRecoveryResult[] = [];

    for (const incident of incidents) {
      const evaluation = await evaluateSeoRegressionRecovery(incident, current, client);

      if (!evaluation.comparable) {
        continue;
      }

      results.push(
        await applyRecoveryTransition(client, {
          incident,
          snapshotId,
          evaluation,
          eventPrefix: "seo_regression",
          recoveringMessage: "SEO-regression incident entered recovering after one healthy comparable product-page sample.",
          resolvedMessage: "SEO-regression incident resolved after a second consecutive healthy comparable product-page sample.",
          reopenedMessage: "SEO-regression recovery reset because grouped SEO regression signals returned."
        })
      );
    }

    return results;
  });
}

export async function updatePriceAvailabilityRecovery(
  storeId: string,
  snapshotId: string
): Promise<CatalogDropRecoveryResult[]> {
  return withTransaction(async (client) => {
    const incidents = await getRecoverablePriceAvailabilityIncidents(storeId, client);
    const results: CatalogDropRecoveryResult[] = [];

    for (const incident of incidents) {
      const evaluation = await evaluatePriceAvailabilityRecovery(
        incident,
        snapshotId,
        client
      );

      if (!evaluation.comparable) {
        continue;
      }

      results.push(
        await applyRecoveryTransition(client, {
          incident,
          snapshotId,
          evaluation,
          eventPrefix: "price_availability",
          recoveringMessage: "Product-data mismatch entered recovering after one healthy comparable product-data check.",
          resolvedMessage: "Product-data mismatch resolved after a second consecutive healthy comparable product-data check.",
          reopenedMessage: "Product-data mismatch recovery reset because grouped price or availability signals returned."
        })
      );
    }

    return results;
  });
}

async function evaluateCatalogDropRecovery(
  incident: CatalogDropIncidentRow,
  snapshot: SnapshotFeedRow,
  client: pg.PoolClient
): Promise<RecoveryEvaluation> {
  if (!incident.baseline_metric_id || !incident.configuration_hash || incident.baseline_median === null) {
    return {
      comparable: false,
      healthy: false,
      reason: "incident is missing baseline recovery context",
      evidence: {}
    };
  }

  const baseline = await getActiveIncidentBaseline(incident, client);

  if (!baseline) {
    return {
      comparable: false,
      healthy: false,
      reason: "active incident baseline is unavailable or stale",
      evidence: {
        baselineMetricId: incident.baseline_metric_id,
        baselineVersion: incident.baseline_version,
        configurationHash: incident.configuration_hash
      }
    };
  }

  const snapshotConfigHash = createFeedConfigHash(snapshot.feed_url);

  if (snapshotConfigHash !== incident.configuration_hash) {
    return {
      comparable: false,
      healthy: false,
      reason: "snapshot feed configuration does not match incident configuration",
      evidence: {
        snapshotConfigurationHash: snapshotConfigHash,
        incidentConfigurationHash: incident.configuration_hash
      }
    };
  }

  const currentCount = Number(snapshot.feed_product_count);
  const baselineMedian = Number(baseline.median_value);
  const evidence = {
    observedValue: currentCount,
    baselineValue: baselineMedian,
    baselineVersion: baseline.baseline_version,
    configurationHash: incident.configuration_hash
  };

  if (isInsideActiveBaselineGuardrails(currentCount, baselineMedian)) {
    return {
      comparable: true,
      healthy: true,
      reason: "feed product count is inside active baseline guardrails",
      evidence
    };
  }

  const decision = detectFeedCatalogDrop({
    currentCount,
    baselineMedian: Number(incident.baseline_median),
    percentThreshold: Number(incident.thresholds_json?.percentThreshold ?? 0.2),
    absoluteThreshold: Number(incident.thresholds_json?.absoluteThreshold ?? 20)
  });

  if (decision.isDrop) {
    return {
      comparable: true,
      healthy: false,
      reason: "catalog drop returned during recovery",
      evidence: {
        ...evidence,
        changeAbs: decision.changeAbs,
        changePct: decision.changePct
      }
    };
  }

  return {
    comparable: false,
    healthy: false,
    reason: "feed product count is outside guardrails but below catalog-drop threshold",
    evidence
  };
}

async function getRecoverableCatalogDropIncidents(
  storeId: string,
  client: pg.PoolClient
): Promise<CatalogDropIncidentRow[]> {
  const result = await client.query<CatalogDropIncidentRow>(
    `
      SELECT id,
             store_id,
             baseline_metric_id,
             baseline_version,
             baseline_median,
             configuration_hash,
             thresholds_json,
             status
      FROM incidents
      WHERE store_id = $1
        AND type = 'catalog_drop'
        AND status IN ('open', 'investigating', 'acknowledged', 'recovering')
      ORDER BY last_seen_at DESC
      FOR UPDATE
    `,
    [storeId]
  );

  return result.rows;
}

async function getRecoverableSourceDivergenceIncidents(
  storeId: string,
  client: pg.PoolClient
): Promise<SourceDivergenceIncidentRow[]> {
  const result = await client.query<SourceDivergenceIncidentRow>(
    `
      SELECT id, store_id, status, configuration_hash, thresholds_json
      FROM incidents
      WHERE store_id = $1
        AND type = 'source_divergence'
        AND status IN ('open', 'investigating', 'acknowledged', 'recovering')
      ORDER BY last_seen_at DESC
      FOR UPDATE
    `,
    [storeId]
  );

  return result.rows;
}

function evaluateSourceDivergenceRecovery(
  incident: SourceDivergenceIncidentRow,
  context: SourceDivergenceContextRow
): RecoveryEvaluation {
  const configurationHash = createSourceDivergenceConfigHash(context.feed_url);
  const matchedStorefrontCount = Number(context.matched_storefront_count);
  const missingFromFeedCount = Number(context.missing_from_feed_count);
  const missingRatio =
    matchedStorefrontCount === 0 ? 0 : missingFromFeedCount / matchedStorefrontCount;
  const evidence: Record<string, unknown> = {
    matchedStorefrontCount,
    missingFromFeedCount,
    missingRatio,
    configurationHash
  };

  if (incident.configuration_hash !== configurationHash) {
    return {
      comparable: false,
      healthy: false,
      reason: "source-divergence recovery configuration does not match incident configuration",
      evidence: {
        ...evidence,
        incidentConfigurationHash: incident.configuration_hash
      }
    };
  }

  if (
    context.feed_check_status !== "success" ||
    Number(context.category_check_count) === 0 ||
    context.all_category_checks_success !== true ||
    matchedStorefrontCount === 0
  ) {
    return {
      comparable: false,
      healthy: false,
      reason: "source-divergence recovery requires successful feed and complete category checks",
      evidence
    };
  }

  const absoluteThreshold = Number(incident.thresholds_json?.absoluteThreshold ?? 20);
  const percentThreshold = Number(incident.thresholds_json?.percentThreshold ?? 0.1);
  const matchMethods = incident.thresholds_json?.matchMethods ?? [
    "normalized_url",
    "canonical_url",
    "offer_id"
  ];
  const decision = detectMatchedStorefrontFeedLoss({
    matchedStorefrontCount,
    missingFromFeedCount,
    absoluteThreshold,
    percentThreshold
  });

  evidence["absoluteThreshold"] = absoluteThreshold;
  evidence["percentThreshold"] = percentThreshold;
  evidence["matchMethods"] = matchMethods;
  evidence["matchingVersion"] = incident.thresholds_json?.matchingVersion ?? "source_matches_v1";

  if (missingFromFeedCount < absoluteThreshold && missingRatio < percentThreshold) {
    return {
      comparable: true,
      healthy: true,
      reason: "matched storefront products missing from feed are below recovery thresholds",
      evidence
    };
  }

  if (decision.isDrop) {
    return {
      comparable: true,
      healthy: false,
      reason: "source divergence returned during recovery",
      evidence: {
        ...evidence,
        changeAbs: decision.changeAbs,
        changePct: decision.changePct
      }
    };
  }

  return {
    comparable: false,
    healthy: false,
    reason: "source divergence is between recovery and incident thresholds",
    evidence
  };
}

async function getRecoverableSeoRegressionIncidents(
  storeId: string,
  client: pg.PoolClient
): Promise<SeoRegressionIncidentRow[]> {
  const result = await client.query<SeoRegressionIncidentRow>(
    `
      SELECT id, store_id, status, opened_snapshot_id, configuration_hash, thresholds_json
      FROM incidents
      WHERE store_id = $1
        AND type = 'seo_regression'
        AND status IN ('open', 'investigating', 'acknowledged', 'recovering')
      ORDER BY last_seen_at DESC
      FOR UPDATE
    `,
    [storeId]
  );

  return result.rows;
}

async function getRecoverablePriceAvailabilityIncidents(
  storeId: string,
  client: pg.PoolClient
): Promise<PriceAvailabilityIncidentRow[]> {
  const result = await client.query<PriceAvailabilityIncidentRow>(
    `
      SELECT id, store_id, status, configuration_hash, thresholds_json
      FROM incidents
      WHERE store_id = $1
        AND type = 'price_availability_mismatch'
        AND status IN ('open', 'investigating', 'acknowledged', 'recovering')
      ORDER BY last_seen_at DESC
      FOR UPDATE
    `,
    [storeId]
  );

  return result.rows;
}

async function evaluatePriceAvailabilityRecovery(
  incident: PriceAvailabilityIncidentRow,
  snapshotId: string,
  client: pg.PoolClient
): Promise<RecoveryEvaluation> {
  const configurationHash = createPriceAvailabilityConfigHash();
  const thresholds = getPriceAvailabilityThresholds(incident);
  const evidenceBase = {
    configurationHash,
    incidentConfigurationHash: incident.configuration_hash,
    priceTolerance: thresholds.priceTolerance,
    minimumAffectedCount: thresholds.minimumAffectedCount,
    minimumAffectedRatio: thresholds.minimumAffectedRatio,
    minimumComparableMatches: thresholds.minimumComparableMatches,
    allowedMatchMethods: thresholds.allowedMatchMethods,
    matchingVersion: thresholds.matchingVersion,
    priceNormalizationVersion: thresholds.priceNormalizationVersion,
    availabilityNormalizationVersion: thresholds.availabilityNormalizationVersion,
    currencyRules: thresholds.currencyRules
  };

  if (incident.configuration_hash !== configurationHash) {
    return {
      comparable: false,
      healthy: false,
      reason: "price/availability recovery configuration does not match incident configuration",
      evidence: evidenceBase
    };
  }

  const rows = await getPriceAvailabilityMatchRows(
    incident.store_id,
    snapshotId,
    thresholds.allowedMatchMethods,
    client
  );

  if (rows.length < thresholds.minimumComparableMatches) {
    return {
      comparable: false,
      healthy: false,
      reason: "price/availability recovery requires enough successful high-confidence comparable matches",
      evidence: {
        ...evidenceBase,
        comparableMatchCount: rows.length
      }
    };
  }

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
  const significant =
    signals.length > 0 &&
    totalAffected >= thresholds.minimumAffectedCount &&
    affectedRatio >= thresholds.minimumAffectedRatio;
  const activeSignalTypes = await getIncidentSignalMetricsBySource(
    incident.id,
    "feed_vs_storefront",
    client
  );
  const unhealthySignalTypes = significant ? signals.map((signal) => signal.metric) : [];
  const unhealthySignalTypeSet = new Set<string>(unhealthySignalTypes);
  const recoveredSignalTypes = activeSignalTypes.filter(
    (metric) => !unhealthySignalTypeSet.has(metric)
  );
  const remainingAffectedCount =
    signals.length === 0 ? 0 : Math.max(...signals.map((signal) => signal.count));
  const evidence = {
    ...evidenceBase,
    comparableMatchCount: rows.length,
    remainingAffectedCount,
    affectedRatio,
    recoveredSignalTypes,
    unhealthySignalTypes
  };

  if (!significant) {
    return {
      comparable: true,
      healthy: true,
      reason: "grouped price/availability mismatches are below recovery thresholds",
      evidence
    };
  }

  return {
    comparable: true,
    healthy: false,
    reason: "price/availability mismatch returned during recovery",
    evidence
  };
}

async function evaluateSeoRegressionRecovery(
  incident: SeoRegressionIncidentRow,
  current: SeoSnapshotContext,
  client: pg.PoolClient
): Promise<RecoveryEvaluation> {
  const currentConfigurationHash = createSeoRegressionConfigHash(current.manifest);
  const evidenceBase = {
    configurationHash: currentConfigurationHash,
    incidentConfigurationHash: incident.configuration_hash,
    sampleManifestHash: createSeoSampleManifestHash(current.manifest),
    parserVersions: {
      productPageParserVersion: current.manifest.productPageParserVersion,
      normalizationVersion: current.manifest.normalizationVersion,
      schemaValidationVersion: current.manifest.schemaValidationVersion
    }
  };

  if (!incident.opened_snapshot_id || incident.configuration_hash !== currentConfigurationHash) {
    return {
      comparable: false,
      healthy: false,
      reason: "SEO recovery configuration does not match incident configuration",
      evidence: evidenceBase
    };
  }

  if (!isSeoSnapshotComparable(current)) {
    return {
      comparable: false,
      healthy: false,
      reason: "current product-page sample is not comparable for SEO recovery",
      evidence: {
        ...evidenceBase,
        comparableChecks: current.comparableChecks,
        failedChecks: current.failedChecks,
        selectedCount: current.manifest.selectedCount
      }
    };
  }

  const opened = await getSeoSnapshotContext(incident.store_id, incident.opened_snapshot_id, client);

  if (!opened || !isSeoSnapshotComparable(opened)) {
    return {
      comparable: false,
      healthy: false,
      reason: "opened SEO-regression snapshot is not comparable",
      evidence: evidenceBase
    };
  }

  const reference = await getPreviousComparableSeoSnapshot(
    incident.store_id,
    opened,
    client
  );

  if (!reference) {
    return {
      comparable: false,
      healthy: false,
      reason: "SEO recovery reference snapshot is unavailable",
      evidence: evidenceBase
    };
  }

  const observations = await getSeoObservationPairs(reference.snapshotId, current.snapshotId, client);

  const seoCoverageMinimum = Number(incident.thresholds_json?.seoCoverageMinimum ?? 0.8);

  if (observations.commonCount < 20 || observations.coverage < seoCoverageMinimum) {
    return {
      comparable: false,
      healthy: false,
      reason: "SEO recovery URL intersection is below coverage gates",
      evidence: {
        ...evidenceBase,
        comparableUrlCount: observations.commonCount,
        coverage: observations.coverage,
        seoCoverageMinimum
      }
    };
  }

  const currentSignals = evaluateSeoSignals(observations.rows);
  const activeSignalTypes = await getIncidentSignalMetricsBySource(
    incident.id,
    "product_page",
    client
  );
  const unhealthySignalTypes = currentSignals.map((signal) => signal.metric);
  const unhealthySignalTypeSet = new Set<string>(unhealthySignalTypes);
  const recoveredSignalTypes = activeSignalTypes.filter(
    (metric) => !unhealthySignalTypeSet.has(metric)
  );
  const remainingAffectedCount = currentSignals.reduce(
    (max, signal) => Math.max(max, signal.changeAbs),
    0
  );
  const evidence = {
    ...evidenceBase,
    comparableUrlCount: observations.commonCount,
    coverage: observations.coverage,
    remainingAffectedCount,
    recoveredSignalTypes,
    unhealthySignalTypes,
    referenceSnapshotId: reference.snapshotId
  };

  if (currentSignals.length === 0) {
    return {
      comparable: true,
      healthy: true,
      reason: "grouped SEO regression signals are below recovery thresholds",
      evidence
    };
  }

  return {
    comparable: true,
    healthy: false,
    reason: "SEO regression signals returned during recovery",
    evidence
  };
}

async function getActiveIncidentBaseline(
  incident: CatalogDropIncidentRow,
  client: pg.PoolClient
): Promise<BaselineRow | null> {
  const result = await client.query<BaselineRow>(
    `
      SELECT *
      FROM baseline_metrics
      WHERE id = $1
        AND store_id = $2
        AND baseline_version = $3
        AND configuration_hash = $4
        AND status = 'active'
        AND valid_to IS NULL
      LIMIT 1
    `,
    [
      incident.baseline_metric_id,
      incident.store_id,
      incident.baseline_version,
      incident.configuration_hash
    ]
  );

  return result.rows[0] ?? null;
}

async function getSnapshotFeedRow(
  storeId: string,
  snapshotId: string,
  client: pg.PoolClient
): Promise<SnapshotFeedRow | null> {
  const result = await client.query<SnapshotFeedRow>(
    `
      SELECT
        snapshots.id AS snapshot_id,
        snapshots.store_id,
        snapshots.feed_product_count,
        snapshots.baseline_role,
        snapshots.finished_at,
        COALESCE(source_checks.url, stores.feed_url) AS feed_url,
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

async function getSourceDivergenceContext(
  storeId: string,
  snapshotId: string,
  client: pg.PoolClient
): Promise<SourceDivergenceContextRow | null> {
  const result = await client.query<SourceDivergenceContextRow>(
    `
      SELECT
        snapshots.id AS snapshot_id,
        snapshots.store_id,
        COALESCE(feed_check.url, stores.feed_url) AS feed_url,
        feed_check.status AS feed_check_status,
        COUNT(category_checks.id) AS category_check_count,
        BOOL_AND(category_checks.status = 'success') AS all_category_checks_success,
        (
          SELECT COUNT(DISTINCT storefront_item_id)
          FROM source_matches
          WHERE source_matches.snapshot_id = snapshots.id
            AND source_matches.store_id = snapshots.store_id
            AND source_matches.storefront_item_id IS NOT NULL
            AND source_matches.match_confidence >= 0.9
        ) AS matched_storefront_count,
        (
          SELECT COUNT(DISTINCT storefront_item_id)
          FROM source_matches
          WHERE source_matches.snapshot_id = snapshots.id
            AND source_matches.store_id = snapshots.store_id
            AND source_matches.storefront_item_id IS NOT NULL
            AND source_matches.feed_item_id IS NULL
            AND source_matches.match_confidence >= 0.9
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
      GROUP BY snapshots.id, stores.feed_url, feed_check.url, feed_check.status
      LIMIT 1
    `,
    [storeId, snapshotId]
  );

  return result.rows[0] ?? null;
}

async function getSeoSnapshotContext(
  storeId: string,
  snapshotId: string,
  client: pg.PoolClient
): Promise<SeoSnapshotContext | null> {
  const result = await client.query<{
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
  current: SeoSnapshotContext,
  client: pg.PoolClient
): Promise<SeoSnapshotContext | null> {
  const result = await client.query<{ id: string }>(
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

  return previousId ? getSeoSnapshotContext(storeId, previousId, client) : null;
}

async function getSeoObservationPairs(
  previousSnapshotId: string,
  currentSnapshotId: string,
  client: pg.PoolClient
): Promise<{
  rows: Array<{
    previous: SeoObservationRow;
    current: SeoObservationRow;
  }>;
  commonCount: number;
  coverage: number;
}> {
  const result = await client.query<{
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
  metric: SeoSignalMetric,
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
    changePct: ratio
  };
}

async function getIncidentSignalMetricsBySource(
  incidentId: string,
  source: string,
  client: pg.PoolClient
): Promise<string[]> {
  const result = await client.query<{ metric: string }>(
    `
      SELECT metric
      FROM incident_signals
      WHERE incident_id = $1
        AND source = $2
      ORDER BY metric
    `,
    [incidentId, source]
  );

  return result.rows.map((row) => row.metric);
}

function isHealthyHttp(status: number | null): boolean {
  return typeof status === "number" && status >= 200 && status < 400;
}

function isHttpError(status: number | null): boolean {
  return typeof status === "number" && status >= 400;
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

function createSeoSampleManifestHash(manifest: SeoSampleManifest): string {
  return createHash("sha256")
    .update(JSON.stringify({
      sampleStrategy: manifest.sampleStrategy,
      selectedCount: manifest.selectedCount,
      selectedUrlsHash: manifest.selectedUrlsHash,
      productPageParserVersion: manifest.productPageParserVersion,
      normalizationVersion: manifest.normalizationVersion,
      schemaValidationVersion: manifest.schemaValidationVersion
    }))
    .digest("hex");
}

async function getPriceAvailabilityMatchRows(
  storeId: string,
  snapshotId: string,
  allowedMatchMethods: string[],
  client: pg.PoolClient
): Promise<PriceAvailabilityMatchRow[]> {
  const sourceState = await client.query<{ comparable: boolean }>(
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

  const result = await client.query<PriceAvailabilityMatchRow>(
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
        AND source_matches.match_method = ANY($3::text[])
        AND source_matches.match_confidence >= 0.9
    `,
    [storeId, snapshotId, allowedMatchMethods]
  );

  return result.rows;
}

async function hasIncidentEvent(
  incidentId: string,
  snapshotId: string,
  eventTypes: string[],
  client: pg.PoolClient
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM incident_events
        WHERE incident_id = $1
          AND snapshot_id = $2
          AND event_type = ANY($3::text[])
      ) AS exists
    `,
    [incidentId, snapshotId, eventTypes]
  );

  return result.rows[0]?.exists ?? false;
}

export async function applyRecoveryTransition(
  client: pg.PoolClient,
  input: {
    incident: RecoverableIncidentRow;
    snapshotId: string;
    evaluation: RecoveryEvaluation;
    eventPrefix: string;
    recoveringMessage: string;
    resolvedMessage: string;
    reopenedMessage: string;
  }
): Promise<CatalogDropRecoveryResult> {
  if (!input.evaluation.comparable) {
    return {
      incidentId: input.incident.id,
      status: input.incident.status,
      transition: "no_change"
    };
  }

  const locked = await client.query<RecoverableIncidentRow>(
    "SELECT id, store_id, status FROM incidents WHERE id = $1 FOR UPDATE",
    [input.incident.id]
  );
  const incident = locked.rows[0];

  if (!incident) {
    return {
      incidentId: input.incident.id,
      status: input.incident.status,
      transition: "no_change"
    };
  }

  const healthyEventType = `${input.eventPrefix}_recovery_healthy`;
  const resolvedEventType = `${input.eventPrefix}_resolved`;
  const reopenedEventType = `${input.eventPrefix}_reopened`;

  if (input.evaluation.healthy) {
    const alreadyRecordedForSnapshot = await hasIncidentEvent(
      incident.id,
      input.snapshotId,
      [healthyEventType, resolvedEventType],
      client
    );

    if (alreadyRecordedForSnapshot) {
      return {
        incidentId: incident.id,
        status: incident.status,
        transition: "no_change"
      };
    }

    if (incident.status === "recovering") {
      await client.query(
        `
          UPDATE incidents
          SET status = 'resolved',
              closed_snapshot_id = $2,
              resolved_at = now(),
              updated_at = now()
          WHERE id = $1
        `,
        [incident.id, input.snapshotId]
      );
      const eventId = await insertIncidentEvent(client, {
        incident,
        snapshotId: input.snapshotId,
        eventType: resolvedEventType,
        fromStatus: "recovering",
        toStatus: "resolved",
        message: input.resolvedMessage,
        metadata: {
          reason: input.evaluation.reason,
          ...input.evaluation.evidence
        }
      });
      if (eventId) {
        await createAlertDeliveriesForIncidentEvent(client, {
          incidentId: incident.id,
          eventId,
          alertType: "incident_resolved"
        });
      }

      return {
        incidentId: incident.id,
        status: "resolved",
        transition: "resolved"
      };
    }

    if (["open", "investigating", "acknowledged"].includes(incident.status)) {
      await client.query(
        `
          UPDATE incidents
          SET status = 'recovering',
              updated_at = now()
          WHERE id = $1
        `,
        [incident.id]
      );
      await insertIncidentEvent(client, {
        incident,
        snapshotId: input.snapshotId,
        eventType: healthyEventType,
        fromStatus: incident.status,
        toStatus: "recovering",
        message: input.recoveringMessage,
        metadata: {
          reason: input.evaluation.reason,
          ...input.evaluation.evidence
        }
      });

      return {
        incidentId: incident.id,
        status: "recovering",
        transition: "recovering_started"
      };
    }
  }

  if (!input.evaluation.healthy && incident.status === "recovering") {
    await client.query(
      `
        UPDATE incidents
        SET status = 'open',
            closed_snapshot_id = NULL,
            resolved_at = NULL,
            last_seen_at = now(),
            updated_at = now()
        WHERE id = $1
      `,
      [incident.id]
    );
    const eventId = await insertIncidentEvent(client, {
      incident,
      snapshotId: input.snapshotId,
      eventType: reopenedEventType,
      fromStatus: "recovering",
      toStatus: "open",
      message: input.reopenedMessage,
      metadata: {
        reason: input.evaluation.reason,
        ...input.evaluation.evidence
      }
    });
    if (eventId) {
      await createAlertDeliveriesForIncidentEvent(client, {
        incidentId: incident.id,
        eventId,
        alertType: "incident_worsened"
      });
    }

    return {
      incidentId: incident.id,
      status: "open",
      transition: "reopened"
    };
  }

  return {
    incidentId: incident.id,
    status: incident.status,
    transition: "no_change"
  };
}

export async function insertIncidentEvent(
  client: pg.PoolClient,
  input: {
    incident: RecoverableIncidentRow;
    snapshotId: string;
    eventType: string;
    fromStatus: RecoverableIncidentRow["status"];
    toStatus: RecoverableIncidentRow["status"];
    message: string;
    metadata: Record<string, unknown>;
  }
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())
      ON CONFLICT (incident_id, event_type, snapshot_id)
      WHERE snapshot_id IS NOT NULL
      DO NOTHING
      RETURNING id
    `,
    [
      input.incident.id,
      input.incident.store_id,
      input.snapshotId,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      input.message,
      JSON.stringify(input.metadata)
    ]
  );
  return result.rows[0]?.id ?? null;
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

function getPriceAvailabilityThresholds(
  incident: PriceAvailabilityIncidentRow
): Required<NonNullable<PriceAvailabilityIncidentRow["thresholds_json"]>> & {
  minimumAffectedCount: number;
  minimumAffectedRatio: number;
  minimumComparableMatches: number;
  priceTolerance: { absolute: number; relative: number };
  allowedMatchMethods: Array<"offer_id" | "normalized_url" | "canonical_url">;
  matchingVersion: string;
  priceNormalizationVersion: string;
  availabilityNormalizationVersion: string;
  currencyRules: string;
} {
  return {
    minimumAffectedCount: Number(incident.thresholds_json?.minimumAffectedCount ?? 5),
    minimumAffectedRatio: Number(incident.thresholds_json?.minimumAffectedRatio ?? 0.2),
    minimumComparableMatches: Number(incident.thresholds_json?.minimumComparableMatches ?? 20),
    priceTolerance: incident.thresholds_json?.priceTolerance ?? {
      absolute: 0.02,
      relative: 0.001
    },
    allowedMatchMethods: incident.thresholds_json?.allowedMatchMethods ?? [
      "offer_id",
      "normalized_url",
      "canonical_url"
    ],
    matchingVersion: incident.thresholds_json?.matchingVersion ?? "source_matches_v1",
    priceNormalizationVersion:
      incident.thresholds_json?.priceNormalizationVersion ?? "effective_decimal_price_v1",
    availabilityNormalizationVersion:
      incident.thresholds_json?.availabilityNormalizationVersion ?? "availability_enum_v1",
    currencyRules: incident.thresholds_json?.currencyRules ?? "same_currency_required"
  };
}
