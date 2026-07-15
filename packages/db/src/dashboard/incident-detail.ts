import type { IncidentStatus } from "@eim/core";
import { getPool } from "../client";
import {
  mapDashboardIncidentListItem,
  type DashboardIncidentListItem,
  type DashboardIncidentListRow
} from "./incidents";

const maximumSamples = 20;
const maximumTimelineEvents = 100;
const maximumComments = 100;

type DashboardIncidentDetailRow = DashboardIncidentListRow & {
  store_domain: string;
};

type DashboardTimelineRow = {
  id: string;
  event_type: string;
  from_status: IncidentStatus | null;
  to_status: IncidentStatus | null;
  message: string;
  metadata_json: Record<string, unknown>;
  created_at: Date;
};

type DashboardSignalRow = {
  id: string;
  source: string;
  metric: string;
  before_value: string | null;
  after_value: string | null;
  change_abs: string | null;
  change_pct: string | null;
  sample_items_json: unknown;
  created_at: Date;
};

type DashboardCommentRow = {
  id: string;
  body: string;
  created_at: Date;
};

type DashboardAlertDeliveryRow = {
  channel: "email" | "telegram";
  status: string;
  attempt_count: number;
  last_error: string | null;
  sent_at: Date | null;
};

export type DashboardIncidentDetail = {
  incident: DashboardIncidentListItem;
  store: {
    id: string;
    name: string;
    domain: string;
  };
  timeline: Array<{
    id: string;
    type: string;
    reason: string | null;
    fromStatus: IncidentStatus | null;
    toStatus: IncidentStatus | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
  signals: Array<{
    id: string;
    type: string;
    metric: string;
    source: string | null;
    metrics: Record<string, number | null>;
    evidence: { sampleCount: number };
    createdAt: string;
  }>;
  samples: Array<{
    stableKey: string | null;
    offerId: string | null;
    title: string | null;
    url: string | null;
  }>;
  comments: Array<{
    id: string;
    body: string;
    createdAt: string;
  }>;
  alertDeliveries: Array<{
    channel: "email" | "telegram";
    status: string;
    attemptCount: number;
    lastErrorCode: string | null;
    sentAt: string | null;
  }>;
};

export async function getDashboardIncidentDetail(
  incidentId: string
): Promise<DashboardIncidentDetail | null> {
  const pool = getPool();
  const incidentResult = await pool.query<DashboardIncidentDetailRow>(
    `
      SELECT
        incidents.id,
        incidents.store_id,
        stores.name AS store_name,
        stores.domain AS store_domain,
        incidents.type,
        incidents.severity,
        incidents.status,
        incidents.title,
        incidents.summary,
        incidents.affected_count,
        incidents.likely_source,
        incidents.confidence_score,
        incidents.first_detected_at,
        incidents.updated_at,
        to_char(
          incidents.updated_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS updated_at_cursor
      FROM incidents
      JOIN stores ON stores.id = incidents.store_id
      WHERE incidents.id = $1
    `,
    [incidentId]
  );
  const incident = incidentResult.rows[0];
  if (!incident) return null;

  const [timelineResult, signalResult, commentResult, deliveryResult] = await Promise.all([
    pool.query<DashboardTimelineRow>(
      `
        SELECT id, event_type, from_status, to_status, message, metadata_json, created_at
        FROM incident_events
        WHERE incident_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2
      `,
      [incidentId, maximumTimelineEvents]
    ),
    pool.query<DashboardSignalRow>(
      `
        SELECT
          id,
          source,
          metric,
          before_value,
          after_value,
          change_abs,
          change_pct,
          sample_items_json,
          created_at
        FROM incident_signals
        WHERE incident_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [incidentId]
    ),
    pool.query<DashboardCommentRow>(
      `
        SELECT id, body, created_at
        FROM incident_comments
        WHERE incident_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2
      `,
      [incidentId, maximumComments]
    ),
    pool.query<DashboardAlertDeliveryRow>(
      `
        SELECT channel, status::text, attempt_count, last_error, sent_at
        FROM alert_deliveries
        WHERE incident_id = $1
          AND channel IN ('email', 'telegram')
        ORDER BY created_at ASC, id ASC
      `,
      [incidentId]
    )
  ]);

  return {
    incident: mapDashboardIncidentListItem(incident),
    store: {
      id: incident.store_id,
      name: incident.store_name,
      domain: incident.store_domain
    },
    timeline: timelineResult.rows.map((row) => ({
      id: row.id,
      type: row.event_type,
      reason: readReason(row.metadata_json) ?? nullableText(row.message),
      fromStatus: row.from_status,
      toStatus: row.to_status,
      metadata: redactTimelineMetadata(row.metadata_json),
      createdAt: row.created_at.toISOString()
    })),
    signals: signalResult.rows.map((row) => ({
      id: row.id,
      type: row.metric,
      metric: row.metric,
      source: row.source,
      metrics: {
        beforeValue: toNumber(row.before_value),
        afterValue: toNumber(row.after_value),
        changeAbs: toNumber(row.change_abs),
        changePct: toNumber(row.change_pct)
      },
      evidence: { sampleCount: Array.isArray(row.sample_items_json) ? row.sample_items_json.length : 0 },
      createdAt: row.created_at.toISOString()
    })),
    samples: signalResult.rows
      .flatMap((row) => normalizeSamples(row.sample_items_json))
      .slice(0, maximumSamples),
    comments: commentResult.rows.map((row) => ({
      id: row.id,
      body: row.body,
      createdAt: row.created_at.toISOString()
    })),
    alertDeliveries: deliveryResult.rows.map((row) => ({
      channel: row.channel,
      status: row.status,
      attemptCount: row.attempt_count,
      lastErrorCode: safeDeliveryErrorCode(row.last_error),
      sentAt: row.sent_at?.toISOString() ?? null
    }))
  };
}

function normalizeSamples(value: unknown): DashboardIncidentDetail["samples"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const sample = {
      stableKey: nullableText(item.stableKey) ?? nullableText(item.stable_key),
      offerId: nullableText(item.offerId) ?? nullableText(item.offer_id),
      title: nullableText(item.title),
      url: nullableText(item.url)
    };
    return sample.stableKey || sample.offerId || sample.title || sample.url ? [sample] : [];
  });
}

function readReason(metadata: Record<string, unknown>): string | null {
  return nullableText(metadata.reason);
}

function redactTimelineMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).flatMap(([key, value]) => {
      if (isSensitiveMetadataKey(key)) return [];
      return [[key, redactMetadataValue(value)]];
    })
  );
}

function redactMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMetadataValue);
  if (!isRecord(value)) return value;
  return redactTimelineMetadata(value);
}

function isSensitiveMetadataKey(key: string): boolean {
  return /(?:actor|token|secret|password|authorization|api[_-]?key|recipient|email|chat[_-]?id|thread[_-]?id|provider|payload|body|content)/i.test(
    key
  );
}

function safeDeliveryErrorCode(value: string | null): string | null {
  if (!value) return null;
  const candidate = value.split(":", 1)[0]?.trim() ?? "";
  return /^[a-z][a-z0-9_]{0,100}$/.test(candidate) ? candidate : "delivery_failed";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}
