CREATE TABLE email_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL UNIQUE REFERENCES stores(id) ON DELETE CASCADE,
  recipient_emails TEXT[] NOT NULL CHECK (
    cardinality(recipient_emails) BETWEEN 1 AND 20
    AND array_position(recipient_emails, NULL) IS NULL
  ),
  enabled BOOLEAN NOT NULL DEFAULT true,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX email_destinations_enabled_store_idx
  ON email_destinations (store_id)
  WHERE enabled = true;
