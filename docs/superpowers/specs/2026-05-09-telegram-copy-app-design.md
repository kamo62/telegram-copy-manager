# Telegram Copy Application Design

Date: 2026-05-09

## Objective

Build a Telegram-to-MetaTrader 5 copy trading application that can register a Telegram account through the frontend, monitor selected Telegram signal providers, parse varied text signal formats, review parser output, and execute approved signals through a MetaTrader 5 Expert Advisor.

The first release must prove two things together:

- Telegram signals can be parsed reliably enough to inspect, test, and improve.
- MetaTrader 5 execution works through a correctly typed MQL5 Expert Advisor path.

## Product Scope

V1 is an MT5-first MVP with a parser lab. It is not a full TSCopier clone yet.

Included in v1:

- Frontend Telegram registration flow.
- Telegram code verification and 2FA password handling.
- Telegram dialog/channel/group selection.
- Provider setup and enable/disable state.
- Raw message capture before parsing.
- Parser lab for recent provider messages.
- Deterministic text parser for common forex signal formats.
- Signal lifecycle commands such as cancel, close, partial close, move SL to breakeven, and modify SL/TP.
- One logical trade with multiple TP levels and planned partial closes.
- Symbol aliases, remapping, prefixes, suffixes, and account-specific broker symbol handling.
- Signal queue for MT5.
- MT5 Expert Advisor account registration, heartbeat, polling, execution, and result reporting.
- Dashboard views for providers, parser results, MT5 accounts, signals, trades, and execution logs.
- Analytics & Performance: per-provider attribution, account-level KPIs, equity curve, and monthly returns.
- Equity Guardian: per-account drawdown limit with pause-on-breach for new OPEN_TRADE commands.
- Provider Strategy Configuration: per-provider message template selection, TP1-TP4 rules, and pip manipulation.
- Per-trade lifecycle event log.

Deferred until after v1:

- Image signal parsing.
- AI assistant.
- Economic event filter.
- 100 take-profit levels.
- Multi-platform execution beyond MT5.
- Payment/licensing.
- Cloud broker APIs such as MetaAPI.

## Architecture

The application has three main parts:

- Frontend web app: setup, review, monitoring, and operations.
- Backend API and workers: Telegram sessions, provider monitoring, parsing, persistence, queueing, and reporting.
- MT5 Expert Advisor: account registration, broker-specific validation, order execution, and trade result reporting.

The backend owns Telegram and normalized signal state. The EA owns MT5 execution reality. The EA must not parse Telegram text; it receives clean trade instructions only.

## Frontend Flow

The first usable workflow starts in the frontend:

1. User enters Telegram `api_id`, `api_hash`, and phone number.
2. Backend starts Telethon login and sends the Telegram code.
3. Frontend shows a verification step for the code.
4. If Telegram requires 2FA, frontend asks for the password.
5. Backend stores the Telegram session locally and returns a safe app profile/session identifier.
6. Frontend lists available Telegram dialogs.
7. User selects one or more signal providers.
8. User opens Parser Lab for a provider and tests recent messages.
9. User enables provider auto-copy only after parser results look acceptable.
10. MT5 account connection status and signal execution status appear on the dashboard.

Security requirement: the frontend must not keep API hash, 2FA password, or long-lived Telegram secrets in browser storage. Browser state may keep only non-secret profile/session identifiers and display metadata.

## Real Provider Fixture Capture

The parser should be developed against real provider messages as early as possible.

The app should support a safe fixture-capture workflow:

1. User authenticates Telegram locally through the app or a local development helper.
2. User selects a real channel/group/provider.
3. The app fetches a bounded recent-message window.
4. User can mark messages as entry signals, management commands, noise, or unknown.
5. User can redact sensitive names, links, or account details before saving fixtures.
6. Saved fixtures become deterministic parser tests.

Fixture storage should include:

- raw message text, optionally redacted.
- source provider label.
- Telegram message date and message ID where appropriate.
- expected command type.
- expected symbol resolution.
- expected entry, SL, TP1-TP4, and lifecycle action fields.
- expected parser confidence and warnings.

Telegram API credentials, OTP codes, 2FA passwords, and `.session` files must not be committed. Development auth should use local environment variables or the frontend setup flow, with generated session files ignored by git.

## Backend Responsibilities

The backend provides:

- Telegram connection endpoints:
  - start connection
  - submit verification code
  - submit 2FA password when needed
  - disconnect session
  - list dialogs
  - fetch recent messages for parser lab
- Provider management:
  - selected dialog metadata
  - enabled/disabled state
  - parser mode and risk profile selection
  - channel-owned lot size used for every approved trade from that provider
- Symbol mapping management:
  - provider-specific symbol aliases
  - account-specific broker symbol mappings
  - global defaults
  - prefix and suffix rules
  - excluded symbols
  - allow-only symbol lists
  - mapping validation against EA-reported broker symbols
- Raw message ingestion:
  - provider ID
  - Telegram message ID
  - timestamp
  - sender metadata where available
  - raw text
  - duplicate fingerprint
- Parser service:
  - deterministic parser rules
  - confidence score
  - matched pattern ID
  - missing fields
  - warnings
  - parse status
- Signal queue:
  - normalized signal payloads
  - lifecycle command payloads
  - target account/provider eligibility
  - pending, leased, executed, failed, ignored, duplicate, expired states
- MT5 API:
  - EA registration
  - heartbeat
  - account position/order snapshots
  - poll next eligible signals
  - report execution result
  - report trade closed or modified events where available
- Analytics API:
  - account-level KPIs: initial balance, total profit, deltas for today, this week, and this month
  - per-provider attribution rows: pips, W/L %, average drawdown, P/L, profit, gain
  - equity curve series per account
  - monthly returns series per account
  - downloadable provider report (CSV/PDF) for a selected window
- Equity Guardian API:
  - read and update per-account threshold and pause-on-breach state
  - breach event log per account
  - manual unpause action (audited)
- Provider Strategy Configuration API:
  - read and update per-provider message-template choice, TP1-TP4 strategy rules, and pip-manipulation settings
  - settings change history per provider
  - configuration test endpoint that applies template plus rules to a sample raw message and returns the would-be parsed signal, without affecting live state
- Per-trade events API:
  - chronological lifecycle event log per logical trade

Backend persistence should use SQLite initially but keep models clean enough to move to Postgres later.

## Parser Design

The parser stores raw input and produces a normalized signal model. Parser failures are useful product data and must be visible in the UI.

V1 supported signal fields:

- direction: BUY or SELL.
- command type: open, cancel pending, close, close partial, move SL to breakeven, modify SL, modify TP.
- order type for open commands: market, limit, or stop.
- symbol.
- raw provider symbol text.
- canonical symbol.
- entry price or entry zone.
- stop loss.
- take profits: TP1, TP2, TP3, TP4.
- optional provider-sent lot size hint, captured for review but not trusted for MT5 execution.
- optional provider-sent risk hint, captured for review but not trusted for MT5 execution.
- optional expiry.
- optional partial-close allocation per TP.

The first parser should be deterministic and test-driven. It should support varied but common text formats such as:

- `BUY EURUSD @ 1.0850`
- `EURUSD BUY 1.0850`
- `Buy Gold now`
- `XAUUSD SELL LIMIT 2365`
- `Entry 1.0850 - 1.0860`
- `SL 1.0810`
- `TP1 1.0900`
- `TP2 1.0950`
- `TP3 1.1000`
- `TP4 1.1050`
- `Close half`
- `Close 50%`
- `Close TP1`
- `Move SL to BE`
- `Move SL entry`
- `Cancel EURUSD`
- `Cancel pending`
- `Take Profit: 1.0900`
- emoji/noisy multi-line Telegram messages

Every parser result should include:

- normalized fields
- raw symbol text
- canonical symbol
- mapping status
- confidence
- matched pattern IDs
- missing required fields
- warnings
- original raw message

Signals with low confidence or missing execution-critical fields must require manual review instead of entering the live MT5 queue.

## Symbol Mapping Design

Symbol handling is a first-class workflow because Telegram providers and brokers rarely use identical names.

The parser should not assume that the raw provider symbol is directly tradable. It should extract:

- `raw_symbol`: the exact text from Telegram, for example `GOLD`, `NAS100`, `US30`, `EUR/USD`, or `XAUUSD`.
- `canonical_symbol`: the app-normalized symbol, for example `XAUUSD` or `EURUSD`.
- `broker_symbol`: the account-specific MT5 symbol after mappings, prefix, and suffix are applied.
- `mapping_status`: mapped, unmapped, ambiguous, excluded, or unavailable.

Mapping precedence should be explicit:

1. Provider-specific alias, for example Provider A maps `GOLD` to `XAUUSD`.
2. Account-specific symbol override, for example `XAUUSD` to `XAUUSD.r`.
3. Global alias, for example `US30` to `DJI30`.
4. Account prefix/suffix, for example prefix `m.` or suffix `.raw`.
5. Fallback to canonical symbol.

The dashboard must let the user configure:

- global aliases such as `GOLD -> XAUUSD`.
- provider aliases for providers with unusual naming.
- account mappings for broker-specific symbols.
- prefix and suffix per MT5 account.
- include/exclude symbol lists.
- whether unmapped symbols require manual review or are rejected.

The EA should report available MT5 symbols to the backend when possible. The dashboard should use that list to show whether a mapped broker symbol is currently available in the connected terminal. If no EA symbol list is available, mapping can still be configured but must show as unverified.

Parser Lab should show symbol resolution inline:

- raw provider text
- canonical symbol
- mapped broker symbol per selected MT5 account
- status and warning if mapping is missing, ambiguous, excluded, or unavailable

Lifecycle commands must use the same mapping and provider context. For example, a later message saying `Cancel Gold` or `Move SL BE XAUUSD` must resolve to the correct logical trade before an MT5 command is queued.

## Provider Strategy Configuration

Each provider has a configuration record that layers strategy preferences over the deterministic parser output before a signal enters the queue. The deterministic parser remains the source of truth for raw fields; strategy configuration only adjusts what is sent to MT5.

Per-provider configuration includes:

- Channel lot size: the operator-configured execution volume for this Telegram provider. The app must not use lot sizes embedded in provider Telegram messages.
- Message Template: Automatic, Named template, or Manual override. A Test Message preview applies the chosen template to a recent raw message and shows the resulting parsed signal.
- TP1-TP4 strategy: when TP1 hits, set SL to ENTRY plus an offset, or multiply SL pips by a factor.
- TP manipulation: change TP1 to N pips, change TP1 to a 1:R risk-reward target, or only apply when the signal lacks a given TP.
- Pip add, randomize, or spread on individual TP levels.
- Settings History: append-only audit log of who changed what and when.

The strategy configuration must round-trip through the queue so the EA receives the modified TP/SL. The configuration test endpoint must run against a sample raw message without affecting live state.

## Equity Guardian

Equity Guardian is a per-MT5Account drawdown limiter that protects the account from cascading losses driven by provider signals.

State per account:

- threshold: maximum acceptable drawdown percentage.
- current_drawdown: most recent computed drawdown.
- paused: boolean, true after a breach until manually unpaused.
- breach history: append-only log of breach events with timestamp, drawdown at breach, and action taken.

Behavioral rule: when current_drawdown is greater than or equal to threshold, the queue rejects new OPEN_TRADE commands for that account. Lifecycle commands on already-open trades (CANCEL_PENDING, CLOSE_TRADE, CLOSE_PARTIAL, MOVE_SL_TO_BE, MODIFY_SL, MODIFY_TP, MARK_TP_HIT) continue to pass so existing exposure can be managed or closed.

Manual unpause is an audited action and is recorded in the breach history.

Equity Guardian is a backend rule, not just a UI display. The queue and EA paths must consult it on every OPEN_TRADE evaluation.

## Signal Lifecycle and Multi-TP Design

The app must treat provider messages as a lifecycle stream, not as isolated trade entries. A provider can send an open signal first, then later send management instructions such as cancel, close, close partial, move SL to BE, or update TP/SL.

The normalized command model should support:

- `OPEN_TRADE`: create a new logical trade from an entry signal.
- `CANCEL_PENDING`: cancel one or more pending orders for the logical trade, symbol, or provider.
- `CLOSE_TRADE`: close the full remaining position/order group.
- `CLOSE_PARTIAL`: close a fixed lot size, percentage, or named TP leg.
- `MOVE_SL_TO_BE`: move stop loss to entry or entry plus configured offset.
- `MODIFY_SL`: set a new stop loss.
- `MODIFY_TP`: set one or more take-profit targets.
- `MARK_TP_HIT`: record a provider-announced TP hit when the broker state does not already prove it.

A "trade" in the frontend is a logical trade group. It can contain multiple MT5 orders, deals, or position-management actions underneath it.

For TP1-TP4 behavior, the user-facing model is:

- one logical trade card in the app.
- one shared entry idea and one shared signal history.
- TP legs with configured allocation, for example 25/25/25/25 or 50/25/15/10.
- each TP leg has target price, intended close volume, status, and broker execution evidence.
- intended close volume is derived from the channel-owned lot size, not from Telegram provider text. For example, a `0.20` channel lot with four equal TP targets creates `0.05` per TP leg.

MT5 execution has two implementation modes:

- Split-order mode: open multiple child orders/positions with the same logical trade ID, each with its own TP. This is straightforward on hedging accounts and keeps broker-side TPs visible, but can behave differently on netting accounts.
- Virtual-TP mode: open one broker position and let the EA monitor price, then close partial volume at TP1-TP4. This best matches "one trade" in the app, but requires the EA to stay online and manage partial closes reliably.

V1 should support the logical trade group model in the backend and UI, then implement the EA with a configurable TP execution mode. The default should be virtual-TP mode when the user wants one trade with TP1-TP4 partial closes. The EA must detect account margin mode and report whether the selected mode is supported.

## Position State and TP Management

TP1-TP4 and lifecycle commands require current MT5 state, not only the original signal.

The backend stores the plan:

- logical trade ID.
- provider and source message history.
- intended symbol, side, entry, SL, TP1-TP4, and volume allocation.
- intended execution mode: split-order or virtual-TP.
- command history from the provider, such as cancel, BE, close half, or close TP1.

The EA reports the reality:

- account mode: hedging or netting.
- open positions by ticket, symbol, side, volume, open price, SL, TP, profit, and magic/comment identifiers.
- pending orders by ticket, symbol, type, volume, open price, SL, TP, and expiration.
- current bid/ask for symbols involved in active logical trades.
- broker-supported volume minimum, maximum, and step where available.
- result of every close, partial close, cancel, SL/TP modification, and TP-leg action.

The dashboard compares plan vs reality:

- planned TP legs vs remaining broker volume.
- which TP legs are open, hit, closed manually, skipped, failed, or unknown.
- whether a provider management command has been applied to MT5.
- whether a logical trade is out of sync with broker state.

Decision split:

- Backend decides what the provider message means and which logical trade it belongs to.
- Backend queues an intended action, for example close TP1 or move SL to BE.
- EA validates live MT5 state before applying the action.
- EA decides the exact executable volume after broker constraints and current remaining volume are known.
- EA reports the actual result back, including the volume closed or modified.

For virtual-TP mode, the EA must continuously manage the active logical trade while it is running:

- watch current price for TP1-TP4 thresholds.
- close the configured portion when a TP threshold is hit.
- move SL according to configured rules after TP hits if enabled.
- report each TP leg closure back to the backend.

For split-order mode, the backend/EA creates child orders or positions for each TP leg. Provider commands still target the logical trade first, then resolve to one or more child broker tickets.

If the app cannot reconcile a command to an open logical trade with enough confidence, it must require manual review instead of sending a blind close/cancel/modify command to MT5.

## Analytics & Performance

The dashboard must surface attribution and account-level performance, not just live operational state.

Per-provider attribution is computed from the join of LogicalTrade, ExecutionReport, and Provider:

- pips
- W/L percentage
- average drawdown
- P/L (currency-denominated)
- profit
- gain (return percentage)

Account-level KPIs:

- initial balance
- total profit
- delta for today, this week, and this month
- EA status badge tied to MT5 heartbeat freshness

Time series:

- equity curve: account growth versus trade count, stored either as a derived view over ExecutionReport or as pre-aggregated daily snapshots.
- drawdown series: aligned with the equity curve.
- monthly returns: percentage return per calendar month per account.

Filtering and export:

- filter by provider name, by date range, and by enabled/disabled status.
- "Provider Report" export as CSV or PDF for a selected window.

Performance metrics must match a hand-computed value on a fixture-driven test account, so analytics output is testable without a live broker.

## MT5 Expert Advisor Design

The MT5 integration path is an Expert Advisor that polls the backend API.

The EA must:

- register account number, server, company, currency, balance, and equity.
- send periodic heartbeat.
- poll for eligible signals with a short interval.
- map standard symbols to broker symbols.
- support prefix/suffix symbol mapping.
- apply the backend-provided broker symbol for each command and reject mismatches.
- optionally report available terminal symbols to the backend for mapping validation.
- report current open positions and pending orders for active logical trades.
- validate symbol availability through Market Watch.
- validate market and pending order prices against current bid/ask.
- normalize volume to broker constraints.
- use typed MQL5 trade structures.
- execute market orders with `TRADE_ACTION_DEAL`.
- execute pending orders with `TRADE_ACTION_PENDING`.
- use `ENUM_ORDER_TYPE` values for BUY, SELL, BUY_LIMIT, SELL_LIMIT, BUY_STOP, and SELL_STOP.
- delete pending orders when a `CANCEL_PENDING` command is received.
- close full or partial positions when close commands are received.
- move SL to breakeven or modify SL/TP when management commands are received.
- manage TP1-TP4 legs according to the configured split-order or virtual-TP mode.
- use full close or partial close operations by position ticket where possible, and check the resulting trade retcode.
- calculate close volume from the requested TP leg/percentage and current remaining broker volume.
- tag broker orders/positions with logical trade IDs in comments and/or magic-number strategy.
- inspect `MqlTradeResult.retcode`, not just the boolean return from `OrderSend`.
- report retcode, retcode_external, broker comment, order ticket, deal ticket, requested price, filled price, volume, and error text.

The EA should use `EventSetTimer` for polling and heartbeat. The backend URL must be added to MT5 allowed WebRequest URLs by the user.

For partial closes, the EA should prefer ticket-specific close behavior so it does not accidentally close the wrong position when multiple positions share a symbol or magic number. In hedging accounts this can use MQL5 trade-class partial close behavior. In netting accounts, partial volume reduction must be handled according to account mode and broker constraints, then reported back with exact volume actually closed.

The EA should avoid ad hoc JSON splitting for complex responses. If MQL5-side JSON parsing is too brittle, the backend should return a simple line-oriented or single-signal payload format that the EA can parse safely.

## Data Model

Core entities:

- AppProfile: local application profile for one user/operator.
- TelegramSession: local Telethon session metadata and state.
- Provider: selected Telegram dialog/channel/group.
- SymbolAlias: global or provider-specific alias from raw provider text to canonical symbol.
- AccountSymbolMapping: account-specific canonical-to-broker symbol mapping, prefix, suffix, include list, and exclude list.
- RawMessage: immutable captured Telegram message.
- ParserFixture: reusable parser test case created from raw or pasted text.
- ParsedSignal: normalized parse output and confidence.
- SignalCommand: normalized open/cancel/close/modify command generated from a parsed provider message.
- LogicalTrade: app-level trade grouping one provider idea across all TP legs and MT5 actions.
- TradeLeg: TP1-TP4 allocation, target price, status, and close evidence.
- MT5Account: account registration and heartbeat state.
- ExecutionQueueItem: signal/account work item for the EA.
- ExecutionReport: result returned by the EA.
- Trade: opened or pending order known to the app.
- AuditLog: operational events and errors.
- EquityGuardian: per-MT5Account threshold, current drawdown, paused state, and breach history.
- ProviderConfig: per-Provider message-template choice, TP strategy rules, pip-manipulation settings, plus version, author, and timestamp for history.
- ProviderConfigHistory: append-only changelog rows for ProviderConfig.
- EquitySnapshot: periodic per-account balance and equity capture used for the equity curve.
- LogicalTradeEvent: timestamped events (OPEN, SL_MOVED, TP_HIT, PARTIAL_CLOSE, MODIFY, CANCEL, CLOSED) joined to LogicalTrade as an explicit append-only log for the UI feed.

## Frontend Screens

The frontend uses a top-level navigation rail (Home, Linked Accounts, Account Management, Live, Telegram Setup) with the Live workspace organized as tabs.

V1 top-level screens:

- Telegram Setup: API ID, API hash, phone, code, and 2FA flow.
- Live workspace (default after setup): the operations console, organized as tabs (see below).
- Linked Accounts / Account Management: MT5 account registration, heartbeat health, broker/server, and risk defaults.

V1 Live-workspace tabs:

- Performance: account KPIs strip (initial balance, total profit, today/week/month deltas), equity-curve chart with growth/drawdown toggle, monthly-returns bar chart, and a small per-account latency strip.
- Providers: sortable performance table with columns for name, risk, TP count, SL, others, pips, W/L %, average drawdown, P/L, profit, and gain. Filter chips by name, date, and status. Per-row gear opens the Provider Configuration modal. Add Provider opens the dialog picker. Provider Report exports a CSV or PDF for the selected window.
- History: chronological logical trades. Each row is expandable to a per-trade lifecycle event log (timestamped OPEN, SL_MOVED, TP_HIT, PARTIAL_CLOSE, MODIFY, CANCEL, CLOSED) and a P/L sparkline.
- Equity Guardian: per-account current drawdown, threshold, pause-on-breach toggle, breach event log, manual unpause action.
- Symbol Settings: global aliases, provider aliases, account mappings, prefix/suffix, include/exclude rules, and EA symbol validation, presented as editable tables.
- Signal Strategy Rules: per-provider per-pair rule editor (forward-compatible UI scaffold even if backend per-pair support lags).
- Logs: combined parser-review queue and MT5 execution logs as a single timestamped feed with type and status filters.

Cross-cutting UI elements:

- Status bar header: brand, health chips, queue count, last-poll clock, refresh action, and live-poll dot.
- Quick actions: command palette (Cmd/Ctrl+K) for refresh, pause provider, jump-to-tab, and open settings.
- Settings drawer (Cmd/Ctrl+,): global Telegram credentials and add-provider flow.
- Per-trade lifecycle event log surfaces in the History tab and inside any expanded logical trade.
- P/L sparkline appears on each logical trade card.

The first screen after setup is the Live workspace, not a marketing page.

The visual direction is a modern dark terminal: dense, monospace numerics, sharp 1 px borders, a single cyan accent on near-black, with status bar, ticker tape, and tabbed working surface. Color is reserved for direction (green for up, red for down) and warnings (amber). Inspiration is Bloomberg-style operations terminals while keeping the navigability of TSCopier.

## Testing and Verification

Mandatory verification for implementation:

- Frontend typecheck.
- Frontend lint.
- Frontend unit/component tests.
- Frontend production build with bun.
- Backend unit tests.
- Backend parser fixture tests.
- Backend API tests for Telegram setup state transitions, provider selection, queue transitions, duplicate handling, and MT5 execution reports.
- Backend tests for lifecycle commands, TP leg allocation, duplicate management messages, and command-to-trade matching.
- Backend tests for symbol alias precedence, prefix/suffix application, include/exclude filtering, and unmapped-symbol review behavior.
- Docker/application rebuild after code changes.

MT5 verification has two levels:

- Static/source verification against current MQL5 documentation for request/result types, order actions, order types, timer usage, and WebRequest constraints.
- Manual demo-terminal verification when an MT5 environment is available.

The project should document what can be verified locally and what requires a real MT5 terminal.

## Risks and Constraints

- Telegram session handling must avoid leaking credentials into frontend storage.
- Signal parsing will never be perfect on day one; Parser Lab and fixtures are required to improve safely.
- `OrderSend` returning true does not prove trade execution; retcodes and trade transaction outcomes matter.
- Broker symbol naming and volume constraints vary; the EA must own broker-specific validation.
- Symbol mapping affects parser confidence, provider setup, MT5 account readiness, and lifecycle command matching.
- MT5 WebRequest requires users to allow the backend URL in terminal settings.
- MT5 account mode matters. Hedging accounts and netting accounts handle multiple positions and partial exits differently, so the EA must detect and report account mode.
- Broker-side positions usually expose one TP field per position. TP1-TP4 support must be modeled as either multiple child positions/orders or EA-managed virtual TPs with partial closes.
- Strategy Tester cannot execute WebRequest, so live/demo terminal testing is still needed.

## Success Criteria

V1 is successful when:

- A user can register Telegram from the frontend.
- A user can verify Telegram code and 2FA from the frontend.
- A user can select a Telegram provider from the frontend.
- Recent provider messages can be parsed and reviewed in Parser Lab.
- Parser fixtures cover the supported v1 signal formats.
- Parser fixtures cover open, cancel pending, close, close partial, BE, SL/TP modification, and TP1-TP4 messages.
- Parser fixtures cover raw symbol aliases and mapped broker symbols, including prefix/suffix cases.
- A parsed, approved signal can enter an MT5 queue.
- The dashboard can show whether a provider symbol maps to a broker symbol for each connected MT5 account.
- A logical trade can track TP1-TP4 legs and partial-close status.
- A provider management message can be matched to the correct logical trade and queued as an MT5 command.
- An MT5 EA can register, heartbeat, poll, execute a demo signal, and report the result.
- An MT5 EA can process at least one non-entry lifecycle command in demo mode, such as move SL to BE or cancel pending.
- Execution logs show enough detail to diagnose failures without guessing.
- Provider/channel lot size controls MT5 queue volume, and provider-sent lot sizes are ignored for execution.
- Multi-TP queue payloads include explicit per-leg volumes that add back to the configured channel lot size.
- Per-provider performance metrics are visible in the Providers tab and match a hand-computed value on a fixture-driven test account.
- Equity Guardian threshold breach pauses new OPEN_TRADE commands for the affected account while continuing to pass lifecycle commands on already-open trades.
- Provider Strategy Configuration changes round-trip through the queue and the EA receives the modified TP/SL on demo execution.
- Per-trade lifecycle event log is populated for every state transition (OPEN, SL_MOVED, TP_HIT, PARTIAL_CLOSE, MODIFY, CANCEL, CLOSED).
