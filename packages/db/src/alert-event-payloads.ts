import {
  canonicalAlertPayloadSchema,
  type AlertType,
  type CanonicalAlertPayload,
  type CanonicalAlertSample,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentType
} from "@eim/core";
import type pg from "pg";

const maximumSamples = 8;
const maximumEvidenceItems = 10;

type AlertEventPayloadRow = {
  id: string;
  incident_event_id: string;
  incident_id: string;
  store_id: string;
  alert_type: AlertType;
  payload_version: string;
  payload_json: unknown;
  created_at: Date;
};

type AlertPayloadContextRow = {
  store_id: string;
  store_name: string;
  store_domain: string;
  incident_id: string;
  incident_type: IncidentType;
  incident_severity: IncidentSeverity;
  incident_title: string;
  incident_summary: string;
  incident_status: IncidentStatus;
  affected_count: number;
  likely_source: string | null;
  confidence_score: string | null;
  evidence_json: unknown;
  first_detected_at: Date;
  event_id: string;
  event_type: string;
  event_message: string;
  event_metadata: Record<string, unknown>;
  event_created_at: Date;
};

type AlertPayloadSignalRow = {
  metric: string;
  before_value: string | null;
  after_value: string | null;
  sample_items_json: unknown;
};

export type AlertEventPayloadRecord = {
  id: string;
  incidentEventId: string;
  incidentId: string;
  storeId: string;
  alertType: AlertType;
  payloadVersion: "v1";
  payload: CanonicalAlertPayload;
  createdAt: string;
};

export type DeliveryAlertPayloadState =
  | { status: "valid"; payload: CanonicalAlertPayload }
  | { status: "payload_validation_failed" }
  | { status: "unsupported_payload_version" };

export async function createOrGetAlertEventPayload(
  client: pg.PoolClient,
  input: { incidentId: string; eventId: string; alertType: AlertType }
): Promise<AlertEventPayloadRecord> {
  const existing = await getAlertEventPayloadByEventId(input.eventId, client);
  if (existing) {
    assertPayloadIdentity(existing, input);
    return existing;
  }

  const contextResult = await client.query<AlertPayloadContextRow>(
    `
      SELECT
        stores.id AS store_id,
        stores.name AS store_name,
        stores.domain AS store_domain,
        incidents.id AS incident_id,
        incidents.type AS incident_type,
        incidents.severity AS incident_severity,
        incidents.title AS incident_title,
        incidents.summary AS incident_summary,
        incidents.status AS incident_status,
        incidents.affected_count,
        incidents.likely_source,
        incidents.confidence_score,
        incidents.evidence_json,
        incidents.first_detected_at,
        incident_events.id AS event_id,
        incident_events.event_type,
        incident_events.message AS event_message,
        incident_events.metadata_json AS event_metadata,
        incident_events.created_at AS event_created_at
      FROM incidents
      JOIN stores ON stores.id = incidents.store_id
      JOIN incident_events
        ON incident_events.incident_id = incidents.id
       AND incident_events.store_id = stores.id
      WHERE incidents.id = $1
        AND incident_events.id = $2
    `,
    [input.incidentId, input.eventId]
  );
  const context = contextResult.rows[0];
  if (!context) {
    throw new Error(
      `Incident event ${input.eventId} was not found for incident ${input.incidentId}`
    );
  }

  const signals = await client.query<AlertPayloadSignalRow>(
    `
      SELECT metric, before_value, after_value, sample_items_json
      FROM incident_signals
      WHERE incident_id = $1
      ORDER BY created_at ASC, metric ASC
    `,
    [input.incidentId]
  );
  const payload = buildCanonicalAlertPayload(context, signals.rows, input.alertType);

  const inserted = await client.query<AlertEventPayloadRow>(
    `
      INSERT INTO alert_event_payloads (
        incident_event_id,
        incident_id,
        store_id,
        alert_type,
        payload_version,
        payload_json,
        created_at
      )
      VALUES ($1, $2, $3, $4, 'v1', $5::jsonb, clock_timestamp())
      ON CONFLICT (incident_event_id) DO NOTHING
      RETURNING *
    `,
    [
      input.eventId,
      input.incidentId,
      context.store_id,
      input.alertType,
      JSON.stringify(payload)
    ]
  );

  if (inserted.rows[0]) return mapAlertEventPayload(inserted.rows[0]);

  const concurrentlyCreated = await getAlertEventPayloadByEventId(input.eventId, client);
  if (!concurrentlyCreated) {
    throw new Error(`Alert payload ${input.eventId} was not created`);
  }
  assertPayloadIdentity(concurrentlyCreated, input);
  return concurrentlyCreated;
}

export async function getAlertEventPayloadByEventId(
  eventId: string,
  executor: Pick<pg.Pool | pg.PoolClient, "query">
): Promise<AlertEventPayloadRecord | null> {
  const result = await executor.query<AlertEventPayloadRow>(
    "SELECT * FROM alert_event_payloads WHERE incident_event_id = $1",
    [eventId]
  );
  return result.rows[0] ? mapAlertEventPayload(result.rows[0]) : null;
}

export async function getAlertEventPayloadsByEventIds(
  eventIds: string[],
  executor: Pick<pg.Pool | pg.PoolClient, "query">
): Promise<Map<string, AlertEventPayloadRecord>> {
  if (eventIds.length === 0) return new Map();
  const result = await executor.query<AlertEventPayloadRow>(
    "SELECT * FROM alert_event_payloads WHERE incident_event_id = ANY($1::uuid[])",
    [eventIds]
  );
  return new Map(
    result.rows.map((row) => {
      const payload = mapAlertEventPayload(row);
      return [payload.incidentEventId, payload];
    })
  );
}

export async function getDeliveryAlertPayloadStatesByEventIds(
  eventIds: string[],
  executor: Pick<pg.Pool | pg.PoolClient, "query">
): Promise<Map<string, DeliveryAlertPayloadState>> {
  if (eventIds.length === 0) return new Map();
  const result = await executor.query<AlertEventPayloadRow>(
    "SELECT * FROM alert_event_payloads WHERE incident_event_id = ANY($1::uuid[])",
    [eventIds]
  );
  return new Map(
    result.rows.map((row) => [row.incident_event_id, classifyDeliveryPayload(row)])
  );
}

function buildCanonicalAlertPayload(
  context: AlertPayloadContextRow,
  signals: AlertPayloadSignalRow[],
  alertType: AlertType
): CanonicalAlertPayload {
  const samples = signals
    .flatMap((signal) => normalizeSamples(signal.sample_items_json))
    .slice(0, maximumSamples);
  const reason = stringValue(context.event_metadata?.reason);

  return canonicalAlertPayloadSchema.parse({
    version: "v1",
    alertType,
    store: {
      id: context.store_id,
      name: context.store_name,
      domain: context.store_domain
    },
    incident: {
      id: context.incident_id,
      type: context.incident_type,
      severity: context.incident_severity,
      title: context.incident_title,
      summary: context.incident_summary,
      status: context.incident_status,
      affectedCount: context.affected_count,
      likelySource: context.likely_source,
      confidenceScore:
        context.confidence_score === null ? null : Number(context.confidence_score),
      firstDetectedAt: context.first_detected_at.toISOString()
    },
    metrics: signals.map((signal) => ({
      name: signal.metric,
      beforeValue: signal.before_value,
      afterValue: signal.after_value,
      unit: metricUnit(signal.metric)
    })),
    evidence: normalizeEvidence(context.evidence_json, context.event_message),
    samples,
    event: {
      id: context.event_id,
      type: context.event_type,
      reason,
      occurredAt: context.event_created_at.toISOString()
    }
  });
}

function normalizeEvidence(value: unknown, eventMessage: string): string[] {
  const values = Array.isArray(value) ? value : [];
  const evidence = values
    .map((item) => evidenceString(item))
    .filter((item): item is string => item !== null)
    .slice(0, maximumEvidenceItems);
  if (evidence.length === 0 && eventMessage.trim()) evidence.push(eventMessage.trim());
  return evidence;
}

function evidenceString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return null;

  for (const key of ["reason", "message", "description", "status"]) {
    const candidate = stringValue(value[key]);
    if (candidate) return candidate;
  }

  const serialized = JSON.stringify(value);
  return serialized === "{}" ? null : serialized;
}

function normalizeSamples(value: unknown): CanonicalAlertSample[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const sample: CanonicalAlertSample = {};
    const stableKey = stringValue(item.stableKey) ?? stringValue(item.stable_key);
    const offerId = stringValue(item.offerId) ?? stringValue(item.offer_id);
    const url = stringValue(item.url);
    const title = stringValue(item.title);
    if (stableKey) sample.stableKey = stableKey;
    if (offerId) sample.offerId = offerId;
    if (url) sample.url = url;
    if (title) sample.title = title;
    return Object.keys(sample).length > 0 ? [sample] : [];
  });
}

function metricUnit(metric: string): string | null {
  if (metric === "source_check_failure_count") return "checks";
  if (["noindex", "canonical_away", "schema_missing", "http_error"].includes(metric)) {
    return "pages";
  }
  if (
    metric.includes("product") ||
    metric.includes("mismatch") ||
    metric === "matched_storefront_missing_from_feed"
  ) {
    return "products";
  }
  return null;
}

function mapAlertEventPayload(row: AlertEventPayloadRow): AlertEventPayloadRecord {
  const state = classifyDeliveryPayload(row);
  if (state.status !== "valid") {
    throw new Error(`Alert payload ${row.id} does not match its relational identity`);
  }

  return {
    id: row.id,
    incidentEventId: row.incident_event_id,
    incidentId: row.incident_id,
    storeId: row.store_id,
    alertType: row.alert_type,
    payloadVersion: "v1",
    payload: state.payload,
    createdAt: row.created_at.toISOString()
  };
}

function classifyDeliveryPayload(row: AlertEventPayloadRow): DeliveryAlertPayloadState {
  if (row.payload_version !== "v1") {
    return { status: "unsupported_payload_version" };
  }

  const parsed = canonicalAlertPayloadSchema.safeParse(row.payload_json);
  if (!parsed.success) return { status: "payload_validation_failed" };

  const payload = parsed.data;
  if (
    payload.version !== row.payload_version ||
    payload.alertType !== row.alert_type ||
    payload.event.id !== row.incident_event_id ||
    payload.incident.id !== row.incident_id ||
    payload.store.id !== row.store_id
  ) {
    return { status: "payload_validation_failed" };
  }

  return { status: "valid", payload };
}

function assertPayloadIdentity(
  payload: AlertEventPayloadRecord,
  expected: { incidentId: string; eventId: string; alertType: AlertType }
): void {
  if (
    payload.incidentId !== expected.incidentId ||
    payload.incidentEventId !== expected.eventId ||
    payload.alertType !== expected.alertType
  ) {
    throw new Error(`Alert payload ${expected.eventId} already exists with different identity`);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
