import {
  emailDestinationInputSchema,
  type EmailDestinationInput
} from "@eim/core";
import type pg from "pg";
import { getPool } from "./client";

type EmailDestinationRow = {
  id: string;
  store_id: string;
  recipient_emails: string[];
  enabled: boolean;
  disabled_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type EmailDestinationRecord = {
  id: string;
  storeId: string;
  recipientEmails: string[];
  enabled: boolean;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function getEmailDestination(
  storeId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<EmailDestinationRecord | null> {
  const result = await executor.query<EmailDestinationRow>(
    "SELECT * FROM email_destinations WHERE store_id = $1",
    [storeId]
  );
  return result.rows[0] ? mapEmailDestination(result.rows[0]) : null;
}

export async function upsertEmailDestination(
  storeId: string,
  input: EmailDestinationInput,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<EmailDestinationRecord> {
  const destination = emailDestinationInputSchema.parse(input);
  const result = await executor.query<EmailDestinationRow>(
    `
      INSERT INTO email_destinations (
        store_id,
        recipient_emails,
        enabled,
        disabled_at,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        CASE WHEN $3 THEN NULL ELSE clock_timestamp() END,
        clock_timestamp(),
        clock_timestamp()
      )
      ON CONFLICT (store_id)
      DO UPDATE SET
        recipient_emails = EXCLUDED.recipient_emails,
        enabled = EXCLUDED.enabled,
        disabled_at = CASE
          WHEN EXCLUDED.enabled THEN NULL
          ELSE COALESCE(email_destinations.disabled_at, clock_timestamp())
        END,
        updated_at = clock_timestamp()
      RETURNING *
    `,
    [storeId, destination.recipientEmails, destination.enabled]
  );
  return mapEmailDestination(result.rows[0]);
}

export async function disableEmailDestination(
  storeId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<EmailDestinationRecord | null> {
  const result = await executor.query<EmailDestinationRow>(
    `
      UPDATE email_destinations
      SET enabled = false,
          disabled_at = COALESCE(disabled_at, clock_timestamp()),
          updated_at = clock_timestamp()
      WHERE store_id = $1
      RETURNING *
    `,
    [storeId]
  );
  return result.rows[0] ? mapEmailDestination(result.rows[0]) : null;
}

function mapEmailDestination(row: EmailDestinationRow): EmailDestinationRecord {
  return {
    id: row.id,
    storeId: row.store_id,
    recipientEmails: row.recipient_emails,
    enabled: row.enabled,
    disabledAt: row.disabled_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
