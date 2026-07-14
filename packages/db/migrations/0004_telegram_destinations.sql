CREATE TABLE telegram_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL UNIQUE REFERENCES stores(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL CHECK (length(btrim(chat_id)) BETWEEN 1 AND 128),
  thread_id INTEGER CHECK (thread_id IS NULL OR thread_id > 0),
  display_name TEXT CHECK (
    display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 120
  ),
  enabled BOOLEAN NOT NULL DEFAULT true,
  verified_at TIMESTAMPTZ,
  last_verification_error TEXT,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX telegram_destinations_enabled_store_idx
  ON telegram_destinations (store_id)
  WHERE enabled = true;
