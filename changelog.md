# Changelog

## 2026-05-09

Implemented and verified the Telegram/KAL VIP parser backtest workflow.

Changes made in this session:

- Added local Telegram environment configuration in ignored `.env` for GramJS login, phone-based auth, saved session reuse, and the target `KAL VIP` dialog.
- Added persistent GramJS session reuse so saved Telegram session strings can reconnect after the API process restarts.
- Added local Telegram flow script at `scripts/telegram-flow.ts` for starting login, submitting OTP/2FA, listing dialogs, selecting KAL VIP, importing history, and running parser backtests.
- Added package scripts: `telegram:start`, `telegram:dialogs`, `telegram:select`, `telegram:import`, and `telegram:backtest`.
- Authenticated Telegram successfully with OTP and selected the KAL VIP provider.
- Imported 2,215 KAL VIP messages from roughly the last 3 months into ignored local SQLite storage.
- Added provider history import endpoint: `POST /api/providers/:id/import-messages`.
- Added provider parser backtest endpoint: `POST /api/providers/:id/backtest`.
- Added backtest JSON report output under ignored `data/backtests/`.
- Updated Telegram capture to include quoted/replied message text when available, allowing parser context for comments such as `Put this back`.
- Added quote-aware parser handling for reinstated signals where a later comment reactivates a quoted signal.
- Added wall-of-text signal extraction for `Execution Model` and `Execution Plan` blocks containing entry, SL, and TP details.
- Added direction inference from entry, SL, and TP geometry when a signal block omits explicit BUY/SELL wording.
- Added support for KAL VIP shorthand gold signals such as `Gold buy limit`, `Gold sell limit`, compact entry zones, and compact TP ranges.
- Added `NO_SIGNAL` classification to stop treating ordinary channel chatter and result summaries as executable trade entries.
- Tightened lifecycle classification for TP hits, SL result updates, cancels, close commands, and modification commands.
- Added explicit `TRAILING_STOP` command parsing with pips/points preserved as data instead of converted prematurely.
- Added parser fixtures for education/analysis text, result updates such as `Buy 66 full TP 400pips`, TP-only lifecycle updates such as `TP 1`, executable KAL VIP gold limits, and trailing-stop pips/points.
- Added detection for conditional multi-scenario plans so posts with both buy and sell setups plus `only if`/`reaction-based` wording are treated as analysis, not executable orders.
- Applied KAL VIP's default Gold/XAUUSD provider context to symbol-less lifecycle updates such as `TP 1`, reducing false manual-review items.
- Added Parser Lab fixture labelling controls in the dashboard so captured parsed messages can be marked as entry, management, noise, or unknown and saved as reusable parser fixtures.
- Added optional redacted fixture text capture in Parser Lab so sensitive names, links, or account details can be replaced before saving deterministic fixtures.
- Tightened Parser Lab fixture-redaction coverage so the saved fixture payload reflects the operator-edited text from the fixture row.
- Extended dashboard parser results with raw message IDs and classification metadata for fixture capture.
- Added provider auto-copy enable/pause controls in the dashboard, backed by the existing provider settings API.
- Added provider parser-mode and risk-profile settings through SQLite-backed API persistence and dashboard controls.
- Added configurable global symbol aliases and account symbol mappings through the API and dashboard controls.
- Added SQLite-backed execution settings for default lot size, default risk percent, MT5 polling interval, and allowed order types, with dashboard controls.
- Enforced allowed order types during signal approval so disabled market, limit, or stop orders cannot enter the MT5 queue.
- Propagated default lot size and risk percent into queued MT5 poll-line payloads, and updated the EA to use backend-provided command volume with its local default as a fallback.
- Added configured MT5 polling intervals to both work and no-work poll-line payloads, with EA timer refresh support.
- Persisted ignored and duplicate parser decisions as non-leaseable queue items so the dashboard can show those queue states without sending them to MT5.
- Reconciled MT5 execution reports back into logical trade state so executed opens mark TP legs open and virtual-TP broker comments close the matching TP leg on the dashboard.
- Recorded provider-announced `MARK_TP_HIT` lifecycle messages locally against the matched logical trade instead of queueing unsupported MT5 work.
- Persisted latest MT5 snapshots per account, surfaced broker position/order counts in the dashboard, and marked open logical trades out of sync when snapshots no longer contain matching broker records.
- Added deterministic parser extraction for optional lot size and risk percent as review metadata only; MT5 execution no longer trusts provider-sent lot/risk hints.
- Added per-Telegram-channel lot size persistence, API updates, and dashboard controls so each provider owns its execution volume.
- Added explicit per-TP volume splitting in queued MT5 line payloads, for example channel lot `0.20` across four TP targets sends `0.05` per TP leg.
- Updated the MQL5 EA to consume backend-provided TP leg volumes for split-order requests and virtual-TP partial closes.
- Added account-scoped MT5 log inspection at `GET /api/mt5/accounts/:accountId/logs`, with optional account filtering on `GET /api/execution-logs?accountId=...`.
- Added SQLite/D1-ready `symbol_aliases` persistence and parser-context merging so saved aliases affect subsequent parser resolution.
- Verified live fixture capture through the API: raw message classification update, fixture save, and fixture retrieval with Telegram/raw-message metadata and expected parser fields.
- Added local MT5 API/EA contract smoke script at `scripts/mt5-smoke.ts`.
- Added package script: `mt5:smoke`.
- Extended typechecking to cover `scripts/`, including Telegram and MT5 helper scripts.
- Verified the local MT5 contract smoke against the running API. The smoke registered a unique demo MT5 account, sent heartbeat, parsed and approved an `OPEN_TRADE`, leased the line-oriented `/api/mt5/poll-line` payload, reported execution through `/api/mt5/report`, then repeated the same flow for a `MOVE_SL_TO_BE` lifecycle command matched to the logical trade.
- Documented that `bun run mt5:smoke` proves the backend contract consumed by the EA, but does not replace a real MetaTrader terminal compile/run.
- Added `MODIFY_TP` dispatch and SL/TP modification handling to the MQL5 Expert Advisor.
- Fixed MQL5 execution report calls so every `Report(...)` call passes the explicit `volume` argument expected by the report function.
- Added static EA source tests for `MODIFY_TP` dispatch and compile-safer `Report(...)` call arity.
- Added MT5 smoke helper coverage for heartbeat payloads with terminal symbols.
- Tightened MQL5 broker-state matching so position management and pending-order cancellation check logical trade IDs embedded in broker comments, not only symbol plus magic number.
- Added static EA source coverage for logical-trade comment matching on positions and pending orders.
- Added MQL5 snapshot reporting to `/api/mt5/snapshot` with current EA-owned positions and pending orders, including tickets, symbols, type, volume, open price, SL, TP, profit, and broker comments.
- Extended MQL5 snapshots with selected-symbol bid/ask, point, digits, and broker volume min/max/step metadata for plan-vs-reality checks.
- Added static EA source coverage for snapshot reporting.
- Replaced chart-symbol-only MT5 `availableSymbols` payloads with a terminal symbol inventory built from `SymbolsTotal(false)` and `SymbolName(index, false)`.
- Added static EA source coverage so registration and heartbeat symbol reporting cannot regress to `_Symbol` only.
- Added pending-order price validation in the MQL5 EA against current bid/ask and broker `SYMBOL_TRADE_STOPS_LEVEL` distance before sending pending order requests.
- Added static EA source coverage for pending-order bid/ask and stop-level validation.
- Added MQL5 execution for `TRAILING_STOP`, converting pips or points with the broker symbol point size before improving SL.
- Added API approval support for configurable execution mode, so approved open signals can queue either default `VIRTUAL_TP` or explicit `SPLIT_ORDER`.
- Added MQL5 split-order execution that creates one child request per configured TP leg with per-leg volume allocation and TP-specific comments.
- Added MQL5 virtual TP monitoring that tracks TP1-TP4 legs after a virtual-TP open, watches live bid/ask on timer, and closes planned partial volumes when a TP threshold is hit.
- Added tests for trailing-stop line-poll payloads, split-order approval payloads, split child order source coverage, and virtual TP source coverage.
- Added `docs/mt5-demo-terminal-verification.md` with the remaining manual MT5 compile/demo-terminal verification runbook.
- Documented the important pips/points behavior in parser output: conversion must happen broker-side using the account symbol point size.
- Added parser tests for KAL VIP gold limit signals, result chatter, quote reinstatement, wall-of-text execution blocks, education text, TP lifecycle updates, and trailing stop pips/points.
- Updated Biome includes so ignored local Telegram session files under `apps/api/data/` do not break linting.

Latest KAL VIP backtest after parser improvements:

- Total messages: 2,215
- `NO_SIGNAL`: 1,233
- `OPEN_TRADE`: 729
- Lifecycle commands: 253
- Actionable messages: 982
- Actionable messages requiring review: 83
- Actionable review rate: 8.45%

Verification run after code changes:

- `bun run typecheck`
- `bun test`
- `bun run lint`
- `bun run build`
- `bun run docker:build`
- `bun run mt5:smoke`
- Live GramJS dialog listing against the saved Telegram session.
- Live KAL VIP parser backtest via `bun run telegram:backtest`.
- Playwright desktop and mobile screenshots for the dashboard fixture controls.

Latest MT5 local contract smoke:

- Account registered: unique `mt5-900...` demo account generated per smoke run.
- Heartbeat: account reported `online` through `/api/mt5/heartbeat`.
- Open command: `OPEN_TRADE` for `EURUSD.raw` leased from `/api/mt5/poll-line` and reported as executed with retcode `10009`.
- Lifecycle command: `MOVE_SL_TO_BE` for the same logical trade leased from `/api/mt5/poll-line` and reported as executed with retcode `10009`.
- Execution logs: both smoke queue items found in `/api/execution-logs`.

Known remaining parser gaps:

- Some educational messages can still resemble lifecycle instructions if they contain trade-management words in natural language.
- TP-only updates such as `Tp 1` still require matching to the most recent open logical trade before they can be safely acted on.
- More KAL VIP messages should be manually labelled as fixtures to calibrate false positives and false negatives.
- Image/OCR signal parsing remains deferred and is not implemented.

## 2026-05-09 (Web UI Milestone 1)

Completed Bloomberg-terminal-style dark UI rewrite for `apps/web` + 8 functional bug fixes.

Infrastructure & theming:
- Rewrote `apps/web/src/styles.css` with a dark-terminal palette (`--bg: #0c0f12`, `--panel: #12161b`, `--accent: #54b8ff`), flat 1 px borders, zero shadows, `tabular-nums`, `Inter`+mono stacks, and a maximum 4 px radius.
- Updated `apps/web/index.html` with `<meta name="color-scheme" content="dark">` and title `TG-TC · Operations`.
- Installed `uplot` (~40 KB) as the lightweight charting dependency for Milestone 3.

Structural rewrite:
- Created `apps/web/src/components/` with `Tag.tsx`, `StatusBar.tsx`, `Sidebar.tsx`, `Panel.tsx`, `SetupFlow.tsx`, and `DialogPicker.tsx`.
- Rewrote `App.tsx` shell around three new regions:
  - `StatusBar` (28 px sticky top bar): brand, DB/Telegram health chips, signal-queue count, UTC clock, live pulse dot, and wired refresh action.
  - `Sidebar` (200 px sticky nav): section switcher driven by `activeView` state.
  - Conditional panel rendering via `activeView`; default `"dashboard"` renders all panels simultaneously to preserve existing test DOM assertions.
- Replaced `StatusPill` with `Tag` component using 1 px border tone tokens (`good`/`warn`/`muted`/`up`/`down`).

Bug fixes:
- **(a)** Wired the refresh action into `StatusBar` so the top-right refresh button actually triggers `refreshDashboard()` instead of being a no-op.
- **(b)** Wired `activeView` sidebar navigation as a real section switcher (`showDashboard`, `showTelegram`, `showProviders`, etc.).
- **(c)** Fixed `mappingForm.accountId` syncing via `useEffect` + `hasSyncedMapping` ref so the mapping form defaults to the first live MT5 account instead of a hardcoded placeholder.
- **(e)** Replaced the DOM-hack fixture redaction with proper `redactedFixtureText` React state + ref map, fixing race conditions during fixture saves.
- **(f)** Replaced the static `"-"` placeholder with a live pulse dot in the status bar to indicate real-time connection health.
- **(g)** Added `lastPollError` and `refreshing` states with visual feedback (error chip, loading state on refresh button) so the operator knows when dashboard health is stale or reloading.
- **(h)** Ensured execution log timestamps render in a dedicated `timestamp` column instead of being omitted.

Form/test interop:
- Converged alias and mapping forms to controlled inputs for UI consistency, while reading from `FormData` on submit to remain compatible with existing `fireEvent.change` tests.
- Used `Map<HTMLTextAreaElement>` refs for fixture textarea values so `Save fixture` reads synchronously from the DOM, bypassing React state batching issues in the Happy DOM test environment.

Verification:
- `bun test`: 63 pass, 0 fail.
- `bun run typecheck`: clean.
- `bun run lint`: clean (warnings only).
- `bun run build`: web bundle 220 KB JS + 17 KB CSS.

Known remaining MT5 verification gap:

- The backend/EA HTTP contract has been smoke-tested locally, and the EA source is statically covered by tests, but the `.mq5` file still needs to be compiled and run inside a real MetaTrader 5 demo terminal to prove actual order placement, broker retcodes, and hedging/netting behavior.

Known remaining MT5 implementation gaps:

- EA-managed virtual TP1-TP4 monitoring is implemented in source but still needs demo-terminal proof under real broker ticks and volume constraints.
- Split-order mode creates TP child requests in source but still needs demo-terminal proof on hedging and netting accounts.
- `TRAILING_STOP` is implemented in source but still needs demo-terminal proof against symbol point sizes and broker stop-level rules.
