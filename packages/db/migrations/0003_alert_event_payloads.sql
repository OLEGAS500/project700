CREATE TABLE alert_event_payloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_event_id UUID NOT NULL UNIQUE REFERENCES incident_events(id) ON DELETE NO ACTION,
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL CHECK (
    alert_type IN ('incident_opened', 'incident_worsened', 'incident_resolved')
  ),
  payload_version TEXT NOT NULL CHECK (payload_version = 'v1'),
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX alert_event_payloads_incident_created_idx
  ON alert_event_payloads (incident_id, created_at DESC);
