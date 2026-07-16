# Staging readiness

This runbook validates only the web service and its PostgreSQL dependency. It does not connect Merchant Center, send alerts, invoke a provider, or expose configuration details.

## Endpoint contract

`GET /api/health` is a public, uncached readiness endpoint.

- `200 {"status":"ok"}` means the Next.js service can acquire its configured database pool and execute a lightweight `SELECT 1`.
- `503 {"status":"unavailable"}` means the service is running but cannot currently complete that database check.
- The response intentionally contains no error message, connection string, schema name, provider detail, store data, or timestamp.

## Railway configuration

After the deployment containing this endpoint is active, configure the web service in Railway:

1. Open **Settings** → **Deploy**.
2. Set **Healthcheck Path** to `/api/health` and save.
3. Trigger or wait for the next deployment.
4. Confirm the deployment is marked successful, then request `https://<staging-domain>/api/health`.

The expected response is HTTP 200 with exactly `{"status":"ok"}`. Treat a 503 as a staging availability failure: inspect Railway's deploy logs and PostgreSQL service state there, without copying secrets, database URLs, or provider payloads into tickets or chat.

## Boundaries

The healthcheck is an availability signal, not an application acceptance test. The reproducible v0.1 fixture and the real Merchant API staging gate remain separate checks.
