import type {
  AcknowledgeIncidentInput,
  AddIncidentCommentInput,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  IgnoreIncidentInput
} from "@eim/core";
import type pg from "pg";
import { getPool, withTransaction } from "../client";

type IncidentRow = {
  id: string;
  store_id: string;
  baseline_metric_id: string | null;
  baseline_version: number | null;
  baseline_median: string | null;
  configuration_hash: string | null;
  before_value: string | null;
  after_value: string | null;
  thresholds_json: Record<string, unknown>;
  opened_snapshot_id: string | null;
  closed_snapshot_id: string | null;
  severity: IncidentSeverity;
  type: IncidentType;
  title: string;
  summary: string;
  likely_source: string | null;
  confidence_score: string | null;
  evidence_json: unknown[];
  affected_count: number;
  first_detected_at: Date;
  last_seen_at: Date;
  status: IncidentStatus;
  resolved_at: Date | null;
  ignored_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

type IncidentSignalRow = {
  id: string;
  source: string;
  metric: string;
  before_value: string | null;
  after_value: string | null;
  change_abs: string | null;
  change_pct: string | null;
  sample_items_json: unknown[];
  created_at: Date;
};

type IncidentEventRow = {
  id: string;
  snapshot_id: string | null;
  event_type: string;
  from_status: IncidentStatus | null;
  to_status: IncidentStatus | null;
  message: string;
  metadata_json: Record<string, unknown>;
  created_at: Date;
};

type IncidentCommentRow = {
  id: string;
  actor: string;
  body: string;
  created_at: Date;
};

export type IncidentRecord = {
  id: string;
  storeId: string;
  baselineMetricId: string | null;
  baselineVersion: number | null;
  baselineMedian: number | null;
  configurationHash: string | null;
  beforeValue: number | null;
  afterValue: number | null;
  thresholds: Record<string, unknown>;
  openedSnapshotId: string | null;
  closedSnapshotId: string | null;
  severity: IncidentSeverity;
  type: IncidentType;
  title: string;
  summary: string;
  likelySource: string | null;
  confidenceScore: number | null;
  evidence: unknown[];
  affectedCount: number;
  firstDetectedAt: string;
  lastSeenAt: string;
  status: IncidentStatus;
  resolvedAt: string | null;
  ignoredReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IncidentSignalRecord = {
  id: string;
  source: string;
  metric: string;
  beforeValue: number | null;
  afterValue: number | null;
  changeAbs: number | null;
  changePct: number | null;
  sampleItems: unknown[];
  createdAt: string;
};

export type IncidentEventRecord = {
  id: string;
  snapshotId: string | null;
  eventType: string;
  fromStatus: IncidentStatus | null;
  toStatus: IncidentStatus | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type IncidentCommentRecord = {
  id: string;
  actor: string;
  body: string;
  createdAt: string;
};

export type IncidentDetail = IncidentRecord & {
  signals: IncidentSignalRecord[];
  events: IncidentEventRecord[];
  comments: IncidentCommentRecord[];
};

export class IncidentNotFoundError extends Error {
  constructor(incidentId: string) {
    super(`Incident ${incidentId} was not found`);
    this.name = "IncidentNotFoundError";
  }
}

export class IncidentActionConflictError extends Error {
  constructor(action: "acknowledge" | "ignore", status: IncidentStatus) {
    super(`Cannot ${action} an incident with status ${status}`);
    this.name = "IncidentActionConflictError";
  }
}

export async function listIncidents(input: {
  storeId: string;
  status?: IncidentStatus;
}): Promise<IncidentRecord[]> {
  const result = await getPool().query<IncidentRow>(
    `
      SELECT *
      FROM incidents
      WHERE store_id = $1
        AND ($2::incident_status IS NULL OR status = $2)
      ORDER BY last_seen_at DESC, created_at DESC
    `,
    [input.storeId, input.status ?? null]
  );

  return result.rows.map(mapIncident);
}

export async function getIncidentDetail(incidentId: string): Promise<IncidentDetail | null> {
  const pool = getPool();
  const incidentResult = await pool.query<IncidentRow>(
    "SELECT * FROM incidents WHERE id = $1",
    [incidentId]
  );
  const incident = incidentResult.rows[0];

  if (!incident) {
    return null;
  }

  const [signals, events, comments] = await Promise.all([
    pool.query<IncidentSignalRow>(
      `
        SELECT *
        FROM incident_signals
        WHERE incident_id = $1
        ORDER BY source ASC, metric ASC
      `,
      [incidentId]
    ),
    pool.query<IncidentEventRow>(
      `
        SELECT id, snapshot_id, event_type, from_status, to_status, message, metadata_json, created_at
        FROM incident_events
        WHERE incident_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [incidentId]
    ),
    pool.query<IncidentCommentRow>(
      `
        SELECT id, actor, body, created_at
        FROM incident_comments
        WHERE incident_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [incidentId]
    )
  ]);

  return {
    ...mapIncident(incident),
    signals: signals.rows.map(mapIncidentSignal),
    events: events.rows.map(mapIncidentEvent),
    comments: comments.rows.map(mapIncidentComment)
  };
}

export async function acknowledgeIncident(
  incidentId: string,
  input: AcknowledgeIncidentInput
): Promise<IncidentRecord> {
  return withTransaction(async (client) => {
    const incident = await getIncidentForUpdate(client, incidentId);

    if (incident.status === "acknowledged") {
      return mapIncident(incident);
    }

    if (!["open", "investigating"].includes(incident.status)) {
      throw new IncidentActionConflictError("acknowledge", incident.status);
    }

    const updated = await client.query<IncidentRow>(
      `
        UPDATE incidents
        SET status = 'acknowledged', updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [incidentId]
    );
    const acknowledged = updated.rows[0];

    await insertUserActionEvent(client, {
      incident: acknowledged,
      eventType: "incident_acknowledged",
      fromStatus: incident.status,
      toStatus: "acknowledged",
      message: "Incident acknowledged.",
      metadata: { actor: input.actor }
    });

    if (input.comment) {
      await insertComment(client, acknowledged, input.actor, input.comment);
    }

    return mapIncident(acknowledged);
  });
}

export async function ignoreIncident(
  incidentId: string,
  input: IgnoreIncidentInput
): Promise<IncidentRecord> {
  return withTransaction(async (client) => {
    const incident = await getIncidentForUpdate(client, incidentId);

    if (incident.status === "ignored") {
      return mapIncident(incident);
    }

    if (!["open", "investigating", "acknowledged", "recovering"].includes(incident.status)) {
      throw new IncidentActionConflictError("ignore", incident.status);
    }

    const updated = await client.query<IncidentRow>(
      `
        UPDATE incidents
        SET status = 'ignored',
            ignored_reason = $2,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [incidentId, input.reason]
    );
    const ignored = updated.rows[0];

    await insertUserActionEvent(client, {
      incident: ignored,
      eventType: "incident_ignored",
      fromStatus: incident.status,
      toStatus: "ignored",
      message: "Incident ignored by user decision.",
      metadata: { actor: input.actor, reason: input.reason }
    });

    return mapIncident(ignored);
  });
}

export async function addIncidentComment(
  incidentId: string,
  input: AddIncidentCommentInput
): Promise<IncidentCommentRecord> {
  return withTransaction(async (client) => {
    const incident = await getIncidentForUpdate(client, incidentId);
    return insertComment(client, incident, input.actor, input.body);
  });
}

async function getIncidentForUpdate(
  client: pg.PoolClient,
  incidentId: string
): Promise<IncidentRow> {
  const result = await client.query<IncidentRow>(
    "SELECT * FROM incidents WHERE id = $1 FOR UPDATE",
    [incidentId]
  );
  const incident = result.rows[0];

  if (!incident) {
    throw new IncidentNotFoundError(incidentId);
  }

  return incident;
}

async function insertComment(
  client: pg.PoolClient,
  incident: IncidentRow,
  actor: string,
  body: string
): Promise<IncidentCommentRecord> {
  const inserted = await client.query<IncidentCommentRow>(
    `
      INSERT INTO incident_comments (incident_id, store_id, actor, body, created_at)
      VALUES ($1, $2, $3, $4, clock_timestamp())
      RETURNING id, actor, body, created_at
    `,
    [incident.id, incident.store_id, actor, body]
  );
  const comment = inserted.rows[0];

  await insertUserActionEvent(client, {
    incident,
    eventType: "incident_commented",
    fromStatus: incident.status,
    toStatus: incident.status,
    message: "Incident comment added.",
    metadata: { actor, commentId: comment.id }
  });

  return mapIncidentComment(comment);
}

async function insertUserActionEvent(
  client: pg.PoolClient,
  input: {
    incident: IncidentRow;
    eventType: string;
    fromStatus: IncidentStatus;
    toStatus: IncidentStatus;
    message: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO incident_events (
        incident_id,
        store_id,
        event_type,
        from_status,
        to_status,
        message,
        metadata_json,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, clock_timestamp())
    `,
    [
      input.incident.id,
      input.incident.store_id,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      input.message,
      JSON.stringify(input.metadata)
    ]
  );
}

function mapIncident(row: IncidentRow): IncidentRecord {
  return {
    id: row.id,
    storeId: row.store_id,
    baselineMetricId: row.baseline_metric_id,
    baselineVersion: row.baseline_version,
    baselineMedian: toNumber(row.baseline_median),
    configurationHash: row.configuration_hash,
    beforeValue: toNumber(row.before_value),
    afterValue: toNumber(row.after_value),
    thresholds: row.thresholds_json,
    openedSnapshotId: row.opened_snapshot_id,
    closedSnapshotId: row.closed_snapshot_id,
    severity: row.severity,
    type: row.type,
    title: row.title,
    summary: row.summary,
    likelySource: row.likely_source,
    confidenceScore: toNumber(row.confidence_score),
    evidence: row.evidence_json,
    affectedCount: row.affected_count,
    firstDetectedAt: row.first_detected_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    status: row.status,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    ignoredReason: row.ignored_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapIncidentSignal(row: IncidentSignalRow): IncidentSignalRecord {
  return {
    id: row.id,
    source: row.source,
    metric: row.metric,
    beforeValue: toNumber(row.before_value),
    afterValue: toNumber(row.after_value),
    changeAbs: toNumber(row.change_abs),
    changePct: toNumber(row.change_pct),
    sampleItems: row.sample_items_json,
    createdAt: row.created_at.toISOString()
  };
}

function mapIncidentEvent(row: IncidentEventRow): IncidentEventRecord {
  return {
    id: row.id,
    snapshotId: row.snapshot_id,
    eventType: row.event_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    message: row.message,
    metadata: row.metadata_json,
    createdAt: row.created_at.toISOString()
  };
}

function mapIncidentComment(row: IncidentCommentRow): IncidentCommentRecord {
  return {
    id: row.id,
    actor: row.actor,
    body: row.body,
    createdAt: row.created_at.toISOString()
  };
}

function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}
