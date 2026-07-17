# Handoff

Updated: 2026-07-17

## Active thread: signal correlation and lifecycle alignment

Phase 1 implemented and committed. Nothing deployed. No behaviour change yet.

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
