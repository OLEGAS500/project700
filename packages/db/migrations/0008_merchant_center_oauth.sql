CREATE TABLE merchant_center_oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX merchant_center_oauth_states_hash_idx
  ON merchant_center_oauth_states (state_hash);

CREATE INDEX merchant_center_oauth_states_store_idx
  ON merchant_center_oauth_states (store_id, created_at DESC);

CREATE INDEX merchant_center_oauth_states_expiry_idx
  ON merchant_center_oauth_states (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE merchant_center_oauth_credentials (
  store_id UUID PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  expires_at TIMESTAMPTZ NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  credentials_version INTEGER NOT NULL DEFAULT 1 CHECK (credentials_version >= 1),
  refresh_lock_id UUID,
  refresh_lock_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((refresh_lock_id IS NULL) = (refresh_lock_expires_at IS NULL))
);

CREATE INDEX merchant_center_oauth_credentials_refresh_lock_idx
  ON merchant_center_oauth_credentials (refresh_lock_expires_at)
  WHERE refresh_lock_id IS NOT NULL;
