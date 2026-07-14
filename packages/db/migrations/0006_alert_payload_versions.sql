ALTER TABLE alert_event_payloads
  DROP CONSTRAINT alert_event_payloads_payload_version_check;

ALTER TABLE alert_event_payloads
  ADD CONSTRAINT alert_event_payloads_payload_version_check
  CHECK (payload_version ~ '^v[0-9]+$');
