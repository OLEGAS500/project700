ALTER TABLE incidents
  ADD COLUMN catalog_drop_candidate_id UUID
    REFERENCES incident_candidates(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX incidents_catalog_drop_candidate_idx
  ON incidents (catalog_drop_candidate_id)
  WHERE catalog_drop_candidate_id IS NOT NULL;

CREATE UNIQUE INDEX incident_events_feed_merchant_correlation_incident_idx
  ON incident_events (incident_id)
  WHERE event_type = 'feed_merchant_correlation_confirmed';
