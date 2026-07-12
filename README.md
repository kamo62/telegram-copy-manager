# Telegram TC

Telegram TC is a local-first Telegram-to-MetaTrader 5 copy-trading operations desk. It connects to
Telegram signal channels, normalizes messages into executable trade commands, lets an operator review
and configure provider behaviour, and exposes a polling contract for the `TelegramTC_EA` Expert
Advisor to execute work in MT5.

The app is MT5-first. Telegram auth, provider selection, parsing, queueing, account linking, and
broker-state reconciliation are implemented. Live trading still depends on a configured Telegram
account, a demo or live MT5 terminal, and the EA being attached to an MT5 chart with WebRequest
enabled for the backend URL.

## What It Does

- Connects a Telegram account with either the deterministic mock adapter or the real GramJS adapter.
- Turns selected Telegram channels or groups into providers that can be enabled, disabled, tested,
  configured, symbol-locked, and assigned to one or more MT5 accounts.
- Parses open-trade and lifecycle messages, including market/limit/stop entries, SL/TP levels,
  partial closes, move-SL commands, TP-hit announcements, and trailing-stop commands.
- Supports an extended parser mode for terse single-symbol level posts (for example short
  Gold/XAUUSD levels), expanding shorthand levels like `41`, `56`, and `03` from a fresh
  EA-reported reference price when the provider is locked to one symbol.
- Resolves symbols through global aliases, provider aliases, account-specific overrides, broker
  suffix/prefix rules, and EA-reported broker symbol inventories.
- Builds logical trades and queue items for the EA while keeping parser intent separate from broker
  execution results.
- Deduplicates captured Telegram messages and can expire stale open-trade replays so refetching the
  recent Telegram history after a relaunch does not queue duplicate trades.
- Supports app-managed virtual TP handling, TP1-TP4 allocation, runner lots, break-even/last-TP/trail
  runner behaviour, split-order execution mode, and app-owned default SL/TP distances.
- Reconciles MT5 reports, snapshots, and broker history into open/closed trade history, execution
  logs, missing pending-order cancellation, out-of-sync diagnostics, account performance, provider
  performance, and external/manual broker activity.
- Normalizes USD/ZAR mixed-account performance into a configured reporting currency and leaves
  unsupported mixed-currency aggregates blank instead of relabeling unknown conversions.
- Pauses new open trades per account through Equity Guardian when drawdown breaches the configured
  threshold, while allowing lifecycle management commands to continue.

## Application Surfaces

The web app is an operator dashboard, not a landing page. The main navigation is:

- `Live`: account overview, account-specific live workspace, pending EA link slots, and the active
  workspace tabs.
- `Telegram Setup`: Telegram login, OTP/2FA flow, dialog refresh, provider selection, and provider
  resync for the global provider-monitoring lifecycle.
- `Linked Accounts`: MT5 link-slot creation, link-code workflow, connected account cards, provider
  assignment summary, and read-only external broker activity.
- `Settings`: execution defaults, allowed order types, polling/dedup settings, stale open-trade
  expiry, risk display thresholds, reporting currency/USD-ZAR rate, and optional Azure OpenAI parser
  extraction key storage.

Inside the Live workspace:

- `Performance`: overview chart, statistics view, account/provider range metrics, and external
  manual broker activity that affects equity.
- `Providers`: aggregate provider overview, account-scoped copy chips, provider config, parser
  template and symbol lock, lot/risk sizing, TP allocation, runner config, provider config dry-run
  tests, parse-recent action, and CSV performance export.
- `History`: open positions/orders, external positions/orders, closed trade rollups, and per-leg
  close detail.
- `Equity Guardian`: account drawdown thresholds and manual unpause controls.
- `Symbol Settings`: global/provider aliases and per-account broker symbol mappings.
- `Logs`: Parser Lab, recent-message parsing, AI review, approve/ignore actions, fixture
  classification/redaction, saved fixtures, signal queue, and EA execution reports.

## Repository Structure

- `apps/web`: React + Vite operations dashboard.
- `apps/api`: Bun/Hono API, static web serving, Telegram adapter boundary, SQLite persistence, MT5
  queue/reconciliation, and dashboard APIs.
- `packages/core`: deterministic parser, symbol resolver, lifecycle matcher, logical trade model,
  and queue payload builder.
- `mt5`: MetaTrader 5 Expert Advisor source that registers, heartbeats, posts snapshots/history,
  polls line-oriented work, executes commands, and reports broker results.
- `migrations`: SQLite schema used by the app and kept portable for a future D1-style backend.
- `scripts`: local Telegram import/backtest helper and MT5 smoke-test helper.
- `data`: runtime-only local databases, Telegram session files, backtest output, and other generated
  state. This path is ignored by git and Docker build context.

## Local Development

Use Bun for this project.

```bash
bun install
bun run dev:api
bun run dev:web
```

The API listens on `http://127.0.0.1:8787`. The Vite dev server listens on
`http://127.0.0.1:5173`. In production builds, the API serves the built web app from
`apps/web/dist`.

Useful scripts:

```bash
bun run typecheck
bun run lint
bun test
bun run build
bun run docker:build
bun run mt5:smoke
```

## Configuration

Common environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | API/server port | `8787` |
| `DATABASE_PATH` | SQLite database path | `data/telegram-tc.db` |
| `WEB_STATIC_ROOT` | Static web build path for the API to serve | auto-detects `apps/web/dist` |
| `SEED_DEMO_DATA` | Seed local mock/demo rows | `false` |
| `DEFAULT_MT5_ACCOUNT_ID` | Fallback parser account context | demo account id |
| `TELEGRAM_ADAPTER` | Telegram adapter: `mock` or `gramjs` | `mock` unless real runtime is used |
| `TELEGRAM_API_ID` | Telegram API id for GramJS login | unset |
| `TELEGRAM_API_HASH` | Telegram API hash for GramJS login | unset |
| `TELEGRAM_SESSION_DIR` | Server-side GramJS session storage | `data/telegram-sessions` |
| `TELEGRAM_SESSION_FILE` | Explicit saved GramJS session file to import | unset |
| `TELEGRAM_IMPORT_EXISTING_SESSION` | Import the only JSON session in `TELEGRAM_SESSION_DIR` | `false` |
| `AZURE_OPENAI_API_KEY` | Optional parser extraction key | unset |
| `AZURE_OPENAI_ENDPOINT` | Optional Azure OpenAI endpoint override | code fallback if unset |
| `AZURE_OPENAI_DEPLOYMENT` | Parser extraction deployment/model name | `gpt-5.4-mini` |

For Docker Compose, put deployment secrets and runtime values in `.env.production`. Do not commit
`.env`, `.env.*`, SQLite files, logs, Telegram sessions, compiled EA artifacts, or runtime data.

## Telegram Workflow

Local tests use the mock Telegram adapter. For a real Telegram account, run the API with GramJS:

```bash
TELEGRAM_ADAPTER=gramjs bun run dev:api
```

The UI collects `api_id`, `api_hash`, phone, OTP code, and optional 2FA password, but only safe
profile/session identifiers are kept in browser state. GramJS session strings are stored on the
server under `data/telegram-sessions`.

The helper script can drive a command-line import/backtest flow against a running API:

```bash
TELEGRAM_ADAPTER=gramjs bun run dev:api
TELEGRAM_API_ID=... TELEGRAM_API_HASH=... TELEGRAM_PHONE_NUMBER=... bun run telegram:start
bun scripts/telegram-flow.ts code <telegram-code>
bun run telegram:dialogs
bun run telegram:select
bun run telegram:import
bun run telegram:backtest
```

Optional script knobs include `TELEGRAM_TC_API_URL`, `TELEGRAM_TARGET_DIALOG`,
`TELEGRAM_HISTORY_DAYS`, `TELEGRAM_CHUNKED`, `TELEGRAM_CHUNK_DAYS`, `TELEGRAM_DATE_FROM`, and
`TELEGRAM_DATE_TO`.

## MT5 Workflow

1. Build or compile `mt5/TelegramTC_EA.mq5` in MetaEditor.
2. Start the API or Docker service.
3. In the app, create a link slot from `Linked Accounts`.
4. In MT5, open `Tools -> Options -> Expert Advisors`, enable WebRequest, and add the backend URL
   that the EA will call, for example `http://<your-server-host>:18787`.
5. Attach `TelegramTC_EA` to a chart, enable live trading, set `BackendBaseUrl` to the API `/api`
   URL, and paste the app link code into `LinkCode`.
6. Wait for the EA to register and heartbeat. The slot will turn into a connected account in the
   dashboard.

The EA currently polls `/api/mt5/poll-line`, executes line-oriented commands, posts execution
reports to `/api/mt5/report`, sends broker snapshots to `/api/mt5/snapshot`, and sends history deals
to `/api/mt5/history`. It also heartbeats with balance, equity, and available symbols.

Important EA inputs:

- `BackendBaseUrl`: deployed API base URL ending in `/api`.
- `LinkCode`: code from the app's link slot.
- `PollSeconds`: work polling cadence.
- `HeartbeatSeconds`: account heartbeat cadence.
- `HistoryBackfillSeconds` and `HistoryLookbackHours`: broker-history sync cadence and window.
- `DefaultLots`: fallback lots if provider/app sizing does not provide volume.
- `BrokerMinLotMultiplier`: optional broker-minimum sizing override across symbols.
- `MinStopBufferMultiplier`: optional broker stop-distance safety buffer.

## API Overview

The API is intentionally simple HTTP/JSON plus a line-oriented MT5 polling endpoint:

- Health and dashboard: `GET /health`, `GET /api/health`, `GET /api/dashboard`,
  `GET /api/telegram/status`.
- Telegram: `/api/telegram/start`, `/api/telegram/verify-code`, `/api/telegram/submit-password`,
  `/api/telegram/dialogs`, `/api/telegram/disconnect`.
- Providers and parser lab: `/api/providers`, `/api/providers/:id/*`, `/api/parser/*`,
  `/api/providers/performance`, `/api/providers/performance/export.csv`,
  `/api/signals/:id/approve`, `/api/signals/:id/ignore`, `/api/signals/:id/ai-review`.
- Symbols and settings: `/api/settings`, `/api/symbol-mappings/*`.
- MT5 account linking and protection: `/api/account-slots`, `/api/account-provider-links`,
  `/api/equity-guardian`, `/api/accounts/:accountId/stats`,
  `/api/accounts/:accountId/risk-thresholds`.
- MT5 execution contract: `/api/mt5/register`, `/api/mt5/heartbeat`, `/api/mt5/poll-line`,
  legacy `/api/mt5/poll`, `/api/mt5/report`, `/api/mt5/snapshot`, `/api/mt5/history`,
  `/api/mt5/active-plans`.
- Logs and reconciliation: `/api/execution-logs`, `/api/mt5/accounts/:accountId/logs`,
  `/api/execution-logs/:id`, `/api/trades/:id/broker-orders`, `/api/account/performance`.

## Docker

Build the local image:

```bash
bun run docker:build
```

Run the home-server compose service with Docker Compose v2:

```bash
docker compose up -d --build
```

The compose file maps host port `18787` to container port `8787`, loads `.env.production`, mounts
`./data` to `/app/data`, and uses `restart: unless-stopped` so the service comes back after host or
Docker daemon restarts.

Use `docker compose`, not the old `docker-compose` v1 binary. The v1 binary can fail during
container recreation with `KeyError: 'ContainerConfig'` on newer image metadata.

## Backups and restore

Create a SQLite backup through the admin endpoint. The API keeps the newest 14 files under
`data/backups/`:

```bash
curl -fsS -X POST http://127.0.0.1:18787/api/admin/backup
curl -fsS http://127.0.0.1:18787/api/admin/backups
```

To restore, stop the container, copy the chosen backup over `data/telegram-tc.db`, then start the
container again:

```bash
docker compose stop app
cp data/backups/telegram-tc-<UTC-timestamp>.db data/telegram-tc.db
docker compose up -d app
```

Example host crontab entry for a nightly backup at 02:17:

```cron
17 2 * * * curl -fsS -X POST http://127.0.0.1:18787/api/admin/backup >/dev/null
```

## License

Telegram TC is source-available under the custom licence in `LICENSE`.

- Free for personal, educational, evaluation, research, and other non-commercial use.
- Personal use on your own trading account is allowed as long as you are not selling, hosting,
  sublicensing, managing, or otherwise monetizing the software or a service based on it for someone
  else.
- Commercial use is not granted by the public licence. Selling it, hosting it as a paid service,
  bundling it into a paid product, using it for paid client work, or running it inside a for-profit
  organisation requires a separate written royalty-bearing commercial licence from the owner.

This is not an OSI open-source licence because commercial use is restricted.

## Verification

Before pushing any code or docs change, run the full gate:

```bash
bun run typecheck
bun run lint
bun test
bun run build
bun run docker:build
```

`bun run mt5:smoke` is available for a running API when you want to exercise the parser -> approval
-> MT5 poll-line -> report path without a real terminal. Real execution still needs manual demo/live
terminal verification because only MT5 can prove broker retcodes, WebRequest allow-listing, EA input
values, symbol metadata, and live order handling.

## Versioning

The root `package.json` `version` field is the canonical application version. The MT5 EA version in
`mt5/TelegramTC_EA.mq5` must stay aligned with it:

```mql5
#property version   "1.15.0"
```

Classify every change with SemVer before final verification:

- Patch: backward-compatible bug fixes, logging, tests, labels, and safe UI/docs fixes.
- Minor: backward-compatible new behaviour, API fields, UI states, EA/backend payload fields, or
  workflows.
- Major: breaking API, DB, env, EA protocol changes, required migrations, or changes that make older
  deployed components unsafe or incompatible.

Documentation-only maintenance does not require a runtime version bump, but it still needs a
`changelog.md` entry.
