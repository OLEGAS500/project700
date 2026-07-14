import {
  alertPreferencesSchema,
  createBaselineConfigHash,
  defaultAlertPreferences,
  type AlertPreferences,
  type UpdateAlertPreferencesInput
} from "@eim/core";
import type pg from "pg";
import { getPool, withTransaction } from "./client";

type Row = {
  store_id: string;
  alert_preference_version: number;
  preferences_json: AlertPreferences;
  configuration_hash: string;
  updated_at: Date;
};

export type AlertPreferencesRecord = {
  storeId: string;
  alertPreferenceVersion: number;
  preferences: AlertPreferences;
  configurationHash: string;
  updatedAt: string;
};

export async function createDefaultAlertPreferences(
  client: pg.PoolClient,
  storeId: string
): Promise<AlertPreferencesRecord> {
  const hash = createAlertPreferencesHash(defaultAlertPreferences);
  const result = await client.query<Row>(
    `INSERT INTO store_alert_preferences (store_id, preferences_json, configuration_hash)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (store_id) DO NOTHING
     RETURNING *`,
    [storeId, JSON.stringify(defaultAlertPreferences), hash]
  );
  return result.rows[0] ? map(result.rows[0]) : getAlertPreferences(storeId, client);
}

export async function getAlertPreferences(
  storeId: string,
  executor: pg.Pool | pg.PoolClient = getPool()
): Promise<AlertPreferencesRecord> {
  const result = await executor.query<Row>("SELECT * FROM store_alert_preferences WHERE store_id = $1", [storeId]);
  if (!result.rows[0]) throw new Error(`Alert preferences for store ${storeId} were not found`);
  return map(result.rows[0]);
}

export async function updateAlertPreferences(
  storeId: string,
  patch: UpdateAlertPreferencesInput
): Promise<AlertPreferencesRecord> {
  return withTransaction(async (client) => {
    const current = await client.query<Row>("SELECT * FROM store_alert_preferences WHERE store_id = $1 FOR UPDATE", [storeId]);
    if (!current.rows[0]) throw new Error(`Alert preferences for store ${storeId} were not found`);
    const preferences = alertPreferencesSchema.parse({ ...current.rows[0].preferences_json, ...patch });
    const result = await client.query<Row>(
      `UPDATE store_alert_preferences
       SET alert_preference_version = alert_preference_version + 1,
           preferences_json = $2::jsonb,
           configuration_hash = $3,
           updated_at = clock_timestamp()
       WHERE store_id = $1
       RETURNING *`,
      [storeId, JSON.stringify(preferences), createAlertPreferencesHash(preferences)]
    );
    return map(result.rows[0]);
  });
}

export function createAlertPreferencesHash(preferences: AlertPreferences): string {
  return createBaselineConfigHash({
    preferences: {
      ...preferences,
      mutedIncidentTypes: [...preferences.mutedIncidentTypes].sort()
    },
    version: "alert_preferences_v1"
  });
}

function map(row: Row): AlertPreferencesRecord {
  return {
    storeId: row.store_id,
    alertPreferenceVersion: row.alert_preference_version,
    preferences: alertPreferencesSchema.parse(row.preferences_json),
    configurationHash: row.configuration_hash,
    updatedAt: row.updated_at.toISOString()
  };
}
