# Merchant Center OAuth staging smoke

This runbook is a manual release gate for the Merchant Center OAuth UI. It must use a disposable staging store, a staging Google OAuth client, and a private test Merchant Center account. It is not part of CI.

## Prerequisites

- A staging deployment with a disposable PostgreSQL database.
- A Google OAuth web application client configured for the staging origin.
- An authorized redirect URI matching the deployed route exactly:
  `https://staging.example.com/api/merchant-center/oauth/callback`.
- A staging store that can be safely disconnected and reconnected.
- Runtime variables configured outside the repository:
  - `DATABASE_URL`
  - `GOOGLE_MERCHANT_CENTER_CLIENT_ID`
  - `GOOGLE_MERCHANT_CENTER_CLIENT_SECRET`
  - `GOOGLE_MERCHANT_CENTER_REDIRECT_URI`
  - `MERCHANT_CENTER_CREDENTIALS_ENCRYPTION_KEY`

`MERCHANT_CENTER_CREDENTIALS_ENCRYPTION_KEY` must be a base64-encoded 32-byte value. Generate a new value with a secret manager or an equivalent cryptographically secure command. Never put it in `.env` committed to source control, logs, tickets, or screenshots.

## Smoke flow

1. Open `/stores/<store-id>/merchant-center` and confirm the initial state is `Not connected`.
2. Select `Connect Merchant Center`.
3. Confirm the browser leaves the app for Google and the authorization request contains the configured staging redirect URI.
4. Complete consent with the disposable account.
5. Confirm the browser returns to the store page with a success banner.
6. Confirm the page shows only account metadata, scopes, expiry, credentials version, and updated time. It must not show access tokens, refresh tokens, authorization codes, client secrets, or provider diagnostics.
7. Start `Refresh credentials` once. Confirm the page returns to a healthy connected state and the credentials version advances.
8. Open a second browser tab and submit refresh while the first request is still running. Confirm the UI shows a safe in-progress message and no credentials are exposed.
9. Select `Disconnect`, accept the explicit confirmation, and confirm the page shows `Not connected`.
10. Reconnect the same staging account and confirm a new authorization succeeds.
11. Repeat the flow with Google cancellation. Confirm the app returns to the store page with a cancellation message and no credentials are created.

## Database and logs

Verify only safe metadata in the database:

```sql
SELECT
  store_id,
  credentials_version,
  token_type,
  expires_at,
  scopes,
  created_at,
  updated_at,
  refresh_lock_id IS NOT NULL AS refresh_in_progress
FROM merchant_center_oauth_credentials
WHERE store_id = '<STAGING_STORE_ID>';
```

Do not copy encrypted token columns into tickets or chat. Search staging logs for accidental occurrences of the access token, refresh token, authorization code, client secret, and full provider request URL. The expected result is no match.

## Key rotation

The current v0.1 storage format uses one active encryption key and does not support decrypting with two keys during an in-place rotation. Use this controlled procedure:

1. Pause Merchant Center refresh jobs for the affected stores.
2. With the old key still configured, disconnect every affected staging or production store through the application so encrypted rows are removed.
3. Deploy the new `MERCHANT_CENTER_CREDENTIALS_ENCRYPTION_KEY` through the secret manager.
4. Reconnect each store and run the smoke checks above.
5. Re-enable refresh jobs after all stores have been reauthorized.

For a future zero-downtime rotation, add an explicit key-versioned envelope and dual-key migration before changing this procedure.

## Failure handling

If the provider rejects consent, the callback redirects to the store page with a safe error state. Do not retry by copying a callback URL containing `code` or `state`; start a new authorization flow from the store page. If the staging check fails, revoke the disposable OAuth client and remove its runtime secrets after collecting only safe status metadata.
