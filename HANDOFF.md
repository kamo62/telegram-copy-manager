# Handoff

Updated: 2026-07-25 (v1.57.4 CLOSE_PARTIAL safety completion)

## v1.57.4 — final pre-deploy safety completion

- The runnable flatten model now mirrors `ExecutePartialClose`: pending orders remain untouched, one aggregate report covers all attempted positions, only `DONE` slices are marked idempotently executed, and `PLACED`, `DONE_PARTIAL`, or failed slices stay `PARTIAL`/held for retry or reconciliation. An already-executed or zero-attempt partial command reports `UNKNOWN`.
- Pending-trade flattening is capability-only: `pending-close-flatten-v1` is required on a fresh heartbeat. EA version `1.57.1` alone, or `lane2-close-contract` alone, is held.
- **Recompile and reattach `mt5/TelegramTC_EA.mq5`; build the EA binary from the final 1.57.4 commit only. Intermediate 1.57.1/1.57.2 binaries carry the CLOSE_PARTIAL regression. CLOSE_PARTIAL is deliberately not capability-gated.**
- A held `PLACED`/`DONE_PARTIAL` partial close can still be requeued by an operator after its broker order fills. PERCENT payloads recalculate against `targetRemainingVolume`; LOTS and TP_LEG payloads do not know the filled amount. Reconcile the current MT5 snapshot and history for the position ticket, compare filled and remaining volume with the held report, and only then requeue an operator-adjusted residual close. Do not blindly requeue LOTS/TP_LEG work.

## v1.57.3 — CLOSE_PARTIAL regressions from the 1.57.1 flatten rewrite (FIXED)

Found in an Opus 5 review of 757bca9a; three prior review passes missed them.
`ExecuteClose` (`mt5/TelegramTC_EA.mq5`) serves both CLOSE_TRADE and
CLOSE_PARTIAL (dispatch at `:241`), but the flatten rewrite applied CLOSE_TRADE
semantics to both, so a partial close:

1. cancelled every working pending order for the logical trade, destroying the
   remaining entries of a multi-entry/ladder setup;
2. reported PARTIAL and stayed held even when it fully succeeded, because the
   surviving position looked like an incomplete flatten;
3. was never marked idempotently executed (the marker required the position to
   be gone), so a replay could close a second slice of the same position.

The server capability gate did not shield any of this:
`requiresPendingCloseFlattenContract` (`apps/api/src/app.ts`) returns false for
CLOSE_PARTIAL. The old EA did not cancel pendings, so the regression would have
appeared only after the recompile.

Fix: partial closes run their own `ExecutePartialClose` path that never touches
pending orders, reports EXECUTED on a DONE deal, and marks the ticket executed
so a replay cannot double-close. Full closes keep the 1.57.2 hardening
(complete only once the broker confirms the position is gone; PLACED and
DONE_PARTIAL stay retryable) via a `fullClose` gate. Covered by EA
source-contract regressions plus a partial-close case in the runnable flatten
model; all three fixes were mutation-checked.

Applied all four second-pass HIGH/MEDIUM close-flatten and EA-contract fixes on
fix/vipgold-duplicate-open-prevention; nothing was pushed or deployed.

- Pending-trade CLOSE_TRADE flattening now requires the fresh
  pending-close-flatten-v1 capability or EA version >=1.57.1. The recompiled
  EA advertises both lane2-close-contract and pending-close-flatten-v1.
- Requeue rejects unbound LIFECYCLE_RECONCILIATION:* items, and the EA rejects
  every lifecycle command with an empty logicalTradeId; empty identity is
  never a wildcard.
- PLACED and DONE_PARTIAL closes stay retryable until broker state confirms
  the ticket is gone. Partial retry uses the current remaining volume and
  idempotent replay cannot double-close.
- Added runnable flatten-state coverage for pending-order removal, fill
  rescan, partial handling, and idempotent replay, plus server/API and EA
  contract regressions.
- **EA recompile and reattach are required before this new flattening behavior
  can run.** Old EAs keep the prior safe behavior and are held from the new
  pending-close path until a fresh compatible register/heartbeat is confirmed.

Applied all six HIGH/MEDIUM trade-safety review fixes on `fix/vipgold-duplicate-open-prevention`; nothing was pushed or deployed.

- Quoted NEW-order status comments now stay lifecycle context: activated/triggered/filled are `NO_SIGNAL`, deleted is `CANCEL_PENDING`, closed is `CLOSE_TRADE`, and modified is non-open unless a complete supported modification command is present.
- Provider order IDs take precedence over fingerprint/parameter deduplication, terminal trades no longer block reposts, fresh live EA quotes win over stale durable snapshots, and short hashtags/TP numbering are not ticket identities.
- Unmatched, ambiguous, incomplete, and incompatible lifecycle commands are persisted as `HELD` with `LIFECYCLE_RECONCILIATION:*` reasons and original-message evidence.
- Provider CLOSE on a pending logical trade remains `CLOSE_TRADE`; the EA now cancels matching pending orders, re-scans for fills, closes matching positions, and reports `UNKNOWN`/`PARTIAL` when exposure is not fully confirmed gone.
- **EA recompile and reattach/redeploy are required before this flattening behavior can run.** The server holds close work for EAs without `lane2-close-contract`; legacy EAs are not silently used.
- Added regressions for all six findings, including the pending-fill-before-close orphan case. Full gate was run after the final patch; no push/deploy was performed.

Updated: 2026-07-24 (v1.57.0 duplicate-open prevention)

Implemented the scoped trade-safety batch on `fix/vipgold-duplicate-open-prevention`; nothing was pushed or deployed.

- Activation/status replies, including VIP Gold msg 546, stay lifecycle context and never create an open.
- Provider order IDs are persisted on logical trades; duplicate `(provider, account, order id)` opens are HELD as `DUPLICATE_ORDER_ID`.
- Naked STOP/LIMIT entries and known-unquoted MARKET orders are HELD before EA delivery.
- Provider CLOSE commands fan out to every active logical trade sharing the provider order id.
- Added exact live 545/546/547, duplicate-id, naked-order, quote, and close-fanout regression coverage.
- Full gate passed after the final metadata/test pass: `bun run typecheck`, `bun run lint`, `bun test` (541 passed, 0 failed), and `bun run build`.

Updated: 2026-07-24 (v1.56.2 follow-up review fixes)

## Session progress (2026-07-24) - required Medium fixes applied locally

Applied only the two required pre-deploy review fixes on `feat/symbol-picker-and-actionable-alerts`; nothing was pushed, opened as a PR, or deployed.

- Correlated held symbol-mapping alert counts to the queue item's account after provider relinking.
- Rejected blank canonical broker input unless an account rule is intentionally dirty for a rules-only save.
- Added regression coverage for the relinked multi-account attribution and both canonical save outcomes.
- Execution and held-for-review behavior remain unchanged.
- Version aligned to 1.56.2 in `package.json` and the MT5 EA metadata; changelog updated.

Updated: 2026-07-24 (symbol picker and actionable alerts review fixes)

## Session progress (2026-07-24) - review fixes applied locally

Applied all eight review fixes on `feat/symbol-picker-and-actionable-alerts`; changes remain local and
nothing was pushed, opened as a PR, or deployed.

- Fixed unrelated quoted-symbol suggestions, canonical alert mapping saves, provider-scoped alert suppression, affix confidence, actionable blocked counts, suppression request validation, dashboard alert query fan-out, and broker inventory validation.
- Added regression coverage for each finding, including malformed JSON/non-string suppression bodies and canonical-versus-raw mapping payloads.
- Suppressed tokens still follow the normal approval path and remain `HELD` with `SYMBOL_MAPPING_*`; execution and held-for-review behavior is unchanged.
- Version aligned to 1.56.1 in `package.json` and the MT5 EA metadata.
- Full gate passed: `bun run typecheck`, `bun run lint`, `bun test` (531 passed, 0 failed), and `bun run build`.

Updated: 2026-07-24 (symbol picker and actionable alerts)

## Session progress (2026-07-24) - implementation complete locally

Implemented locally on branch `feat/symbol-picker-and-actionable-alerts`; changes remain local and
nothing was pushed, opened as a PR, or deployed.

- Added a searchable, quote-aware, keyboard-accessible broker-symbol combobox with refresh-safe selection and confirm-only affix suggestions.
- Structured unmapped-symbol alerts by provider and account, showing blocked signal counts and suggested quoted broker symbols.
- Added persisted per-provider "not an instrument" suppression with audit logging. Suppression is excluded from the alert and needs-mapping surfaces only; execution still holds unmapped signals for review.
- Added end-to-end coverage for alert mapping, suppression, quote metadata, and held-for-review behavior after suppression. `FRONTEND_PARITY.md` was preserved unchanged.
- Version aligned to 1.56.0 in the root package and EA metadata. Changelog entry added.
- Final gate: `bun run typecheck` passed, `bun run lint` passed, `bun test` passed with 525 tests and 0 failures, and `bun run build` passed for both API and web bundles.
- No push, pull request, or deployment was performed.

Updated: 2026-07-23 (UI fidelity and information architecture session)

## Session progress (2026-07-23) - implementation complete locally

Implemented locally on branch `feat/ui-fidelity-and-ia-2026-07-23`; changes remain uncommitted and
nothing was pushed, opened as a PR, or deployed.

- Operations no longer renders the Signal ledger. Telegram Setup is limited to authentication, dialog selection, and provider addition.
- Providers is the global provider hub for aggregate performance, health, and enable, pause, remove monitoring. Account-scoped provider copy settings remain in the account workspace.
- Account headers have Rename, Remove account, and Manage link actions. Nicknames are nullable, persisted through `PATCH /api/mt5/accounts/:accountId`, and used as the display fallback before the MT5 account number.
- External and untracked trades support local browser dismissal only. No broker mutation is performed.
- Offline and stale states use neutral and amber tokens, stale headers show last-known balances, the equity chart handles flat and single-point history, settings accept comma decimals, `/review` redirects to `/logs`, and the app has a favicon.
- Version bumped to 1.55.1 in the root package and EA metadata. Changelog entry added.
- Final gate: `bun run typecheck` passed, `bun run lint` passed, `bun test` passed with 515 tests and 0 failures, and `bun run build` passed for both API and web bundles.
- Git commits were requested but blocked by the environment because `.git/index.lock` cannot be created. No push, pull request, or deployment was performed.

## Session progress (2026-07-17) — all on branch, NOTHING deployed

Commits this session (oldest first):
- `b8fa3a48` v1.27.0 Phase 1: reply-link capture + alias/origin persistence (forward-only).
- `587093e8` v1.28.0 French vocabulary normalization (gated; English byte-identical).
- `2542132a` v1.29.0 WTI crude oil -> USOIL recognition.
- `73cf5d60` v1.30.0 VIP Gold order lifecycle (Deleted->cancel, Closed->close, order id) + stock index coverage (US30/NAS100/SPX500/GER40/UK100/JP225 + aliases).
- `f24ab4c7` v1.31.0 Phase 2a shadow-only lifecycle correlation logging (per-provider `correlationMode`, default off; audit-only; diff reviewed for shadow-only safety).
- `a043bdde` v1.32.0 non-adjacent ticker extraction (symbol on its own line / SYM/SYM / tagged).

All suites green at head: core 56, api 240 (296 total). Not deployed.

### Providers created this session (live DB, DISABLED)
- Metabear `provider_n8jb90` — enabled=0, multi-symbol (no lock), parserMode deterministic.
- VIP Gold `provider_15k9j3v` — enabled=0, lockedSymbol=XAUUSD.
- Both disabled => no ingest, no execution. KAL VIP `provider_1gfxfwd` still the only enabled provider. Enable VIP Gold only AFTER Phase 2a shadow validation (lifecycle-heavy).

### Channel analysis (read-only, no DB writes) — real vs reported win rates
- Verified real win rates (reply-linked opens->outcomes) are far below advertised:
  VIP Gold 82% (verified, signed closes), Metabear ~65-92%, French 77%, THE 1% TRADING
  58% (they admit "63% from 92%" in-channel), Forex Manipulation 2 clean parse but
  73% of trades go silent, Prime FX/Olinvest never post losses (marketing).
- Add candidates: Metabear + Forex Manipulation 2 (clean parse); VIP Gold + French
  (shadow first). Skip: Olinvest, Premium (Gold+Forex), Gold Signal, Elliott Wave.

### Remaining parser-coverage gaps (Phase 4)
- Symbol-less gold signals (Premium, Olinvest: "Sell 4042/4045") -> need per-provider
  `lockedSymbol=XAUUSD`, not parser code.
- LONG/SHORT direction vocab + header-only opens with levels in follow-ups
  (gold_signal) -> needs LONG/SHORT support AND multi-message correlation; low priority.

## Active thread: signal correlation and lifecycle alignment

Phase 1, Phase 2a (shadow), Phase 3 (VIP Gold lifecycle parse) implemented and committed.
Nothing deployed. No execution behaviour change (Phase 2a is shadow/audit-only, off by default).

### State

- Design doc `plan-signal-correlation-17-07-26.md` on branch `release/ops-redesign-1.21.1`.
  - First draft committed `4082cca1`; hardened after Codex review `d71b9e9c`;
    review questions resolved `a4b8209b`.
- Reviewed by Codex (sol, xhigh) against `4082cca1`. Review found 4 critical and
  5 high issues. All are folded into the doc under "Revisions after Codex review".
- Goal: tie provider lifecycle messages (cancels, TP-hits, re-entries) to the
  specific open trade using the Telegram reply link we previously discarded at
  `apps/api/src/telegram.ts:377`, so our positions stay aligned with the provider.

### Phase 1 DONE (commit `b8fa3a48`, v1.27.0)

Forward-only plumbing. No parsing, queueing, or execution change; nothing reads
the new columns/tables yet. Implemented by Codex Terra, reviewed, suites green
(core 43, api 237). Not deployed.

- `telegram.ts`: `replyToMessageId` captured from `message.replyTo.replyToMsgId`.
- `raw_messages.reply_to_message_id` (additive migration, populated at all 3
  INSERT sites; correlated groups use the anchor's reply id).
- `raw_message_aliases` table: every folded correlation constituent aliases to
  its stored raw message, so a reply to a folded id still resolves (gap-free).
- `trade_origins` table: indexed `(provider, account, opening telegram id)` ->
  `logical_trade` mapping, populated in `insertTrade`; manual origins excluded.
- Tests: adapter capture, migration idempotency (legacy+fresh), gap-free alias
  mapping through correlation, origin mapping + manual exclusion.

### Next: Phase 2 (correlation resolver + matcher, gated + shadow)

- Wire `matchLifecycleCommandToTrade` explicit-target path (packages/core:757)
  behind a feature gate. Resolve per `(provider/dialog, origin message, account)`
  using reply chain then fingerprint, validating ownership, active state,
  action-vs-state compatibility, and a live broker ticket before queueing.
- Run first in a per-provider shadow phase that logs the intended action without
  executing. Promote to live only after shadow output matches captured traffic.
- Then Phase 3 (VIP Gold parser fixes behind regression gates), Phase 4
  (Automatic/Aggressive UI + policy). See plan doc "## Sequencing".

### Decisions locked

- D1: Automatic fills only genuinely missing stop/TP from defaults. Invalid explicit
  geometry and guessed entry hold. Aggressive additionally executes guessed entry.
- D2: per-provider `maxEntriesPerSignal` cap (default 5). Over-cap signals hold by
  default; first-N execution is opt-in only.
- D3: the "11 of 284 executed" shortfall is a separate routing/guardian
  investigation, not part of this work.

### Open questions

All four settled and recorded in the plan doc under "Resolved review questions
(2026-07-17)": lifecycle retry-with-TTL then hold; action-vs-state compatibility
table; per-account independent resolution (not all-or-hold); Aggressive guessed
entry is MARKET-intent only at a fresh quote (<=60s).

## Pending: deploy v1.26.0 / v1.27.0 (prior threads, not yet shipped)

- Branch `release/ops-redesign-1.21.1` now at v1.27.0. It carries v1.26.0
  (geometry-inference parsing for single-symbol providers plus parameter-level
  open-signal dedup) and the v1.27.0 Phase 1 correlation plumbing above. Both
  reviewed, tests green (core 43, api 237). Not deployed.
- Remaining:
  1. Deploy: `bun run deploy` (backs up live DB, rsyncs, swaps container).
  2. Set Locked symbol = XAUUSD on KAL VIP (`provider_1gfxfwd`), or inference stays off.
  3. Watch the next directionless KAL VIP signal in ParseLab.
- Trade-safety backlog (2026-07-14 audit) still open: double-close on lost report,
  percent-risk ignored, naked orders, guardian timing.

## Useful commands

- Deploy: `bun run deploy`
- Live providers: `curl -s http://192.168.0.100:18787/api/providers`
- Recent KAL VIP messages: `curl -s "http://192.168.0.100:18787/api/providers/provider_1gfxfwd/messages?limit=10"`
- Tests: `bun test packages/core && bun test apps/api`
