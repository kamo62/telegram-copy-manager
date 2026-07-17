# Handoff

Updated: 2026-07-17

## Active thread: signal correlation and lifecycle alignment

Design only. No implementation started. No code touched in the app. Nothing deployed.

### State

- Design doc `plan-signal-correlation-17-07-26.md` on branch `release/ops-redesign-1.21.1`.
  - First draft committed `4082cca1`.
  - Hardened after Codex review, committed in this session (see `git log`).
- Reviewed by Codex (sol, xhigh) against `4082cca1`. Review found 4 critical and
  5 high issues. All are folded into the doc under "Revisions after Codex review".
- Goal: tie provider lifecycle messages (cancels, TP-hits, re-entries) to the
  specific open trade using the Telegram reply link we currently discard at
  `apps/api/src/telegram.ts:377`, so our positions stay aligned with the provider.

### Why implementation has not started

The user asked to proceed to implementation ("if comfortable") then went to nap.
Codex's review changed the design materially on safety-critical points, so building
the plan as first committed would have shipped wrong-trade closes, ticketless
lifecycle commands, and invalid-price auto-execution. The doc is now hardened, but
implementing a safety-critical change to a live money system unsupervised, straight
off a just-revised plan, is not the right call. Wait for a green-light on the
hardened plan.

### Decisions locked

- D1: Automatic fills only genuinely missing stop/TP from defaults. Invalid explicit
  geometry and guessed entry hold. Aggressive additionally executes guessed entry.
- D2: per-provider `maxEntriesPerSignal` cap (default 5). Over-cap signals hold by
  default; first-N execution is opt-in only.
- D3: the "11 of 284 executed" shortfall is a separate routing/guardian
  investigation, not part of this work.

### Open questions to settle before build

- Unresolved lifecycle commands: retryable, or permanent review holds?
- Valid target states per lifecycle action (cancel vs close vs modify)?
- Confirm multi-account lifecycle is all-or-hold.
- Source and freshness bound for an Aggressive guessed entry?

### Next steps

1. Get user sign-off on the hardened plan and the four open questions.
2. Implement phase 1 first (reply-link capture + complete reply graph), forward-only,
   no behaviour change. Route execution to Codex terra (medium) per workflow.
3. Phase 2 correlation behind a feature gate in a per-provider shadow phase (log
   intended action, do not execute) before going live.

## Pending: deploy v1.26.0 (prior thread, not yet shipped)

- Branch `release/ops-redesign-1.21.1` carries v1.26.0: geometry-inference parsing
  for single-symbol providers plus parameter-level open-signal dedup. Reviewed,
  implemented, tests green (core 43/43, API 232/232). Not deployed.
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
