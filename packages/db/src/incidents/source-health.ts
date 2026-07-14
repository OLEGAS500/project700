import { createBaselineConfigHash } from "@eim/core";
import type pg from "pg";
import { createIncidentOpenedAlertDelivery } from "../alerts";
import { getPool, withTransaction } from "../client";
import { captureSnapshotThresholds } from "../thresholds";
import { applyRecoveryTransition, type RecoverableIncidentRow } from "./recovery";
import { upsertIncidentSignal } from "./signals";

type SnapshotFeedRow = {
  snapshot_id: string;
  store_id: string;
  feed_product_count: number | null;
  baseline_role: string;
  finished_at: Date | null;
  feed_url: string;
  feed_check_status: "success" | "partial" | "timeout" | "blocked" | "authentication_failed" | "parse_failed" | "source_unavailable" | null;
};

type FeedCheckStatus = NonNullable<SnapshotFeedRow["feed_check_status"]>;

type FeedSourceHealthDecision = {
  open: boolean;
  reason: string;
  consecutiveFailures: number;
  previousStatus: FeedCheckStatus | null;
  lastSuccessfulAt: string | null;
  previousSuccessfulCount: number | null;
};

type FeedSourceHealthContextRow = {
  previous_status: FeedCheckStatus | null;
  consecutive_failures: string;
  last_successful_at: Date | null;
  previous_successful_count: number | null;
};

type SourceHealthIncidentRow = RecoverableIncidentRow & {
  configuration_hash: string | null;
};

export async function createOrUpdateFeedSourceHealthIncident(
  storeId: string,
  snapshotId: string
): Promise<string | null> {
  const snapshot = await getSnapshotFeedRow(storeId, snapshotId);

  if (
    !snapshot ||
    snapshot.feed_check_status === null
  ) {
    return null;
  }

  if (snapshot.feed_check_status === "success") {
    return recordFeedSourceHealthRecoveryEvidence(storeId, snapshotId, snapshot.feed_url);
  }

  if (snapshot.feed_check_status === "partial") {
    return null;
  }

  const failureStatus = snapshot.feed_check_status;

  const capturedThresholds = await captureSnapshotThresholds(storeId, snapshotId);
  const sourceHealthDecision = await shouldOpenFeedSourceHealthIncident(
    storeId,
    snapshotId,
    failureStatus,
    snapshot.feed_url,
    capturedThresholds.thresholds.sourceHealthConsecutiveFailures
  );

  if (!sourceHealthDecision.open) {
    return null;
  }

  const configurationHash = createFeedSourceHealthConfigHash(snapshot.feed_url);
  const evidence = [
    `feed source check returned ${snapshot.feed_check_status}`,
    `consecutive failures: ${sourceHealthDecision.consecutiveFailures}`,
    sourceHealthDecision.lastSuccessfulAt
      ? `last successful feed check: ${sourceHealthDecision.lastSuccessfulAt}`
      : "last successful feed check: unknown",
    sourceHealthDecision.reason,
    "no conclusion was made about product availability"
  ];
  return withTransaction(async (client) => {
    const result = await client.query<SourceHealthIncidentRow>(
      `
        WITH existing AS (
          SELECT id
          FROM incidents
          WHERE store_id = $1
            AND type = 'source_health'
            AND status IN ('open', 'investigating', 'acknowledged', 'recovering')
            AND likely_source = 'feed'
            AND configuration_hash = $5
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        ),
        updated AS (
          UPDATE incidents
          SET opened_snapshot_id = $2,
              summary = $3,
              evidence_json = $4,
              affected_count = $6::integer,
              after_value = $6::numeric,
              last_seen_at = now(),
              updated_at = now()
          WHERE id IN (SELECT id FROM existing)
          RETURNING id, store_id, status, configuration_hash
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
          after_value,
          first_detected_at,
          last_seen_at,
          status
          )
          SELECT
            $1,
            $2,
            'warning',
            'source_health',
            'Feed source could not be verified',
            $3,
            'feed',
            0.95,
            $4,
            $7,
            $6::integer,
            $5,
            $6::numeric,
            now(),
            now(),
            'open'
          WHERE NOT EXISTS (SELECT 1 FROM updated)
          RETURNING id, store_id, status, configuration_hash
        )
        SELECT id, store_id, status, configuration_hash FROM updated
        UNION ALL
        SELECT id, store_id, status, configuration_hash FROM inserted
        LIMIT 1
      `,
      [
        storeId,
        snapshotId,
      buildFeedSourceHealthSummary(failureStatus, sourceHealthDecision),
        JSON.stringify(evidence),
        configurationHash,
        sourceHealthDecision.consecutiveFailures,
        JSON.stringify({
          sourceHealthConsecutiveFailures:
            capturedThresholds.thresholds.sourceHealthConsecutiveFailures,
          thresholdVersion: capturedThresholds.thresholdVersion,
          thresholdConfigurationHash: capturedThresholds.configurationHash
        })
      ]
    );
    const incident = result.rows[0];

    await upsertSourceHealthSignal(
      client,
      incident.id,
      failureStatus,
      sourceHealthDecision
    );
    await createIncidentOpenedAlertDelivery(client, {
      incidentId: incident.id,
      storeId,
      snapshotId
    });

    await applyRecoveryTransition(client, {
      incident,
      snapshotId,
      eventPrefix: "source_health",
      evaluation: {
        comparable: true,
        healthy: false,
        reason: `feed source check returned ${failureStatus}`,
        evidence: {
          sourceStatus: failureStatus,
          configurationHash,
          consecutiveFailures: sourceHealthDecision.consecutiveFailures
        }
      },
      recoveringMessage: "Feed source health entered recovering after one successful feed check.",
      resolvedMessage: "Feed source health resolved after a second consecutive successful feed check.",
      reopenedMessage: "Feed source health recovery reset because the feed check failed again."
    });

    return incident.id;
  });
}

async function shouldOpenFeedSourceHealthIncident(
  storeId: string,
  snapshotId: string,
  status: FeedCheckStatus,
  feedUrl: string,
  consecutiveFailureThreshold: number
): Promise<FeedSourceHealthDecision> {
  const context = await getFeedSourceHealthContext(storeId, snapshotId, feedUrl);

  if (status === "authentication_failed") {
    return {
      open: true,
      reason: "authentication failure opens source health immediately",
      ...context
    };
  }

  if (status === "parse_failed") {
    return {
      open: context.previousStatus === "success",
      reason:
        context.previousStatus === "success"
          ? `feed parse failed after a previous successful check with ${context.previousSuccessfulCount ?? "unknown"} products`
          : "parse failure observed without a previous successful check"
      ,
      ...context
    };
  }

  if (["blocked", "timeout", "source_unavailable"].includes(status)) {
    const reachedThreshold = context.consecutiveFailures >= consecutiveFailureThreshold;

    return {
      open: reachedThreshold,
      reason: reachedThreshold
        ? `feed source failed in ${consecutiveFailureThreshold} consecutive checks`
        : "single transient feed source failure observed",
      ...context
    };
  }

  return {
    open: false,
    reason: "status does not require a source health incident",
    ...context
  };
}

function buildFeedSourceHealthSummary(
  status: FeedCheckStatus,
  decision: FeedSourceHealthDecision
): string {
  if (status === "parse_failed") {
    return `Product feed was reachable, but its XML could not be parsed. Previous successful count: ${decision.previousSuccessfulCount ?? "unknown"}.`;
  }

  return `Product feed could not be verified. Source status: ${status}. Consecutive failures: ${decision.consecutiveFailures}. No conclusion was made about product availability.`;
}

async function upsertSourceHealthSignal(
  executor: pg.Pool | pg.PoolClient,
  incidentId: string,
  status: FeedCheckStatus,
  decision: FeedSourceHealthDecision
): Promise<void> {
  await upsertIncidentSignal(executor, {
    incidentId,
    source: "feed",
    metric: "source_check_failure_count",
    beforeValue: decision.previousSuccessfulCount,
    afterValue: decision.consecutiveFailures,
    changeAbs: decision.consecutiveFailures,
    sampleItems: [
      {
        status,
        previousStatus: decision.previousStatus,
        lastSuccessfulAt: decision.lastSuccessfulAt,
        reason: decision.reason
      }
    ]
  });
}

async function recordFeedSourceHealthRecoveryEvidence(
  storeId: string,
  snapshotId: string,
  feedUrl: string
): Promise<string | null> {
  const configurationHash = createFeedSourceHealthConfigHash(feedUrl);
  return withTransaction(async (client) => {
    const existing = await client.query<SourceHealthIncidentRow>(
      `
        SELECT id, store_id, status, configuration_hash
        FROM incidents
        WHERE store_id = $1
          AND type = 'source_health'
          AND status IN ('open', 'investigating', 'acknowledged', 'recovering')
          AND likely_source = 'feed'
          AND configuration_hash = $2
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [storeId, configurationHash]
    );
    const incident = existing.rows[0];

    if (!incident) {
      return null;
    }

    await client.query(
      `
        UPDATE incidents
        SET evidence_json = evidence_json || $2::jsonb,
            updated_at = now()
        WHERE id = $1
      `,
      [
        incident.id,
        JSON.stringify([
          "feed source check succeeded after source-health failure; recovery lifecycle evaluated"
        ])
      ]
    );

    await upsertIncidentSignal(client, {
      incidentId: incident.id,
      source: "feed",
      metric: "source_check_success",
      afterValue: 1,
      sampleItems: [
        {
          snapshotId,
          status: "success"
        }
      ]
    });

    await applyRecoveryTransition(client, {
      incident,
      snapshotId,
      eventPrefix: "source_health",
      evaluation: {
        comparable: true,
        healthy: true,
        reason: "feed source check succeeded",
        evidence: {
          sourceStatus: "success",
          configurationHash
        }
      },
      recoveringMessage: "Feed source health entered recovering after one successful feed check.",
      resolvedMessage: "Feed source health resolved after a second consecutive successful feed check.",
      reopenedMessage: "Feed source health recovery reset because the feed check failed again."
    });

    return incident.id;
  });
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

async function getFeedSourceHealthContext(
  storeId: string,
  snapshotId: string,
  feedUrl: string
): Promise<Omit<FeedSourceHealthDecision, "open" | "reason">> {
  const result = await getPool().query<FeedSourceHealthContextRow>(
    `
      WITH current_check AS (
        SELECT finished_at, COALESCE(url, $3) AS feed_url
        FROM source_checks
        WHERE store_id = $1
          AND snapshot_id = $2
          AND source = 'feed'
        ORDER BY finished_at DESC
        LIMIT 1
      ),
      ordered_checks AS (
        SELECT
          status,
          finished_at,
          items_observed,
          count(*) FILTER (WHERE status IN ('success', 'partial')) OVER (
            ORDER BY finished_at DESC
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ) AS newer_successes
        FROM source_checks
        WHERE store_id = $1
          AND source = 'feed'
          AND snapshot_id <> $2
          AND COALESCE(url, $3) = COALESCE((SELECT feed_url FROM current_check), $3)
          AND finished_at < COALESCE((SELECT finished_at FROM current_check), now())
      )
      SELECT
        (SELECT status FROM ordered_checks ORDER BY finished_at DESC LIMIT 1) AS previous_status,
        (
          SELECT COUNT(*)
          FROM ordered_checks
          WHERE newer_successes = 0
            AND status NOT IN ('success', 'partial')
        ) AS consecutive_failures,
        (
          SELECT finished_at
          FROM ordered_checks
          WHERE status IN ('success', 'partial')
          ORDER BY finished_at DESC
          LIMIT 1
        ) AS last_successful_at,
        (
          SELECT items_observed
          FROM ordered_checks
          WHERE status IN ('success', 'partial')
          ORDER BY finished_at DESC
          LIMIT 1
        ) AS previous_successful_count
    `,
    [storeId, snapshotId, feedUrl]
  );

  const row = result.rows[0];

  return {
    previousStatus: row?.previous_status ?? null,
    consecutiveFailures: Number(row?.consecutive_failures ?? 0) + 1,
    lastSuccessfulAt: row?.last_successful_at?.toISOString() ?? null,
    previousSuccessfulCount: row?.previous_successful_count ?? null
  };
}

function createFeedSourceHealthConfigHash(feedUrl: string): string {
  return createBaselineConfigHash({
    rule: "source_health",
    source: "feed",
    feedUrl,
    collectorVersion: "feed_v1"
  });
}
