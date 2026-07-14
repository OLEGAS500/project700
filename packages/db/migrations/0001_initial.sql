CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE baseline_status AS ENUM ('learning', 'pending_user_confirmation', 'active');
CREATE TYPE snapshot_status AS ENUM ('queued', 'running', 'completed', 'partial', 'failed');
CREATE TYPE baseline_role AS ENUM ('candidate', 'confirmed_baseline', 'normal_check', 'confirmation_check');
CREATE TYPE baseline_metric_status AS ENUM ('learning', 'ready_for_confirmation', 'active', 'stale', 'relearning');
CREATE TYPE incident_candidate_status AS ENUM ('pending_confirmation', 'confirmed', 'dismissed', 'expired', 'source_failure');
CREATE TYPE source_check_source AS ENUM ('category', 'product_page', 'sitemap', 'feed', 'merchant_center');
CREATE TYPE source_check_status AS ENUM ('success', 'partial', 'timeout', 'blocked', 'authentication_failed', 'parse_failed', 'source_unavailable');
CREATE TYPE source_item_source AS ENUM ('storefront', 'sitemap', 'feed', 'merchant_center');
CREATE TYPE incident_severity AS ENUM ('critical', 'warning', 'info');
CREATE TYPE incident_status AS ENUM ('open', 'investigating', 'acknowledged', 'recovering', 'resolved', 'ignored');
CREATE TYPE incident_type AS ENUM ('catalog_drop', 'source_divergence', 'seo_regression', 'price_availability_mismatch', 'source_health');
CREATE TYPE alert_delivery_status AS ENUM ('pending', 'suppressed', 'sent', 'failed');

CREATE TABLE stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  sitemap_url TEXT NOT NULL,
  feed_url TEXT NOT NULL,
  merchant_center_account_id TEXT,
  baseline_status baseline_status NOT NULL DEFAULT 'learning',
  baseline_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX stores_domain_idx ON stores (domain);

CREATE TABLE store_thresholds (
  store_id UUID PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  threshold_version INTEGER NOT NULL DEFAULT 1 CHECK (threshold_version >= 1),
  thresholds_json JSONB NOT NULL,
  configuration_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE store_alert_preferences (
  store_id UUID PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  alert_preference_version INTEGER NOT NULL DEFAULT 1 CHECK (alert_preference_version >= 1),
  preferences_json JSONB NOT NULL,
  configuration_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE monitored_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  name TEXT,
  criticality INTEGER NOT NULL DEFAULT 3 CHECK (criticality BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX monitored_categories_store_url_idx ON monitored_categories (store_id, url);
CREATE INDEX monitored_categories_store_idx ON monitored_categories (store_id);

CREATE TABLE snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  status snapshot_status NOT NULL DEFAULT 'queued',
  baseline_role baseline_role NOT NULL DEFAULT 'candidate',
  sitemap_url_count INTEGER,
  feed_product_count INTEGER,
  merchant_total_count INTEGER,
  merchant_approved_count INTEGER,
  merchant_pending_count INTEGER,
  merchant_disapproved_count INTEGER,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT date_trunc('minute', now()),
  idempotency_key TEXT NOT NULL,
  sample_manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  threshold_version INTEGER,
  thresholds_json JSONB,
  threshold_configuration_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX snapshots_store_created_idx ON snapshots (store_id, created_at DESC);
CREATE INDEX snapshots_store_started_idx ON snapshots (store_id, started_at DESC NULLS LAST, created_at DESC);
CREATE UNIQUE INDEX snapshots_store_role_idempotency_idx ON snapshots (store_id, baseline_role, idempotency_key);

CREATE TABLE source_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  source source_check_source NOT NULL,
  check_key TEXT NOT NULL,
  url TEXT,
  status source_check_status NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  http_status INTEGER,
  items_observed INTEGER NOT NULL DEFAULT 0 CHECK (items_observed >= 0),
  total_items_seen INTEGER,
  skipped_items INTEGER,
  error_code TEXT,
  error_message TEXT,
  error_samples_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  retry_of_source_check_id UUID REFERENCES source_checks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX source_checks_snapshot_idx ON source_checks (snapshot_id);
CREATE INDEX source_checks_store_source_idx ON source_checks (store_id, source, created_at DESC);
CREATE UNIQUE INDEX source_checks_snapshot_source_key_idx ON source_checks (snapshot_id, source, check_key);

CREATE TABLE source_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  source source_item_source NOT NULL,
  stable_key TEXT NOT NULL,
  offer_id TEXT,
  url TEXT,
  title TEXT,
  price TEXT,
  currency TEXT,
  availability TEXT,
  image_url TEXT,
  http_status INTEGER,
  indexability TEXT,
  canonical_url TEXT,
  schema_present BOOLEAN,
  merchant_status TEXT,
  merchant_issues_json JSONB,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX source_items_snapshot_source_idx ON source_items (snapshot_id, source);
CREATE INDEX source_items_store_key_idx ON source_items (store_id, stable_key);
CREATE UNIQUE INDEX source_items_snapshot_source_key_idx ON source_items (snapshot_id, source, stable_key);

CREATE TABLE source_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  matched_key TEXT NOT NULL,
  match_method TEXT NOT NULL,
  match_confidence NUMERIC(4, 3) NOT NULL,
  sitemap_item_id UUID REFERENCES source_items(id) ON DELETE SET NULL,
  feed_item_id UUID REFERENCES source_items(id) ON DELETE SET NULL,
  storefront_item_id UUID REFERENCES source_items(id) ON DELETE SET NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX source_matches_snapshot_key_idx ON source_matches (snapshot_id, matched_key);
CREATE INDEX source_matches_store_snapshot_idx ON source_matches (store_id, snapshot_id);

CREATE TABLE baseline_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  source TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  status baseline_metric_status NOT NULL DEFAULT 'learning',
  baseline_version INTEGER NOT NULL DEFAULT 1,
  configuration_hash TEXT NOT NULL,
  median_value NUMERIC NOT NULL,
  min_value NUMERIC,
  max_value NUMERIC,
  p10_value NUMERIC,
  p90_value NUMERIC,
  sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
  window_start_at TIMESTAMPTZ NOT NULL,
  window_end_at TIMESTAMPTZ NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  confirmed_by_user_id UUID,
  confirmed_at TIMESTAMPTZ,
  last_recalculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX baseline_metrics_store_metric_idx ON baseline_metrics (store_id, source, metric, scope, status);
CREATE UNIQUE INDEX baseline_metrics_active_version_idx ON baseline_metrics (store_id, source, metric, scope, baseline_version);

CREATE TABLE incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  baseline_metric_id UUID REFERENCES baseline_metrics(id) ON DELETE SET NULL,
  baseline_version INTEGER,
  baseline_median NUMERIC,
  configuration_hash TEXT,
  before_value NUMERIC,
  after_value NUMERIC,
  thresholds_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  opened_snapshot_id UUID REFERENCES snapshots(id) ON DELETE SET NULL,
  closed_snapshot_id UUID REFERENCES snapshots(id) ON DELETE SET NULL,
  severity incident_severity NOT NULL,
  type incident_type NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  likely_source TEXT,
  confidence_score NUMERIC(4, 3),
  evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  affected_count INTEGER NOT NULL DEFAULT 0 CHECK (affected_count >= 0),
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status incident_status NOT NULL DEFAULT 'open',
  resolved_at TIMESTAMPTZ,
  ignored_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX incidents_store_status_idx ON incidents (store_id, status, last_seen_at DESC);

CREATE TABLE incident_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  type incident_type NOT NULL,
  scope_key TEXT NOT NULL,
  baseline_metric_id UUID NOT NULL REFERENCES baseline_metrics(id) ON DELETE CASCADE,
  baseline_version INTEGER NOT NULL,
  baseline_median NUMERIC NOT NULL,
  configuration_hash TEXT NOT NULL,
  first_snapshot_id UUID NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  confirmation_snapshot_id UUID REFERENCES snapshots(id) ON DELETE SET NULL,
  before_value NUMERIC NOT NULL,
  observed_value NUMERIC NOT NULL,
  change_abs NUMERIC NOT NULL,
  change_pct NUMERIC NOT NULL,
  status incident_candidate_status NOT NULL DEFAULT 'pending_confirmation',
  status_reason TEXT,
  fingerprint TEXT NOT NULL,
  evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  thresholds_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmation_due_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT
);

CREATE UNIQUE INDEX incident_candidates_pending_fingerprint_idx
  ON incident_candidates (fingerprint)
  WHERE status = 'pending_confirmation';

CREATE INDEX incident_candidates_store_status_idx ON incident_candidates (store_id, status, created_at DESC);
CREATE INDEX incident_candidates_due_idx
  ON incident_candidates (confirmation_due_at, locked_at)
  WHERE status = 'pending_confirmation';

CREATE TABLE incident_debounce_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  type incident_type NOT NULL,
  scope_key TEXT NOT NULL,
  configuration_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_snapshot_id UUID NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  last_snapshot_id UUID NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  first_affected_count INTEGER NOT NULL CHECK (first_affected_count >= 0),
  last_affected_count INTEGER NOT NULL CHECK (last_affected_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'dismissed')),
  status_reason TEXT,
  confirmed_incident_id UUID REFERENCES incidents(id) ON DELETE SET NULL,
  evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  thresholds_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX incident_debounce_candidates_pending_fingerprint_idx
  ON incident_debounce_candidates (fingerprint)
  WHERE status = 'pending';
CREATE INDEX incident_debounce_candidates_store_status_idx
  ON incident_debounce_candidates (store_id, type, status, updated_at DESC);

CREATE TABLE incident_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  metric TEXT NOT NULL,
  before_value NUMERIC,
  after_value NUMERIC,
  change_abs NUMERIC,
  change_pct NUMERIC,
  sample_items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX incident_signals_incident_source_metric_idx
  ON incident_signals (incident_id, source, metric);

CREATE TABLE incident_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  snapshot_id UUID REFERENCES snapshots(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  from_status incident_status,
  to_status incident_status,
  message TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX incident_events_incident_created_idx ON incident_events (incident_id, created_at DESC);
CREATE UNIQUE INDEX incident_events_incident_type_snapshot_idx
  ON incident_events (incident_id, event_type, snapshot_id)
  WHERE snapshot_id IS NOT NULL;
CREATE UNIQUE INDEX incident_events_incident_opened_idx
  ON incident_events (incident_id)
  WHERE event_type = 'incident_opened';

CREATE TABLE incident_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX incident_comments_incident_created_idx
  ON incident_comments (incident_id, created_at ASC);

CREATE TABLE alert_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  incident_type incident_type NOT NULL,
  severity_threshold incident_severity NOT NULL DEFAULT 'critical',
  metric_threshold_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  muted_until TIMESTAMPTZ,
  notify_on_open BOOLEAN NOT NULL DEFAULT true,
  notify_on_worsening BOOLEAN NOT NULL DEFAULT true,
  notify_on_recovery BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX alert_preferences_store_type_idx ON alert_preferences (store_id, incident_type);

CREATE TABLE maintenance_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  CHECK (ends_at > starts_at)
);

CREATE INDEX maintenance_windows_active_store_time_idx
  ON maintenance_windows (store_id, starts_at, ends_at)
  WHERE cancelled_at IS NULL;

CREATE TABLE alert_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  incident_event_id UUID NOT NULL REFERENCES incident_events(id) ON DELETE NO ACTION,
  channel TEXT NOT NULL DEFAULT 'default',
  alert_type TEXT NOT NULL,
  status alert_delivery_status NOT NULL DEFAULT 'pending',
  primary_suppression_reason TEXT,
  maintenance_window_id UUID REFERENCES maintenance_windows(id) ON DELETE SET NULL,
  alert_preference_version INTEGER NOT NULL,
  alert_preference_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE (incident_event_id, channel)
);

CREATE INDEX alert_deliveries_store_status_idx
  ON alert_deliveries (store_id, status, created_at DESC);
