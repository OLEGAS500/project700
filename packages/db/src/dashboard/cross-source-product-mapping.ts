import { normalizeOfferId } from "@eim/core";
import { merchantItemIssuesConfigurationHash } from "../incidents/merchant-item-issues";
import { withTransaction } from "../client";

export type CrossSourceProductMatchInput = {
  feedSnapshotId: string;
  merchantSnapshotId: string;
};

export type CrossSourceProductMatchStatus =
  | "matched"
  | "feed_only"
  | "merchant_only"
  | "ambiguous";

export type CrossSourceProductMatchSide = {
  stableKey: string | null;
  offerId: string | null;
  title: string | null;
};

export type ProductMatchSample = {
  identityKey: string;
  identityKeyTruncated: boolean;
  feedCount: number;
  merchantCount: number;
  feed: CrossSourceProductMatchSide | null;
  merchant: CrossSourceProductMatchSide | null;
};

export type CrossSourceProductMatchSummary = {
  feedSnapshotId: string;
  merchantSnapshotId: string;
  storeId: string;
  comparable: boolean;
  incompatibilityReason:
    | "source_check_missing"
    | "source_check_incomplete"
    | "merchant_identity_inventory_missing"
    | "merchant_configuration_mismatch"
    | null;
  feedCheckStatus: string | null;
  merchantCheckStatus: string | null;
  matchedCount: number;
  feedOnlyCount: number;
  merchantOnlyCount: number;
  ambiguousCount: number;
  samples: {
    matched: ProductMatchSample[];
    feedOnly: ProductMatchSample[];
    merchantOnly: ProductMatchSample[];
    ambiguous: ProductMatchSample[];
  };
  truncated: boolean;
};

const merchantItemIssuesVersion = "v1";
const merchantItemIssuesCheckKey = "merchant_center:item_issues";
const merchantProductIdentityVersion = "v1";
const maximumSampleCountPerStatus = 50;
const maximumOutputTextLength = 256;
const maximumTotalCount = 1_000_000;

type SnapshotContextRow = {
  id: string;
  store_id: string;
  merchant_center_account_id: string | null;
  feed_check_status: string | null;
  merchant_check_status: string | null;
  merchant_item_issues_version: string | null;
  merchant_product_identity_version: string | null;
  merchant_product_identity_complete: boolean | null;
  merchant_configuration_hash: string | null;
};

type MatchCountRow = {
  matched_count: string;
  feed_only_count: string;
  merchant_only_count: string;
  ambiguous_count: string;
};

type MatchSampleRow = {
  status: CrossSourceProductMatchStatus;
  identity_key: string;
  identity_key_truncated: boolean;
  feed_count: string;
  merchant_count: string;
  feed_stable_key: string | null;
  feed_offer_id: string | null;
  feed_title: string | null;
  merchant_stable_key: string | null;
  merchant_offer_id: string | null;
  merchant_title: string | null;
};

export async function getCrossSourceProductMatchSummary(
  input: CrossSourceProductMatchInput
): Promise<CrossSourceProductMatchSummary | null> {
  if (!isUuid(input.feedSnapshotId) || !isUuid(input.merchantSnapshotId)) {
    return null;
  }

  return withTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const contextResult = await client.query<SnapshotContextRow>(
      `
        SELECT
          snapshots.id,
          snapshots.store_id,
          stores.merchant_center_account_id,
          feed_check.status::text AS feed_check_status,
          merchant_check.status::text AS merchant_check_status,
          merchant_check.metadata_json ->> 'merchantItemIssuesVersion'
            AS merchant_item_issues_version,
          merchant_check.metadata_json ->> 'merchantProductIdentityVersion'
            AS merchant_product_identity_version,
          merchant_check.metadata_json ->> 'merchantProductIdentityComplete' = 'true'
            AS merchant_product_identity_complete,
          merchant_check.metadata_json ->> 'merchantItemIssuesConfigurationHash'
            AS merchant_configuration_hash
        FROM snapshots
        JOIN stores ON stores.id = snapshots.store_id
        LEFT JOIN LATERAL (
          SELECT status
          FROM source_checks
          WHERE source_checks.snapshot_id = snapshots.id
            AND source_checks.store_id = snapshots.store_id
            AND source_checks.source = 'feed'
          ORDER BY finished_at DESC, created_at DESC, id DESC
          LIMIT 1
        ) AS feed_check ON true
        LEFT JOIN LATERAL (
          SELECT status, metadata_json
          FROM source_checks
          WHERE source_checks.snapshot_id = snapshots.id
            AND source_checks.store_id = snapshots.store_id
            AND source_checks.source = 'merchant_center'
            AND source_checks.check_key = $2
            AND source_checks.metadata_json ->> 'merchantItemIssuesVersion' = $3
          ORDER BY finished_at DESC, created_at DESC, id DESC
          LIMIT 1
        ) AS merchant_check ON true
        WHERE snapshots.id = ANY($1::uuid[])
      `,
      [[input.feedSnapshotId, input.merchantSnapshotId], merchantItemIssuesCheckKey, merchantItemIssuesVersion]
    );

    const contexts = new Map(contextResult.rows.map((row) => [row.id, row]));
    const feedContext = contexts.get(input.feedSnapshotId);
    const merchantContext = contexts.get(input.merchantSnapshotId);

    if (!feedContext || !merchantContext || feedContext.store_id !== merchantContext.store_id) {
      return null;
    }

    const feedCheckStatus = feedContext.feed_check_status;
    const merchantCheckStatus = merchantContext.merchant_check_status;
    const hasSourceChecks = Boolean(feedCheckStatus && merchantCheckStatus);
    const sourceChecksComplete = feedCheckStatus === "success" && merchantCheckStatus === "success";
    const configurationHash = merchantContext.merchant_center_account_id
      ? merchantItemIssuesConfigurationHash(merchantContext.merchant_center_account_id)
      : null;
    const configurationMatches =
      merchantContext.merchant_item_issues_version === merchantItemIssuesVersion &&
      /^[0-9a-f]{64}$/.test(merchantContext.merchant_configuration_hash ?? "") &&
      merchantContext.merchant_configuration_hash === configurationHash;
    const hasCompleteMerchantIdentityInventory =
      merchantContext.merchant_product_identity_version === merchantProductIdentityVersion &&
      merchantContext.merchant_product_identity_complete === true;

    const incompatibilityReason = !hasSourceChecks
      ? "source_check_missing"
      : !sourceChecksComplete
        ? "source_check_incomplete"
        : !hasCompleteMerchantIdentityInventory
          ? "merchant_identity_inventory_missing"
        : !configurationMatches
          ? "merchant_configuration_mismatch"
          : null;

    if (incompatibilityReason) {
      return emptySummary({
        feedSnapshotId: input.feedSnapshotId,
        merchantSnapshotId: input.merchantSnapshotId,
        storeId: feedContext.store_id,
        comparable: false,
        incompatibilityReason,
        feedCheckStatus,
        merchantCheckStatus
      });
    }

    const queryValues = [
      input.feedSnapshotId,
      input.merchantSnapshotId,
      merchantContext.merchant_configuration_hash
    ];
    const countResult = await client.query<MatchCountRow>(
      `${buildMappingCtes()}
       SELECT
         COUNT(*) FILTER (WHERE status = 'matched')::text AS matched_count,
         COUNT(*) FILTER (WHERE status = 'feed_only')::text AS feed_only_count,
         COUNT(*) FILTER (WHERE status = 'merchant_only')::text AS merchant_only_count,
         COUNT(*) FILTER (WHERE status = 'ambiguous')::text AS ambiguous_count
       FROM classified_matches`,
      queryValues
    );
    const sampleResult = await client.query<MatchSampleRow>(
      `${buildMappingCtes()}
       , ranked_matches AS (
         SELECT
           classified_matches.*,
           ROW_NUMBER() OVER (
             PARTITION BY status
             ORDER BY identity_key
           ) AS sample_rank
         FROM classified_matches
       )
       SELECT
         status,
         LEFT(identity_key, ${maximumOutputTextLength}) AS identity_key,
         CHAR_LENGTH(identity_key) > ${maximumOutputTextLength} AS identity_key_truncated,
         feed_count::text,
         merchant_count::text,
         feed_stable_key,
         feed_offer_id,
         feed_title,
         merchant_stable_key,
         merchant_offer_id,
         merchant_title
       FROM ranked_matches
       WHERE sample_rank <= ${maximumSampleCountPerStatus}
       ORDER BY status, identity_key`,
      queryValues
    );

    const counts = countResult.rows[0];
    if (!counts) {
      throw new Error("Cross-source product mapping count query returned no row");
    }

    const matched = boundedCount(counts.matched_count);
    const feedOnly = boundedCount(counts.feed_only_count);
    const merchantOnly = boundedCount(counts.merchant_only_count);
    const ambiguous = boundedCount(counts.ambiguous_count);
    const samples = {
      matched: [] as ProductMatchSample[],
      feedOnly: [] as ProductMatchSample[],
      merchantOnly: [] as ProductMatchSample[],
      ambiguous: [] as ProductMatchSample[]
    };

    for (const row of sampleResult.rows) {
      const sample = mapSample(row);
      if (row.status === "matched") samples.matched.push(sample);
      else if (row.status === "feed_only") samples.feedOnly.push(sample);
      else if (row.status === "merchant_only") samples.merchantOnly.push(sample);
      else samples.ambiguous.push(sample);
    }

    return {
      feedSnapshotId: input.feedSnapshotId,
      merchantSnapshotId: input.merchantSnapshotId,
      storeId: feedContext.store_id,
      comparable: true,
      incompatibilityReason: null,
      feedCheckStatus,
      merchantCheckStatus,
      matchedCount: matched.value,
      feedOnlyCount: feedOnly.value,
      merchantOnlyCount: merchantOnly.value,
      ambiguousCount: ambiguous.value,
      samples,
      truncated:
        matched.truncated ||
        feedOnly.truncated ||
        merchantOnly.truncated ||
        ambiguous.truncated ||
        matched.value > samples.matched.length ||
        feedOnly.value > samples.feedOnly.length ||
        merchantOnly.value > samples.merchantOnly.length ||
        ambiguous.value > samples.ambiguous.length
    };
  });
}

export function normalizeCrossSourceOfferId(value: string | null | undefined): string | null {
  return normalizeOfferId(value) ?? null;
}

export function normalizeCrossSourceStableKey(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function emptySummary(input: {
  feedSnapshotId: string;
  merchantSnapshotId: string;
  storeId: string;
  comparable: false;
  incompatibilityReason: NonNullable<CrossSourceProductMatchSummary["incompatibilityReason"]>;
  feedCheckStatus: string | null;
  merchantCheckStatus: string | null;
}): CrossSourceProductMatchSummary {
  return {
    ...input,
    matchedCount: 0,
    feedOnlyCount: 0,
    merchantOnlyCount: 0,
    ambiguousCount: 0,
    samples: {
      matched: [],
      feedOnly: [],
      merchantOnly: [],
      ambiguous: []
    },
    truncated: false
  };
}

function mapSample(row: MatchSampleRow): ProductMatchSample {
  return {
    identityKey: row.identity_key,
    identityKeyTruncated: row.identity_key_truncated,
    feedCount: boundedCount(row.feed_count).value,
    merchantCount: boundedCount(row.merchant_count).value,
    feed:
      row.feed_stable_key || row.feed_offer_id || row.feed_title
        ? {
            stableKey: row.feed_stable_key,
            offerId: row.feed_offer_id,
            title: row.feed_title
          }
        : null,
    merchant:
      row.merchant_stable_key || row.merchant_offer_id || row.merchant_title
        ? {
            stableKey: row.merchant_stable_key,
            offerId: row.merchant_offer_id,
            title: row.merchant_title
          }
        : null
  };
}

function boundedCount(value: string): { value: number; truncated: boolean } {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { value: maximumTotalCount, truncated: true };
  }
  return {
    value: Math.min(parsed, maximumTotalCount),
    truncated: parsed > maximumTotalCount
  };
}

function buildMappingCtes(): string {
  return `
    WITH feed_records AS (
      SELECT
        source_items.id::text AS row_id,
        'feed'::text AS side,
        NULLIF(
          LOWER(BTRIM(REGEXP_REPLACE(source_items.offer_id, '[[:space:]]+', ' ', 'g'))),
          ''
        ) AS offer_key,
        NULLIF(LOWER(BTRIM(source_items.stable_key)), '') AS stable_key,
        LEFT(NULLIF(BTRIM(source_items.stable_key), ''), ${maximumOutputTextLength}) AS stable_key_display,
        LEFT(
          NULLIF(BTRIM(REGEXP_REPLACE(source_items.offer_id, '[[:space:]]+', ' ', 'g')), ''),
          ${maximumOutputTextLength}
        ) AS offer_id_display,
        LEFT(NULLIF(BTRIM(source_items.title), ''), ${maximumOutputTextLength}) AS title
      FROM source_items
      JOIN snapshots AS feed_snapshot
        ON feed_snapshot.id = source_items.snapshot_id
       AND feed_snapshot.store_id = source_items.store_id
      WHERE source_items.snapshot_id = $1
        AND source_items.source = 'feed'
    ),
    merchant_records AS (
      SELECT
        source_items.id::text AS row_id,
        'merchant'::text AS side,
        NULLIF(
          LOWER(BTRIM(REGEXP_REPLACE(source_items.offer_id, '[[:space:]]+', ' ', 'g'))),
          ''
        ) AS offer_key,
        NULLIF(LOWER(BTRIM(source_items.stable_key)), '') AS stable_key,
        LEFT(NULLIF(BTRIM(source_items.stable_key), ''), ${maximumOutputTextLength}) AS stable_key_display,
        LEFT(
          NULLIF(BTRIM(REGEXP_REPLACE(source_items.offer_id, '[[:space:]]+', ' ', 'g')), ''),
          ${maximumOutputTextLength}
        ) AS offer_id_display,
        LEFT(NULLIF(BTRIM(source_items.title), ''), ${maximumOutputTextLength}) AS title
      FROM source_items
      JOIN snapshots AS merchant_snapshot
        ON merchant_snapshot.id = source_items.snapshot_id
       AND merchant_snapshot.store_id = source_items.store_id
      WHERE source_items.snapshot_id = $2
        AND source_items.source = 'merchant_center'
        AND source_items.metadata_json ->> 'merchantDataKind' = 'product_identity'
        AND source_items.metadata_json ->> 'merchantProductIdentityVersion' = 'v1'
        AND source_items.metadata_json ->> 'merchantItemIssuesConfigurationHash' = $3
    ),
    all_records AS (
      SELECT
        row_id,
        side,
        offer_key,
        stable_key,
        stable_key_display,
        offer_id_display,
        title
      FROM feed_records
      UNION ALL
      SELECT
        row_id,
        side,
        offer_key,
        stable_key,
        stable_key_display,
        offer_id_display,
        title
      FROM merchant_records
    ),
    offer_groups AS (
      SELECT
        offer_key,
        COUNT(*) FILTER (WHERE side = 'feed') AS feed_count,
        COUNT(*) FILTER (WHERE side = 'merchant') AS merchant_count,
        MIN(stable_key_display) FILTER (WHERE side = 'feed') AS feed_stable_key,
        MIN(offer_id_display) FILTER (WHERE side = 'feed') AS feed_offer_id,
        MIN(title) FILTER (WHERE side = 'feed') AS feed_title,
        MIN(stable_key_display) FILTER (WHERE side = 'merchant') AS merchant_stable_key,
        MIN(offer_id_display) FILTER (WHERE side = 'merchant') AS merchant_offer_id,
        MIN(title) FILTER (WHERE side = 'merchant') AS merchant_title
      FROM all_records
      WHERE offer_key IS NOT NULL
      GROUP BY offer_key
    ),
    resolved_offer_groups AS (
      SELECT
        offer_groups.*,
        CASE
          WHEN feed_count > 1 OR merchant_count > 1
            THEN 'ambiguous'
          WHEN feed_count = 1 AND merchant_count = 1
            THEN 'matched'
          ELSE NULL
        END AS status
      FROM offer_groups
    ),
    offer_classifications AS (
      SELECT
        'offer:' || offer_key AS identity_key,
        feed_count,
        merchant_count,
        feed_stable_key,
        feed_offer_id,
        feed_title,
        merchant_stable_key,
        merchant_offer_id,
        merchant_title,
        status
      FROM resolved_offer_groups
      WHERE status IS NOT NULL
    ),
    remaining_records AS (
      SELECT all_records.*
      FROM all_records
      LEFT JOIN resolved_offer_groups
        ON resolved_offer_groups.offer_key = all_records.offer_key
      WHERE resolved_offer_groups.status IS NULL
    ),
    stable_groups AS (
      SELECT
        stable_key,
        COUNT(*) FILTER (WHERE side = 'feed') AS feed_count,
        COUNT(*) FILTER (WHERE side = 'merchant') AS merchant_count,
        MIN(offer_key) FILTER (WHERE side = 'feed') AS feed_offer_key,
        MIN(offer_key) FILTER (WHERE side = 'merchant') AS merchant_offer_key,
        MIN(stable_key_display) FILTER (WHERE side = 'feed') AS feed_stable_key,
        MIN(offer_id_display) FILTER (WHERE side = 'feed') AS feed_offer_id,
        MIN(title) FILTER (WHERE side = 'feed') AS feed_title,
        MIN(stable_key_display) FILTER (WHERE side = 'merchant') AS merchant_stable_key,
        MIN(offer_id_display) FILTER (WHERE side = 'merchant') AS merchant_offer_id,
        MIN(title) FILTER (WHERE side = 'merchant') AS merchant_title
      FROM remaining_records
      WHERE stable_key IS NOT NULL
      GROUP BY stable_key
    ),
    stable_classifications AS (
      SELECT
        CASE
          WHEN feed_count = 1 AND merchant_count = 0
            THEN COALESCE('offer:' || feed_offer_key, 'stable:' || stable_key)
          WHEN feed_count = 0 AND merchant_count = 1
            THEN COALESCE('offer:' || merchant_offer_key, 'stable:' || stable_key)
          ELSE 'stable:' || stable_key
        END AS identity_key,
        feed_count,
        merchant_count,
        feed_stable_key,
        feed_offer_id,
        feed_title,
        merchant_stable_key,
        merchant_offer_id,
        merchant_title,
        CASE
          WHEN feed_count > 1 OR merchant_count > 1 THEN 'ambiguous'
          WHEN feed_count = 1 AND merchant_count = 1 THEN 'matched'
          WHEN feed_count = 1 THEN 'feed_only'
          ELSE 'merchant_only'
        END::text AS status
      FROM stable_groups
      WHERE NOT (
        feed_count = 1
        AND merchant_count = 1
        AND feed_offer_key IS NOT NULL
        AND merchant_offer_key IS NOT NULL
        AND feed_offer_key <> merchant_offer_key
      )
    ),
    stable_offer_disagreements AS (
      SELECT
        'offer:' || feed_offer_key AS identity_key,
        1::bigint AS feed_count,
        0::bigint AS merchant_count,
        feed_stable_key,
        feed_offer_id,
        feed_title,
        NULL::text AS merchant_stable_key,
        NULL::text AS merchant_offer_id,
        NULL::text AS merchant_title,
        'feed_only'::text AS status
      FROM stable_groups
      WHERE feed_count = 1
        AND merchant_count = 1
        AND feed_offer_key IS NOT NULL
        AND merchant_offer_key IS NOT NULL
        AND feed_offer_key <> merchant_offer_key
      UNION ALL
      SELECT
        'offer:' || merchant_offer_key AS identity_key,
        0::bigint AS feed_count,
        1::bigint AS merchant_count,
        NULL::text AS feed_stable_key,
        NULL::text AS feed_offer_id,
        NULL::text AS feed_title,
        merchant_stable_key,
        merchant_offer_id,
        merchant_title,
        'merchant_only'::text AS status
      FROM stable_groups
      WHERE feed_count = 1
        AND merchant_count = 1
        AND feed_offer_key IS NOT NULL
        AND merchant_offer_key IS NOT NULL
        AND feed_offer_key <> merchant_offer_key
    ),
    unidentified_classifications AS (
      SELECT
        COALESCE('offer:' || offer_key, 'unidentified:' || row_id) AS identity_key,
        CASE WHEN side = 'feed' THEN 1::bigint ELSE 0::bigint END AS feed_count,
        CASE WHEN side = 'merchant' THEN 1::bigint ELSE 0::bigint END AS merchant_count,
        CASE WHEN side = 'feed' THEN stable_key_display ELSE NULL::text END AS feed_stable_key,
        CASE WHEN side = 'feed' THEN offer_id_display ELSE NULL::text END AS feed_offer_id,
        CASE WHEN side = 'feed' THEN title ELSE NULL::text END AS feed_title,
        CASE WHEN side = 'merchant' THEN stable_key_display ELSE NULL::text END AS merchant_stable_key,
        CASE WHEN side = 'merchant' THEN offer_id_display ELSE NULL::text END AS merchant_offer_id,
        CASE WHEN side = 'merchant' THEN title ELSE NULL::text END AS merchant_title,
        CASE WHEN offer_key IS NULL THEN 'ambiguous' ELSE side || '_only' END AS status
      FROM remaining_records
      WHERE stable_key IS NULL
    ),
    classified_matches AS (
      SELECT * FROM offer_classifications
      UNION ALL
      SELECT * FROM stable_classifications
      UNION ALL
      SELECT * FROM stable_offer_disagreements
      UNION ALL
      SELECT * FROM unidentified_classifications
    )`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
