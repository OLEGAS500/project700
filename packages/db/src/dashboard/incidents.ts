import type { IncidentSeverity, IncidentStatus, IncidentType } from "@eim/core";
import { getPool } from "../client";

export type DashboardIncidentListItem = {
  id: string;
  storeId: string;
  storeName: string;
  type: IncidentType;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  summary: string;
  affectedCount: number;
  likelySource: string | null;
  confidenceScore: number | null;
  firstDetectedAt: string;
  updatedAt: string;
};

export type DashboardIncidentListInput = {
  storeId?: string;
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  type?: IncidentType;
  source?: string;
  cursor?: string;
  limit?: number;
};

export type DashboardIncidentListResult = {
  incidents: DashboardIncidentListItem[];
  nextCursor: string | null;
};

export class InvalidDashboardCursorError extends Error {
  constructor() {
    super("cursor must be a valid dashboard incident cursor");
    this.name = "InvalidDashboardCursorError";
  }
}

export type DashboardIncidentListRow = {
  id: string;
  store_id: string;
  store_name: string;
  type: IncidentType;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  summary: string;
  affected_count: number;
  likely_source: string | null;
  confidence_score: string | null;
  first_detected_at: Date;
  updated_at: Date;
  updated_at_cursor: string;
};

type DashboardIncidentCursor = {
  updatedAt: string;
  id: string;
};

const defaultLimit = 50;

export async function listDashboardIncidents(
  input: DashboardIncidentListInput = {}
): Promise<DashboardIncidentListResult> {
  const limit = input.limit ?? defaultLimit;
  const cursor = input.cursor ? decodeDashboardIncidentCursor(input.cursor) : null;
  const result = await getPool().query<DashboardIncidentListRow>(
    `
      SELECT
        incidents.id,
        incidents.store_id,
        stores.name AS store_name,
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
      WHERE ($1::uuid IS NULL OR incidents.store_id = $1)
        AND ($2::incident_status IS NULL OR incidents.status = $2)
        AND ($3::incident_severity IS NULL OR incidents.severity = $3)
        AND ($4::incident_type IS NULL OR incidents.type = $4)
        AND ($5::text IS NULL OR incidents.likely_source = $5)
        AND (
          $6::timestamptz IS NULL
          OR (incidents.updated_at, incidents.id) < ($6::timestamptz, $7::uuid)
        )
      ORDER BY incidents.updated_at DESC, incidents.id DESC
      LIMIT $8
    `,
    [
      input.storeId ?? null,
      input.status ?? null,
      input.severity ?? null,
      input.type ?? null,
      input.source ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      limit + 1
    ]
  );

  const page = result.rows.slice(0, limit);
  const last = page.at(-1);

  return {
    incidents: page.map(mapDashboardIncidentListItem),
    nextCursor:
      result.rows.length > limit && last
        ? encodeDashboardIncidentCursor({ updatedAt: last.updated_at_cursor, id: last.id })
        : null
  };
}

export function mapDashboardIncidentListItem(
  row: DashboardIncidentListRow
): DashboardIncidentListItem {
  return {
    id: row.id,
    storeId: row.store_id,
    storeName: row.store_name,
    type: row.type,
    severity: row.severity,
    status: row.status,
    title: row.title,
    summary: row.summary,
    affectedCount: row.affected_count,
    likelySource: row.likely_source,
    confidenceScore: row.confidence_score === null ? null : Number(row.confidence_score),
    firstDetectedAt: row.first_detected_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export function encodeDashboardIncidentCursor(cursor: DashboardIncidentCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeDashboardIncidentCursor(value: string): DashboardIncidentCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !isRecord(parsed) ||
      typeof parsed.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      typeof parsed.id !== "string" ||
      !isUuid(parsed.id)
    ) {
      throw new InvalidDashboardCursorError();
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch (error) {
    if (error instanceof InvalidDashboardCursorError) throw error;
    throw new InvalidDashboardCursorError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}
