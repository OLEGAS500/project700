# Ecommerce Incident Monitor v0.1

## Product Positioning

Category: ecommerce revenue monitoring.

First segment: SEO/PPC agencies that manage several Shopify stores and are responsible for Google Merchant Center health.

One-line positioning:

> Revenue incident monitoring for ecommerce stores and agencies.

Landing-page promise:

> Know when your store, product feed, SEO, or Merchant Center breaks before revenue drops.

What this is not:

- Not another SEO audit.
- Not another generic uptime monitor.
- Not another feed sync app.
- Not a Shopify App Store product in v0.1.

Core distinction:

The product correlates multiple sources into one business incident:

```text
Storefront product pages
  -> Sitemap
  -> XML product feed
  -> Google Merchant Center
  -> Optional ad/revenue impact estimate
```

The user should not receive "canonical changed" as a standalone alert. They should receive:

> 312 product pages now canonicalize to category pages, 187 disappeared from sitemap, and 94 products lost Merchant Center approval after the same deployment window.

## ICP

Primary buyer:

SEO/PPC specialist or agency owner managing Shopify ecommerce clients.

Why this buyer:

- Already understands the cost of catalog, feed, and Merchant Center errors.
- Can connect 5-20 stores from one sales conversation.
- Needs a dashboard across clients.
- Can explain the incident to store owners.
- Easier to interview than large ecommerce operators.

Initial use case:

Every morning, a PPC specialist sees how many products are available in the store, feed, sitemap, and Merchant Center, and gets an immediate alert if counts diverge or drop sharply.

## v0.1 Scope

### Inputs

Required:

- Store domain.
- Sitemap URL.
- Product XML feed URL.
- 5-20 critical category URLs.

Optional:

- Google Merchant Center OAuth connection.
- Telegram destination.
- Email destination.

### Daily Checks

Source: sitemap

- URL count.
- New URLs.
- Removed URLs.
- HTTP status for sampled or critical URLs.

Source: critical category pages

- Product count visible on category page.
- Product URLs discovered.
- HTTP status.
- No obvious empty-category state.

Source: product pages

- HTTP status.
- `index` / `noindex`.
- Canonical URL.
- Product schema presence.
- Image URL presence and reachability.
- Price and availability, when extractable.
- Technical indexability signals, not full Google index coverage.

Source: XML product feed

- Product count.
- Offer IDs.
- Product URLs.
- Price.
- Availability.
- Image URL.

Source: Merchant Center, optional

- Product count by status.
- Approved / pending / disapproved counts.
- Destination statuses.
- Item-level issues.
- Product IDs / offer IDs where available.

### Explicitly Out Of Scope

- WooCommerce plugin.
- Shopify App Store publication.
- Hourly checks for huge catalogs.
- Full checkout purchase testing.
- Mass URL Inspection API checks.
- Google Indexing API for normal product pages.
- Claims that the product checks indexing for every product page.
- Automatic fixes.
- AI recommendations.
- White-label PDFs.
- JavaScript error monitoring from real visitors.

## API Notes

Google Merchant API is viable for v0.1 because it exposes processed product data, destination statuses, item-level issues, and aggregate product statuses.

Google Indexing API is not viable for ecommerce product-page indexing checks because Google documents it for pages with `JobPosting` or `BroadcastEvent` in `VideoObject`.

Search Console URL Inspection can be used later for targeted checks, but not as a full-catalog daily crawler. Current documented quota is 2,000 queries per day per site and 600 queries per minute per site.

The product should say "technical indexability monitoring" in v0.1, not "indexing monitoring." v0.1 tracks HTTP status, robots, noindex, canonical, sitemap presence, and selected structured-data signals. It does not prove that Google indexed every product URL.

Robots.txt evaluation is deferred until after Milestone 3 hardening. Until then, product-page checks may report `noindex` from meta robots and `X-Robots-Tag`, plus HTTP status, canonical, sitemap presence, schema, and image presence. The system must not set `blocked_by_robots` unless a URL has actually been evaluated against robots.txt rules.

Image reachability is also deferred for v0.1 collector hardening. Product-page checks extract image URL presence; sampled image HEAD/GET checks can be added later without treating missing reachability data as a product-page regression.

## Core Data Model

### Store

- `id`
- `name`
- `domain`
- `sitemap_url`
- `feed_url`
- `merchant_center_account_id`
- `baseline_status` (`learning`, `pending_user_confirmation`, `active`)
- `baseline_confirmed_at`
- `created_at`

### MonitoredCategory

- `id`
- `store_id`
- `url`
- `name`
- `criticality`

### Snapshot

- `id`
- `store_id`
- `started_at`
- `finished_at`
- `status`
- `baseline_role` (`candidate`, `confirmed_baseline`, `normal_check`, `confirmation_check`)
- `sitemap_url_count`
- `feed_product_count`
- `merchant_total_count`
- `merchant_approved_count`
- `merchant_pending_count`
- `merchant_disapproved_count`

### SourceCheck

One row per source attempted during a snapshot.

- `id`
- `snapshot_id`
- `store_id`
- `source` (`category`, `product_page`, `sitemap`, `feed`, `merchant_center`)
- `url`
- `status` (`success`, `partial`, `timeout`, `blocked`, `authentication_failed`, `parse_failed`, `source_unavailable`)
- `started_at`
- `finished_at`
- `duration_ms`
- `http_status`
- `items_observed`
- `error_code`
- `error_message`
- `retry_of_source_check_id`

Source status rules:

- `success`: source was fetched, parsed, and returned comparable data.
- `partial`: source returned data, but extraction missed non-critical fields or sampled checks failed.
- `timeout`: source did not respond within the configured timeout.
- `blocked`: likely anti-bot or WAF block, such as CAPTCHA, 403 challenge, or Cloudflare interstitial.
- `authentication_failed`: OAuth or credential problem.
- `parse_failed`: response was available but not parseable into expected fields.
- `source_unavailable`: upstream returned 5xx, DNS failed, TLS failed, or connection failed.

### SourceItem

One normalized row per observed product-like object per source.

- `id`
- `snapshot_id`
- `store_id`
- `source` (`storefront`, `sitemap`, `feed`, `merchant_center`)
- `stable_key`
- `offer_id`
- `url`
- `title`
- `price`
- `availability`
- `image_url`
- `http_status`
- `indexability`
- `canonical_url`
- `schema_present`
- `merchant_status`
- `merchant_issues_json`
- `raw_hash`

### Incident

- `id`
- `store_id`
- `opened_snapshot_id`
- `closed_snapshot_id`
- `severity` (`critical`, `warning`, `info`)
- `type`
- `title`
- `summary`
- `likely_source`
- `confidence_score`
- `evidence_json`
- `affected_count`
- `first_detected_at`
- `last_seen_at`
- `status` (`open`, `investigating`, `acknowledged`, `recovering`, `resolved`, `ignored`)
- `resolved_at`
- `ignored_reason`

### IncidentSignal

- `id`
- `incident_id`
- `source`
- `metric`
- `before_value`
- `after_value`
- `change_abs`
- `change_pct`
- `sample_items_json`

### BaselineMetric

- `id`
- `store_id`
- `metric`
- `source`
- `median_value`
- `p10_value`
- `p90_value`
- `sample_count`
- `window_start_at`
- `window_end_at`
- `confirmed_by_user_id`
- `confirmed_at`

### AlertPreference

- `id`
- `store_id`
- `incident_type`
- `severity_threshold`
- `metric_threshold_json`
- `muted_until`
- `notify_on_open`
- `notify_on_worsening`
- `notify_on_recovery`

### MaintenanceWindow

- `id`
- `store_id`
- `starts_at`
- `ends_at`
- `scope`
- `reason`

## Matching Strategy

v0.1 should match products with a conservative stable key:

1. Merchant Center `offerId`, if available.
2. Feed product ID / SKU / `g:id`.
3. Normalized product URL without query string.
4. Canonical URL.
5. Fallback hash from title + image URL + price.

Do not promise perfect identity resolution in v0.1. The product only needs enough matching to detect drops, mismatches, and obvious lost products.

## Source Extraction Strategy

Use the cheapest reliable machine-readable source first:

1. Shopify JSON endpoints and embedded structured data, when available.
2. Sitemap and XML product feed.
3. JSON-LD Product schema.
4. Stable HTML selectors and link extraction.
5. Playwright rendering as an expensive fallback, not the default crawler.

Playwright should be used only for stores where product/category data cannot be extracted through simpler methods. It increases cost, duration, and the number of crawler-specific failures.

## Baseline And Confirmation Logic

New stores enter `learning` mode.

Baseline rules:

- First successful snapshot becomes a baseline candidate, not an active baseline.
- Rolling baseline uses the latest 7-14 successful comparable checks.
- Baseline metrics use median values and normal ranges, not only the immediately previous snapshot.
- User can manually confirm a baseline after reviewing initial counts.
- Incidents are suppressed or downgraded while baseline status is `learning`, unless the same critical condition appears in two successful confirmation checks.

Comparison rules:

- A major drop can create a business incident only when the relevant sources have `success` or acceptable `partial` status.
- If a source returns `timeout`, `blocked`, `parse_failed`, or `source_unavailable`, create a source health event, not a product-loss incident.
- For critical drops, automatically run one confirmation check after 5-15 minutes.
- If the confirmation check succeeds and confirms the drop, open or escalate the incident.
- If the confirmation check fails because the monitor could not fetch data, keep the event as source health and avoid claiming products disappeared.

## Incident Rules

### Critical: Catalog Drop

Trigger when one of these is true:

- Critical category product count drops by at least 50% and by at least 20 products.
- Feed product count drops by at least 20%.
- Merchant approved count drops by at least 20%.
- More than 10% of previously healthy product URLs now return 4xx/5xx.

Group signals within the same store and same snapshot into one incident.

Confirmation requirement:

- Open a critical business incident only after a successful current check and either a confirmed baseline comparison or a successful repeat check.
- If the current source check failed, open a source health event instead.

### Warning: Source Divergence

Trigger when:

- Storefront product count and feed product count differ by more than 10%.
- Feed count and Merchant Center processed count differ by more than 10%.
- Approved products fall while feed count remains stable.

### Warning: SEO Regression

Trigger when:

- More than 5% of sampled product pages become `noindex`.
- More than 5% of product pages change canonical away from themselves.
- Product schema disappears from more than 10% of sampled product pages.

### Warning: Price Or Availability Mismatch

Trigger when:

- Same stable key has different price on storefront and feed.
- Same stable key is available on storefront but out of stock or missing in feed.
- Same stable key has unreachable image URL in feed or storefront.

## Likely Source Confidence

`likely_source` is always a hypothesis.

Example:

```json
{
  "likely_source": "feed",
  "confidence_score": 0.86,
  "evidence": [
    "category count stable",
    "sitemap count stable",
    "feed count dropped 38%",
    "merchant approved count dropped 34%"
  ]
}
```

Confidence scoring v0.1 can be rule-based:

- Start at `0.50`.
- Add `0.15` for each stable neighboring source that narrows the problem.
- Add `0.20` when the downstream source changes in the expected direction.
- Subtract `0.20` for any failed or partial source needed to support the hypothesis.
- Cap at `0.95`; never display as certainty.

Display copy should use "likely", "appears", or "possible" rather than definitive blame.

## Incident Recovery Lifecycle

Incident statuses:

- `open`: new confirmed incident.
- `investigating`: teammate is actively reviewing.
- `acknowledged`: team has seen it and does not need repeated open alerts.
- `recovering`: latest successful check improved but recovery is not confirmed.
- `resolved`: recovery confirmed.
- `ignored`: intentionally dismissed or excluded from future alerts.

Resolution rules:

- Do not close an incident after one missing signal disappears.
- Move to `recovering` when metrics return inside the baseline range on one successful check.
- Move to `resolved` after two consecutive successful checks are inside the baseline range.
- For source divergence, require the relevant source gap to fall below the configured threshold.
- For page-health incidents, require critical sampled URLs to be reachable and indexability signals to return to expected values.
- Send a recovery alert only when `notify_on_recovery` is enabled.

## Noise Controls

v0.1 must support:

- Per-store thresholds.
- Excluded categories.
- Maintenance windows.
- Mute by incident type.
- Acknowledge.
- Ignore.
- Staff comment on an incident.
- Notification only when severity worsens.
- Optional recovery alert.

Default alert behavior:

- Notify on new critical incidents.
- Notify on warning incidents only once per store per check window.
- Do not notify repeatedly while acknowledged.
- Notify when an acknowledged incident worsens to critical.
- Suppress business incidents during maintenance windows, but keep source checks and timeline records.

## Alert Format

```text
Critical: product catalog drop

Store: example.com
Collection: /collections/shoes
Products before: 642
Products now: 17
Change: -97.4%
First detected: 2026-07-14 03:15 UTC

Additional signals:
- Sitemap URLs: no material change
- Feed products: -621
- Merchant Center approved products: -590

Likely source: feed or collection publication problem
Confidence: 0.86
Evidence: category count stable, sitemap count stable, feed and Merchant Center dropped together

Samples:
- /products/red-running-shoe
- /products/black-sneaker
- /products/trail-shoe
```

Alert principles:

- Send one alert per incident, not one alert per field change.
- Include before/after numbers.
- Include likely source only as a confidence-scored hypothesis.
- Include samples so the agency can verify quickly.
- Update existing incidents instead of creating duplicates while the same condition persists.
- Separate monitor failures from business incidents.
- Run confirmation checks for critical drops before sending the strongest wording.

## MVP Architecture

Recommended stack for fast build:

- Next.js or Remix dashboard.
- Postgres for snapshots, source items, and incidents.
- Background jobs via Trigger.dev, Inngest, BullMQ, or a simple cron worker first.
- Playwright only for category pages that require rendering.
- `fetch` + HTML parser for simple pages.
- Telegram Bot API and transactional email for alerts.
- Google OAuth + Merchant API as the first premium integration.

Crawler strategy:

- Start with daily checks.
- Limit v0.1 to 500-5,000 products per store depending on plan.
- Crawl critical categories and a deterministic sample of product pages.
- Parse feed fully when size allows.
- For large catalogs, store aggregate counts plus sampled items.
- Prefer Shopify JSON, sitemap/feed data, and JSON-LD before HTML selector parsing.
- Use Playwright only as fallback for pages that require rendering.
- Store source-check status separately from product health metrics.

## Pricing Hypothesis

Starter: $29/month

- 1 store.
- Up to 500 products.
- Daily checks.
- Email alerts.

Pro: $79/month

- Up to 3 stores.
- Up to 5,000 products total.
- Checks every 6 hours.
- Telegram + email.
- Merchant Center connection.

Agency: $199/month

- Up to 20 stores.
- Team dashboard.
- Shared notification destinations.
- Longer incident history.

Enterprise / large catalog:

- Custom pricing based on products, URLs, check frequency, and retention.

## Build Sequence

The implementation plan is the source of truth for development order. Merchant Center is intentionally last, after the core incident loop works without OAuth.

Milestone 1:

- Build store onboarding with domain, sitemap, feed URL, category URLs.
- Add Postgres schema, migrations, and model tests.
- Put new stores into `learning` baseline status.
- Schedule the first snapshot job after store creation.

Milestone 2:

- Implement sitemap fetch and count snapshots.
- Implement XML feed parser for common Google Shopping fields.
- Implement category product-count extraction.
- Implement product page checks: HTTP, noindex, canonical, schema, image, price/availability best effort.

Milestone 3:

- Persist snapshots and source checks.
- Normalize source items.
- Generate stable product keys.

Milestone 4:

- Add baseline learning, rolling metrics, and user baseline confirmation.

Milestone 5:

- Create snapshot comparison.
- Implement incident rules for catalog drop, source divergence, SEO regression, and price/availability mismatch.
- Add source health events and confirmation checks.

Milestone 6:

- Add recovery lifecycle and noise controls.

Milestone 7:

- Add Telegram and email alerts.

Milestone 8:

- Add dashboard: stores, health, open incidents, latest counts.

Milestone 9:

- Add Merchant Center OAuth and product status aggregation.

Final v0.1 hardening:

- Run against 5-10 real stores with permission or public demo stores.
- Tune thresholds to reduce noise.
- Prepare agency interview demo.

## Validation Script

Ask SEO/PPC agency operators:

1. How many ecommerce stores do you manage?
2. Who notices when products disappear from categories, feeds, or Merchant Center?
3. What was the most expensive catalog/feed/SEO incident in the last year?
4. How did you discover it?
5. How long did it take to diagnose?
6. Which systems did you compare?
7. Would a daily cross-source incident alert have changed the outcome?
8. What would make the alert trustworthy enough to act on?
9. Who would pay: agency or client?
10. What threshold is noisy versus urgent?

Strong buying signal:

They can name a recent incident, remember the diagnosis pain, and ask if they can connect multiple client stores.

Weak signal:

They say it is "nice to have" but cannot recall a specific painful event.

## First Demo Scenario

Use a seeded test store and simulate:

- Category product count drops from 642 to 17.
- Feed loses 621 offer IDs.
- Merchant approved count drops by 590.
- Sitemap remains stable.

Dashboard should show one critical incident:

> Product catalog drop likely caused by feed or publication issue.

This demo proves the product's central claim: it correlates multiple signals into one business incident.
