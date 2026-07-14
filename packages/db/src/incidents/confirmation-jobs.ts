import type pg from "pg";
import { getPool } from "../client";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type DueIncidentConfirmationCandidate = {
  candidateId: string;
  storeId: string;
  scheduledFor: string;
  attemptCount: number;
  lockedBy: string;
};

type ClaimConfirmationCandidatesInput = {
  limit?: number;
  workerId?: string;
  maxAttempts?: number;
};

async function claimDueIncidentConfirmationCandidatesFrom(
  executor: Queryable,
  input: ClaimConfirmationCandidatesInput = {}
): Promise<DueIncidentConfirmationCandidate[]> {
  const limit = input.limit ?? 10;
  const workerId = input.workerId ?? "default-worker";
  const maxAttempts = input.maxAttempts ?? 5;

  await executor.query(
    `
      UPDATE incident_candidates
      SET status = 'expired',
          status_reason = 'confirmation_window_expired',
          locked_at = NULL,
          locked_by = NULL,
          updated_at = now()
      WHERE status = 'pending_confirmation'
        AND expires_at <= now()
    `
  );
  await executor.query(
    `
      UPDATE incident_candidates
      SET status = 'source_failure',
          status_reason = 'confirmation_attempts_exhausted',
          locked_at = NULL,
          locked_by = NULL,
          updated_at = now()
      WHERE status = 'pending_confirmation'
        AND confirmation_due_at <= now()
        AND attempt_count >= $1
        AND (locked_at IS NULL OR locked_at < now() - interval '15 minutes')
    `,
    [maxAttempts]
  );

  const result = await executor.query<{
    id: string;
    store_id: string;
    confirmation_due_at: Date;
    attempt_count: number;
    locked_by: string;
  }>(
    `
      UPDATE incident_candidates
      SET attempt_count = attempt_count + 1,
          locked_at = now(),
          locked_by = $2,
          last_error = NULL,
          updated_at = now()
      WHERE id IN (
        SELECT id
        FROM incident_candidates
        WHERE status = 'pending_confirmation'
          AND confirmation_due_at <= now()
          AND expires_at > now()
          AND attempt_count < $3
          AND (locked_at IS NULL OR locked_at < now() - interval '15 minutes')
        ORDER BY confirmation_due_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, store_id, confirmation_due_at, attempt_count, locked_by
    `,
    [limit, workerId, maxAttempts]
  );

  return result.rows.map((row) => ({
    candidateId: row.id,
    storeId: row.store_id,
    scheduledFor: row.confirmation_due_at.toISOString(),
    attemptCount: row.attempt_count,
    lockedBy: row.locked_by
  }));
}

async function markIncidentConfirmationAttemptFailedWithClient(
  executor: Queryable,
  candidateId: string,
  error: unknown
): Promise<void> {
  await executor.query(
    `
      UPDATE incident_candidates
      SET last_error = $2,
          updated_at = now()
      WHERE id = $1
    `,
    [candidateId, error instanceof Error ? error.message : String(error)]
  );
}

export async function claimDueIncidentConfirmationCandidates(
  limit = 10,
  workerId = "default-worker",
  maxAttempts = 5
): Promise<DueIncidentConfirmationCandidate[]> {
  return claimDueIncidentConfirmationCandidatesFrom(getPool(), {
    limit,
    workerId,
    maxAttempts
  });
}

export async function markIncidentConfirmationAttemptFailed(
  candidateId: string,
  error: unknown
): Promise<void> {
  await markIncidentConfirmationAttemptFailedWithClient(getPool(), candidateId, error);
}
