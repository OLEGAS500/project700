import type { CreateMaintenanceWindowInput } from "@eim/core";
import type pg from "pg";
import { getPool, withTransaction } from "./client";

type MaintenanceWindowRow = {
  id: string;
  store_id: string;
  starts_at: Date;
  ends_at: Date;
  reason: string;
  created_by: string;
  created_at: Date;
  cancelled_at: Date | null;
};

export type MaintenanceWindowRecord = {
  id: string;
  storeId: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  createdBy: string;
  createdAt: string;
  cancelledAt: string | null;
};

export class MaintenanceWindowNotFoundError extends Error {
  constructor(windowId: string) {
    super(`Maintenance window ${windowId} was not found`);
    this.name = "MaintenanceWindowNotFoundError";
  }
}

export async function createMaintenanceWindow(
  storeId: string,
  input: CreateMaintenanceWindowInput
): Promise<MaintenanceWindowRecord> {
  const result = await getPool().query<MaintenanceWindowRow>(
    `
      INSERT INTO maintenance_windows (
        store_id,
        starts_at,
        ends_at,
        reason,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `,
    [storeId, input.startsAt, input.endsAt, input.reason, input.createdBy]
  );

  return mapMaintenanceWindow(result.rows[0]);
}

export async function listMaintenanceWindows(
  storeId: string
): Promise<MaintenanceWindowRecord[]> {
  const result = await getPool().query<MaintenanceWindowRow>(
    `
      SELECT *
      FROM maintenance_windows
      WHERE store_id = $1
      ORDER BY starts_at DESC, created_at DESC
    `,
    [storeId]
  );

  return result.rows.map(mapMaintenanceWindow);
}

export async function cancelMaintenanceWindow(
  storeId: string,
  windowId: string
): Promise<MaintenanceWindowRecord> {
  return withTransaction(async (client) => {
    const result = await client.query<MaintenanceWindowRow>(
      `
        UPDATE maintenance_windows
        SET cancelled_at = COALESCE(cancelled_at, clock_timestamp())
        WHERE id = $1
          AND store_id = $2
        RETURNING *
      `,
      [windowId, storeId]
    );
    const window = result.rows[0];

    if (!window) {
      throw new MaintenanceWindowNotFoundError(windowId);
    }

    return mapMaintenanceWindow(window);
  });
}

export async function getActiveMaintenanceWindow(
  executor: pg.Pool | pg.PoolClient,
  storeId: string,
  at?: Date
): Promise<MaintenanceWindowRecord | null> {
  const result = await executor.query<MaintenanceWindowRow>(
    `
      SELECT *
      FROM maintenance_windows
      WHERE store_id = $1
        AND cancelled_at IS NULL
        AND starts_at <= COALESCE($2::timestamptz, clock_timestamp())
        AND ends_at > COALESCE($2::timestamptz, clock_timestamp())
      ORDER BY starts_at DESC, created_at DESC
      LIMIT 1
    `,
    [storeId, at ?? null]
  );

  return result.rows[0] ? mapMaintenanceWindow(result.rows[0]) : null;
}

export async function isAlertSuppressedByMaintenance(
  executor: pg.Pool | pg.PoolClient,
  storeId: string,
  at?: Date
): Promise<boolean> {
  return Boolean(await getActiveMaintenanceWindow(executor, storeId, at));
}

function mapMaintenanceWindow(row: MaintenanceWindowRow): MaintenanceWindowRecord {
  return {
    id: row.id,
    storeId: row.store_id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null
  };
}
