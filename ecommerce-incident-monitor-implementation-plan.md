# Ecommerce Incident Monitor Implementation Plan

## Goal

Build v0.1 that reliably detects one core scenario:

> A significant group of products is lost or diverges between storefront, sitemap, XML feed, and optional Merchant Center, then the system groups signals into one clear incident and sends a useful alert.

The implementation should optimize for trust:

- Distinguish real business incidents from monitor/source failures.
- Confirm critical drops before alarming.
- Use baselines instead of one-snapshot comparisons.
- Keep alerts sparse and actionable.

## Recommended Repository Structure

```text
apps/web
  app
    dashboard
    stores
    incidents
    settings
  components
  lib

apps/worker
  jobs
    run-store-check.ts
    run-confirmation-check.ts
    send-alerts.ts
  sources
    sitemap.ts
    feed.ts
    category.ts
    product-page.ts
    merchant-center.ts
  incident-engine
    baseline.ts
    compare.ts
    confidence.ts
    rules.ts
    recovery.ts

packages/core
  types.ts
  thresholds.ts
  normalize.ts
  product-key.ts

packages/db
  schema.ts
  migrations
  repositories

packages/integrations
  google
    merchant.ts
    oauth.ts
  telegram.ts
  email.ts
```

For fastest start, this can still live in one Next.js app with a worker process. The important boundary is logical: source collectors, incident engine, alerting, and UI should not be tangled together.

## Data Contracts

### SourceCheckStatus

```ts
type SourceCheckStatus =
  | "success"
  | "partial"
  | "timeout"
  | "blocked"
  | "authentication_failed"
  | "parse_failed"
  | "source_unavailable";
```

### SourceCheckResult

```ts
type SourceCheckResult<TItem = SourceItemInput> = {
  source: "sitemap" | "feed" | "category" | "product_page" | "merchant_center";
  url?: string;
  status: SourceCheckStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  httpStatus?: number;
  itemsObserved: number;
  items: TItem[];
  errorCode?: string;
  errorMessage?: string;
};
```

### SourceItemInput

```ts
type SourceItemInput = {
  source: "storefront" | "sitemap" | "feed" | "merchant_center";
  stableKey?: string;
  offerId?: string;
  url?: string;
  title?: string;
  price?: string;
  currency?: string;
  availability?: string;
  imageUrl?: string;
  httpStatus?: number;
  indexability?: "indexable" | "noindex" | "blocked_by_robots" | "unknown";
  canonicalUrl?: string;
  schemaPresent?: boolean;
  merchantStatus?: "approved" | "pending" | "disapproved" | "unknown";
  merchantIssues?: MerchantIssue[];
  rawHash: string;
};
```

### IncidentCandidate

```ts
type IncidentCandidate = {
  storeId: string;
  type:
    | "catalog_drop"
    | "source_divergence"
    | "seo_regression"
    | "price_availability_mismatch"
    | "source_health";
  severity: "critical" | "warning" | "info";
  title: string;
  summary: string;
  affectedCount: number;
  signals: IncidentSignalInput[];
  likelySource?: string;
  confidenceScore?: number;
  evidence: string[];
  requiresConfirmation: boolean;
};
```

## Public API v0.1

### Stores

`POST /api/stores`

Creates a monitored store.

Request:

```json
{
  "name": "Example Store",
  "domain": "https://example.com",
  "sitemapUrl": "https://example.com/sitemap.xml",
  "feedUrl": "https://example.com/google-feed.xml",
  "categoryUrls": [
    "https://example.com/collections/shoes",
    "https://example.com/collections/bags"
  ]
}
```

Acceptance:

- Validates URLs.
- Creates store in `learning` baseline state.
- Schedules first snapshot.

`GET /api/stores`

Returns stores with latest health summary.

`GET /api/stores/:id`

Returns store settings, latest counts, baseline state, and open incident count.

### Checks

`POST /api/stores/:id/checks`

Runs an on-demand check.

Request:

```json
{
  "mode": "normal_check"
}
```

Allowed modes:

- `normal_check`
- `confirmation_check`
- `baseline_candidate`

Acceptance:

- Creates snapshot.
- Writes `SourceCheck` rows.
- Writes `SourceItem` rows for successful comparable sources.
- Runs incident engine only when enough comparable data exists.

### Incidents

`GET /api/incidents?storeId=:id&status=open`

Lists incidents.

`GET /api/incidents/:id`

Returns incident detail, signals, evidence, samples, and timeline.

`POST /api/incidents/:id/acknowledge`

Marks incident acknowledged.

`POST /api/incidents/:id/ignore`

Marks incident ignored with reason.

`POST /api/incidents/:id/comment`

Adds staff comment.

### Settings

`PATCH /api/stores/:id/thresholds`

Updates per-store thresholds.

`GET /api/stores/:id/thresholds`

Returns the current versioned per-store thresholds.

`POST /api/stores/:id/maintenance-windows`

Creates a maintenance window.

`GET /api/stores/:id/maintenance-windows`

Lists scheduled, active, ended, and cancelled maintenance windows.

`DELETE /api/stores/:id/maintenance-windows/:windowId`

Cancels a maintenance window without deleting its history.

`PATCH /api/stores/:id/alert-preferences`

Controls per-incident alert behavior.

`GET /api/stores/:id/alert-preferences`

Returns the current versioned alert preferences.

## Milestones

### Milestone 1: Project Skeleton And Database

Build:

- Next.js app or equivalent.
- Postgres schema and migrations.
- Store creation UI.
- Store list UI.
- Basic auth can be single-user or simple invite-only for v0.1.

Acceptance criteria:

- A store can be created with domain, sitemap, feed, and category URLs.
- Database has tables for stores, monitored categories, snapshots, source checks, source items, incidents, incident signals, baseline metrics, alert preferences, and maintenance windows.
- `npm test` or equivalent runs at least schema/model tests.

### Milestone 2: Source Collectors

Build:

- Sitemap fetcher and parser.
- XML product feed parser for common Google Shopping fields.
- Category collector using cheap strategies first.
- Product page collector for sampled URLs.
- Source status classification.

Collector order:

1. Shopify JSON or embedded machine-readable data where available.
2. Sitemap/feed.
3. JSON-LD Product schema.
4. HTML parsing.
5. Playwright fallback.

Acceptance criteria:

- Sitemap collector returns URL count and URL items.
- Feed collector returns product count, offer IDs, URLs, prices, availability, and images.
- Category collector returns product count or `parse_failed` without pretending products disappeared.
- Product page collector returns HTTP, noindex, canonical, schema, image, price/availability when available.
- Timeout, blocked, parse failed, and 5xx responses are recorded as `SourceCheck` status.

### Milestone 3: Snapshot Persistence And Product Matching

Build:

- Snapshot orchestration job.
- Source item normalization.
- Stable-key generation.
- Raw hash generation.
- Deterministic product sampling.

Acceptance criteria:

- Running a store check creates one snapshot and source checks for every configured source.
- Successful source items are persisted with stable keys.
- Same feed/product URL produces the same stable key across runs.
- Large feeds can be capped or sampled without crashing.

### Milestone 4: Baseline Engine

Build:

- Learning mode.
- Baseline candidate creation.
- Rolling baseline from 7-14 successful checks.
- Manual baseline confirmation.
- Normal range metrics.
- Versioned baseline metrics with `configuration_hash`.
- Per-metric statuses: learning, ready for confirmation, active, stale, relearning.

Acceptance criteria:

- New stores do not emit business incidents from the first snapshot.
- Baseline metrics use successful comparable checks only.
- User can confirm baseline in UI.
- Incident engine can compare current metrics against baseline median and range.
- Feed product count baseline is calculated from successful feed source checks, even when the overall snapshot is partial.
- Changing the feed URL creates a new baseline version and marks the previous version stale.
- Incident engine remains disabled while baseline is being established.

### Milestone 5: Incident Engine

Build:

- Catalog drop rule.
- Source divergence rule.
- SEO regression rule.
- Price/availability mismatch rule.
- Source health event rule.
- Incident deduplication.
- DB-backed confirmation-check scheduling from due `incident_candidates`.
- Confidence scoring.

Acceptance criteria:

- A failed source fetch creates a source health event, not a catalog-loss incident.
- A critical drop schedules confirmation within 5-15 minutes.
- A confirmed drop opens one incident with multiple signals.
- Evidence and confidence score are stored.
- Repeated checks update the same open incident rather than creating duplicates.
- Source divergence is based on matched storefront products missing from feed, not raw category-count sums.

First vertical slice:

- Implement only `feed.product_count` catalog drop against an active feed baseline.
- First abnormal normal check creates an `incident_candidate`, not a business incident.
- Confirmation snapshot either confirms one `catalog_drop` incident, dismisses the candidate, or marks it `source_failure`.
- Alerts and recovery lifecycle remain out of scope until later milestones.
- Active baseline recalculation excludes observations outside guardrails while related drop candidates/incidents are being handled.
- Worker can recover scheduled confirmations by claiming due pending candidates from Postgres; the in-memory queue is only a local/dev hint.
- Confirmation leases store `attempt_count`, `locked_at`, `locked_by`, `last_error`, and terminal `status_reason` values for expiry, configuration invalidation, source failure, dismissal, and confirmation.
- Confirmation claims use PostgreSQL time and stop retrying after the configured max attempts, marking the candidate `source_failure` with `confirmation_attempts_exhausted`.
- Feed source-health incidents use debounce rules: `authentication_failed` opens immediately, `parse_failed` opens after a previous successful check, and `blocked`/`timeout`/`source_unavailable` open after consecutive failures.
- Feed source-health debounce is scoped to the same feed configuration; a successful check or feed URL/configuration change resets consecutive-failure counting.
- Feed source-health incidents dedupe by store, source, and source configuration hash; repeated failures update the same incident and signal, while later successful checks add recovery evidence for Milestone 6.
- SEO regression uses only compatible product-page samples with the same sample strategy and selected URL hash, sufficient product-page check coverage, and URL intersection coverage.
- SEO regression groups noindex, canonical-away, schema-missing, and HTTP-error signals into one `seo_regression` incident with sampled affected URLs.
- Product data mismatch uses only high-confidence `offer_id`, `normalized_url`, and `canonical_url` source matches; fallback matches do not create business incidents.
- Product data mismatch compares effective decimal price in the same currency and normalized availability enum values, then groups price and availability signals into one `price_availability_mismatch` incident.
- Incident engine modularization has started without behavior changes: the public `@eim/db` exports remain stable while pure rule evaluation moves out of the DB orchestration entrypoint one rule at a time.
- Shared incident signal persistence is centralized in `packages/db/src/incidents/signals.ts`; rule modules call one upsert helper instead of duplicating `incident_signals` SQL.
- Candidate types, fingerprint construction, confirmation read/lock query, and catalog-drop candidate creation are centralized in `packages/db/src/incidents/candidates.ts`.
- Confirmation job lease/reclaim, max-attempt exhaustion, and attempt failure metadata are centralized in `packages/db/src/incidents/confirmation-jobs.ts`.
- Catalog-drop confirmation transaction now lives in `packages/db/src/incidents/confirmation.ts` with one `withTransaction` boundary from candidate lock through terminal candidate update.
- Feed source-health debounce, incident dedupe, failure evidence, and recovery evidence now live in `packages/db/src/incidents/source-health.ts`.
- SEO regression sample compatibility, coverage gates, transition detection, grouped incident upsert, and affected URL signal samples now live in `packages/db/src/incidents/seo-regression.ts`.
- Live PostgreSQL smoke has been run against a clean PostgreSQL service schema: migrations applied from scratch and `npm run test:postgres` passed with 19/19 tests.
- Live PostgreSQL smoke fixed two real-DB issues: `baseline_metrics` now migrates before tables that reference it, and baseline recalculation uses the feed URL captured on each source check instead of the store's current feed URL.

### Milestone 6: Recovery Lifecycle And Noise Controls

Build:

- Incident statuses: open, investigating, acknowledged, recovering, resolved, ignored.
- Recovery detection.
- Maintenance windows.
- Per-store thresholds.
- Mute/ignore/acknowledge/comment.
- Notify-on-worsening and notify-on-recovery preferences.

Acceptance criteria:

- Incident moves to `recovering` after one successful normal check.
- Incident moves to `resolved` after two consecutive successful checks inside baseline range.
- Catalog-drop recovery v1 is implemented first: only successful comparable feed checks with the same baseline/configuration can advance recovery; partial/source failures and stale baselines do not close incidents.
- Catalog-drop recovery transitions are recorded in `incident_events`, and repeated evaluation of the same recovery snapshot is idempotent.
- Shared recovery transition primitive now handles `recovering`, `resolved`, `reopened`, and idempotent same-snapshot `no_change` transitions.
- Feed source-health recovery uses the shared primitive: one successful feed check moves the incident to `recovering`, a second successful feed check resolves it, and a renewed source failure during recovery reopens it.
- Source-divergence recovery uses the shared primitive and the thresholds/configuration captured on the incident: successful comparable feed/category checks with matched storefront-feed loss below threshold move the incident through `recovering` and `resolved`, while renewed high-confidence loss reopens it.
- SEO-regression recovery uses the shared primitive: compatible product-page samples with the same selected URLs and parser/normalizer/schema versions must clear all grouped SEO regression signals before moving through `recovering` and `resolved`; any renewed grouped signal reopens the incident.
- Price/availability mismatch uses a DB-backed debounce candidate before opening a business incident: the first comparable grouped mismatch creates `pending`, a healthy comparable snapshot dismisses it, and a second consecutive comparable mismatch confirms one grouped incident.
- Price/availability recovery uses the shared primitive and the thresholds/configuration captured on the incident: all grouped price and availability mismatch signals must fall below threshold for `recovering`/`resolved`, while renewed significant mismatch reopens it.
- User actions are persisted through `acknowledgeIncident`, `ignoreIncident`, and `addIncidentComment`: acknowledge and ignore take a row lock, update status atomically, and append an `incident_events` timeline record. Ignore requires a reason; repeated acknowledge/ignore requests are idempotent.
- Incident comments are stored in `incident_comments` and linked into the timeline with `incident_commented` events. `GET /api/incidents/:id` returns the incident, signals, events, and comments; action endpoints validate actor/reason/body payloads.
- Alert preferences are versioned per store and expose global/channel toggles, muted incident types, open/worsening/recovery controls, and saved worsening policy settings. Every lifecycle event creates idempotent `email` and `telegram` delivery intents. Each delivery persists the lifecycle event ID, alert type, primary suppression reason, maintenance window, and immutable preference version/hash used for the decision. Decisions are applied in a stable order: global disable, disabled channel, muted incident type, disabled event type, then maintenance window. The v0.1 worsening event is a `recovering -> open` transition.
- Maintenance windows suppress only alert delivery. Snapshots, collectors, incident rules, debounce, confirmation, recovery, user actions, and timeline writes continue normally. Each alert delivery is persisted as `pending` or `suppressed`; suppression records its reason and, for maintenance, the active window in an `alert_suppressed` timeline event.
- Per-store thresholds are versioned and strictly validated. A snapshot captures its effective threshold version, JSON, and configuration hash before evaluation; later settings changes apply only to subsequent snapshots while existing candidates and incidents retain their saved thresholds for confirmation and recovery.
- Acknowledged incidents do not repeatedly notify.
- Maintenance windows suppress alerts but keep timeline records.
- Threshold changes affect subsequent checks.

### Milestone 7: Alerts

Build:

- Durable per-channel delivery worker with PostgreSQL leases, retry scheduling, fencing, and injected senders before connecting a provider.
- Email alerts.
- Telegram alerts.
- Alert rendering with before/after, confidence, evidence, and sample products.
- Recovery alert.

Acceptance criteria:

- Milestone 7.1 applies ordered SQL migrations through a checksum-verified, advisory-lock-protected runner and persists alert delivery attempts without changing incident lifecycle decisions.
- Milestone 7.2 freezes one versioned canonical payload per incident lifecycle event before channel delivery. Email and Telegram intents reference the same immutable event payload, retries never rebuild it from current incident state, and provider senders receive rendered channel messages rather than incident-domain records.
- Milestone 7.3 stores one secret-free Telegram destination per store, exposes strict GET/PUT/DELETE configuration endpoints, resolves enabled destinations before fake transport invocation, and terminally fails missing or disabled destination configuration without consuming provider retry attempts.
- Milestone 7.4 sends Telegram messages through an injectable HTTP transport, persists `<chat_id>:<message_id>` as the provider identifier, applies Telegram `retry_after` to the existing fenced retry schedule, and terminally classifies permanent provider errors without exposing bot credentials.
- Milestone 7.5 provides a run-once Telegram runtime entrypoint. It validates `DATABASE_URL` and `TELEGRAM_BOT_TOKEN` before claiming deliveries, uses one process-scoped worker identity, runs one Telegram batch, emits only safe aggregate counts, and exits nonzero only for configuration or batch-level runtime failures.
- Pending email and Telegram intents can be claimed independently; active leases are not double-claimed, expired leases are reclaimed, stale workers are fenced, and retry delay follows 1, 5, 15, and 60 minute steps before the configured maximum attempts.
- The first worker slice uses an injected fake sender only; it does not call Telegram, email, or any provider API.
- Critical confirmed incidents send one alert.
- Alerts include store, affected source, before/after metrics, first detected time, confidence, evidence, and samples.
- Source health alerts use different wording from business incidents.
- Recovery alerts are optional per store.

Milestone 7.1 durable delivery worker core is complete and operationally verified. The ordered migration runner applies checksum-verified migrations under a PostgreSQL advisory lock, and the clean PostgreSQL CI suite verifies pending-delivery claim, lease/reclaim, attempt fencing, deterministic retry scheduling, terminal failure, per-channel isolation, and fake-sender batch handling.

Milestone 7.2 immutable alert payload and pure renderer is complete and operationally verified. Migration `0003_alert_event_payloads.sql` stores one canonical `v1` payload per incident event, delivery claims load that frozen payload, and the worker renders provider-ready Telegram or email content before calling its injected sender. The Telegram renderer distinguishes business incidents, source-health failures, worsening, and recovery; escapes HTML; limits samples; and safely truncates long output. Clean GitHub CI passed all 22 PostgreSQL smoke tests, including migration replay, payload immutability, shared per-channel event payloads, retry reuse, lease fencing, and rendered fake-sender delivery.

Milestone 7.3 Telegram destination configuration is complete and operationally verified. Migration `0004_telegram_destinations.sql` stores chat and optional topic identifiers without bot secrets; updates are concurrency-safe and DELETE soft-disables the destination with audit timestamps. The worker builds a destination-aware `TelegramSendRequest` for its injected sender, while missing or disabled configuration produces a fenced terminal delivery failure. `TELEGRAM_BOT_TOKEN` is isolated behind an environment-only configuration boundary with token-redaction helpers. Clean GitHub CI passed all 23 PostgreSQL smoke tests, including ordered migration replay, concurrent destination upsert, cross-store isolation, fake Telegram destination delivery, email independence, terminal configuration failures, and secret-free persistence.

Milestone 7.4 Telegram HTTP transport is complete and operationally verified. The injectable transport sends one `sendMessage` request with the configured chat/topic destination and immutable HTML content, persists stable provider message IDs, distinguishes transient timeout/network/5xx/rate-limit failures from permanent provider failures, and honors a clamped Telegram `retry_after` override without weakening lease fencing. Clean GitHub CI passed the updated PostgreSQL smoke suite and full validation pipeline, including provider success, retry, rate-limit scheduling, permanent failure, existing fencing, email isolation, and secret-free error persistence.

Enabling a Telegram destination affects future alert deliveries and does not automatically retry historical terminal configuration failures.

Milestone 7.5 Telegram run-once runtime is code-complete. `npm run worker:telegram` loads configuration before the first claim, creates the real transport, executes one Telegram batch, and writes only aggregate delivery statistics. It deliberately does not add a loop, scheduler, or hosting integration; `SIGTERM` cannot cause a second batch to start. The runtime and transport are CI-verified through injected HTTP responses, but a controlled live Telegram provider smoke test with a private test chat remains pending and is never run in CI.

Milestone 7 hardening backlog: classify an immutable payload that is missing, malformed, or unsupported after claim as a permanent delivery failure (`payload_missing`, `payload_validation_failed`, or `unsupported_payload_version`) so the lease does not wait for expiry without an immediate diagnostic.

### Milestone 8: Dashboard

Build:

- Stores overview.
- Store detail with latest counts by source.
- Incident list.
- Incident detail with timeline, signals, evidence, samples, and comments.
- Settings for thresholds, alert preferences, and maintenance windows.

Acceptance criteria:

- Agency user can see all stores and open incidents on one screen.
- Incident detail explains what changed and why the system suspects the likely source.
- User can acknowledge, ignore, comment, and set maintenance window without database access.

### Milestone 9: Merchant Center Integration

Build:

- Google OAuth.
- Merchant account connection.
- Product status aggregation.
- Product issue import.
- Offer ID mapping.

Acceptance criteria:

- Store can connect Merchant Center.
- Check can pull approved, pending, disapproved counts.
- Check can import item-level issues for sampled or changed products.
- Merchant Center failures are classified as `authentication_failed`, `source_unavailable`, or `partial`.
- Incident engine can correlate feed drops with Merchant approved drops.

## Demo Acceptance Scenario

Seeded run:

- Baseline category count: 642.
- Baseline feed products: 642.
- Baseline Merchant approved products: 620.
- Current category count: 17.
- Current feed products: 21.
- Current Merchant approved products: 30.
- Sitemap count: stable.
- All relevant source checks: success.

Expected result:

- One critical `catalog_drop` incident.
- `affectedCount` around 621.
- `likelySource` is `feed_or_publication`.
- `confidenceScore >= 0.80`.
- Alert includes before/after counts and sample lost products.

Failed-source run:

- Feed request returns 503.
- Category and sitemap remain stable.

Expected result:

- No product-loss incident.
- One source health event for feed source unavailable.
- Optional warning alert uses monitor/source wording.

Recovery run:

- Counts return to baseline range once.

Expected result:

- Incident moves to `recovering`.

Next successful run:

- Counts remain in baseline range.

Expected result:

- Incident moves to `resolved`.
- Recovery alert sent only if enabled.

## Test Plan

Unit tests:

- URL normalization.
- Stable-key generation.
- Feed parsing.
- Sitemap parsing.
- Source status classification.
- Threshold comparison.
- Confidence scoring.
- Incident deduplication.
- Recovery transitions.

Integration tests:

- Full snapshot with successful sources.
- Full snapshot with blocked category source.
- Critical drop with confirmation.
- Critical drop suppressed during learning mode.
- Maintenance window suppresses alert but records incident timeline.
- Merchant Center aggregation maps statuses into metrics.

Fixture stores:

- Static HTML store.
- Shopify-like JSON fixture.
- Infinite-scroll category fixture requiring fallback.
- Broken feed fixture.
- Price mismatch fixture.
- Noindex/canonical regression fixture.

## Risk Register

Crawler fragility:

- Mitigation: prefer machine-readable sources, store source status, use Playwright only as fallback.

False positives:

- Mitigation: baseline, confirmation checks, source health separation, maintenance windows.

Noisy alerts:

- Mitigation: incident grouping, dedupe, acknowledge, mute, notify-on-worsening only.

Large catalog cost:

- Mitigation: plan limits, deterministic sampling, aggregate metrics, custom pricing for large stores.

Merchant API integration delay:

- Mitigation: core v0.1 works with storefront, sitemap, and feed before Merchant Center is connected.

Database write succeeds but enqueue fails:

- Current v0.1 uses a simple placeholder queue after DB store creation.
- Risk scenario: store, alert preferences, and baseline snapshot are committed, enqueue fails, API returns 500, and retry returns 409 because the store already exists.
- Near-term mitigation: live Postgres integration smoke covers durable DB state and duplicate-domain behavior; the queued DB snapshot remains the source of truth.
- Before a real queue is introduced, choose one durable pattern: transactional outbox, DB-backed snapshot polling, safe re-enqueue by existing snapshot ID, or successful API response with asynchronous enqueue retry.

Dependency advisory in Next/PostCSS:

- Current npm audit reports a moderate PostCSS advisory through `next@16.2.10`.
- `npm audit fix --force` proposes a breaking downgrade and should not be used.
- Recheck when a stable Next release includes `postcss >= 8.5.10`, then run tests, typecheck, lint, and build again.

Robots.txt and image reachability scope:

- Milestone 2/3 product-page checks evaluate meta robots, `X-Robots-Tag`, canonical, HTTP status, schema, price/availability, and image URL presence.
- Do not emit or persist `blocked_by_robots` unless robots.txt rules were actually fetched and evaluated.
- Image reachability checks are deferred; missing `imageReachable` is not comparable evidence for incidents.

## Definition Of Done For v0.1

v0.1 is done when:

- A user can add a store with sitemap, feed, and critical categories.
- The system creates repeated snapshots with source check statuses.
- Baseline learning prevents first-run false alarms.
- Confirmed product drops create one grouped incident.
- Source failures do not masquerade as product loss.
- Incident detail shows before/after, evidence, confidence, and samples.
- Telegram or email alert is sent for confirmed critical incidents.
- A recovery lifecycle exists and can close incidents after confirmed recovery.
- Demo scenario can be shown end to end in under two minutes.

## Operational Gate

GitHub Actions runs the live PostgreSQL smoke path with a PostgreSQL service container:

```text
npm ci
npm test
npm run test:postgres
npm run typecheck
npm run lint
npm run build
```

Milestones that depend on database semantics are not operationally signed off until this CI job passes.
Milestone 6 is complete and operationally verified. GitHub Actions passed the clean PostgreSQL suite with 19/19 smoke tests, covering recovery lifecycle, user actions, maintenance suppression, versioned thresholds, alert preferences, concurrent per-channel intent creation, historical preference capture, suppression precedence, and foreign-key integrity. Future database changes must continue to pass the same PostgreSQL smoke suite before merge.
