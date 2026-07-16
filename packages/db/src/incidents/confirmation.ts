import {
  createBaselineConfigHash,
  detectFeedCatalogDrop
} from "@eim/core";
import type pg from "pg";
import { createIncidentOpenedAlertDelivery } from "../alerts";
import { withTransaction } from "../client";
import {
  getCandidateForConfirmation,
  mapCandidate,
  type CandidateRow,
  type IncidentCandidateRecord
} from "./candidates";
import { applyFeedMerchantCorrelation } from "./feed-merchant-correlation";
import { upsertIncidentSignal } from "./signals";

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

export async function confirmFeedCatalogDropCandidate(
  candidateId: string,
  confirmationSnapshotId: string
): Promise<{ candidate: IncidentCandidateRecord; incidentId: string | null }> {
  return withTransaction(async (client) => {
    const candidate = await getCandidateForConfirmation(client, candidateId);

    if (!candidate) {
      throw new Error(`Pending candidate ${candidateId} was not found`);
    }

    if (candidate.status !== "pending_confirmation") {
      return {
        candidate: mapCandidate(candidate),
        incidentId: await findIncidentForCandidate(candidate, client)
      };
    }

    if (candidate.is_expired) {
      const updated = await client.query<CandidateRow>(
        `
          UPDATE incident_candidates
          SET status = 'expired',
              status_reason = 'confirmation_window_expired',
              confirmation_snapshot_id = $2,
              locked_at = NULL,
              locked_by = NULL,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [candidateId, confirmationSnapshotId]
      );
      return { candidate: mapCandidate(updated.rows[0]), incidentId: null };
    }

    const snapshot = await getSnapshotFeedRow(
      candidate.store_id,
      confirmationSnapshotId,
      client
    );
    const activeBaseline = await getActiveFeedBaseline(candidate.store_id, client);
    const snapshotConfigHash = snapshot ? createFeedConfigHash(snapshot.feed_url) : null;

    const configurationInvalidationReason =
      !activeBaseline || activeBaseline.id !== candidate.baseline_metric_id
        ? "baseline_stale_or_replaced"
        : activeBaseline.configuration_hash !== candidate.configuration_hash
          ? "baseline_configuration_changed"
          : snapshotConfigHash !== candidate.configuration_hash
            ? "confirmation_configuration_changed"
            : null;

    if (configurationInvalidationReason) {
      const updated = await client.query<CandidateRow>(
        `
          UPDATE incident_candidates
          SET status = 'expired',
              status_reason = $3,
              confirmation_snapshot_id = $2,
              locked_at = NULL,
              locked_by = NULL,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [candidateId, confirmationSnapshotId, configurationInvalidationReason]
      );
      return { candidate: mapCandidate(updated.rows[0]), incidentId: null };
    }

    if (!snapshot || snapshot.feed_check_status !== "success" || snapshot.feed_product_count === null) {
      const updated = await client.query<CandidateRow>(
        `
          UPDATE incident_candidates
          SET status = 'source_failure',
              status_reason = 'confirmation_source_check_failed',
              confirmation_snapshot_id = $2,
              locked_at = NULL,
              locked_by = NULL,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [candidateId, confirmationSnapshotId]
      );
      return { candidate: mapCandidate(updated.rows[0]), incidentId: null };
    }

    const decision = detectFeedCatalogDrop({
      currentCount: Number(snapshot.feed_product_count),
      baselineMedian: Number(candidate.baseline_median),
      percentThreshold: Number(candidate.thresholds_json?.percentThreshold ?? 0.2),
      absoluteThreshold: Number(candidate.thresholds_json?.absoluteThreshold ?? 20)
    });

    if (!decision.isDrop) {
      const updated = await client.query<CandidateRow>(
        `
          UPDATE incident_candidates
          SET status = 'dismissed',
              status_reason = 'confirmation_recovered',
              confirmation_snapshot_id = $2,
              observed_value = $3,
              change_abs = $4,
              change_pct = $5,
              locked_at = NULL,
              locked_by = NULL,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [candidateId, confirmationSnapshotId, snapshot.feed_product_count, decision.changeAbs, decision.changePct]
      );
      return { candidate: mapCandidate(updated.rows[0]), incidentId: null };
    }

    const incident = await client.query<{ id: string }>(
      `
        INSERT INTO incidents (
          store_id,
          catalog_drop_candidate_id,
          baseline_metric_id,
          baseline_version,
          baseline_median,
          configuration_hash,
          before_value,
          after_value,
          thresholds_json,
          opened_snapshot_id,
          severity,
          type,
          title,
          summary,
          likely_source,
          confidence_score,
          evidence_json,
          affected_count,
          first_detected_at,
          last_seen_at,
          status
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          'critical',
          'catalog_drop',
          'Feed product catalog drop',
          $11,
          'feed',
          0.85,
          $12,
          $13,
          now(),
          now(),
          'open'
        )
        RETURNING id
      `,
      [
        candidate.store_id,
        candidate.id,
        candidate.baseline_metric_id,
        candidate.baseline_version,
        candidate.baseline_median,
        candidate.configuration_hash,
        candidate.before_value,
        snapshot.feed_product_count,
        JSON.stringify(candidate.thresholds_json ?? {}),
        confirmationSnapshotId,
        `Feed product count dropped from ${Number(candidate.baseline_median)} to ${Number(snapshot.feed_product_count)}.`,
        JSON.stringify(candidate.evidence_json ?? []),
        Math.max(0, Number(candidate.baseline_median) - Number(snapshot.feed_product_count))
      ]
    );
    const incidentId = incident.rows[0].id;

    const boundCandidate = await client.query<CandidateRow>(
      `
        UPDATE incident_candidates
        SET confirmation_snapshot_id = $2,
            updated_at = now()
        WHERE id = $1
          AND status = 'pending_confirmation'
        RETURNING *
      `,
      [candidateId, confirmationSnapshotId]
    );
    if (!boundCandidate.rows[0]) {
      throw new Error(`Pending candidate ${candidateId} could not be bound to its incident`);
    }

    await upsertIncidentSignal(client, {
      incidentId,
      source: "feed",
      metric: "product_count",
      beforeValue: candidate.baseline_median,
      afterValue: snapshot.feed_product_count,
      changeAbs: decision.changeAbs,
      changePct: decision.changePct
    });
    await applyFeedMerchantCorrelation(client, {
      incidentId,
      candidateId: candidate.id
    });
    await createIncidentOpenedAlertDelivery(client, {
      incidentId,
      storeId: candidate.store_id,
      snapshotId: confirmationSnapshotId
    });

    const updated = await client.query<CandidateRow>(
      `
        UPDATE incident_candidates
        SET status = 'confirmed',
            status_reason = 'confirmation_matched_drop',
            confirmation_snapshot_id = $2,
            observed_value = $3,
            change_abs = $4,
            change_pct = $5,
            locked_at = NULL,
            locked_by = NULL,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [candidateId, confirmationSnapshotId, snapshot.feed_product_count, decision.changeAbs, decision.changePct]
    );

    return {
      candidate: mapCandidate(updated.rows[0]),
      incidentId
    };
  });
}

async function findIncidentForCandidate(
  candidate: CandidateRow,
  client: pg.PoolClient
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM incidents
      WHERE catalog_drop_candidate_id = $1
         OR (
          catalog_drop_candidate_id IS NULL
          AND store_id = $2
          AND type = 'catalog_drop'
          AND baseline_metric_id = $3
          AND baseline_version = $4
          AND configuration_hash = $5
          AND opened_snapshot_id = $6
        )
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [
      candidate.id,
      candidate.store_id,
      candidate.baseline_metric_id,
      candidate.baseline_version,
      candidate.configuration_hash,
      candidate.confirmation_snapshot_id
    ]
  );

  return result.rows[0]?.id ?? null;
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
  client: pg.PoolClient
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

function createFeedConfigHash(feedUrl: string): string {
  return createBaselineConfigHash({
    source: "feed",
    metric: "product_count",
    feedUrl,
    collectorVersion: "feed_v1",
    normalizationVersion: "product_count_v1"
  });
}
