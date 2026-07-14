import type { AlertType, CanonicalAlertPayload } from "@eim/core";
import type pg from "pg";
import { getAlertEventPayloadsByEventIds } from "./alert-event-payloads";
import { getPool } from "./client";

export type AlertDeliveryChannel = "email" | "telegram";
export type AlertDeliveryJobStatus = "pending" | "sent" | "failed";

type AlertDeliveryJobRow = {
  id: string;
  incident_id: string;
  store_id: string;
  incident_event_id: string;
  channel: AlertDeliveryChannel;
  alert_type: AlertType;
  status: AlertDeliveryJobStatus;
  attempt_count: number;
  locked_at: Date | null;
  locked_by: string | null;
  lease_expires_at: Date | null;
  next_attempt_at: Date;
  last_error: string | null;
  failed_at: Date | null;
  provider_message_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type ClaimedAlertDelivery = {
  id: string;
  incidentId: string;
  storeId: string;
  incidentEventId: string;
  channel: AlertDeliveryChannel;
  alertType: AlertType;
  payload: CanonicalAlertPayload;
  attemptCount: number;
  lockedBy: string;
  lockedAt: string;
  leaseExpiresAt: string;
};

export type AlertDeliveryJobRecord = {
  id: string;
  status: AlertDeliveryJobStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastError: string | null;
  failedAt: string | null;
  providerMessageId: string | null;
};

export type ClaimDueAlertDeliveriesInput = {
  channel: AlertDeliveryChannel;
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
};

export type MarkAlertDeliverySentInput = {
  deliveryId: string;
  workerId: string;
  claimedAttemptCount: number;
  providerMessageId: string;
};

export type MarkAlertDeliveryAttemptFailedInput = {
  deliveryId: string;
  workerId: string;
  claimedAttemptCount: number;
  error: unknown;
  maxAttempts?: number;
};

export type AlertDeliveryConfigurationErrorCode =
  | "telegram_destination_missing"
  | "telegram_destination_disabled";

export type MarkAlertDeliveryConfigurationFailedInput = {
  deliveryId: string;
  workerId: string;
  claimedAttemptCount: number;
  errorCode: AlertDeliveryConfigurationErrorCode;
};

const retryDelaysSeconds = [60, 300, 900, 3_600] as const;

export async function claimDueAlertDeliveries(
  input: ClaimDueAlertDeliveriesInput
): Promise<ClaimedAlertDelivery[]> {
  const limit = input.limit ?? 10;
  const leaseSeconds = input.leaseSeconds ?? 300;
  const maxAttempts = input.maxAttempts ?? 5;

  await getPool().query(
    `
      UPDATE alert_deliveries
      SET status = 'failed',
          failed_at = clock_timestamp(),
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE status = 'pending'
        AND channel = $1
        AND attempt_count >= $2
        AND next_attempt_at <= clock_timestamp()
        AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
    `,
    [input.channel, maxAttempts]
  );

  const result = await getPool().query<AlertDeliveryJobRow>(
    `
      UPDATE alert_deliveries
      SET attempt_count = attempt_count + 1,
          locked_by = $3,
          locked_at = clock_timestamp(),
          lease_expires_at = clock_timestamp() + ($4 * interval '1 second'),
          updated_at = clock_timestamp()
      WHERE id IN (
        SELECT id
        FROM alert_deliveries
        WHERE status = 'pending'
          AND channel = $2
          AND EXISTS (
            SELECT 1
            FROM alert_event_payloads
            WHERE alert_event_payloads.incident_event_id = alert_deliveries.incident_event_id
          )
          AND next_attempt_at <= clock_timestamp()
          AND attempt_count < $5
          AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `,
    [limit, input.channel, input.workerId, leaseSeconds, maxAttempts]
  );

  const payloads = await getAlertEventPayloadsByEventIds(
    result.rows.map((row) => row.incident_event_id),
    getPool()
  );

  return result.rows.map((row) => {
    const payload = payloads.get(row.incident_event_id);
    if (!payload) {
      throw new Error(`Claimed alert delivery ${row.id} is missing its immutable payload`);
    }
    return mapClaimedAlertDelivery(row, payload.payload);
  });
}

export async function markAlertDeliverySent(
  input: MarkAlertDeliverySentInput
): Promise<AlertDeliveryJobRecord | null> {
  const result = await getPool().query<AlertDeliveryJobRow>(
    `
      UPDATE alert_deliveries
      SET status = 'sent',
          sent_at = clock_timestamp(),
          provider_message_id = $4,
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE id = $1
        AND status = 'pending'
        AND locked_by = $2
        AND attempt_count = $3
      RETURNING *
    `,
    [input.deliveryId, input.workerId, input.claimedAttemptCount, input.providerMessageId]
  );
  if (result.rows[0]) return mapAlertDeliveryJobRecord(result.rows[0]);

  const existing = await getPool().query<AlertDeliveryJobRow>(
    `
      SELECT *
      FROM alert_deliveries
      WHERE id = $1
        AND status = 'sent'
        AND attempt_count = $2
    `,
    [input.deliveryId, input.claimedAttemptCount]
  );
  return existing.rows[0] ? mapAlertDeliveryJobRecord(existing.rows[0]) : null;
}

export async function markAlertDeliveryAttemptFailed(
  input: MarkAlertDeliveryAttemptFailedInput
): Promise<AlertDeliveryJobRecord | null> {
  const maxAttempts = input.maxAttempts ?? 5;
  const retryDelaySeconds = retryDelaysSeconds[Math.min(input.claimedAttemptCount - 1, retryDelaysSeconds.length - 1)];
  const error = toErrorMessage(input.error);
  const result = await getPool().query<AlertDeliveryJobRow>(
    `
      UPDATE alert_deliveries
      SET status = CASE WHEN attempt_count >= $4 THEN 'failed'::alert_delivery_status ELSE 'pending'::alert_delivery_status END,
          next_attempt_at = CASE WHEN attempt_count >= $4 THEN next_attempt_at ELSE clock_timestamp() + ($5 * interval '1 second') END,
          last_error = $6,
          failed_at = CASE WHEN attempt_count >= $4 THEN clock_timestamp() ELSE NULL END,
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE id = $1
        AND status = 'pending'
        AND locked_by = $2
        AND attempt_count = $3
      RETURNING *
    `,
    [input.deliveryId, input.workerId, input.claimedAttemptCount, maxAttempts, retryDelaySeconds, error]
  );
  if (result.rows[0]) return mapAlertDeliveryJobRecord(result.rows[0]);

  const existing = await getPool().query<AlertDeliveryJobRow>(
    `
      SELECT *
      FROM alert_deliveries
      WHERE id = $1
        AND attempt_count = $2
        AND status = 'failed'
    `,
    [input.deliveryId, input.claimedAttemptCount]
  );
  return existing.rows[0] ? mapAlertDeliveryJobRecord(existing.rows[0]) : null;
}

export async function markAlertDeliveryConfigurationFailed(
  input: MarkAlertDeliveryConfigurationFailedInput
): Promise<AlertDeliveryJobRecord | null> {
  const result = await getPool().query<AlertDeliveryJobRow>(
    `
      UPDATE alert_deliveries
      SET status = 'failed',
          last_error = $4,
          failed_at = clock_timestamp(),
          locked_at = NULL,
          locked_by = NULL,
          lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE id = $1
        AND status = 'pending'
        AND locked_by = $2
        AND attempt_count = $3
      RETURNING *
    `,
    [input.deliveryId, input.workerId, input.claimedAttemptCount, input.errorCode]
  );
  if (result.rows[0]) return mapAlertDeliveryJobRecord(result.rows[0]);

  const existing = await getPool().query<AlertDeliveryJobRow>(
    `
      SELECT *
      FROM alert_deliveries
      WHERE id = $1
        AND status = 'failed'
        AND attempt_count = $2
        AND last_error = $3
    `,
    [input.deliveryId, input.claimedAttemptCount, input.errorCode]
  );
  return existing.rows[0] ? mapAlertDeliveryJobRecord(existing.rows[0]) : null;
}

function mapClaimedAlertDelivery(
  row: AlertDeliveryJobRow,
  payload: CanonicalAlertPayload
): ClaimedAlertDelivery {
  if (!row.locked_by || !row.locked_at || !row.lease_expires_at) {
    throw new Error(`Claimed alert delivery ${row.id} is missing lease metadata`);
  }

  return {
    id: row.id,
    incidentId: row.incident_id,
    storeId: row.store_id,
    incidentEventId: row.incident_event_id,
    channel: row.channel,
    alertType: row.alert_type,
    payload,
    attemptCount: row.attempt_count,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at.toISOString(),
    leaseExpiresAt: row.lease_expires_at.toISOString()
  };
}

function mapAlertDeliveryJobRecord(row: AlertDeliveryJobRow): AlertDeliveryJobRecord {
  return {
    id: row.id,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    lastError: row.last_error,
    failedAt: row.failed_at?.toISOString() ?? null,
    providerMessageId: row.provider_message_id
  };
}

function toErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}
