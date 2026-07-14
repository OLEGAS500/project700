import type pg from "pg";

export type CandidateRow = {
  id: string;
  store_id: string;
  type: "catalog_drop";
  scope_key: string;
  baseline_metric_id: string;
  baseline_version: number;
  baseline_median: string;
  configuration_hash: string;
  first_snapshot_id: string;
  confirmation_snapshot_id: string | null;
  before_value: string;
  observed_value: string;
  change_abs: string;
  change_pct: string;
  status: "pending_confirmation" | "confirmed" | "dismissed" | "expired" | "source_failure";
  status_reason: string | null;
  fingerprint: string;
  evidence_json: unknown[];
  thresholds_json: Record<string, unknown>;
  created_at: Date;
  confirmation_due_at: Date;
  expires_at: Date;
  attempt_count: number;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
};

export type CandidateWithExpirationRow = CandidateRow & {
  is_expired: boolean;
};

export type IncidentCandidateRecord = {
  id: string;
  storeId: string;
  type: "catalog_drop";
  scopeKey: string;
  baselineMetricId: string;
  baselineVersion: number;
  baselineMedian: number;
  configurationHash: string;
  firstSnapshotId: string;
  confirmationSnapshotId: string | null;
  beforeValue: number;
  observedValue: number;
  changeAbs: number;
  changePct: number;
  status: CandidateRow["status"];
  statusReason: string | null;
  fingerprint: string;
  evidence: unknown[];
  thresholds: Record<string, unknown>;
  createdAt: string;
  confirmationDueAt: string;
  expiresAt: string;
};

export function buildCatalogDropCandidateFingerprint(
  storeId: string,
  configurationHash: string
): string {
  return [storeId, "catalog_drop", "feed.product_count", configurationHash].join(":");
}

export async function getCandidateForConfirmation(
  client: pg.PoolClient,
  candidateId: string
): Promise<CandidateWithExpirationRow | null> {
  const result = await client.query<CandidateWithExpirationRow>(
    "SELECT *, expires_at <= now() AS is_expired FROM incident_candidates WHERE id = $1 FOR UPDATE",
    [candidateId]
  );

  return result.rows[0] ?? null;
}

export async function upsertCatalogDropCandidate(
  executor: pg.Pool | pg.PoolClient,
  input: {
    storeId: string;
    baselineMetricId: string;
    baselineVersion: number;
    baselineMedian: string;
    configurationHash: string;
    firstSnapshotId: string;
    observedValue: number;
    changeAbs: number;
    changePct: number;
    evidence: unknown[];
    thresholds: Record<string, unknown>;
  }
): Promise<CandidateRow> {
  const fingerprint = buildCatalogDropCandidateFingerprint(
    input.storeId,
    input.configurationHash
  );
  const result = await executor.query<CandidateRow>(
    `
      INSERT INTO incident_candidates (
        store_id,
        type,
        scope_key,
        baseline_metric_id,
        baseline_version,
        baseline_median,
        configuration_hash,
        first_snapshot_id,
        before_value,
        observed_value,
        change_abs,
        change_pct,
        status,
        fingerprint,
        evidence_json,
        thresholds_json,
        confirmation_due_at,
        expires_at
      )
      VALUES (
        $1, 'catalog_drop', 'feed.product_count', $2, $3, $4, $5, $6,
        $7, $8, $9, $10, 'pending_confirmation', $11, $12, $13,
        now() + interval '10 minutes',
        now() + interval '30 minutes'
      )
      ON CONFLICT (fingerprint) WHERE status = 'pending_confirmation'
      DO UPDATE SET
        first_snapshot_id = EXCLUDED.first_snapshot_id,
        observed_value = EXCLUDED.observed_value,
        change_abs = EXCLUDED.change_abs,
        change_pct = EXCLUDED.change_pct,
        evidence_json = EXCLUDED.evidence_json,
        thresholds_json = EXCLUDED.thresholds_json,
        confirmation_due_at = EXCLUDED.confirmation_due_at,
        updated_at = now(),
        expires_at = EXCLUDED.expires_at
      RETURNING *
    `,
    [
      input.storeId,
      input.baselineMetricId,
      input.baselineVersion,
      input.baselineMedian,
      input.configurationHash,
      input.firstSnapshotId,
      input.baselineMedian,
      input.observedValue,
      input.changeAbs,
      input.changePct,
      fingerprint,
      JSON.stringify(input.evidence),
      JSON.stringify(input.thresholds)
    ]
  );

  return result.rows[0];
}

export function mapCandidate(row: CandidateRow): IncidentCandidateRecord {
  return {
    id: row.id,
    storeId: row.store_id,
    type: row.type,
    scopeKey: row.scope_key,
    baselineMetricId: row.baseline_metric_id,
    baselineVersion: row.baseline_version,
    baselineMedian: Number(row.baseline_median),
    configurationHash: row.configuration_hash,
    firstSnapshotId: row.first_snapshot_id,
    confirmationSnapshotId: row.confirmation_snapshot_id,
    beforeValue: Number(row.before_value),
    observedValue: Number(row.observed_value),
    changeAbs: Number(row.change_abs),
    changePct: Number(row.change_pct),
    status: row.status,
    statusReason: row.status_reason,
    fingerprint: row.fingerprint,
    evidence: row.evidence_json,
    thresholds: row.thresholds_json ?? {},
    createdAt: row.created_at.toISOString(),
    confirmationDueAt: row.confirmation_due_at.toISOString(),
    expiresAt: row.expires_at.toISOString()
  };
}
