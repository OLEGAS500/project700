ALTER TABLE alert_deliveries
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN locked_at TIMESTAMPTZ,
  ADD COLUMN locked_by TEXT,
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_error TEXT,
  ADD COLUMN failed_at TIMESTAMPTZ,
  ADD COLUMN provider_message_id TEXT,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX alert_deliveries_due_pending_idx
  ON alert_deliveries (status, channel, next_attempt_at, created_at)
  WHERE status = 'pending';
