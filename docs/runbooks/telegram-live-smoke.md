# Telegram Live Smoke

## Purpose

Verify one real Telegram delivery without placing provider secrets, chat IDs, or message contents in source control or CI logs.

## Prerequisites

- A disposable PostgreSQL database and a test store.
- A private test Telegram chat or group, never a customer destination.
- One pending Telegram `alert_delivery` with its incident, lifecycle event, and immutable event payload.
- An enabled Telegram destination for that test store.
- A local `TELEGRAM_BOT_TOKEN` for a test bot.

## Prepare

Configure the test store's Telegram destination through the existing API. Keep the chat ID outside committed files.

Confirm the selected delivery is `pending`, has `attempt_count = 0`, and has no provider message ID or last error. Mark the companion email delivery for the same event as `sent` or `suppressed` so it does not affect the check.

Export the database URL in the current shell, read the bot token interactively, then set a non-empty test worker ID. Do not put these values in `.env`, scripts, source files, or the implementation plan.

## Run

Run:

```sh
npm run worker:telegram
```

Expected stdout is one aggregate JSON object with `channel: "telegram"`, `claimed: 1`, `sent: 1`, `retried: 0`, and `failed: 0`. It must not include a token, chat ID, request URL, or alert content.

Remove the token from the shell after the command completes.

## Verify

Confirm one message arrived in the private test chat. In PostgreSQL, the delivery must be `sent`, have `attempt_count = 1`, a non-null `sent_at`, and provider message ID `<chat_id>:<message_id>`. `last_error`, `locked_by`, `locked_at`, and `lease_expires_at` must be null.

Run the worker once more. It must report `claimed: 0` and must not create a second Telegram message.

Search the delivery record and captured runtime output for the test token. No token, full Telegram request URL, raw provider response, or alert text may be persisted or logged.

## Scope

This is a controlled manual release gate. It is not part of GitHub Actions and does not install a scheduler or make the Telegram channel production-automated.
