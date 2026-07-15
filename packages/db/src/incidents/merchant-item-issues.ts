import { createBaselineConfigHash, type IncidentSeverity, type SourceCheckStatus } from "@eim/core";
import type pg from "pg";
import { createIncidentOpenedAlertDelivery } from "../alerts";
import { getPool, withTransaction } from "../client";
import {
  applyRecoveryTransition,
  type CatalogDropRecoveryResult,
  type RecoveryEvaluation,
  type RecoverableIncidentRow
} from "./recovery";
import { upsertIncidentSignal } from "./signals";

const merchantItemIssuesVersion = "v1";
const merchantItemIssuesRuleVersion = "merchant_item_issues_v1";
const maximumSamples = 20;
const maximumIssueTextLength = 256;

type MerchantItemIssueRecord = {
  code: string;
  severity: string;
  attribute: string;
  reportingContext: string;
};

type MerchantItemIssueProduct = {
  stableKey: string;
  offerId: string | null;
  title: string | null;
  issues: MerchantItemIssueRecord[];
};

type MerchantItemIssuesCheckRow = {
  snapshot_id: string;
  store_id: string;
  account_id: string | null;
  status: SourceCheckStatus | null;
};

type MerchantItemIssuesSourceItemRow = {
  stable_key: string;
  offer_id: string | null;
  title: string | null;
  merchant_issues_json: unknown;
};

type MerchantItemIssueIncidentRow = RecoverableIncidentRow & {
  configuration_hash: string | null;
};

type PendingDebounceRow = {
  id: string;
  first_snapshot_id: string;
  last_snapshot_id: string;
  first_affected_count: number;
};

export type MerchantItemIssuesObservation = {
  snapshotId: string;
  storeId: string;
  status: SourceCheckStatus | null;
  configurationHash: string | null;
  affectedProducts: number;
  issueCount: number;
  criticalProducts: number;
  warningProducts: number;
  issueCodes: Array<{ code: string; count: number }>;
  sampleItems: Array<{
    stableKey: string;
    offerId: string | null;
    title: string | null;
    issueCode: string;
    issueSeverity: string;
    affectedAttribute: string;
    reportingContext: string;
  }>;
};

export type MerchantItemIssuesEvaluation = {
  severity: IncidentSeverity;
  affectedProducts: number;
  issueCount: number;
  criticalProducts: number;
  warningProducts: number;
  issueCodes: Array<{ code: string; count: number }>;
  sampleItems: MerchantItemIssuesObservation["sampleItems"];
  evidence: string[];
  summary: string;
};

export function merchantItemIssuesConfigurationHash(accountId: string): string {
  return createBaselineConfigHash({
    version: merchantItemIssuesRuleVersion,
    accountId
  });
}

export function merchantItemIssuesFingerprint(
  storeId: string,
  configurationHash: string
): string {
  return createBaselineConfigHash({
    version: "merchant_item_issues_debounce_v1",
    storeId,
    configurationHash
  });
}

export function buildMerchantItemIssuesEvaluation(
  products: MerchantItemIssueProduct[]
): MerchantItemIssuesEvaluation {
  const issueCodeCounts = new Map<string, number>();
  const sampleItems: MerchantItemIssuesEvaluation["sampleItems"] = [];
  let issueCount = 0;
  let criticalProducts = 0;

  for (const product of products) {
    if (product.issues.length === 0) continue;

    const hasCriticalIssue = product.issues.some((issue) => isCriticalIssueSeverity(issue.severity));
    if (hasCriticalIssue) criticalProducts += 1;

    for (const issue of product.issues) {
      issueCount += 1;
      issueCodeCounts.set(issue.code, (issueCodeCounts.get(issue.code) ?? 0) + 1);
      if (sampleItems.length < maximumSamples) {
        sampleItems.push({
          stableKey: product.stableKey,
          offerId: product.offerId,
          title: product.title,
          issueCode: issue.code,
          issueSeverity: issue.severity,
          affectedAttribute: issue.attribute,
          reportingContext: issue.reportingContext
        });
      }
    }
  }

  const affectedProducts = products.filter((product) => product.issues.length > 0).length;
  const warningProducts = Math.max(0, affectedProducts - criticalProducts);
  const issueCodes = [...issueCodeCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
    .slice(0, 10);
  const severity: IncidentSeverity = criticalProducts > 0 ? "critical" : "warning";
  const pluralProducts = affectedProducts === 1 ? "product" : "products";
  const pluralIssues = issueCount === 1 ? "issue" : "issues";

  return {
    severity,
    affectedProducts,
    issueCount,
    criticalProducts,
    warningProducts,
    issueCodes,
    sampleItems,
    evidence: [
      `Merchant Center reported ${affectedProducts} ${pluralProducts} with item-level issues.`,
      `Collected ${issueCount} normalized ${pluralIssues} from a complete successful check.`,
      `Products with critical-severity issues: ${criticalProducts}.`,
      `Products with warning-severity issues: ${warningProducts}.`,
      issueCodes.length > 0
        ? `Most common issue codes: ${issueCodes.map((item) => `${item.code} (${item.count})`).join(", ")}.`
        : "No normalized issue codes were available."
    ],
    summary: `Merchant Center reports ${affectedProducts} ${pluralProducts} with ${issueCount} item-level ${pluralIssues}.`
  };
}

export async function createOrUpdateMerchantItemIssuesIncident(
  storeId: string,
  snapshotId: string
): Promise<string | null> {
  return withTransaction(async (client) => {
    await lockMerchantItemIssuesRule(client, storeId);

    const read = await readMerchantItemIssuesObservation(storeId, snapshotId, client, true);
    if (!read || read.observation.status !== "success" || !read.observation.configurationHash) {
      return null;
    }

    const { observation, evaluation } = read;
    const configurationHash = observation.configurationHash;
    if (configurationHash === null) {
      return null;
    }
    const fingerprint = merchantItemIssuesFingerprint(storeId, configurationHash);

    const activeIncident = await getActiveMerchantItemIssuesIncident(
      client,
      storeId,
      configurationHash
    );

    if (activeIncident && evaluation.affectedProducts > 0) {
      await updateMerchantItemIssuesIncident(client, activeIncident.id, snapshotId, evaluation);
      return activeIncident.id;
    }

    if (evaluation.affectedProducts === 0) {
      await dismissPendingMerchantItemIssuesCandidate(client, fingerprint, snapshotId);
      return null;
    }

    const candidate = await getPendingMerchantItemIssuesCandidate(client, fingerprint);

    if (!candidate) {
      await insertMerchantItemIssuesCandidate(
        client,
        storeId,
        snapshotId,
        fingerprint,
        configurationHash,
        evaluation
      );
      return null;
    }

    if (candidate.last_snapshot_id === snapshotId) {
      return null;
    }

    await client.query(
      `
        UPDATE incident_debounce_candidates
        SET last_snapshot_id = $2,
            last_affected_count = $3,
            evidence_json = $4::jsonb,
            updated_at = clock_timestamp()
        WHERE id = $1 AND status = 'pending'
      `,
      [candidate.id, snapshotId, evaluation.affectedProducts, JSON.stringify(evaluation.evidence)]
    );

    const incidentId = await insertMerchantItemIssuesIncident(
      client,
      storeId,
      snapshotId,
      configurationHash,
      candidate.first_affected_count,
      evaluation
    );

    await client.query(
      `
        UPDATE incident_debounce_candidates
        SET status = 'confirmed',
            status_reason = 'consecutive_complete_checks',
            confirmed_incident_id = $2,
            updated_at = clock_timestamp()
        WHERE id = $1 AND status = 'pending'
      `,
      [candidate.id, incidentId]
    );
    await createIncidentOpenedAlertDelivery(client, { incidentId, storeId, snapshotId });

    return incidentId;
  });
}

export async function updateMerchantItemIssuesRecovery(
  storeId: string,
  snapshotId: string
): Promise<CatalogDropRecoveryResult[]> {
  return withTransaction(async (client) => {
    await lockMerchantItemIssuesRule(client, storeId);
    const read = await readMerchantItemIssuesObservation(storeId, snapshotId, client, true);

    if (!read || read.observation.status !== "success" || !read.observation.configurationHash) {
      return [];
    }

    const { observation } = read;

    const incidents = await getRecoverableMerchantItemIssuesIncidents(storeId, client);
    const results: CatalogDropRecoveryResult[] = [];

    for (const incident of incidents) {
      const comparable = incident.configuration_hash === observation.configurationHash;
      const evaluation: RecoveryEvaluation = {
        comparable,
        healthy: comparable && observation.affectedProducts === 0,
        reason: comparable
          ? observation.affectedProducts === 0
            ? "complete Merchant Center issue check contains no affected products"
            : "Merchant Center item-level issues returned during recovery"
          : "Merchant Center account configuration changed since incident detection",
        evidence: {
          configurationHash: observation.configurationHash,
          incidentConfigurationHash: incident.configuration_hash,
          affectedProducts: observation.affectedProducts,
          issueCount: observation.issueCount,
          criticalProducts: observation.criticalProducts,
          warningProducts: observation.warningProducts
        }
      };

      results.push(
        await applyRecoveryTransition(client, {
          incident,
          snapshotId,
          evaluation,
          eventPrefix: "merchant_item_issues",
          recoveringMessage: "Merchant Center item issues entered recovering after one complete healthy check.",
          resolvedMessage: "Merchant Center item issues resolved after a second consecutive healthy check.",
          reopenedMessage: "Merchant Center item issues returned during recovery."
        })
      );
    }

    return results;
  });
}

export async function getMerchantItemIssuesObservation(
  storeId: string,
  snapshotId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<MerchantItemIssuesObservation | null> {
  const read = await readMerchantItemIssuesObservation(storeId, snapshotId, executor, false);
  return read?.observation ?? null;
}

async function readMerchantItemIssuesObservation(
  storeId: string,
  snapshotId: string,
  executor: pg.Pool | pg.PoolClient,
  lockSourceCheck: boolean
): Promise<{
  observation: MerchantItemIssuesObservation;
  evaluation: MerchantItemIssuesEvaluation;
} | null> {
  const lockClause = lockSourceCheck ? "\n      FOR UPDATE OF source_checks" : "";
  const checkResult = await executor.query<MerchantItemIssuesCheckRow>(
    `
      SELECT
        snapshots.id AS snapshot_id,
        snapshots.store_id,
        stores.merchant_center_account_id AS account_id,
        source_checks.status
      FROM snapshots
      JOIN stores ON stores.id = snapshots.store_id
      JOIN source_checks
        ON source_checks.snapshot_id = snapshots.id
       AND source_checks.store_id = snapshots.store_id
       AND source_checks.source = 'merchant_center'
       AND source_checks.metadata_json ->> 'merchantItemIssuesVersion' = $3
      WHERE snapshots.id = $2 AND snapshots.store_id = $1
      LIMIT 1${lockClause}
    `,
    [storeId, snapshotId, merchantItemIssuesVersion]
  );
  const check = checkResult.rows[0];

  if (!check) return null;

  const configurationHash = check.account_id
    ? merchantItemIssuesConfigurationHash(check.account_id)
    : null;
  const products = await getMerchantItemIssueProducts(storeId, snapshotId, executor);
  const evaluation = buildMerchantItemIssuesEvaluation(products);

  return {
    observation: {
      snapshotId: check.snapshot_id,
      storeId: check.store_id,
      status: check.status,
      configurationHash,
      affectedProducts: evaluation.affectedProducts,
      issueCount: evaluation.issueCount,
      criticalProducts: evaluation.criticalProducts,
      warningProducts: evaluation.warningProducts,
      issueCodes: evaluation.issueCodes,
      sampleItems: evaluation.sampleItems
    },
    evaluation
  };
}

async function lockMerchantItemIssuesRule(
  client: pg.PoolClient,
  storeId: string
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `merchant_item_issues_rule:${storeId}`
  ]);
}

async function getMerchantItemIssueProducts(
  storeId: string,
  snapshotId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<MerchantItemIssueProduct[]> {
  const result = await executor.query<MerchantItemIssuesSourceItemRow>(
    `
      SELECT stable_key, offer_id, title, merchant_issues_json
      FROM source_items
      WHERE store_id = $1
        AND snapshot_id = $2
        AND source = 'merchant_center'
        AND metadata_json ->> 'merchantDataKind' = 'item_issues'
      ORDER BY stable_key ASC
    `,
    [storeId, snapshotId]
  );

  return result.rows.map((row) => ({
    stableKey: row.stable_key,
    offerId: boundedText(row.offer_id),
    title: boundedText(row.title),
    issues: readIssueRecords(row.merchant_issues_json)
  }));
}

async function getActiveMerchantItemIssuesIncident(
  client: pg.PoolClient,
  storeId: string,
  configurationHash: string
): Promise<MerchantItemIssueIncidentRow | null> {
  const result = await client.query<MerchantItemIssueIncidentRow>(
    `
      SELECT id, store_id, status, configuration_hash
      FROM incidents
      WHERE store_id = $1
        AND type = 'merchant_item_issues'
        AND configuration_hash = $2
        AND status IN ('open', 'investigating', 'acknowledged', 'recovering')
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [storeId, configurationHash]
  );
  return result.rows[0] ?? null;
}

async function getRecoverableMerchantItemIssuesIncidents(
  storeId: string,
  client: pg.PoolClient
): Promise<Array<MerchantItemIssueIncidentRow>> {
  const result = await client.query<MerchantItemIssueIncidentRow>(
    `
      SELECT id, store_id, status, configuration_hash
      FROM incidents
      WHERE store_id = $1
        AND type = 'merchant_item_issues'
        AND status IN ('open', 'investigating', 'acknowledged', 'recovering')
      ORDER BY last_seen_at DESC
      FOR UPDATE
    `,
    [storeId]
  );
  return result.rows;
}

async function getPendingMerchantItemIssuesCandidate(
  client: pg.PoolClient,
  fingerprint: string
): Promise<PendingDebounceRow | null> {
  const result = await client.query<PendingDebounceRow>(
    `
      SELECT id, first_snapshot_id, last_snapshot_id, first_affected_count
      FROM incident_debounce_candidates
      WHERE fingerprint = $1 AND status = 'pending'
      FOR UPDATE
    `,
    [fingerprint]
  );
  return result.rows[0] ?? null;
}

async function insertMerchantItemIssuesCandidate(
  client: pg.PoolClient,
  storeId: string,
  snapshotId: string,
  fingerprint: string,
  configurationHash: string,
  evaluation: MerchantItemIssuesEvaluation
): Promise<void> {
  await client.query(
    `
      INSERT INTO incident_debounce_candidates (
        store_id, type, scope_key, configuration_hash, fingerprint,
        first_snapshot_id, last_snapshot_id, first_affected_count, last_affected_count,
        status, evidence_json, thresholds_json
      )
      VALUES (
        $1, 'merchant_item_issues', 'merchant_center.item_level_issues', $2, $3,
        $4, $4, $5, $5, 'pending', $6::jsonb, $7::jsonb
      )
      ON CONFLICT (fingerprint) WHERE status = 'pending' DO NOTHING
    `,
    [
      storeId,
      configurationHash,
      fingerprint,
      snapshotId,
      evaluation.affectedProducts,
      JSON.stringify(evaluation.evidence),
      JSON.stringify(merchantItemIssuesThresholds())
    ]
  );
}

async function dismissPendingMerchantItemIssuesCandidate(
  client: pg.PoolClient,
  fingerprint: string,
  snapshotId: string
): Promise<void> {
  await client.query(
    `
      UPDATE incident_debounce_candidates
      SET status = 'dismissed',
          status_reason = 'complete_healthy_check',
          last_snapshot_id = $2,
          updated_at = clock_timestamp()
      WHERE fingerprint = $1 AND status = 'pending'
    `,
    [fingerprint, snapshotId]
  );
}

async function insertMerchantItemIssuesIncident(
  client: pg.PoolClient,
  storeId: string,
  snapshotId: string,
  configurationHash: string,
  previousAffectedProducts: number,
  evaluation: MerchantItemIssuesEvaluation
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO incidents (
        store_id, opened_snapshot_id, severity, type, title, summary, likely_source,
        confidence_score, evidence_json, affected_count, configuration_hash,
        before_value, after_value, thresholds_json, first_detected_at, last_seen_at, status
      )
      VALUES (
        $1, $2, $3::incident_severity, 'merchant_item_issues',
        'Merchant Center item-level issues', $4, 'merchant_center',
        0.9, $5::jsonb, $6, $7, $8, $9, $10::jsonb, clock_timestamp(), clock_timestamp(), 'open'
      )
      RETURNING id
    `,
    [
      storeId,
      snapshotId,
      evaluation.severity,
      evaluation.summary,
      JSON.stringify(evaluation.evidence),
      evaluation.affectedProducts,
      configurationHash,
      previousAffectedProducts,
      evaluation.affectedProducts,
      JSON.stringify(merchantItemIssuesThresholds())
    ]
  );
  const incidentId = result.rows[0].id;

  await upsertMerchantItemIssuesSignal(
    client,
    incidentId,
    previousAffectedProducts,
    evaluation
  );

  return incidentId;
}

async function updateMerchantItemIssuesIncident(
  client: pg.PoolClient,
  incidentId: string,
  snapshotId: string,
  evaluation: MerchantItemIssuesEvaluation
): Promise<void> {
  await client.query(
    `
      UPDATE incidents
      SET opened_snapshot_id = $2,
          severity = $3::incident_severity,
          summary = $4,
          evidence_json = $5::jsonb,
          affected_count = $6,
          after_value = $7,
          last_seen_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE id = $1
    `,
    [
      incidentId,
      snapshotId,
      evaluation.severity,
      evaluation.summary,
      JSON.stringify(evaluation.evidence),
      evaluation.affectedProducts,
      evaluation.issueCount
    ]
  );

  await upsertMerchantItemIssuesSignal(client, incidentId, null, evaluation);
}

async function upsertMerchantItemIssuesSignal(
  client: pg.PoolClient,
  incidentId: string,
  beforeAffectedProducts: number | null,
  evaluation: MerchantItemIssuesEvaluation
): Promise<void> {
  const changeAbs =
    beforeAffectedProducts === null ? null : evaluation.affectedProducts - beforeAffectedProducts;
  const changePct =
    beforeAffectedProducts && beforeAffectedProducts > 0 && changeAbs !== null
      ? changeAbs / beforeAffectedProducts
      : null;

  await upsertIncidentSignal(client, {
    incidentId,
    source: "merchant_center",
    metric: "item_level_issues",
    beforeValue: beforeAffectedProducts,
    afterValue: evaluation.affectedProducts,
    changeAbs,
    changePct,
    sampleItems: evaluation.sampleItems
  });
}

function merchantItemIssuesThresholds(): Record<string, unknown> {
  return {
    ruleVersion: merchantItemIssuesRuleVersion,
    confirmation: "two_consecutive_complete_successful_checks",
    severityPolicy: "critical_when_any_issue_is_critical_or_error"
  };
}

function readIssueRecords(value: unknown): MerchantItemIssueRecord[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const code = boundedText(item.code);
    if (!code) return [];
    return [
      {
        code,
        severity: boundedText(item.severity) ?? "unknown",
        attribute: boundedText(item.attribute) ?? "unknown",
        reportingContext: boundedText(item.reportingContext) ?? "unknown"
      }
    ];
  });
}

function isCriticalIssueSeverity(value: string): boolean {
  return ["critical", "error", "disapproved", "severe"].includes(value.toLowerCase());
}

function boundedText(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximumIssueTextLength)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
