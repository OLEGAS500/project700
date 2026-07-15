import { getPool } from "../client";
import { createHash } from "node:crypto";
import {
  buildMerchantIssueSummary,
  type MerchantIssuePriority,
  type MerchantIssueTriageSourceRow
} from "./merchant-issue-triage";

export type DashboardMerchantRemediationSort = "priority" | "issue_count" | "stable_key" | "title";

export type DashboardMerchantRemediationQueueInput = {
  incidentId: string;
  issueCode?: string | null;
  severity?: string | null;
  priority?: MerchantIssuePriority | null;
  search?: string | null;
  sort?: DashboardMerchantRemediationSort;
  cursor?: string | null;
  limit?: number;
};

export type DashboardMerchantRemediationQueueItem = {
  stableKey: string;
  offerId: string | null;
  title: string | null;
  priority: MerchantIssuePriority;
  issueCount: number;
  issueCodes: string[];
  affectedAttributes: string[];
  detailsTruncated: boolean;
};

export type DashboardMerchantRemediationQueueResult = {
  items: DashboardMerchantRemediationQueueItem[];
  nextCursor: string | null;
};

export class InvalidDashboardMerchantRemediationCursorError extends Error {
  constructor() {
    super("cursor must be a valid Merchant remediation queue cursor");
    this.name = "InvalidDashboardMerchantRemediationCursorError";
  }
}

type QueueRow = {
  id: string;
  stable_key: string;
  stable_key_key: string;
  offer_id: string | null;
  title: string | null;
  merchant_issues_json: unknown;
  details_truncated: boolean;
  issue_count: number;
  priority_rank: number;
  title_key: string;
};

export type DashboardMerchantRemediationQueueCursor = {
  version: 2;
  sort: DashboardMerchantRemediationSort;
  priorityRank: number;
  issueCount: number;
  stableKey: string;
  titleKey: string;
  sourceItemId: string;
  filterFingerprint: string;
};

const defaultQueueLimit = 25;
const maximumQueueLimit = 50;
const maximumQueueSortKeyLength = 256;
const maximumIssuesForQueueRow = 100;
const maximumCursorLength = 2048;
const cursorVersion = 2 as const;

export async function listDashboardMerchantRemediationQueue(
  input: DashboardMerchantRemediationQueueInput
): Promise<DashboardMerchantRemediationQueueResult> {
  const sort = isSort(input.sort) ? input.sort : "priority";
  const limit = Math.min(Math.max(input.limit ?? defaultQueueLimit, 1), maximumQueueLimit);
  const issueCode = normalizeQueueFilter(input.issueCode, maximumQueueSortKeyLength);
  const severity = normalizeQueueFilter(input.severity, maximumQueueSortKeyLength)?.toLowerCase() ?? null;
  const priority = isPriority(input.priority) ? input.priority : null;
  const search = normalizeQueueFilter(input.search, 200);
  const filterFingerprint = createQueueFilterFingerprint({
    incidentId: input.incidentId,
    issueCode,
    severity,
    priority,
    search,
    sort
  });
  const cursor = input.cursor ? decodeDashboardMerchantRemediationCursor(input.cursor) : null;
  if (cursor && (cursor.sort !== sort || cursor.filterFingerprint !== filterFingerprint)) {
    throw new InvalidDashboardMerchantRemediationCursorError();
  }

  const escapedSearch = search ? `%${escapeLikePattern(search)}%` : null;
  const orderBy = orderByFor(sort);
  const cursorCondition = cursorConditionFor(sort);
  const result = await getPool().query<QueueRow>(
    `
      WITH incident_context AS (
        SELECT opened_snapshot_id, store_id, type
        FROM incidents
        WHERE id = $1
      ),
      bounded_items AS (
        SELECT
          source_items.id,
          source_items.stable_key,
          LEFT(source_items.stable_key, ${maximumQueueSortKeyLength}) AS stable_key_key,
          source_items.offer_id,
          source_items.title,
          CASE
            WHEN jsonb_typeof(source_items.merchant_issues_json) = 'array'
            THEN jsonb_path_query_array(
              source_items.merchant_issues_json,
              '$[0 to ${maximumIssuesForQueueRow - 1}]'
            )
            ELSE '[]'::jsonb
          END AS merchant_issues_json,
          CASE
            WHEN jsonb_typeof(source_items.merchant_issues_json) = 'array'
            THEN jsonb_array_length(source_items.merchant_issues_json) > ${maximumIssuesForQueueRow}
            ELSE false
          END AS details_truncated
        FROM source_items
        JOIN incident_context
          ON incident_context.opened_snapshot_id = source_items.snapshot_id
         AND incident_context.store_id = source_items.store_id
         AND incident_context.type = 'merchant_item_issues'
        WHERE source_items.source = 'merchant_center'
          AND source_items.metadata_json ->> 'merchantDataKind' = 'item_issues'
      ),
      item_issues AS (
        SELECT
          bounded_items.id,
          bounded_items.stable_key,
          bounded_items.stable_key_key,
          bounded_items.offer_id,
          bounded_items.title,
          bounded_items.merchant_issues_json,
          bounded_items.details_truncated,
          issue
        FROM bounded_items
        CROSS JOIN LATERAL jsonb_array_elements(bounded_items.merchant_issues_json) AS issue
      ),
      normalized_issues AS (
        SELECT
          id,
          stable_key,
          stable_key_key,
          offer_id,
          title,
          merchant_issues_json,
          details_truncated,
          NULLIF(LEFT(BTRIM(issue ->> 'code'), ${maximumQueueSortKeyLength}), '') AS code,
          LOWER(LEFT(COALESCE(NULLIF(BTRIM(issue ->> 'severity'), ''), 'unknown'), ${maximumQueueSortKeyLength})) AS severity,
          LEFT(COALESCE(NULLIF(BTRIM(issue ->> 'attribute'), ''), 'unknown'), ${maximumQueueSortKeyLength}) AS attribute
        FROM item_issues
      ),
      item_rollup AS (
        SELECT
          id,
          stable_key,
          stable_key_key,
          offer_id,
          title,
          merchant_issues_json,
          details_truncated,
          COUNT(DISTINCT CASE
            WHEN code IS NOT NULL THEN CONCAT_WS(
              CHR(31),
              code,
              severity,
              attribute
            )
          END)::integer AS issue_count,
          MAX(CASE
            WHEN code IS NULL THEN NULL
            WHEN severity IN ('critical', 'error', 'disapproved', 'severe') THEN 3
            WHEN severity = 'warning' THEN 2
            ELSE 1
          END)::integer AS priority_rank,
          BOOL_OR(
            $2::text IS NOT NULL
            AND code = $2
          ) AS matches_issue_code,
          BOOL_OR(
            $3::text IS NOT NULL
            AND code IS NOT NULL
            AND severity = $3
          ) AS matches_severity,
          LEFT(COALESCE(title, ''), ${maximumQueueSortKeyLength}) AS title_key
        FROM normalized_issues
        GROUP BY id, stable_key, stable_key_key, offer_id, title, merchant_issues_json, details_truncated
      )
      SELECT
        id,
        stable_key,
        stable_key_key,
        offer_id,
        title,
        merchant_issues_json,
        details_truncated,
        issue_count,
        priority_rank,
        title_key
      FROM item_rollup
      WHERE issue_count > 0
        AND ($2::text IS NULL OR matches_issue_code)
        AND ($3::text IS NULL OR matches_severity)
        AND ($4::text IS NULL OR priority_rank = CASE $4
          WHEN 'critical' THEN 3
          WHEN 'high' THEN 2
          ELSE 1
        END)
        AND ($5::text IS NULL OR (
          stable_key_key ILIKE $5 ESCAPE '\\'
          OR LEFT(COALESCE(offer_id, ''), ${maximumQueueSortKeyLength}) ILIKE $5 ESCAPE '\\'
          OR title_key ILIKE $5 ESCAPE '\\'
        ))
        AND ($9::text IS NULL OR $9::text IS NOT NULL)
        ${cursorCondition}
      ORDER BY ${orderBy}
      LIMIT $11
    `,
    [
      input.incidentId,
      issueCode,
      severity,
      priority,
      escapedSearch,
      cursor?.priorityRank ?? null,
      cursor?.issueCount ?? null,
      cursor?.stableKey ?? null,
      cursor?.titleKey ?? null,
      cursor?.sourceItemId ?? null,
      limit + 1
    ]
  );

  const pageRows = result.rows.slice(0, limit);
  const items = pageRows.flatMap((row) => mapQueueItem(row));
  const lastRow = pageRows.at(-1);

  return {
    items,
    nextCursor:
      result.rows.length > limit && lastRow
        ? encodeDashboardMerchantRemediationCursor({
            version: cursorVersion,
            sort,
            priorityRank: lastRow.priority_rank,
            issueCount: lastRow.issue_count,
            stableKey: lastRow.stable_key_key,
            titleKey: lastRow.title_key,
            sourceItemId: lastRow.id,
            filterFingerprint
          })
        : null
  };
}

export function encodeDashboardMerchantRemediationCursor(
  cursor: DashboardMerchantRemediationQueueCursor
): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeDashboardMerchantRemediationCursor(value: string): DashboardMerchantRemediationQueueCursor {
  try {
    if (value.length > maximumCursorLength) throw new InvalidDashboardMerchantRemediationCursorError();
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isRecord(parsed)) throw new InvalidDashboardMerchantRemediationCursorError();
    const priorityRank = parsed.priorityRank;
    const issueCount = parsed.issueCount;
    if (
      parsed.version !== cursorVersion ||
      !isSort(parsed.sort) ||
      !isSafeInteger(priorityRank) ||
      priorityRank < 1 ||
      priorityRank > 3 ||
      !isSafeInteger(issueCount) ||
      issueCount < 0 ||
      issueCount > maximumIssuesForQueueRow ||
      typeof parsed.stableKey !== "string" ||
      !hasAtMostCodePoints(parsed.stableKey, maximumQueueSortKeyLength) ||
      typeof parsed.titleKey !== "string" ||
      !hasAtMostCodePoints(parsed.titleKey, maximumQueueSortKeyLength) ||
      typeof parsed.sourceItemId !== "string" ||
      !isUuid(parsed.sourceItemId) ||
      typeof parsed.filterFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/i.test(parsed.filterFingerprint)
    ) {
      throw new InvalidDashboardMerchantRemediationCursorError();
    }
    return {
      version: cursorVersion,
      sort: parsed.sort,
      priorityRank,
      issueCount,
      stableKey: parsed.stableKey,
      titleKey: parsed.titleKey,
      sourceItemId: parsed.sourceItemId,
      filterFingerprint: parsed.filterFingerprint
    };
  } catch (error) {
    if (error instanceof InvalidDashboardMerchantRemediationCursorError) throw error;
    throw new InvalidDashboardMerchantRemediationCursorError();
  }
}

function mapQueueItem(row: QueueRow): DashboardMerchantRemediationQueueItem[] {
  const sourceRow: MerchantIssueTriageSourceRow = {
    stableKey: row.stable_key,
    offerId: row.offer_id,
    title: row.title,
    issues: row.merchant_issues_json
  };
  const summary = buildMerchantIssueSummary([sourceRow]);
  const product = summary.prioritizedProducts[0];
  if (!product) return [];
  return [
    {
      stableKey: product.stableKey ?? row.stable_key.slice(0, maximumQueueSortKeyLength),
      offerId: product.offerId,
      title: product.title,
      priority: product.priority,
      issueCount: product.issueCount,
      issueCodes: product.issueCodes,
      affectedAttributes: product.affectedAttributes,
      detailsTruncated: row.details_truncated || summary.truncated
    }
  ];
}

function orderByFor(sort: DashboardMerchantRemediationSort): string {
  switch (sort) {
    case "issue_count":
      return "issue_count DESC, priority_rank DESC, stable_key_key ASC, id ASC";
    case "stable_key":
      return "stable_key_key ASC, priority_rank DESC, issue_count DESC, id ASC";
    case "title":
      return "title_key ASC, priority_rank DESC, issue_count DESC, stable_key_key ASC, id ASC";
    case "priority":
    default:
      return "priority_rank DESC, issue_count DESC, stable_key_key ASC, id ASC";
  }
}

function cursorConditionFor(sort: DashboardMerchantRemediationSort): string {
  switch (sort) {
    case "issue_count":
      return `
        AND (
          $7::integer IS NULL
          OR issue_count < $7
          OR (issue_count = $7 AND priority_rank < $6)
          OR (issue_count = $7 AND priority_rank = $6 AND stable_key_key > $8)
          OR (issue_count = $7 AND priority_rank = $6 AND stable_key_key = $8 AND id > $10)
        )`;
    case "stable_key":
      return `
        AND (
          $8::text IS NULL
          OR stable_key_key > $8
          OR (stable_key_key = $8 AND priority_rank < $6)
          OR (stable_key_key = $8 AND priority_rank = $6 AND issue_count < $7)
          OR (stable_key_key = $8 AND priority_rank = $6 AND issue_count = $7 AND id > $10)
        )`;
    case "title":
      return `
        AND (
          $9::text IS NULL
          OR title_key > $9
          OR (title_key = $9 AND priority_rank < $6)
          OR (title_key = $9 AND priority_rank = $6 AND issue_count < $7)
          OR (title_key = $9 AND priority_rank = $6 AND issue_count = $7 AND stable_key_key > $8)
          OR (title_key = $9 AND priority_rank = $6 AND issue_count = $7 AND stable_key_key = $8 AND id > $10)
        )`;
    case "priority":
    default:
      return `
        AND (
          $6::integer IS NULL
          OR priority_rank < $6
          OR (priority_rank = $6 AND issue_count < $7)
          OR (priority_rank = $6 AND issue_count = $7 AND stable_key_key > $8)
          OR (priority_rank = $6 AND issue_count = $7 AND stable_key_key = $8 AND id > $10)
        )`;
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function normalizeQueueFilter(value: string | null | undefined, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, maximumLength);
  return normalized || null;
}

function createQueueFilterFingerprint(input: {
  incidentId: string;
  issueCode: string | null;
  severity: string | null;
  priority: MerchantIssuePriority | null;
  search: string | null;
  sort: DashboardMerchantRemediationSort;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function isSort(value: unknown): value is DashboardMerchantRemediationSort {
  return value === "priority" || value === "issue_count" || value === "stable_key" || value === "title";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPriority(value: unknown): value is MerchantIssuePriority {
  return value === "critical" || value === "high" || value === "normal";
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function hasAtMostCodePoints(value: string, maximumLength: number): boolean {
  return [...value].length <= maximumLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
