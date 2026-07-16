# v0.1 reproducible demo acceptance

This runbook demonstrates the local PostgreSQL v0.1 lifecycle without calling an external provider. The fixture writes only source snapshots and check results through the production persistence contracts; the existing baseline, candidate, confirmation, correlation, alert, source-health, and recovery paths create the resulting records.

## Preconditions

- A local PostgreSQL database is available through `DATABASE_URL`.
- Dependencies are installed with `npm ci` (or the repository's existing local install is current).
- The web app is optional. When it is running, set `WEB_BASE_URL` if it is not `http://localhost:3000`.

## Two-minute acceptance flow

1. Apply migrations and seed the full scenario:

   ```sh
   npm run db:migrate
   npm run seed:v01-demo
   ```

   The command prints the catalog-drop incident URL, dashboard URL, source-health incident ID, and immutable first-drop and confirmation snapshot IDs. It also asserts the baseline (seven Feed observations of 642), the confirmed 642 → 21 drop, Merchant 620 → 30 corroboration, complete 21/0/599/0 reconciliation, one correlation event, three immutable alert payload metrics, and the isolated HTTP 503 source-health case.

2. In the dashboard, inspect the open critical `catalog_drop` incident. It has `affectedCount` 621, confidence `0.95`, Feed, Merchant, and mapping signals, plus bounded samples. The separate source-health store contains one warning `source_health` incident whose wording identifies the Feed status as `source_unavailable`; it does not claim products disappeared.

3. Advance one healthy Feed-only check:

   ```sh
   npm run advance:v01-demo:recovering
   ```

   The catalog-drop incident moves from `open` to `recovering`. No Merchant check is created for this recovery transition.

4. Advance the second healthy Feed-only check:

   ```sh
   npm run advance:v01-demo:resolved
   ```

   The same incident moves from `recovering` to `resolved`. Re-running either advance command is safe and asserts that lifecycle events are not duplicated.

5. Remove the two known fixture stores:

   ```sh
   npm run cleanup:v01-demo
   npm run cleanup:v01-demo
   ```

   Cleanup deletes fixture alert payloads and deliveries before deleting only the two `.example.test` fixture stores. Each cleanup asserts that unrelated-store count is unchanged.

## Expected scenario values

| Stage | Category | Sitemap | Feed | Merchant approved |
| --- | ---: | ---: | ---: | ---: |
| Seven baseline observations | 642 | 642 | 642 | 620 |
| Confirmed drop | 17 | 642 | 21 | 30 |
| Source failure | 642 | 642 | unavailable (HTTP 503) | not required |
| Recovery checks | not required | not required | 642 | not required |

The drop snapshot has a complete successful Merchant identity inventory of 620: the 21 normalized Feed Offer IDs match, 599 are Merchant-only, and there are no feed-only, ambiguous, or truncated identities. All timestamps are derived from one runtime base in each command, so no static future date is used.

## CI replay sequence

The CI workflow migrates PostgreSQL and runs seed twice, recovering twice, resolved twice, and cleanup twice. This validates replay idempotency alongside the assertion-bearing fixture; it is not a real Merchant API staging check.
