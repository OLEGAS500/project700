import {
  telegramDestinationInputSchema,
  type TelegramDestinationInput
} from "@eim/core";
import type pg from "pg";
import { getPool } from "./client";

type TelegramDestinationRow = {
  id: string;
  store_id: string;
  chat_id: string;
  thread_id: number | null;
  display_name: string | null;
  enabled: boolean;
  verified_at: Date | null;
  last_verification_error: string | null;
  disabled_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type TelegramDestinationRecord = {
  id: string;
  storeId: string;
  chatId: string;
  threadId: number | null;
  displayName: string | null;
  enabled: boolean;
  verifiedAt: string | null;
  lastVerificationError: string | null;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function getTelegramDestination(
  storeId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<TelegramDestinationRecord | null> {
  const result = await executor.query<TelegramDestinationRow>(
    "SELECT * FROM telegram_destinations WHERE store_id = $1",
    [storeId]
  );
  return result.rows[0] ? mapTelegramDestination(result.rows[0]) : null;
}

export async function upsertTelegramDestination(
  storeId: string,
  input: TelegramDestinationInput,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<TelegramDestinationRecord> {
  const destination = telegramDestinationInputSchema.parse(input);
  const result = await executor.query<TelegramDestinationRow>(
    `
      INSERT INTO telegram_destinations (
        store_id,
        chat_id,
        thread_id,
        display_name,
        enabled,
        disabled_at,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        CASE WHEN $5 THEN NULL ELSE clock_timestamp() END,
        clock_timestamp(),
        clock_timestamp()
      )
      ON CONFLICT (store_id)
      DO UPDATE SET
        verified_at = CASE
          WHEN telegram_destinations.chat_id IS DISTINCT FROM EXCLUDED.chat_id
            OR telegram_destinations.thread_id IS DISTINCT FROM EXCLUDED.thread_id
          THEN NULL
          ELSE telegram_destinations.verified_at
        END,
        last_verification_error = CASE
          WHEN telegram_destinations.chat_id IS DISTINCT FROM EXCLUDED.chat_id
            OR telegram_destinations.thread_id IS DISTINCT FROM EXCLUDED.thread_id
          THEN NULL
          ELSE telegram_destinations.last_verification_error
        END,
        chat_id = EXCLUDED.chat_id,
        thread_id = EXCLUDED.thread_id,
        display_name = EXCLUDED.display_name,
        enabled = EXCLUDED.enabled,
        disabled_at = CASE
          WHEN EXCLUDED.enabled THEN NULL
          ELSE COALESCE(telegram_destinations.disabled_at, clock_timestamp())
        END,
        updated_at = clock_timestamp()
      RETURNING *
    `,
    [
      storeId,
      destination.chatId,
      destination.threadId,
      destination.displayName,
      destination.enabled
    ]
  );
  return mapTelegramDestination(result.rows[0]);
}

export async function disableTelegramDestination(
  storeId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<TelegramDestinationRecord | null> {
  const result = await executor.query<TelegramDestinationRow>(
    `
      UPDATE telegram_destinations
      SET enabled = false,
          disabled_at = COALESCE(disabled_at, clock_timestamp()),
          updated_at = clock_timestamp()
      WHERE store_id = $1
      RETURNING *
    `,
    [storeId]
  );
  return result.rows[0] ? mapTelegramDestination(result.rows[0]) : null;
}

function mapTelegramDestination(row: TelegramDestinationRow): TelegramDestinationRecord {
  return {
    id: row.id,
    storeId: row.store_id,
    chatId: row.chat_id,
    threadId: row.thread_id,
    displayName: row.display_name,
    enabled: row.enabled,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    lastVerificationError: row.last_verification_error,
    disabledAt: row.disabled_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
