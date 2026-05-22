# Improvements — 2026-05-21

Status check after a more careful read of the codebase. Phase 3 and Phase 4 are **already shipped**. Only Phase 2.1 and Phase 2.2 remain.

---

## ✅ Phase 3 — Time-based equity curve (DONE)

Originally task #47. Far more sophisticated than the previous plan sketched.

**Implementation:**
- `apps/api/src/app.ts:5261` table `equity_curve_points` — OHLC-bucketed, keyed by `(scope, account_id, provider_id, bucket_start)`, with `open_value / high_value / low_value / close_value`, `balance`, `broker_profit`, `external_floating_pnl`, `realized_pnl`, `floating_pnl`, `net_pnl`, `drawdown_amount`, `drawdown_pct`, `sample_count`, `open_trade_ids_json`, `position_tickets_json`. Index on `(scope, account_id, provider_id, bucket_start DESC)`.
- `apps/api/src/app.ts:5289` table `equity_curve_state` — running max-drawdown anchor per scope (max_drawdown_amount, max_drawdown_at, contributor_json).
- `apps/api/src/app.ts:3875` `recordEquityCurveSamples()` private method writes points on each heartbeat.
- `apps/api/src/app.ts:2145` call site inside the heartbeat handler.
- `apps/api/src/app.ts:4163` cleanup — `DELETE FROM equity_curve_points WHERE bucket_start < ?` for the retention window.
- `apps/api/src/app.ts:4169` projection reads bucket_start + close_value + drawdown_pct into `{ x, equity, drawdown }` for the chart.

**Net result:** chart reflects floating-equity drift continuously, with proper bucketed sampling. Drawdown comes through directly from the persisted column rather than recomputed each request.

---

## ✅ Phase 4 — Categorised stats expansion (DONE)

Six-category stats view, filterable by date range, scope (account vs provider), and provider.

**Implementation:**
- `apps/api/src/app.ts:514` endpoint `GET /api/accounts/:accountId/stats`.
- `apps/api/src/app.ts:3801` `accountStats(accountId, { range, scope, providerId })` aggregator. Returns currency, range, scope, profitReturn, winLoss, riskDrawdown, quality, streaks, timing.
- `apps/api/src/app.ts:3811` `closedTradeStats()` helper — pulls closedTrades + externalCloses, computes per-trade pnl + duration.
- `apps/api/src/app.ts:3823` `curveRiskStats()` reads max drawdown from `equity_curve_state` (Phase 3 dependency).
- `apps/web/src/pages/PerformancePage.tsx:109` — Performance page now has `Overview` and `Statistics` mode-tabs.
- `apps/web/src/pages/PerformancePage.tsx:154` `StatisticsView` component renders 6 cards (Profit/Return, Win/Loss, Risk/Drawdown, Quality, Streaks, Timing). Filter bar with `7d / 30d / 90d / All` range, `Account / Provider` scope, and provider selector.

**Net result:** the operator gets the six-category stats overview they asked for, filterable, sourced from the existing closed trades and equity-curve data.

---

## ❌ Phase 2.1 — Per-EA attribution for `expert`-source closes (still pending)

The History › Closed view still labels every non-tc deal closed by an EA as `Closed by EA` with no hint of *which* EA. We already store the broker's `magic` number on the row.

**Evidence it isn't done:**
- `apps/api/src/app.ts:4574-4593` `externalClosesForAccount` projection output object does NOT include `magic` or `comment`. (The data is in the DB — `external_closes.magic` column at `apps/api/src/app.ts:5396` — just not surfaced.)
- `apps/web/src/components/ClosedPositionsTable.tsx` has zero references to `magic`. The pattern already exists in `apps/web/src/pages/PerformancePage.tsx:361` (`ExternalActivityPanel`) and `apps/web/src/components/OpenPositionsTable.tsx:263` (`externalLabel(position.magic)`).

**Changes:**
- `apps/api/src/app.ts` — extend `externalClosesForAccount` return shape with `magic: Number(row.magic ?? 0)` and `originComment: String(row.comment ?? "").slice(0, 40)`.
- `apps/web/src/App.tsx` — add `magic?: number; originComment?: string;` to `ClosedTradeRow`.
- `apps/web/src/components/ClosedPositionsTable.tsx` — in `ClosedTradeDetail`, when `row.origin === "manual"` and `row.magic > 0`, append `· magic ${magic}` after the trade-meta line; when `row.originComment` is non-empty, render in muted text.
- `apps/api/src/api.test.ts` — assert magic surfaces in `externalCloses` for a seeded other-EA deal.
- `apps/web/src/App.test.tsx` — assert magic chip + comment line appear in the manual-close expanded block.

**Effort:** ~30 minutes.

**Follow-up (separate plan):** operator-facing labels — settings page where the operator names known magics, UI resolves `26050901 → "TelegramTC"`, `12345 → "MyOtherEA"`.

---

## ❌ Phase 2.2 — Backfill external closes beyond 168h (still pending)

**Evidence it isn't done:**
- `mt5/TelegramTC_EA.mq5:12` still has static `input int HistoryLookbackHours = 168;`. Line 14 has `HistoryBackfillSeconds = 60` but that's the backfill cadence, not the lookback window.
- `mt5/TelegramTC_EA.mq5:172` `SendHistoryDeals()` always computes `fromTime = toTime - MathMax(1, HistoryLookbackHours) * 3600`.
- No `history_deep_pull_from` column on `mt5_accounts`.
- No `/api/mt5/accounts/:id/history-deep-pull` endpoint.

**Approach (chosen B from earlier analysis):**

Operator-triggered deep pull. Small "Pull older history" affordance on the Live header opens a date picker; backend stores the target date; next `/poll-line` payload includes `historyDeepPullFrom=YYYY-MM-DD`; EA runs a one-shot wider `HistorySelect` + push, then clears the flag on success. Backend ingestion is already idempotent (dedup by `deal_ticket` + REPAIR path in `saveBrokerHistory`), so re-running is safe.

**Changes:**
- `mt5/TelegramTC_EA.mq5` — read optional `historyDeepPullFrom` from `/poll-line` response; on receipt, run wider `HistorySelect(parsed, TimeCurrent())` once and push; on success, call backend to clear the flag. Bump to v1.7.1.
- `apps/api/src/app.ts` — `mt5_accounts.history_deep_pull_from TEXT` column (via `ensureColumn`); `POST /api/mt5/accounts/:id/history-deep-pull` endpoint (validates date, server-side cap of 365d, sets column, audit log); include the value in the existing `/poll-line` line-format response; `POST /api/mt5/accounts/:id/history-deep-pull/ack` endpoint clears the flag.
- `apps/web/src/components/AccountHeader.tsx` — small "Pull older history" button. Native `<input type="date">` for picker; disabled while a pull is in flight.

**Effort:** ~2-3 hours including EA changes and tests.

**Risks:** MT5's HistorySelect has internal limits at very large windows. Cap server-side to 365 days max. EA logs a warning if it returns zero deals despite the requested window.

---

## Suggested order

1. Phase 2.1 — ~30 min, fully self-contained, no dependencies.
2. Phase 2.2 — ~2-3 hours, independent of Phase 2.1.
