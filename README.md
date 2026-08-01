# Telegram TC

Telegram TC is a Telegram-to-MetaTrader 5 signal-copying platform. It connects to Telegram signal
channels, normalizes their messages into executable trade commands, lets an operator review and
configure how each provider is copied, and drives the `TelegramTC_EA` Expert Advisor to place and
manage the trades in MT5. It is built to handle the many ways real channels post signals rather than
a single fixed format.

The system is MT5-first and provider-agnostic: any channel can be added as a provider, tested against
its own history, tuned, and assigned to one or more MT5 accounts. Live copying requires a connected
Telegram account, a demo or live MT5 terminal, and the EA attached to a chart with WebRequest enabled
for the backend URL.

## What It Does

- Connects a Telegram account through a deterministic mock adapter (for testing) or the real
  teleproto adapter. The existing `gramjs` adapter setting remains as a compatibility label.
- Turns any Telegram channel or group into a provider that can be enabled, disabled, tested against
  its own message history, configured, and assigned to one or more MT5 accounts.
- Parses open-trade and lifecycle messages across the formats channels actually use: market, limit,
  and stop entries; entry zones; single and laddered levels; a stop and multiple take-profit targets;
  partial closes; move-SL-to-break-even; TP-hit and provider-close announcements; cancellations; and
  trailing stops.
- Reads a wide instrument range (forex majors and crosses, metals, indices, crypto, and oil) and
  copes with real-world formatting: the symbol on its own line or in a `SYM/SYM` pair, tickers with
  digits (`US30`, `NAS100`), a stop with no separator (`SL2286`), pip annotations, and non-English
  signal vocabulary such as French buy/sell terms.
- Fills in details a channel omits: a missing symbol from the provider's configured instrument(s),
  and a missing stop or target from provider defaults, so nothing is queued naked.
- Restricts a provider to a chosen set of traded symbols so only the instruments you want are copied,
  holding off-list signals for review.
- Resolves symbols through global aliases, provider aliases, account-specific overrides, broker
  suffix/prefix rules, and EA-reported broker symbol inventories.
- Ties provider follow-ups (cancels, TP-hits, closes, re-entries) back to the specific open trade
  they refer to through the Telegram reply link, so managed positions stay aligned with the provider.
- Builds logical trades and queue items for the EA while keeping parser intent separate from broker
  execution results.
- Deduplicates captured Telegram messages and can expire stale open-trade replays so refetching the
  recent Telegram history after a relaunch does not queue duplicate trades.
- Supports app-managed virtual TP handling, TP1-TP4 allocation, runner lots, break-even/last-TP/trail
  runner behaviour, split-order execution mode, and app-owned default SL/TP distances.
- Lets a take-profit leg configured at 0% allocation apply its own stop-loss strategy, such as
  break-even, once price reaches its target without closing any volume, so an operator can protect a
  trade without giving up a partial at TP1.
- Reconciles MT5 reports, snapshots, and broker history into open/closed trade history, execution
  logs, pending-order cancellation, out-of-sync diagnostics, and account/provider performance.
- Normalizes mixed-currency account performance into a configured reporting currency and leaves
  unsupported conversions blank instead of relabeling unknown rates.
- Pauses new open trades per account through Equity Guardian when drawdown breaches the configured
  threshold, while allowing lifecycle management commands to continue.

## Application Surfaces

The web app is an operator dashboard, not a landing page. The sidebar has three groups.

`Desk`:

- `Operations` (`/`): live account posture, exposure, and the latest desk activity.
- `Review queue` (`/logs`): Parser Lab, recent-message parsing, AI review, approve/ignore actions,
  fixture classification/redaction, saved fixtures, signal queue, and EA execution reports. Carries
  a badge when signals need review.

`Accounts`: one entry per connected MT5 account, plus any pending EA link slots waiting for their
link code to be claimed. Selecting an account opens its workspace. `Add account`
(`/linked-accounts`) handles MT5 link-slot creation, the link-code workflow, connected account
cards, provider assignment summary, and read-only external broker activity. It has no standing nav
item and is reached through that button.

`Setup`:

- `Providers` (`/providers`): aggregate provider overview, account-scoped copy chips, provider
  config, parser template and symbol lock, lot/risk sizing, TP allocation, runner config, provider
  config dry-run tests, parse-recent action, and CSV performance export.
- `Symbols` (`/symbols`): global and provider aliases, plus per-account broker symbol mappings.
- `Telegram` (`/telegram`): Telegram login, OTP/2FA flow, dialog refresh, provider selection, and
  provider resync for the global provider-monitoring lifecycle.
- `Settings` (`/settings`): display theme and colour accents, execution defaults, allowed order
  types, polling/dedup settings, stale open-trade expiry, risk display thresholds, reporting
  currency/USD-ZAR rate, Telegram bot alerting, on-demand database backup, and optional Azure
  OpenAI parser extraction key storage.

An account workspace at `/accounts/:accountId/:tab` shows the account-scoped tab strip:
`performance`, `providers`, `history`, `equity-guardian`, and `logs`. `Performance`
covers the overview chart, statistics view, account/provider range metrics, and external manual
broker activity that affects equity. `History` covers open positions and orders, external positions
and orders, closed trade rollups, and per-leg close detail. `Equity Guardian` covers account
drawdown thresholds and manual unpause controls. A per-account `symbols` view exists at the same URL
scheme so an unmapped-symbol alert can jump straight into that account's context, but it has no tab
of its own; routine alias and mapping work happens on the top-level `Symbols` page.

The top-level `/providers`, `/symbols`, and `/logs` routes are standalone views. They do not render
the account workspace tab strip.

## Repository Structure

- `apps/web`: React + Vite operations dashboard.
- `apps/api`: Bun/Hono API, static web serving, Telegram adapter boundary, SQLite persistence, MT5
  queue/reconciliation, and dashboard APIs.
- `packages/core`: deterministic parser, symbol resolver, lifecycle matcher, logical trade model,
  and queue payload builder.
- `mt5`: MetaTrader 5 Expert Advisor source that registers, heartbeats, posts snapshots/history,
  polls line-oriented work, executes commands, and reports broker results.
- `migrations`: historical SQLite bootstrap snapshots. The runtime schema in `apps/api/src/app.ts`
  is current; refresh the migration set before using it for a future D1-style backend.
- `docs`: archived planning, audit, and incident records with lasting reference value;
  `docs/archive/README.md` explains what remains and what was deleted.
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
| `ASSET_ARCHIVE_ROOT` | Where the API archives previous web asset bundles, so a client still on an older build keeps working through a deploy | `<DATABASE_PATH dir>/asset-archive` |
| `SEED_DEMO_DATA` | Seed local mock/demo rows | `false` |
| `DEFAULT_MT5_ACCOUNT_ID` | Fallback parser account context | demo account id |
| `TELEGRAM_ADAPTER` | Telegram adapter: `mock` or `gramjs` | `mock` unless real runtime is used |
| `TELEGRAM_API_ID` | Telegram API id for teleproto login | unset |
| `TELEGRAM_API_HASH` | Telegram API hash for teleproto login | unset |
| `TELEGRAM_SESSION_DIR` | Server-side teleproto session storage | `data/telegram-sessions` |
| `TELEGRAM_SESSION_FILE` | Explicit saved teleproto session file to import | unset |
| `TELEGRAM_IMPORT_EXISTING_SESSION` | Import the only JSON session in `TELEGRAM_SESSION_DIR` | `false` |
| `AZURE_OPENAI_API_KEY` | Optional parser extraction key | unset |
| `AZURE_OPENAI_ENDPOINT` | Optional Azure OpenAI endpoint override | code fallback if unset |
| `AZURE_OPENAI_DEPLOYMENT` | Parser extraction deployment/model name | `gpt-5.4-mini` |

For Docker Compose, put deployment secrets and runtime values in `.env.production`. Do not commit
`.env`, `.env.*`, SQLite files, logs, Telegram sessions, compiled EA artifacts, or runtime data.

## Telegram Workflow

Local tests use the mock Telegram adapter. For a real Telegram account, run the API with teleproto:

```bash
TELEGRAM_ADAPTER=gramjs bun run dev:api
```

The UI collects `api_id`, `api_hash`, phone, OTP code, and optional 2FA password, but only safe
profile/session identifiers are kept in browser state. Teleproto session strings are stored on the
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
`TELEGRAM_HISTORY_DAYS`, `TELEGRAM_CHUNKED`, `TELEGRAM_CHUNK_DAYS`, `TELEGRAM_DATE_FROM`,
`TELEGRAM_DATE_TO`, and `TELEGRAM_IMPORT_LIMIT` (message cap for the import step, default 50,000).

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
`mt5/TelegramTC_EA.mq5` only needs to move when the EA's own behaviour or protocol changes; a
web-only or API-only patch bumps the app version and leaves the EA metadata as it was:

```mql5
#property version   "1.65.0"
```

Classify every change with SemVer before final verification:

- Patch: backward-compatible bug fixes, logging, tests, labels, and safe UI/docs fixes.
- Minor: backward-compatible new behaviour, API fields, UI states, EA/backend payload fields, or
  workflows.
- Major: breaking API, DB, env, EA protocol changes, required migrations, or changes that make older
  deployed components unsafe or incompatible.

Documentation-only maintenance does not require a runtime version bump, but it still needs a
`changelog.md` entry.
