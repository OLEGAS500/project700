import type { BaselineRole, SourceCheckResult } from "@eim/core";
import type pg from "pg";
import { getPool, withTransaction } from "./client";

type MerchantStatusCounts = {
  total: number;
  approved: number;
  pending: number;
  disapproved: number;
};

type SnapshotRow = {
  id: string;
  store_id: string;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  baseline_role: BaselineRole;
  sitemap_url_count: number | null;
  feed_product_count: number | null;
  merchant_total_count: number | null;
  merchant_approved_count: number | null;
  merchant_pending_count: number | null;
  merchant_disapproved_count: number | null;
  created_at: Date;
};

export type SnapshotRecord = {
  id: string;
  storeId: string;
  status: SnapshotRow["status"];
  baselineRole: BaselineRole;
  sitemapUrlCount: number | null;
  feedProductCount: number | null;
  merchantTotalCount: number | null;
  merchantApprovedCount: number | null;
  merchantPendingCount: number | null;
  merchantDisapprovedCount: number | null;
  createdAt: string;
};

export type SnapshotStore = {
  id: string;
  domain: string;
  sitemapUrl: string;
  feedUrl: string;
  merchantCenterAccountId: string | null;
};

function mapSnapshot(row: SnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    storeId: row.store_id,
    status: row.status,
    baselineRole: row.baseline_role,
    sitemapUrlCount: row.sitemap_url_count,
    feedProductCount: row.feed_product_count,
    merchantTotalCount: row.merchant_total_count,
    merchantApprovedCount: row.merchant_approved_count,
    merchantPendingCount: row.merchant_pending_count,
    merchantDisapprovedCount: row.merchant_disapproved_count,
    createdAt: row.created_at.toISOString()
  };
}

export async function createQueuedSnapshot(
  storeId: string,
  baselineRole: BaselineRole,
  idempotencyKey: string,
  client?: pg.PoolClient
): Promise<SnapshotRecord> {
  const executor = client ?? getPool();
  const result = await executor.query<SnapshotRow>(
    `
      INSERT INTO snapshots (store_id, status, baseline_role, idempotency_key)
      VALUES ($1, 'queued', $2, $3)
      ON CONFLICT (store_id, baseline_role, idempotency_key)
      DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
      RETURNING *
    `,
    [storeId, baselineRole, idempotencyKey]
  );

  return mapSnapshot(result.rows[0]);
}

export async function getLatestQueuedSnapshotForStore(
  storeId: string
): Promise<SnapshotRecord | null> {
  const result = await getPool().query<SnapshotRow>(
    `
      SELECT *
      FROM snapshots
      WHERE store_id = $1 AND status = 'queued'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [storeId]
  );

  return result.rows[0] ? mapSnapshot(result.rows[0]) : null;
}

export async function getSnapshotStore(snapshotId: string): Promise<SnapshotStore | null> {
  const result = await getPool().query<{
    id: string;
    domain: string;
    sitemap_url: string;
    feed_url: string;
    merchant_center_account_id: string | null;
  }>(
    `
      SELECT
        stores.id,
        stores.domain,
        stores.sitemap_url,
        stores.feed_url,
        stores.merchant_center_account_id
      FROM snapshots
      JOIN stores ON stores.id = snapshots.store_id
      WHERE snapshots.id = $1
    `,
    [snapshotId]
  );

  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    domain: row.domain,
    sitemapUrl: row.sitemap_url,
    feedUrl: row.feed_url,
    merchantCenterAccountId: row.merchant_center_account_id
  };
}

export async function persistSourceCheckResult(
  snapshotId: string,
  storeId: string,
  result: SourceCheckResult
): Promise<SnapshotRecord> {
  return withTransaction((client) =>
    persistSourceCheckResultWithClient(client, snapshotId, storeId, result)
  );
}

export async function persistMerchantCenterItemIssuesResult(
  snapshotId: string,
  storeId: string,
  result: SourceCheckResult
): Promise<SnapshotRecord> {
  return withTransaction(async (client) => {
    if (result.status === "success") {
      await client.query(
        `
          DELETE FROM source_items
          WHERE snapshot_id = $1
            AND store_id = $2
            AND source = 'merchant_center'
            AND metadata_json ->> 'merchantDataKind' = 'item_issues'
        `,
        [snapshotId, storeId]
      );
    }

    return persistSourceCheckResultWithClient(client, snapshotId, storeId, result);
  });
}

async function persistSourceCheckResultWithClient(
  client: pg.PoolClient,
  snapshotId: string,
  storeId: string,
  result: SourceCheckResult
): Promise<SnapshotRecord> {
    await client.query(
      `
        UPDATE snapshots
        SET status = 'running', started_at = COALESCE(started_at, now())
        WHERE id = $1
      `,
      [snapshotId]
    );

    await client.query(
      `
        INSERT INTO source_checks (
          snapshot_id,
          store_id,
          source,
          check_key,
          url,
          status,
          started_at,
          finished_at,
          duration_ms,
          http_status,
          items_observed,
          total_items_seen,
          skipped_items,
          error_code,
          error_message,
          error_samples_json,
          metadata_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (snapshot_id, source, check_key)
        DO UPDATE SET
          url = EXCLUDED.url,
          status = EXCLUDED.status,
          started_at = EXCLUDED.started_at,
          finished_at = EXCLUDED.finished_at,
          duration_ms = EXCLUDED.duration_ms,
          http_status = EXCLUDED.http_status,
          items_observed = EXCLUDED.items_observed,
          total_items_seen = EXCLUDED.total_items_seen,
          skipped_items = EXCLUDED.skipped_items,
          error_code = EXCLUDED.error_code,
          error_message = EXCLUDED.error_message,
          error_samples_json = EXCLUDED.error_samples_json,
          metadata_json = source_checks.metadata_json || EXCLUDED.metadata_json
      `,
      [
        snapshotId,
        storeId,
        result.source,
        result.url ?? result.source,
        result.url ?? null,
        result.status,
        result.startedAt,
        result.finishedAt,
        result.durationMs,
        result.httpStatus ?? null,
        result.itemsObserved,
        result.totalItemsSeen ?? null,
        result.skippedItems ?? null,
        result.errorCode ?? null,
        result.errorMessage ?? null,
        JSON.stringify(result.errorSamples ?? []),
        JSON.stringify(result.metadata ?? {})
      ]
    );

    for (const item of result.items) {
      const mergedMetadata = await getMergedSourceItemMetadata(
        client,
        snapshotId,
        item.source,
        item.stableKey,
        item.metadata ?? {}
      );

      await client.query(
        `
          INSERT INTO source_items (
            snapshot_id,
            store_id,
            source,
            stable_key,
            offer_id,
            url,
            title,
            price,
            currency,
            availability,
            image_url,
            http_status,
            indexability,
            canonical_url,
            schema_present,
            merchant_status,
            merchant_issues_json,
            metadata_json,
            raw_hash
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14, $15,
            $16, $17, $18, $19
          )
          ON CONFLICT (snapshot_id, source, stable_key)
          DO UPDATE SET
            offer_id = COALESCE(EXCLUDED.offer_id, source_items.offer_id),
            url = COALESCE(EXCLUDED.url, source_items.url),
            title = COALESCE(EXCLUDED.title, source_items.title),
            price = COALESCE(EXCLUDED.price, source_items.price),
            currency = COALESCE(EXCLUDED.currency, source_items.currency),
            availability = COALESCE(EXCLUDED.availability, source_items.availability),
            image_url = COALESCE(EXCLUDED.image_url, source_items.image_url),
            http_status = COALESCE(EXCLUDED.http_status, source_items.http_status),
            indexability = COALESCE(EXCLUDED.indexability, source_items.indexability),
            canonical_url = COALESCE(EXCLUDED.canonical_url, source_items.canonical_url),
            schema_present = COALESCE(EXCLUDED.schema_present, source_items.schema_present),
            merchant_status = COALESCE(EXCLUDED.merchant_status, source_items.merchant_status),
            merchant_issues_json = COALESCE(EXCLUDED.merchant_issues_json, source_items.merchant_issues_json),
            metadata_json = EXCLUDED.metadata_json,
            raw_hash = EXCLUDED.raw_hash
        `,
        [
          snapshotId,
          storeId,
          item.source,
          item.stableKey,
          item.offerId ?? null,
          item.url ?? null,
          item.title ?? null,
          item.price ?? null,
          item.currency ?? null,
          item.availability ?? null,
          item.imageUrl ?? null,
          item.httpStatus ?? null,
          item.indexability ?? null,
          item.canonicalUrl ?? null,
          item.schemaPresent ?? null,
          item.merchantStatus ?? null,
          item.merchantIssues ? JSON.stringify(item.merchantIssues) : null,
          JSON.stringify(mergedMetadata),
          item.rawHash
        ]
      );
    }

    const merchantCounts =
      result.source === "merchant_center" ? readMerchantStatusCounts(result.metadata) : null;
    const countAssignment =
      result.source === "sitemap"
        ? "sitemap_url_count = $2"
        : result.source === "feed"
          ? "feed_product_count = $2"
          : merchantCounts
            ? `
              merchant_total_count = $2,
              merchant_approved_count = $3,
              merchant_pending_count = $4,
              merchant_disapproved_count = $5
            `
            : "";
    const countValues = merchantCounts
      ? [
          merchantCounts.total,
          merchantCounts.approved,
          merchantCounts.pending,
          merchantCounts.disapproved
        ]
      : result.source === "sitemap" || result.source === "feed"
        ? [result.itemsObserved]
        : [];

    const updated = await client.query<SnapshotRow>(
      `
        WITH status_rollup AS (
          SELECT
            bool_and(status = 'success') AS all_success,
            count(*) FILTER (WHERE status IN ('success', 'partial')) AS useful_checks
          FROM source_checks
          WHERE snapshot_id = $1
        )
        UPDATE snapshots
        SET
          status = CASE
            WHEN status_rollup.all_success THEN 'completed'::snapshot_status
            WHEN status_rollup.useful_checks > 0 THEN 'partial'::snapshot_status
            ELSE 'failed'::snapshot_status
          END,
          finished_at = now()
          ${countAssignment ? `, ${countAssignment}` : ""}
        FROM status_rollup
        WHERE snapshots.id = $1
        RETURNING *
      `,
      [snapshotId, ...countValues]
    );

  return mapSnapshot(updated.rows[0]);
}

export const persistSitemapCheckResult = persistSourceCheckResult;
export const persistFeedCheckResult = persistSourceCheckResult;

function readMerchantStatusCounts(
  metadata: Record<string, unknown> | undefined
): MerchantStatusCounts | null {
  if (!metadata || !isRecord(metadata.merchantStatusCounts)) {
    return null;
  }

  const counts = metadata.merchantStatusCounts;
  const total = readNonNegativeInteger(counts.total);
  const approved = readNonNegativeInteger(counts.approved);
  const pending = readNonNegativeInteger(counts.pending);
  const disapproved = readNonNegativeInteger(counts.disapproved);

  if (
    total === null ||
    approved === null ||
    pending === null ||
    disapproved === null ||
    total !== approved + pending + disapproved
  ) {
    return null;
  }

  return { total, approved, pending, disapproved };
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function getMergedSourceItemMetadata(
  client: pg.PoolClient,
  snapshotId: string,
  source: string,
  stableKey: string | undefined,
  nextMetadata: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!stableKey) {
    return nextMetadata;
  }

  const existing = await client.query<{ metadata_json: Record<string, unknown> }>(
    `
      SELECT metadata_json
      FROM source_items
      WHERE snapshot_id = $1 AND source = $2 AND stable_key = $3
      LIMIT 1
    `,
    [snapshotId, source, stableKey]
  );

  return mergeMetadata(existing.rows[0]?.metadata_json ?? {}, nextMetadata);
}

function mergeMetadata(
  current: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...current,
    ...next
  };

  if (Array.isArray(current.discoveredFrom) || Array.isArray(next.discoveredFrom)) {
    merged.discoveredFrom = dedupeJsonArray([
      ...(Array.isArray(current.discoveredFrom) ? current.discoveredFrom : []),
      ...(Array.isArray(next.discoveredFrom) ? next.discoveredFrom : [])
    ]);
  }

  if (isRecord(current.sourceHashes) || isRecord(next.sourceHashes)) {
    merged.sourceHashes = {
      ...(isRecord(current.sourceHashes) ? current.sourceHashes : {}),
      ...(isRecord(next.sourceHashes) ? next.sourceHashes : {})
    };
  }

  return merged;
}

function dedupeJsonArray(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function listProductPageCandidates(
  snapshotId: string,
  storeId: string,
  limit = 25
): Promise<string[]> {
  const result = await getPool().query<{ url: string }>(
    `
      SELECT url
      FROM source_items
      WHERE snapshot_id = $1
        AND store_id = $2
        AND url IS NOT NULL
        AND (
          source IN ('storefront', 'feed')
          OR url ~* '/products?/'
        )
      GROUP BY url
      ORDER BY md5($2::text || ':' || url)
      LIMIT $3
    `,
    [snapshotId, storeId, limit]
  );

  return result.rows.map((row) => row.url);
}

export async function persistSampleManifest(
  snapshotId: string,
  manifest: {
    sampleStrategy: string;
    productPageParserVersion?: string;
    normalizationVersion?: string;
    schemaValidationVersion?: string;
    requestedSampleSize: number;
    selectedCount: number;
    selectedUrlsHash: string;
    selectedUrls: string[];
  }
): Promise<void> {
  await getPool().query(
    `
      UPDATE snapshots
      SET sample_manifest_json = $2
      WHERE id = $1
    `,
    [snapshotId, JSON.stringify(manifest)]
  );
}

export type SourceMatchInput = {
  matchedKey: string;
  matchMethod: "offer_id" | "normalized_url" | "canonical_url" | "fallback";
  matchConfidence: number;
  sitemapItemId?: string;
  feedItemId?: string;
  storefrontItemId?: string;
  metadata?: Record<string, unknown>;
};

export async function replaceSourceMatches(
  snapshotId: string,
  storeId: string,
  matches: SourceMatchInput[]
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query("DELETE FROM source_matches WHERE snapshot_id = $1", [snapshotId]);

    for (const match of matches) {
      await client.query(
        `
          INSERT INTO source_matches (
            snapshot_id,
            store_id,
            matched_key,
            match_method,
            match_confidence,
            sitemap_item_id,
            feed_item_id,
            storefront_item_id,
            metadata_json
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          snapshotId,
          storeId,
          match.matchedKey,
          match.matchMethod,
          match.matchConfidence,
          match.sitemapItemId ?? null,
          match.feedItemId ?? null,
          match.storefrontItemId ?? null,
          JSON.stringify(match.metadata ?? {})
        ]
      );
    }
  });
}

export type MatchableSourceItem = {
  id: string;
  source: "sitemap" | "feed" | "storefront" | "merchant_center";
  stableKey: string;
  offerId: string | null;
  url: string | null;
  canonicalUrl: string | null;
  metadata: Record<string, unknown>;
};

export async function listMatchableSourceItems(
  snapshotId: string,
  storeId: string
): Promise<MatchableSourceItem[]> {
  const result = await getPool().query<{
    id: string;
    source: MatchableSourceItem["source"];
    stable_key: string;
    offer_id: string | null;
    url: string | null;
    canonical_url: string | null;
    metadata_json: Record<string, unknown>;
  }>(
    `
      SELECT id, source, stable_key, offer_id, url, canonical_url, metadata_json
      FROM source_items
      WHERE snapshot_id = $1 AND store_id = $2
        AND source IN ('sitemap', 'feed', 'storefront', 'merchant_center')
    `,
    [snapshotId, storeId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    source: row.source,
    stableKey: row.stable_key,
    offerId: row.offer_id,
    url: row.url,
    canonicalUrl: row.canonical_url,
    metadata: row.metadata_json ?? {}
  }));
}
