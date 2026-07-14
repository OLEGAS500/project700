import {
  createBaselineConfigHash,
  defaultStoreThresholds,
  storeThresholdsSchema,
  type StoreThresholds,
  type UpdateStoreThresholdsInput
} from "@eim/core";
import type pg from "pg";
import { getPool, withTransaction } from "./client";

type StoreThresholdRow = {
  store_id: string;
  threshold_version: number;
  thresholds_json: StoreThresholds;
  configuration_hash: string;
  updated_at: Date;
};

type SnapshotThresholdRow = {
  store_id: string;
  threshold_version: number | null;
  thresholds_json: StoreThresholds | null;
  threshold_configuration_hash: string | null;
};

export type StoreThresholdRecord = {
  storeId: string;
  thresholdVersion: number;
  thresholds: StoreThresholds;
  configurationHash: string;
  updatedAt: string;
};

export type CapturedSnapshotThresholds = Omit<StoreThresholdRecord, "updatedAt">;

export class StoreThresholdsNotFoundError extends Error {
  constructor(storeId: string) {
    super(`Threshold configuration for store ${storeId} was not found`);
    this.name = "StoreThresholdsNotFoundError";
  }
}

export async function createDefaultStoreThresholds(
  client: pg.PoolClient,
  storeId: string
): Promise<StoreThresholdRecord> {
  const thresholds = defaultStoreThresholds;
  const configurationHash = createThresholdConfigurationHash(thresholds);
  const result = await client.query<StoreThresholdRow>(
    `
      INSERT INTO store_thresholds (
        store_id,
        threshold_version,
        thresholds_json,
        configuration_hash
      )
      VALUES ($1, 1, $2::jsonb, $3)
      ON CONFLICT (store_id) DO NOTHING
      RETURNING *
    `,
    [storeId, JSON.stringify(thresholds), configurationHash]
  );

  if (result.rows[0]) {
    return mapStoreThresholds(result.rows[0]);
  }

  return getStoreThresholds(storeId, client);
}

export async function getStoreThresholds(
  storeId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<StoreThresholdRecord> {
  const result = await executor.query<StoreThresholdRow>(
    "SELECT * FROM store_thresholds WHERE store_id = $1",
    [storeId]
  );
  const row = result.rows[0];

  if (!row) {
    throw new StoreThresholdsNotFoundError(storeId);
  }

  return mapStoreThresholds(row);
}

export async function updateStoreThresholds(
  storeId: string,
  patch: UpdateStoreThresholdsInput
): Promise<StoreThresholdRecord> {
  return withTransaction(async (client) => {
    const current = await client.query<StoreThresholdRow>(
      "SELECT * FROM store_thresholds WHERE store_id = $1 FOR UPDATE",
      [storeId]
    );
    const row = current.rows[0];

    if (!row) {
      throw new StoreThresholdsNotFoundError(storeId);
    }

    const thresholds = storeThresholdsSchema.parse({
      ...row.thresholds_json,
      ...patch,
      priceMismatchTolerance:
        patch.priceMismatchTolerance ?? row.thresholds_json.priceMismatchTolerance
    });
    const configurationHash = createThresholdConfigurationHash(thresholds);
    const updated = await client.query<StoreThresholdRow>(
      `
        UPDATE store_thresholds
        SET threshold_version = threshold_version + 1,
            thresholds_json = $2::jsonb,
            configuration_hash = $3,
            updated_at = clock_timestamp()
        WHERE store_id = $1
        RETURNING *
      `,
      [storeId, JSON.stringify(thresholds), configurationHash]
    );

    return mapStoreThresholds(updated.rows[0]);
  });
}

export async function captureSnapshotThresholds(
  storeId: string,
  snapshotId: string
): Promise<CapturedSnapshotThresholds> {
  return withTransaction(async (client) => {
    const snapshot = await client.query<SnapshotThresholdRow>(
      "SELECT store_id, threshold_version, thresholds_json, threshold_configuration_hash FROM snapshots WHERE id = $1 AND store_id = $2 FOR UPDATE",
      [snapshotId, storeId]
    );
    const row = snapshot.rows[0];

    if (!row) {
      throw new Error(`Snapshot ${snapshotId} does not belong to store ${storeId}`);
    }

    if (
      row.threshold_version !== null &&
      row.thresholds_json !== null &&
      row.threshold_configuration_hash !== null
    ) {
      return {
        storeId,
        thresholdVersion: row.threshold_version,
        thresholds: storeThresholdsSchema.parse(row.thresholds_json),
        configurationHash: row.threshold_configuration_hash
      };
    }

    const current = await client.query<StoreThresholdRow>(
      "SELECT * FROM store_thresholds WHERE store_id = $1 FOR SHARE",
      [storeId]
    );
    const thresholds = current.rows[0];

    if (!thresholds) {
      throw new StoreThresholdsNotFoundError(storeId);
    }

    await client.query(
      `
        UPDATE snapshots
        SET threshold_version = $2,
            thresholds_json = $3::jsonb,
            threshold_configuration_hash = $4
        WHERE id = $1
      `,
      [
        snapshotId,
        thresholds.threshold_version,
        JSON.stringify(thresholds.thresholds_json),
        thresholds.configuration_hash
      ]
    );

    return mapCapturedThresholds(thresholds);
  });
}

export function createThresholdConfigurationHash(thresholds: StoreThresholds): string {
  return createBaselineConfigHash({ ruleThresholds: thresholds, version: "store_thresholds_v1" });
}

function mapStoreThresholds(row: StoreThresholdRow): StoreThresholdRecord {
  return {
    storeId: row.store_id,
    thresholdVersion: row.threshold_version,
    thresholds: storeThresholdsSchema.parse(row.thresholds_json),
    configurationHash: row.configuration_hash,
    updatedAt: row.updated_at.toISOString()
  };
}

function mapCapturedThresholds(row: StoreThresholdRow): CapturedSnapshotThresholds {
  return {
    storeId: row.store_id,
    thresholdVersion: row.threshold_version,
    thresholds: storeThresholdsSchema.parse(row.thresholds_json),
    configurationHash: row.configuration_hash
  };
}
