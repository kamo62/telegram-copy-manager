# Changelog

## 2026-05-20 (Provider modal TP allocation copy)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.8` and kept the
  MT5 EA `#property version` aligned at `1.6.8` for the repo version guard.
- Reworded the provider TP allocation hint and runner summary so they describe scaled TP
  percentages and the configured TP sequence instead of referring to a confusing "final TP".
- Tightened provider strategy dropdown sizing so "Leave SL unchanged" rows stay aligned with the
  delete control and use the same dropdown treatment as the rest of the modal.

## 2026-05-20 (Provider TP pickup and manual close accounting)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.7` and kept the
  MT5 EA `#property version` aligned at `1.6.7` because this corrects provider TP fallback logic and
  realized P/L accounting without changing the EA/backend payload schema.
- Corrected provider TP handling: empty provider TP config still falls back to the app-wide default
  TP, but a provider configured with TP levels now uses matching Telegram TP lines when they exist.
- Kept the single-TP/no-runner fallback to the app-wide TP only for messages that do not contain a
  provider TP to pick up.
- Included external/manual broker history deals in the EA history feed and recorded unmatched
  history deals under stable external trade ids so closed manual MT5 trades move from floating P/L
  into realized P/L, equity curve, drawdown, and monthly performance.

## 2026-05-20 (Provider TP cardinality and default TP fallback)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.6` and kept the
  MT5 EA `#property version` aligned at `1.6.6` because this fixes provider config semantics and
  frontend modal behaviour without changing the EA/backend protocol.
- Preserved empty provider take-profit configs as "no configured provider TPs" instead of silently
  recreating TP1-TP4. Explicit message TPs are then ignored for that provider and the app-wide
  default TP distance is used.
- Kept provider TP cardinality capped at four for now.
- Let the provider config modal delete the final TP row and reload saved provider TP/runner config
  from the dashboard snapshot.

## 2026-05-20 (Small-runner virtual TP close sizing)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.5` and kept the
  MT5 EA `#property version` aligned at `1.6.5` because this is a backwards-compatible backend
  virtual-TP sizing fix with no EA/backend protocol change.
- Fixed app-managed virtual TP close sizing for small trades with a configured runner. When the
  broker-filled volume minus runner volume leaves a managed TP slice smaller than the broker lot
  step, the backend now falls back to the already-planned TP leg volume instead of rounding the close
  request to zero and leaving TP1 unqueued.
- Added a regression for the live SELL 4488 / TP1 4483 shape: 0.02 lots with a 0.01 runner and a
  25% TP1 allocation must still queue a 0.01-lot TP1 close when price crosses TP1.

## 2026-05-19 (Stale-snapshot SL close reconciliation)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.4` and kept the
  MT5 EA `#property version` aligned at `1.6.4` because this is a backwards-compatible backend
  reconciliation fix with no EA/backend protocol change.
- Fixed MT5 history close classification when the latest snapshot is stale. If an SL/TP/history
  deal's close volume covers the remaining broker-open volume, the backend now records it as a
  terminal `FULL_CLOSE` instead of leaving it as a non-TP `PARTIAL_CLOSE`.
- Startup repair now heals older `OUT_OF_SYNC` trades whose recorded close rows cumulatively cover
  the open volume, including rows that were previously mis-recorded as `PARTIAL_CLOSE`.
- Added regressions for full-volume SL closes, TP1-then-SL remaining-volume closes, and startup
  healing of stale partial-close broker history.

## 2026-05-19 (PR review fixes: poll lease safety and filled-volume virtual TP sizing)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.3` and kept the
  MT5 EA `#property version` aligned at `1.6.3` because this fixes two backwards-compatible runtime
  bugs without changing the backend/EA command protocol.
- Stopped retrying `/mt5/poll-line` in the EA. Polling leases queue items server-side, so a lost
  response must not trigger another lease that could skip or reorder pending commands.
- Changed app-managed virtual TP close sizing to use the broker-reported OPEN filled volume for the
  matched position before falling back to the original requested queue volume. This keeps TP-leg
  partial closes correct when `BrokerMinLotMultiplier` changes the actual lot size sent by the EA.
- Added regressions for both PR review findings.

## 2026-05-19 (EA default link code update)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.2` and kept the
  MT5 EA `#property version` aligned at `1.6.2` because this updates the default EA link-code input
  without changing the backend/EA command protocol.
- Updated the EA `LinkCode` default from `-IF3QCYL` to `-UTN4-D6`.
- Added an EA source regression so the expected default link code is checked with the other EA
  packaging/source invariants.

## 2026-05-19 (EA lifecycle command Journal logging)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.1` and kept the
  MT5 EA `#property version` aligned at `1.6.1` because this adds observability without changing the
  backend/EA command protocol.
- Added MT5 Journal logging whenever the EA receives backend `status=WORK`, including command type,
  queue id, logical trade id, symbol, target position/order tickets, partial-close fields, and
  requested SL context.
- Added focused logs for `MODIFY_SL`, `CLOSE_TRADE`/`CLOSE_PARTIAL`, and `TRAILING_STOP` execution
  paths so recovered virtual-TP plans can be traced from backend recovery through EA-side work.
- Added an EA source regression to keep the lifecycle command logging contract in place.

## 2026-05-19 (Virtual TP recovery and operator-state guard)

- Release impact: Minor. Bumped the canonical app version in `package.json` to `1.6.0` and kept the
  MT5 EA `#property version` aligned at `1.6.0` because this adds persisted trade source lineage,
  startup virtual-TP recovery behaviour, and an operator-state startup guard.
- Approved logical trades now keep their source Telegram/raw-message lineage directly in
  `logical_trades.data_json` so a reload/redeploy can trace a broker trade back to the parsed signal
  and raw provider message without relying only on queue rows.
- Startup reconciliation now recovers still-live `OUT_OF_SYNC` virtual-TP trades when persisted
  broker open evidence exists, restoring the logical trade to `OPEN`, re-arming planned TP legs, and
  restoring the active-plan line payload with the known position ticket.
- Added a startup preservation guard for operator-owned routing/config state. Provider links,
  provider config/history, account symbol mappings, and symbol aliases are snapshotted before and
  after startup maintenance; any mutation raises an error instead of silently disappearing, and a
  preserved audit event is written when protected rows exist.
- Added regressions for source lineage, live virtual-TP recovery, and startup mapping/config
  preservation.

## 2026-05-19 (Runner breakeven after app-managed TP)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.5.1` and kept the
  MT5 EA `#property version` aligned at `1.5.1` for deployment/package traceability.
- Fixed app-managed virtual TP runner handling when MT5 reports a TP-leg partial close with a
  generic broker comment such as `Request executed`. The backend now queues the configured
  post-TP `MODIFY_SL`/runner strategy from the structured `CLOSE_PARTIAL` payload instead of
  relying on a broker comment that names `tp1`.
- Added a regression covering the live 200-pip default-TP runner path where TP1 closes the managed
  volume and the remaining runner must move to breakeven.

## 2026-05-19 (Source-available commercial licensing)

Documentation/legal metadata update; no runtime SemVer bump. `package.json` and
`mt5/TelegramTC_EA.mq5` remain at `1.5.0`.

- Added a custom source-available licence that allows free non-commercial use and reserves
  commercial rights for a separate royalty-bearing commercial agreement.
- Added the root `package.json` licence pointer to `LICENSE`.
- Added the README licence summary so users understand non-commercial use, personal trading use, and
  commercial licensing requirements.

## 2026-05-19 (README refresh and Markdown documentation pruning)

Documentation-only maintenance; no runtime SemVer bump. `package.json` and
`mt5/TelegramTC_EA.mq5` remain at `1.5.0`.

- Removed outdated supporting Markdown documents under `docs/` so the README is the primary
  project documentation surface.
- Rewrote the README from the current app implementation, covering the Telegram setup, provider
  configuration, MT5 link-code workflow, EA inputs, API surfaces, Docker deployment, runtime
  configuration, verification gate, and versioning rules.
- Kept `changelog.md` because this repo requires a changelog entry for every change.

## 2026-05-19 (App-owned default TP runners)

- Release impact: Minor. Bumped the canonical app version in `package.json` to `1.5.0` and kept the
  MT5 EA `#property version` aligned at `1.5.0` because this adds app-owned default-TP runner
  management while preserving the existing queue/report contract.
- Fixed no-provider-TP virtual trades so the app derives the TP target from the configured default
  distance and the actual broker open price, then queues a ticket-specific TP-leg partial close when
  live MT5 quotes cross that derived target.
- Runner-aware virtual TP closes now reserve the configured runner volume. For example, a `0.02`
  order with a `0.01` runner closes `0.01` at the default 200-pip TP instead of trying to close the
  whole position.
- Added app-side runner management after the final TP leg confirms: break-even/last-TP modes queue
  `MODIFY_SL`, and trail mode queues the existing EA `TRAILING_STOP` command against the broker
  position ticket.
- Removed the legacy EA-owned virtual-TP state machine, rehydration, and runner handling from
  `mt5/TelegramTC_EA.mq5`. The EA now stays focused on execution, snapshots, broker-history
  reporting, and explicit trailing-stop commands; virtual TP ownership lives in the app.
- Added regressions for the KAL-style default-TP runner path and for keeping virtual-TP ownership out
  of the EA source.

## 2026-05-18 (Closed trade reconciliation fixes)

- Release impact: Minor. Bumped the canonical app version in `package.json` to `1.4.0` and kept the
  MT5 EA `#property version` aligned at `1.4.0` because this adds a `CANCELLED` logical-trade state
  while preserving the existing EA/backend protocol.
- Fixed closed-trade rollups for pending limit/stop orders so the initial broker acceptance row is
  not counted as a filled position. Closed rows now use the actual MT5 fill for entry ticket,
  volume, and weighted open price.
- Hardened startup reconciliation for stuck `OUT_OF_SYNC` trades: persisted real broker close rows
  heal to `CLOSED`, duplicate synthetic snapshot-diff close rows are removed, and unrecoverable
  trades with no broker open evidence are marked `CANCELLED`.
- Fixed the current typecheck/lint blockers in the API tests and closed-history UI.
- Added regressions for pending-order close rollups, persisted startup backfill, and unrecoverable
  out-of-sync cancellation.

## 2026-05-18 (App-managed virtual TP)

- Release impact: Minor. Bumped the canonical app version in `package.json` to `1.3.0` and kept the
  MT5 EA `#property version` aligned at `1.3.0`.
- Moved default virtual TP ownership into the backend application. Pending limit/stop orders now
  remain `PENDING` with planned TP legs until MT5 history or a live position confirms the fill.
- Added app-side TP detection from MT5 quote snapshots, idempotent TP-leg `CLOSE_PARTIAL` queueing,
  post-close SL strategy queueing, and broker-history reconciliation for SL closes before TP
  confirmation.
- Changed the EA into a thinner executor/event reporter for virtual TP flow: it reports new deals
  immediately from `OnTradeTransaction`, keeps snapshots/polling at one second, and throttles
  heartbeat/history backfill work separately.
- Added API and EA source regressions covering pending-order arming, app-managed TP1 close queueing,
  SL strategy queueing, SL-history reconciliation, and transaction-driven history reporting.

## 2026-05-18 (Pending order side labels)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.2.2` and kept the
  MT5 EA `#property version` aligned at `1.2.2`.
- Fixed the History Open pending-orders table so MT5 pending order enums such as `BUY_LIMIT` and
  `BUY_STOP` render as BUY instead of being treated as SELL positions.
- Added a web regression test for mixed buy/sell pending order snapshots.

## 2026-05-18 (Compose restart policy)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.2.1` and kept the
  MT5 EA `#property version` aligned at `1.2.1`.
- Added `restart: unless-stopped` to the Docker Compose app service so the container comes back after
  host or Docker daemon restarts.
- Added a deployment-config regression test that protects the Compose restart policy.
- Documented the restart policy in the home-server Docker notes.

## 2026-05-18 (Deployment and versioning documentation)

Documentation-only update; no runtime SemVer bump. `package.json` and the EA remain at `1.2.0`.

- Documented root `package.json` as the canonical app version source and the requirement that the
  MT5 EA `#property version` stays aligned.
- Documented home-server Docker Compose v2 usage via `docker compose up -d --build`, including why
  the legacy `docker-compose` v1 binary should not be used for rebuilds.
- Added MT5 demo-terminal verification guidance to check EA/package version alignment before
  compiling.

## 2026-05-18 (Manual position visibility and cashflow-aware performance)

- Release impact: Minor. Added root `package.json` as the canonical app version source at
  `1.2.0`, and kept the EA `#property version` aligned at `1.2.0` because this adds new EA
  snapshot fields, API response fields, and UI states.
- Surfaced MT5 positions and pending orders opened outside Telegram TC directly on the Performance
  view, while preserving the read-only external activity block under Linked Accounts.
- Changed account performance rollups to separate realised trading P/L, live floating P/L, and
  inferred net cashflow from deposits/withdrawals. Account growth now tracks trading equity instead
  of treating later account deposits as profit or hiding floating manual P/L behind closed
  broker-order history.
- Normalised MT5 broker-history timestamps such as `2026.05.18 09:00:00` when calculating current
  month/week/day performance buckets.
- Limited EA virtual-TP rehydration to live `OPEN` plans so failed or genuinely out-of-sync trades
  are not revived into the EA after a restart.
- Added API and web regression coverage for deposit-aware account performance and visible external
  manual positions.

## 2026-05-18 (MT5 virtual TP and sync recovery)

Hardens virtual TP management against broker comment truncation and makes sync uncertainty visible
to the operator instead of silently dropping follow-up TP work.

- Changed MT5 EA comments to compact stable IDs (`ttc:<shortId>` / `ttc:<shortId>:tpN`) while the
  backend resolves those short IDs back to the full logical trade id from persisted trade data.
- Made virtual TP state ticket-first in the EA. The EA now stores the position ticket when the trade
  opens and uses it for virtual TP partial closes, SL strategy moves, runner moves, and trailing
  before falling back to broker-comment matching.
- Added EA diagnostics for virtual TP early-return paths including missing symbols, missing
  position tickets, invalid close volume, invalid strategy prices, non-improving SL moves, invalid
  runner trailing distance, and close retcode failures.
- Fixed backend classification for generic virtual TP reports such as `Request executed` by matching
  the reported partial-close price/volume back to the intended TP leg and recording it as
  `PARTIAL_CLOSE`.
- Fixed `/api/mt5/history` handling for numeric MT5 `DEAL_ENTRY` values so entry deals stay `OPEN`
  and exit deals become `PARTIAL_CLOSE` or `FULL_CLOSE` based on the latest broker snapshot.
- Improved snapshot reconciliation to match live broker state by full comment, compact id, known
  order/position tickets, and broker-order mappings before marking a trade `OUT_OF_SYNC`.
- Extended dashboard trade data and the History UI with out-of-sync reasons, matched broker tickets,
  broker comments, last snapshot timestamps, and a warning presentation when broker evidence is
  partial or missing.

Verification added: EA source tests for ticket-first virtual TP and compact diagnostics, API tests
for generic virtual TP partial-close reports, numeric history entries, and truncated-comment
reconciliation, plus a web test for the History warning state.

## 2026-05-17 (MT5 trade lifecycle hardening)

Closes the lifecycle review gaps around default TP visibility, lifecycle command safety, TP-leg
partial closes, runner/trailing execution, broker-history attribution, and app verification.

- Wired provider TP strategy from the config modal into real execution: the freeform strategy text is
  now a structured dropdown/offset model, normalized by the API, sent in the MT5 line payload, and
  applied by the EA after virtual TP hits to move SL to entry or a prior TP without worsening the
  current stop.
- Added parser safeguards so `MODIFY_SL` without a new stop price and trailing-stop commands without
  a distance require review instead of queueing unsafe MT5 work.
- Default-only market trades now create a visible logical TP leg marked as a default-distance target,
  while the MT5 queue still sends the default TP distance for EA-side price calculation.
- Telegram auto-ingestion now processes clean lifecycle commands after clean open signals in message
  order, so safe commands like trailing-stop updates can be queued when they match exactly.
- Lifecycle approvals now match per linked account, fan out when every account has one clear active
  trade, and keep same-account ambiguous symbol commands out of the MT5 queue.
- TP-leg partial closes now carry the intended allocation/volume into the MT5 line payload, preventing
  `Close TP1` from becoming a full-position close.
- Provider runner config is now sent to MT5 for `VIRTUAL_TP` work. Split-order runner mode is blocked
  explicitly until a dedicated child-order design is implemented.
- The EA now uses ticket-led position/order collection for close, modify, cancel, and trail commands;
  adds persistent timer-managed trailing-stop state; and applies runner SL behaviour after final
  virtual TP handling.
- Broker history pips now respect trade direction, so profitable SELL closes report positive pips.
- Broker-order history labels now distinguish signal opens, app closes/modifies/trailing commands,
  TP/SL hits, manual terminal/mobile/web closes, stop-outs, and other broker reasons.
- Real Telegram session connection no longer creates the hidden demo provider unless demo seeding is
  enabled.
- Fixed the frontend resync test fixture so connected Telegram sessions include the active profile id.
- Added Docker build-context protection for runtime data, Telegram session files, local databases,
  logs, and env files so redeploys cannot read or package already-authenticated provider/session
  state.
- Externalized GramJS and websocket native optional modules from the API bundle so Docker builds use
  installed runtime dependencies without trying to inline Telegram's native websocket helpers.

Verification: focused core/API/EA/web suites pass after the red/green lifecycle hardening tests. Full
typecheck, lint, test, build, and Docker verification are run as part of this implementation pass.

## 2026-05-16 (Broker-aware symbols and Telegram auto-ingestion)

Fixes live provider messages not being picked up automatically and prevents stale demo symbol
settings from blocking OctaFX symbols such as `BTCUSD`.

- Added a backend Telegram ingestion loop for enabled providers. It polls connected GramJS sessions
  every 2 seconds, captures new messages, parses unparsed rows, dedupes repeated Telegram message
  IDs, and queues only clean `OPEN_TRADE` signals that do not require review.
- Added broker-aware symbol resolution. The resolver now prefers exact EA-reported symbols, then
  known broker variants such as `GOLD#`, `BTCUSDm`, and `BTCUSD.raw`, and only then configured
  prefix/suffix fallbacks.
- Replaced the stale demo account mapping defaults with empty broker-aware defaults and added repair
  logic for old `.raw` / `XAUUSD.r` / demo include-list mappings once the EA reports plain broker
  symbols such as `BTCUSD` or `XAUUSD`.
- Updated approval fan-out so each linked MT5 account re-resolves the signal against that account's
  symbol list before queueing.
- Fixed the dashboard status bar so `TG gramjs` is shown as healthy, added provider ingestion status
  hints, and changed the command-palette "parse recent" action to process enabled providers instead
  of the first provider only.
- Hardened GramJS message fetching so it resolves the dialog entity before polling even after a
  server restart.
- Updated the EA source to choose a broker-supported market-order filling mode from
  `SYMBOL_FILLING_MODE` instead of hard-coding IOC, which OctaFX rejected for BTCUSD with retcode
  `10030`.

Verification: focused parser/API/UI regression tests pass for OctaFX-style `BTCUSD`, `GOLD` /
`XAUUSD`, suffix/prefix variants, auto-ingestion queue safety, stale mapping repair, and GramJS
status rendering. Full gate and live deployment verification are tracked with this implementation
run.

## 2026-05-16 (MT5 EA HTTP 500 null-byte fix)

Fixes the live MT5 EA integration where Docker networking and `/api/health` were reachable, but
EA POST requests failed with `Telegram TC HTTP 500: Internal Server Error`.

- Added a root `/health` backend route that returns the same JSON as `/api/health`, so host checks
  no longer fall through to the React app shell.
- Added MT5-specific JSON parsing for `/api/mt5/register`, `/api/mt5/heartbeat`,
  `/api/mt5/report`, `/api/mt5/snapshot`, and `/api/mt5/history`. These routes now strip trailing
  null bytes from MT5-style POST bodies and return `400` for malformed JSON instead of uncaught
  parser `500`s.
- Updated `mt5/TelegramTC_EA.mq5` so `HttpPost()` trims the UTF-8 null terminator produced by
  `StringToCharArray(..., WHOLE_ARRAY, CP_UTF8)` before `WebRequest`.
- Documented the deployed EA base URL as `http://192.168.0.100:18787/api` and the matching MT5
  WebRequest allow-list requirement.

Verification: `bun run format`, `bun run typecheck`, `bun run lint`, `bun test` (97 pass),
`bun run build`, and `bun run docker:build` all pass. Remote host `192.168.0.100` was rebuilt
and redeployed as `telegram-tc:latest`; `/api/health` and `/health` return backend JSON health, a
null-terminated MT5-style register request now returns the expected bad-link `404` instead of a
JSON parser `500`, recent container logs no longer show the null-byte parser error, and the OctaFX
MT5 account is online with fresh heartbeat/snapshot timestamps.

## 2026-05-10 (Parser defaults, quote context, and 6-month KAL VIP backtest)

Parser and MT5 contract changes from the MVP parser pass:

- Added configurable default execution distances: default SL = 50 pips and default TP = 200 pips. The web Settings screen now exposes both values and the API persists them with the existing execution settings.
- Parser context now carries `defaultStopLoss` / `defaultTakeProfit` distances. Short open signals such as `Buy Gold now` no longer require extra normalization purely because SL/TP are omitted when defaults are configured.
- Telegram reply parsing now preserves quoted context for lifecycle replies. `Close half` on a replied-to signal inherits the quoted trade's symbol/account context and parses as `CLOSE_PARTIAL` with 50% close intent.
- `TRAILING_STOP` commands are now first-class supported lifecycle commands instead of automatically blocking execution. The EA still converts pips/points broker-side.
- MT5 poll-line payloads now include default SL/TP distance fields. The EA converts those distances into absolute prices from the execution/reference price using `SYMBOL_POINT`.
- Added a minimal `broker_orders` trail plus `GET /api/trades/:id/broker-orders`, populated from MT5 execution reports so logical trades can be linked back to broker order/deal tickets.
- Backtest reporting now includes `autoActionableMessages`, normalization reason counts, matched-pattern counts, and warning counts.
- Telegram history import can run in chunks via `TELEGRAM_CHUNKED=1`, `TELEGRAM_CHUNK_DAYS`, and `TELEGRAM_HISTORY_DAYS`, using Telegram `offsetDate` so older windows do not repeatedly scan from the latest message.
- GramJS session loading now supports importing an existing local session file with `TELEGRAM_SESSION_FILE`, or auto-importing the only `.json` session in `TELEGRAM_SESSION_DIR` for interim local workflows.
- Added Azure GPT-5.4 mini extraction at `POST /api/signals/:id/ai-review`. It only runs for parser outputs that need additional normalization, reads credentials from environment, and returns explicit `ENTRY`, `SL`, and `TP` fields plus advisory classification. Parser Lab exposes `Extract with GPT` only for those items.
- Added API coverage for GPT extraction: mocked Azure response verifies the hardcoded Foundry deployment name, prompt requirement for `ENTRY`, `SL`, and `TP`, returned field shape, and rejection for parser outputs that do not need normalization.
- Provider Configuration modal now sends full execution config to the API: risk mode/amount, TP allocation rows, and runner config. The backend persists provider execution config and applies TP allocation/risk sizing when building MT5 queue payloads.
- Parser Lab now has direct `Approve` and `Ignore` actions so parser outputs can move into the MT5 queue without leaving the Logs tab.
- Telegram auth now persists pending login state across refreshes/re-renders and exposes a "Wrong phone number? Start over" action on the OTP/2FA screens. Restarting disconnects the pending backend session and returns to phone entry.
- Real GramJS deployments no longer auto-create the demo/mock provider after login, and `/api/telegram/dialogs` no longer falls back to mock dialogs when no real connected session is available. Demo rows are hidden unless demo seeding is explicitly enabled.
- Legacy mock provider rows (`dialog-alpha`) are hidden in non-demo deployments so real Telegram logins do not show `Alpha FX Signals`.
- Implemented the current UI polish roadmap pass from `docs/ui-improvements.md`: motion utilities, account KPI stagger animation, sticky sortable provider-table headers, quieter row actions, glassier modal/status chrome, intentional empty/skeleton primitives, provider-table sorting, and clearer whole-row Telegram dialog selection.
- Extracted major app surfaces into `apps/web/src/pages/*` and added `useSortableTable`, `Skeleton`, and `EmptyState` building blocks. `App.tsx` now delegates Performance, Providers, History, Equity Guardian, Telegram Setup, Linked Accounts, Symbol Settings, Logs, and Settings to page components.
- Provider management polish: Telegram dialog rows are sorted with channels/groups before user dialogs, user rows are visually de-emphasized, adding a dialog now asks for confirmation, and Providers now has a Remove action backed by `DELETE /api/providers/:id`.
- Live account onboarding now appears directly inside the Live/Performance tab. When no MT5 account is connected, operators see the link-slot workflow immediately; created slots and connected MT5 accounts render in Live as account cards as well as under Linked Accounts.
- Added account-to-provider routing controls in Live and Linked Accounts. Each connected MT5 account can now be assigned to specific configured providers, and open signals fan out to every linked account for that provider when links exist.
- History can fetch and expand the broker-order trail for a logical trade through `GET /api/trades/:id/broker-orders`, showing order, position, and deal tickets.
- The MQL5 EA report contract now includes `positionTicket` on reports where a position ticket is known, including modify, close, virtual TP close, and best-effort post-open reports.
- Added account-slot/link-code API and Linked Accounts UI. The EA now has a `LinkCode` input and sends it on register/heartbeat; bad link codes are rejected and linked slots show the broker account once connected.
- Added Equity Guardian persistence, API, queue enforcement, and UI. Paused/breached accounts reject new `OPEN_TRADE` leases while allowing non-open lifecycle work to continue.
- Added basic account/provider performance data from MT5 account state and broker-order rows. Provider rows now display pips/P&L/profit/gain fields when data is available.
- Symbol Settings now uses real persisted alias/account mapping rows instead of static preview rows, with backend support for deleting aliases.
- Broker-order rows now include best-effort `pnl_currency` and `pnl_pips` attribution for close/partial-close actions when open and close fill prices are available.
- Settings now includes an Azure GPT API key field. The key is stored server-side in local SQLite `app_secrets`, and dashboard state only exposes whether a key is configured.
- Parser Lab Saved Fixtures now renders recent saved fixtures instead of a placeholder.
- Symbol Settings now supports provider aliases in the Add Mapping modal and can delete global/provider aliases from the table.
- Performance chart now prefers backend account-performance equity/drawdown series and falls back to placeholder data only when no series is available.
- Lifecycle queue payloads now include target broker order/position/deal tickets derived from `BrokerOrder`, and the EA consumes target order/position tickets for pending-order cancellation and position management.
- Snapshot reconciliation now records best-effort manual `FULL_CLOSE` broker-order rows when a previously reported EA-owned broker ticket disappears from MT5 positions/orders.
- Added provider config history and provider config test endpoints so backend strategy changes can be audited and dry-run against sample raw messages.
- Added execution-log detail endpoint returning the report, queue payload, and broker-order trail for drilldown.
- Added `/api/mt5/history` and EA-side `SendHistoryDeals()` so recent broker deal history is posted with deal/order/position tickets, close price, profit, commission, swap, and comments. The backend deduplicates by `deal_ticket` and records exact history-backed broker-order rows when it can match the deal to a logical trade.
- The EA no longer defaults to a loopback API URL. `BackendBaseUrl` is now a placeholder that must be set per environment, and `PollSeconds` defaults to 1 second.
- Improved backend performance rollups from broker-order P/L rows and added API coverage for exact broker-history close reconciliation.
- Disabled runtime demo seeding by default; local demo data now requires `SEED_DEMO_DATA=true` or explicit test options.
- Added queue lease timeout recovery/expiry with configurable `leaseTimeoutSeconds` and `maxLeaseAttempts`.
- Heartbeat freshness is now computed dynamically (`online` / `stale` / `offline`) from `last_heartbeat_at`.
- Heartbeats with invalid link codes are rejected, and linked non-legacy slots require the EA to keep sending its link code.
- GPT extraction is blocked for `NO_SIGNAL` parser outputs.
- Equity Guardian unpause now appends an audited `manual_unpause` event to breach history.
- Parser account context now uses the first linked MT5 account or `DEFAULT_MT5_ACCOUNT_ID` instead of silently relying on the demo account for real parser paths.
- EA risk-percent sizing now uses broker tick size/value and account balance when volume is not explicitly provided.
- Updated the main spec with MVP outstanding status, 6-month KAL VIP parser baseline, default SL/TP rules, quote/reply lifecycle behavior, and pip/point conversion rules.

Latest 6-month KAL VIP backtest (`2025-11-08` to `2026-05-10`):

- Total messages: 4,610
- `NO_SIGNAL`: 2,790
- `OPEN_TRADE`: 946
- `TRADE_SETUP`: 60
- Lifecycle commands: 897
- Actionable messages: 1,843
- Auto-actionable after parser rules: 1,710
- Actionable requiring GPT extraction/operator confirmation: 133 (7.22% of actionable)

Verification: `bun test packages/core apps/api apps/web` 72 pass · `bun run typecheck` clean · `bun run build:web` clean.

## 2026-05-10 (Symbol Settings cleanup — Add-Mapping modal)

Replaces the cramped two-form layout above the Symbol Settings table with the same modal-driven UX as Provider Config:

- Removed the inline `Alias raw / canonical` form and the 6-input `Mapping account / canonical / broker / suffix / include / exclude` form.
- New `apps/web/src/components/SymbolMappingModal.tsx` — accessible (`role="dialog"`, `aria-modal`, Escape, click-outside-to-close), uses the same `modal-form-clean` chrome as the Provider Config modal, with a `Global alias` / `Account-specific` segmented control toggle. Form fields render conditionally per scope, and the Save button label flips to match.
- Symbol Settings tab is now: `Add mapping` button (primary, top-right) + the `SymbolMappingsTable`. No more dead two-thirds-of-the-screen empty area when the panel was the only thing showing.
- Modal uses uncontrolled `defaultValue` inputs + `FormData` on save (same pattern as Provider Config) so test assertions for Alias/Mapping field values round-trip correctly.
- Dropped the now-unused `aliasForm` / `mappingForm` controlled state and the `commaList` helper from `App.tsx`. `useRef` import removed.
- Test 7 updated: opens the modal twice (once for global alias, once for account mapping switching to the Account-specific tab), asserts the same payloads as before.

Verification: `bun test apps/web/` 9 pass · `bun run --cwd apps/web build` clean (250 KB JS + 52 KB lazy uplot + 43 KB CSS).

## 2026-05-10 (Provider Config modal redesign + runner + e2e order tracking spec)

Two pieces of feedback addressed in one commit:

**Runner support** — operators can now leave a small remainder open after the final TP hits (the classic "let a runner ride with SL on BE" pattern):

- New `Runner` section in the Provider Config modal with: enabled toggle, runner lot size, SL behavior select (Move to break-even / Move to last hit TP / Trail by N pips). When trail is selected a "Trail pips" input appears.
- Order summary updated: shows total order, lots allocated to TPs, runner reservation, and a per-action timeline ("TP1 hit · close 0.02 lots · Set SL to ENTRY + 0 pips" → "After final TP · keep 0.01 lots open · SL at break-even").
- `ProviderConfigSubmission` now carries `runner: { enabled, lotSize, slBehavior, trailPips }`. Backend wiring is a follow-up — the UI shape is locked.

**Modal restyled to match the rest of the app**:

- Dropped the "1." / "2." / "3." section numbering, hand-styled green-soft pill toggles, and the gray "Order Resume" tutorial box.
- Risk-mode toggle is now a segmented control matching the Performance tab's chart toggle (`Fixed lots` / `% of balance`).
- Section headers use the same uppercase muted-grey label pattern as the data-table headers.
- TP rows use the same border / hover / monospace tokens as `data-table` rows; the steppers and strategy inputs share input chrome with the rest of the dashboard.
- Order summary is a compact stat-card (Total order / Allocated to TPs / Runner) above an interleaved timeline of TP closes and the runner finale, all using `tabular-nums` mono numerics.
- Modal width slightly wider (720 px max) to fit the 3-stat resume grid.

**Spec — End-to-end trade ↔ broker order linkage** (responding to "we need to map and link the trade taken to a orderID so we can track the order e2e"):

- New "End-to-end order tracking" section in the spec under Position State and TP Management, defining the `BrokerOrder` table that joins LogicalTrade ↔ TradeLeg ↔ broker tickets/deals.
- Captures `order_ticket`, `position_ticket`, `deal_ticket`, requested vs filled volume / price, retcode, broker comment, source (`signal` vs `manual`), and per-action P/L for every open / partial-close / full-close / modify / cancel / trail.
- Per-leg / per-trade / per-provider P/L are derived deterministically from BrokerOrder aggregation — no re-parsing broker history.
- EA `/api/mt5/report` payload contract extended to enrich every report with the broker-side identifiers so partial fills are not lost.
- Manual closes from the MT5 terminal are picked up via snapshot diff and recorded as `BrokerOrder { source: "manual" }` so History reflects reality.
- New `BrokerOrder` entity in Data Model. New `GET /api/trades/:id/broker-orders` endpoint added under Per-trade events API.

Verification: `bun test apps/web/` 9 pass · `bun run --cwd apps/web build` clean (247 KB JS + 52 KB lazy uplot + 43 KB CSS).

## 2026-05-10 (History + Symbol Settings tabularised; Signal Queue moved to Logs)

Brought the History and Symbol Settings tabs in line with the rest of the app:

- **History tab**: replaced the per-trade card-with-grid wall (`TradeCard` × N) with a single `HistoryTable` (`apps/web/src/components/HistoryTable.tsx`). Columns: Trade · Symbol · Side · Mode · Status · TPs · TP progress. Each row has tabular-nums monospaced cells, a green/red side chip, and an inline TP-progress strip showing each leg as a pill (HIT green / OPEN indigo / CLOSED faded / PLANNED neutral) with the target price + allocation %.
- **Symbol Settings tab**: replaced the bespoke `mapping-row` divs with `SymbolMappingsTable` (`apps/web/src/components/SymbolMappingsTable.tsx`) — same `data-table` styling as Providers. Columns: Raw symbol · Canonical · Broker symbol · Status. The two add-mapping forms above the table stay for now.
- **Signal Queue moved to Logs tab**: the queue panel previously lived under History but the spec (and the user's mental model) treats queue / parser / exec logs as the live operational feed. Logs tab now renders Parser Lab + Signal Queue + Execution Logs.
- **Single-panel views go full width**: Telegram Setup, Linked Accounts, and Settings (sidebar destinations) now use `wide-panel` so they fill the workspace instead of leaving two-thirds of the screen empty.
- Linked Accounts panel renamed from `MT5 Accounts` to match the sidebar label.
- Removed the now-unused `TradeCard.tsx`.

Verification: `bun test apps/web/` 9 pass · `bun run --cwd apps/web build` clean (244 KB JS + 52 KB lazy uplot + 36 KB CSS).

## 2026-05-10 (Sidebar dedup + TSC-style Provider Config modal)

Addresses the "sidebar/tabs are duplicated" and "Provider Config modal should look like the TSC screen" feedback:

- **Sidebar shrunk** to four top-level destinations only — `Live`, `Telegram Setup`, `Linked Accounts`, `Settings`. Old per-section items (Providers, Parser Lab, Trade Lifecycle, MT5 Accounts, Symbol Mapping, Execution Logs) are now exclusively in the WorkspaceTabs strip. Sidebar no longer repeats anything tabs already cover. `Dashboard` renamed to `Live`; `MT5 Accounts` renamed to `Linked Accounts` so the sidebar matches the spec.
- **Provider Config modal redesigned** to match the TSCopier "Configure Providers" screen:
  - Section 1 — Message Template: parser mode select labelled `Template` plus a `Test message` button.
  - Section 2 — Risk Management: single value field with two pill toggles ("Use fixed lots" / "Risk a % of your account balance"). Active pill shows the live lot/percent value in green-soft chip.
  - Section 3 — Take Profit Levels: editable rows with `TP #` / `Percentage` (with − / + steppers) / `Strategy` text input / delete-row button. "Distribute % equally" action splits across rows. "Add a new Take Profit level" appends a row.
  - Section 3.1 — Order Resume: derived plain-text summary that updates live as the user changes risk amount / TP percentages.
- **Risk Profile dropped** from the modal and from the PATCH payload. Sizing is now explicit per-channel (lot size or % balance) — no more abstract Balanced/Conservative/Aggressive buckets. Backend retains the column for backward compat but the UI never sends it.
- **`Risk` column removed** from the Providers table (no longer meaningful) — table is now Name · Lots · TP # · SL · Pips · W/L % · Avg.DD · P/L · Profit · Gain · Status · Actions.
- Modal save reads numeric inputs directly from `FormData` instead of React state to dodge the controlled-input flush quirks happy-dom showed under fireEvent.
- Tests adjusted: sidebar text assertions match the new top-level rail (`Linked Accounts` instead of `MT5 Accounts`, `Live` instead of `Dashboard`); provider-settings test no longer touches Risk profile and asserts the new payload `{parserMode, lotSize}`.

Verification: `bun test apps/web/` 9 pass · `bun test apps/api/` 35 pass · `bun run --cwd apps/web build` clean (242 KB JS + 52 KB lazy uplot + 35 KB CSS).

## 2026-05-10 (Spec sync with shipped UI + design corrections)

Brought `docs/superpowers/specs/2026-05-09-telegram-copy-app-design.md` back in line with what was actually shipped over the last five commits and what was decided in conversation:

- **Visual direction** rewritten — replaced the "modern dark terminal: cyan on near-black" wording with the actual implementation: light theme, body `#f5f6fa`, white panels, indigo `#5046e5` primary, Telegram-blue `#229ED9` reserved for sign-in chrome, green/red for direction, amber for warnings. Inter UI + JetBrains Mono for numerics, light shadows, 6–8 px radius, `uplot` for charts.
- **Frontend Screens** restructured into Sign-in screen + Live workspace, with the explicit non-duplication rule between sidebar and tabs (sidebar holds Live / Telegram Setup / Linked Accounts / Settings; everything else lives in WorkspaceTabs). Each tab now has a dedicated description.
- **Provider Configuration modal** description rewritten to match the TSC modal screen — Risk Management is a single-field with a fixed-lots / %-of-balance toggle (no abstract "Risk profile"), TP Levels are an editable per-row list with strategy lines, plus a derived Order Resume summary. Spec now explicitly states "There is no abstract Risk profile (Balanced/Conservative/Aggressive) — sizing is explicit per channel."
- **Telegram /api/telegram/start** documented to fall back to server-side `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` env so the browser never sees secrets.
- **Architecture** section now mentions the actual stack — React + Vite + Inter / JetBrains Mono, `uplot` lazy-loaded, served static from the API origin.
- New **MT5 ↔ EA account linking** section: link-code workflow (App pre-creates a named slot with a short code → operator pastes the code into the EA's `LinkCode` Input → EA includes `linkCode` in every register/heartbeat → backend matches to the slot). Removes the smoke-test pollution by giving each EA pairing an explicit, named, code-mediated slot.
- New `AccountSlot` entity in Data Model.

Verification: `bun test apps/web/` 9 pass · `bun test apps/api/` 35 pass · spec compiles to 627 lines.

## 2026-05-09 (Performance growth chart — TSC parity)

- New `apps/web/src/components/GrowthChart.tsx` — uplot-backed account-growth chart with a Growth / Drawdown toggle. Indigo line + faint area fill matching the rest of the theme (`#5046e5` for growth, `#ef4444` for drawdown), `tabular-nums` axis labels formatted as `$1,234` and `0.0%`.
- uplot lives in a dynamic `import()` inside the chart's `useEffect` so it never touches `document` at module-load. This keeps the build splitting clean (uplot becomes its own ~52 KB chunk only fetched when the user lands on the Performance tab) and dodges the happy-dom `doc.createElement` SSR-ish error that broke tests on first attempt.
- Replaces the "Performance charts coming next" empty state on the Performance tab with the live chart. Stub series generated client-side via `buildPlaceholderGrowth(executedCount)` so the visual lands now; will swap to real `GET /api/equity-curve` when that endpoint ships.
- Resize observer keeps the canvas sized to the container so the chart re-flows on window resize.

Verification: `bun test apps/web/` 9 pass · `bun run --cwd apps/web build` clean (main chunk 240 KB JS / 31 KB CSS, uplot lazy-loaded as its own 52 KB chunk).

## 2026-05-09 (Providers data table + config modal — TSC parity)

Replaces the cramped per-row provider cards with a proper TSC-style data table and a deep configuration modal:

- New `apps/web/src/components/ProvidersTable.tsx` — sortable-ready table with the TSC column set: `Name · Risk · Lots · TP # · SL · Pips · W/L % · Avg. drawdown · P/L · Profit · Gain · Status`. Numeric columns are right-aligned with `tabular-nums`. Per-row Configure (gear) and Pause/Enable buttons. Columns without backend support yet render `—` in muted grey so the shape matches TSC even before analytics endpoints land.
- New `apps/web/src/components/ProviderConfigModal.tsx` — accessible modal (`role=dialog`, `aria-modal`, Escape-to-close, click-outside-to-close) opened from the gear icon. First field is the operator-owned **Channel lot size** with live "Allocation 25/25/25/25 → 0.05 per TP leg" preview, plus parser mode and risk profile. Pivots to uncontrolled inputs + `FormData` read on save so locale-stable lot strings (`"0.2"`/`"0,2"`) round-trip correctly through happy-dom tests.
- App shell wires the modal: `configProvider` state, `onConfigure` opens it, `onSave` POSTs `/api/providers/:id` and refreshes the dashboard, modal closes on success.
- Removed the now-unused `apps/web/src/components/ProviderRow.tsx`.
- Tests updated: provider-settings test opens the modal first via the gear icon before changing parser/risk/lot fields. 9 web tests still green.

Verification: `bun test apps/web/` 9 pass · `bun test apps/api/` 35 pass · `bun run --cwd apps/web build` clean (236 KB JS, 30 KB CSS).

## 2026-05-09 (In-workspace tabs — TSC parity)

Added a tabbed workspace inside the dashboard to scope live operations sections instead of rendering nine panels simultaneously:

- New `apps/web/src/components/WorkspaceTabs.tsx` exposing six tabs: `Performance`, `Providers`, `History`, `Equity Guardian`, `Symbol Settings`, `Logs` (proper ARIA `role="tablist"` / `role="tab"`).
- App shell wires each panel to its tab — Providers panel under `Providers`, Symbol Mapping under `Symbol Settings`, Trade Lifecycle + Signal Queue under `History`, Parser Lab + Execution Logs under `Logs`. Performance and Equity Guardian show empty-state placeholders until charts and threshold controls land.
- Sidebar items remap onto tabs: clicking `Providers / Parser Lab / Trade Lifecycle / Symbol Mapping / Execution Logs` now switches the dashboard tab instead of rendering a one-off panel. `Telegram Setup`, `MT5 Accounts`, `Settings` keep their dedicated views.
- Default tab is `Performance` (with a "charts coming next" empty state) so the first thing operators see post-sign-in is calm summary chrome, not a wall of panels.
- Tests updated to navigate tabs and sidebar before asserting per-panel content; multi-panel "everything together" test split into per-tab assertions. 9 web tests pass.

Verification: `bun test apps/web/` 9 pass · `bun run --cwd apps/web build` clean (231 KB JS, 24 KB CSS).

## 2026-05-09 (Account header strip — TSC parity)

Replaced the four "Providers / Parser Review / Queue / MT5 Accounts" metric cards with a TSC-style account header strip at the top of the workspace:

- Added `apps/web/src/components/AccountHeader.tsx` with two regions: left = `Live` heading + Connected Platform card (Platform · Broker · Type · Expert Advisor + EA WORKING/EA OFFLINE badge), right = five KPI columns (Initial Balance, Total Profit, This Month, This Week, Today). Currency, amounts, and Δ% badges are formatted en-US locale-stable.
- Stub financial KPIs render as `—` with muted Δ chips until backend `/api/account/performance` lands. Connected Platform / EA status are computed from the existing `snapshot.mt5Accounts` (broker derived from server prefix, DEMO/LIVE inferred from server name, EA active = heartbeatStatus online).
- Removed the duplicate marketing topbar (`Live operations` eyebrow + `Telegram TC Operations` h1) — it was contradicting the StatusBar that already shows the app title.
- Promoted the StatusBar `<span class="brand">TG-TC · Operations</span>` to an `<h1>` so the page has a single canonical heading. Test updated to assert the new heading.
- Deleted unused `apps/web/src/components/MetricsGrid.tsx` and trimmed dead lucide-react imports / the unused `metrics` `useMemo`.

Verification:

- `bun test apps/web/` — 9 pass.
- `bun run --cwd apps/web build` — clean (229 KB JS, 23 KB CSS).

## 2026-05-09 (Sign-in & light theme)

Polished the first screen so it matches the TSCopier sign-in style instead of the dense dashboard:

- Added a full-viewport `SignIn` component (`apps/web/src/components/SignIn.tsx`) shown while no Telegram session is connected. Telegram-blue header bar, centered circular logo, "Sign in to Telegram" heading + subtitle, Material-style floating-label phone field, primary CTA. Replaces the previous in-dashboard `Telegram Setup` panel for the unauthenticated state.
- Pivoted the global theme from dark to light. `apps/web/src/styles.css` `:root` tokens now use white panels on `#f5f6fa`, indigo `#5046e5` primary, Telegram-blue `#229ED9` for the sign-in chrome, and Inter UI + JetBrains Mono. Sidebar active state, panel shadows, and card surfaces adjusted for the light palette.
- Stopped collecting Telegram API ID and API hash in the frontend. The backend `/api/telegram/start` handler now falls back to `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from the server env (`apps/api/src/app.ts`), so secrets never travel through the browser. The SignIn screen exposes only the phone-number field.
- Added a `setupStep` sync effect in `App.tsx` so the SignIn screen flips to the dashboard automatically once the polled snapshot reports a `CONNECTED` Telegram session.

Verification:

- `bun test apps/web/` — 9 pass.
- `bun test apps/api/` — 35 pass.
- `bun run --cwd apps/web build` — clean (228 KB JS, 20 KB CSS).

## 2026-05-09 (Doc work and design spec expansion)

- Added `docs/ui-improvements.md` — critical review of `apps/web` with TSC feature-parity scope, "modern dark terminal" direction, channel-lot-size UI surfaces, three-pass implementation sketch, and detailed file change list.
- Expanded `docs/superpowers/specs/2026-05-09-telegram-copy-app-design.md` with new sections for Analytics & Performance, Equity Guardian, and Provider Strategy Configuration; reworked Frontend Screens around a top-level rail and Live-workspace tabs; added matching Backend Responsibilities, Data Model entities, Product Scope items, and Success Criteria; replaced the contradictory Rantoniaina visual reference with the dark-terminal direction.
- Committed the entire MVP working tree (`apps/`, `packages/`, `migrations/`, `mt5/`, `scripts/`, root configs, supporting docs) as `feat: scaffold telegram-tc MVP` so the repo no longer has the bulk of the implementation untracked.

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
- Applied KAL VIP's default Gold/XAUUSD provider context to symbol-less lifecycle updates such as `TP 1`, reducing false operator-confirmation items.
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
