CREATE INDEX incidents_dashboard_updated_idx
  ON incidents (updated_at DESC, id DESC);

CREATE INDEX source_checks_store_source_finished_idx
  ON source_checks (store_id, source, finished_at DESC, created_at DESC, id DESC);

CREATE INDEX baseline_metrics_store_updated_idx
  ON baseline_metrics (store_id, updated_at DESC, id DESC);
