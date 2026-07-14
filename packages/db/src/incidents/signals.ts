import type pg from "pg";

export type IncidentSignalInput = {
  incidentId: string;
  source: string;
  metric: string;
  beforeValue?: number | string | null;
  afterValue?: number | string | null;
  changeAbs?: number | string | null;
  changePct?: number | string | null;
  sampleItems?: unknown[];
};

export async function upsertIncidentSignal(
  executor: pg.Pool | pg.PoolClient,
  input: IncidentSignalInput
): Promise<void> {
  await executor.query(
    `
      INSERT INTO incident_signals (
        incident_id,
        source,
        metric,
        before_value,
        after_value,
        change_abs,
        change_pct,
        sample_items_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (incident_id, source, metric)
      DO UPDATE SET
        before_value = EXCLUDED.before_value,
        after_value = EXCLUDED.after_value,
        change_abs = EXCLUDED.change_abs,
        change_pct = EXCLUDED.change_pct,
        sample_items_json = EXCLUDED.sample_items_json
    `,
    [
      input.incidentId,
      input.source,
      input.metric,
      input.beforeValue ?? null,
      input.afterValue ?? null,
      input.changeAbs ?? null,
      input.changePct ?? null,
      JSON.stringify(input.sampleItems ?? [])
    ]
  );
}
