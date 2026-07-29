# Handoff

## START HERE — 2026-07-29

`main` @ `14164f6d`, pushed. **Production runs v1.64.0 and is live** on 192.168.0.100 — verified by
asset-hash match, both accounts online, Telegram connected. No EA recompile outstanding: EA versions
have moved with the release line but no EA behaviour has changed since 1.60.0.

Working branch `feat/ui-redesign-routes-2026-07-29` @ `14164f6d`, clean, created for the next step.

### DO THIS NEXT — the UI redesign, 7 routes remain

The owner replaced the design target with a new design system. `SPEC-ui-fidelity-2026-07-29.md` is
the authority — read it first. `REVIEW-ui-fidelity.md` describes the OLD target and is historical.

**Shipped (v1.64.0):** canonical token layer, four new components in
`apps/web/src/components/FormControls.tsx` (Switch, NumberField, ThresholdBar, SaveBar), Settings
rebuilt against them. New tokens are canonical; old names (`--ink*`, `--line`, `--panel`) alias onto
them so the vocabulary converges rather than forking.

**Remaining:** `/` `/logs` `/providers` `/symbols` `/telegram` `/history` `/performance`
`/equity-guardian`. They inherit the new tokens and shell but their interiors are unchanged. Apply
components by KIND, not by page. Owner is running Codex manually for this.

### Codex sandbox limits — both cost a full round trip each

1. **Codex cannot run a browser.** No port binding, no Chrome, no Computer Use. It reports this
   honestly instead of faking success, but it means **no visual or layout verification happens on its
   side**. Someone with a browser must do it.
2. **Codex cannot run git.** `.git/index.lock: Operation not permitted`. Create the branch for it and
   tell it explicitly not to run any git command; it will stop dead otherwise.

### How to verify the UI (this is where three bugs came from)

```
DATABASE_PATH=<db-copy> TELEGRAM_ADAPTER=mock PORT=8787 bun apps/api/src/server.ts
bun run dev:web
```

Always override `TELEGRAM_ADAPTER=mock`; the repo `.env` sets gramjs. Fresh DB copy:
`ssh kamo@192.168.0.100 'docker cp telegram-tc-app-1:/app/data/telegram-tc.db /tmp/a.db'` then scp.

The app is a React Router SPA — synthetic `history.pushState` does NOT drive it. Click the real
sidebar buttons and `.workspace-tab` buttons. Use ONE browser tab.

Per route, **both themes**, at **1600px and 560px**: every content child of a `.panel` shares left
and right edges, none overruns its parent, `document.scrollWidth <= innerWidth`. Measure **both
states** of anything collapsible.

Screenshots so far are in `screenshots/` (dark theme: operations, providers, settings, logs,
performance). Light theme and the remaining routes still to capture.

### Layout hazards, each of which produced a real bug

1. **`base.css` duplicated top-level blocks, the later one silently wins.** ~8,600 lines, five bugs
   so far. Grep every occurrence before editing. `bun run lint` has a duplicate guard.
2. **Panel inset depends on a DIRECT-CHILD relationship** — `.panel > *:not(header)` and the
   `margin-inline` group at `signal-desk.css:630`. A wrapper inside a panel silently strips inset and
   padding from everything below it.
3. **Grid items default to `min-width: auto`** and will not shrink below a wide child. `/logs`
   scrolled the whole document at 560px (1554px vs 560px) until `.wide-panel { min-width: 0 }`.

### Shipped 2026-07-28/29 (do not re-investigate)

- **v1.62.0 Telegram backlog drain.** A capture outage lost signals permanently: one page of 50
  messages, newest-first, then the watermark advanced to the newest of them. Now pages backwards with
  a resume cursor and a floor, live-pass-first so new signals are never delayed behind backfill, and
  the watermark only moves forward.
- **v1.63.0 duplicate-open correction.** A parked `HELD` signal no longer suppresses a fresh provider
  post — only an in-flight order or a live trade does. No time window was added; existence of a trade
  is the test. `"Cancel other entries"` no longer parses `entries` as an instrument. An unmapped
  signal symbol reads as absent rather than conflicting at release time. Suppressed `DUPLICATE` rows
  now surface in the review queue, dismissible but never releasable.
- **v1.64.0** — the UI slice above.
- **Telegram ingest errors are diagnosed.** All were `Telegram RPC timed out after 20000ms`, both
  providers failing in the same second, correlated with `telegram.session.stalled`. Session-level, not
  per-provider. The backlog drain now makes recovery reliable.
- **Macroscope review findings applied.** Two real (collapsible wrapper broke the stylesheet contract;
  fan-out dismissal closed the whole signal), one not reachable (an account context cannot unmap a
  known instrument — verified empirically), one doc error.
- **`.macroscope/ignore.md` added** excluding the 493KB corpus fixture, which alone pushed PR #10 to
  an estimated $39.82 against a $10 limit and got that review skipped.

### Known flake, verified against a clean baseline

`AccountHeader > shows honest stale state and exposes account actions` times out under full-suite load
roughly 1 run in 5 and passes in isolation. Do not chase it and do not let it mask a real failure.

### Working discipline that keeps paying

- **Measure rendered boxes, do not judge screenshots.** Three bugs this session came from eyeballing,
  including one where the audit only ever measured a collapsible panel in its collapsed state.
- **Mutation-check every fix: revert the mechanism, the test must fail.** Two fixes this session had
  no covering test at all despite a green suite; one test I wrote needed an early return that would
  have passed without exercising anything, so it was deleted rather than shipped green.
- **Corpus tallies pin `commandType`, NOT symbols.** A parser change can shift symbol extraction
  across all 1,945 messages while the tallies stay byte-identical. Diff symbols separately — that
  check confirmed the `entries` fix improved 11 executable commands and regressed none.
- **Review the Codex diff yourself.** Every pass this session needed correction.
- **Run Fable AND Sol independently, blind to each other.** Sol at xhigh returned NO-GO on a backlog
  commit that looked green and was right.

### Useful commands

- Deploy: `bun run deploy` (backs up live DB, rsyncs, rebuilds, swaps container, verifies)
- Health: `curl -s http://192.168.0.100:18787/api/health`
- Held queue: `curl -s http://192.168.0.100:18787/api/queue-items/held`
- Accounts + EA versions: `curl -s http://192.168.0.100:18787/api/mt5/accounts`
- KAL VIP messages: `curl -s "http://192.168.0.100:18787/api/providers/provider_1gfxfwd/messages?limit=10"`
- Rollback: `git checkout <sha> && bun run deploy` (pre-deploy DB backups are on the box)

---

# History below this line

## Session boundary 2026-07-26 (historical — prod has since moved to v1.60.1)

Branch `fix/vipgold-duplicate-open-prevention` @ `ef409994`, 13 commits ahead of main, PUSHED.
Production is untouched on **v1.56.2**. Nothing from this branch is deployed.
Full plan: `PLAN-evidence-gated-execution.md`. Gate: typecheck, lint, **598 tests**, build all green.

### Two things that are live risks RIGHT NOW on the production box
1. **Orphan path in prod since v1.51.0.** The EA-reconnect auto-release requeues a held pending
   order with no logical trade bound; the EA only rejects unbound *lifecycle* commands, so an OPEN
   goes through and cannot be reconciled. FIXED in this branch but NOT DEPLOYED. If you want it
   sooner, extract it as a standalone patch rather than waiting for steps 4-5.
2. **The duplicate-open and false-dedup fixes are not deployed.** Both original incidents are fixed
   on this branch (stable since v1.57.0) but prod still runs v1.56.2, so a VIP Gold "activated"
   message can still orphan, and a new order at a cancelled order's price can still be swallowed.

### Deploy prerequisites (owner action, not code)
- **Alerting is entirely unconfigured in prod**: `alertBotToken` and `alertChatId` are EMPTY and all
  `alertOn*` flags are unset, so NO alerts of any kind are sent today (guardian pauses, EA offline,
  execution failures included). Evidence holds now force alert dispatch, but they still cannot send
  without a token + chat id. Configure in Settings -> Alerting and use "Send test message".
  Owner has accepted this as a post-deploy item, not a blocker.
- Deploying this branch requires an **EA recompile + reattach** built from the final commit only.

### Where the plan stands
- Steps 1-3 COMPLETE: forward provenance capture, the pure evidence model, and the gate wired at
  `approveSignal` (default-gated, `"operator"` bypass), plus two rounds of review fixes.
- Steps 4-5 REMAINING: demote the same-symbol fallback to a suggestion everywhere, DELETE close-all
  (`isCloseAllInstruction`, the `closeAll` flag, `approveCloseAll`) since the corpus contains zero
  close-all messages, and remove ~250-300 lines of parser guard piles. Then release as v1.60.0.

### Review discipline that actually worked — keep doing this
- **Test from the real corpus, never invented strings.** 1945 real messages are committed at
  `apps/api/src/fixtures/provider-messages.ts`; the replay harness is at
  `scratchpad/replay.ts`. Nine review rounds were spent chasing phrasings the providers never send.
- **Run Sol AND Fable in parallel, independently.** In the last round each found a critical the
  other missed (Sol: release-path orphan; Fable: close-all gate escape + silent alerts).
- **Review BEFORE committing.** The last round caught a book-flattening bug pre-commit.
- Corpus command-type tallies are the inertness check: NO_SIGNAL 1411, OPEN_TRADE 348,
  MARK_TP_HIT 138, CANCEL_PENDING 29, CLOSE_TRADE 15, MOVE_SL_TO_BE 4. Any step that is not meant to
  change classification must leave these byte-identical.

### Measured ground truth (do not re-derive)
- VIP Gold `provider_15k9j3v`: structured copier blocks, 60/68 carry `#` ids, 25/26 lifecycle
  messages carry a Telegram reply id, closes arrive as reply comments, and it closes MANUALLY.
- KAL VIP `provider_1gfxfwd`: prose, ZERO order ids, only 8/160 lifecycle messages carry a reply id;
  152 embed the original signal verbatim as inline `Quoted signal:` text. Lifecycle is 138 TP-hits
  and 15 cancels; it never sends close instructions. 40% of its noise is ALSO quoted form, so the
  quote alone is never evidence — the comment must independently parse to a lifecycle command.
- Zero close-all phrasings exist in the entire corpus.


## Independent review follow-up — F1-F5 fixed locally (2026-07-26), version remains 1.59.0

- Lifecycle `closeAll` is now monotone fail-closed at `evaluateLifecycle`: a matched inline quote can no longer execute or reach provider-wide `approveCloseAll`; it returns `CLOSE_ALL_REQUIRES_OPERATOR`.
- Evidence holds default to alert-enabled, force the evidence alert path even when an older database stored `alertOnHeld=false`, and persist `heldTier` (`action-required` or `fyi`) for later quieting. Production must have the alert bot token and chat id configured before deploy or held signals remain invisible.
- Held OPEN payloads use the target account's provider risk configuration. Conflicting account verdicts demote DROP to HOLD; unbound lifecycle release remains a 409 refusal and leaves the original held card HELD.
- Real corpus command-type tallies remain byte-identical: `NO_SIGNAL 1411`, `OPEN_TRADE 348`, `MARK_TP_HIT 138`, `CANCEL_PENDING 29`, `CLOSE_TRADE 15`, `MOVE_SL_TO_BE 4`. Evidence budgets remain `provider_15k9j3v` no-resolution `24/26/18`, simulated `49/1/18`; `provider_1gfxfwd` no-resolution `290/368/1219`, simulated `395/263/1219` (EXECUTE/HOLD/DROP).
- Verification includes the full Bun gate, targeted real-corpus regressions, `git diff --check`, and mutation checks for all five fixes. No push, deploy, or EA compilation was performed.

## Step 3 open questions — ANSWERED locally (2026-07-26), independent review still pending

Both reviewers hit usage limits mid-review (reset 2:10pm SAST), so commit 9c665eab is
recorded as PENDING INDEPENDENT REVIEW. The two questions flagged in that commit message
were investigated directly and both came back clean:

1. **Can KAL chatter whose inline quote fingerprint-matches a live trade execute?** NO.
   Protection is two-factor and independent. The quote identifies WHICH trade; the comment
   must independently parse to a lifecycle command. Verified against the real corpus:
   `Comment: This one's abit riskier ...` -> NO_SIGNAL and `Comment: 120 pips if you kept
   limits` -> NO_SIGNAL, and `isLifecycleCandidate` (execution-evidence.ts) excludes
   NO_SIGNAL / OPEN_TRADE / TRADE_SETUP, so neither reaches `evaluateLifecycle` no matter how
   cleanly its quote resolves. The genuine `Comment: Tp 2 150pips` -> MARK_TP_HIT does reach it.
2. **Does account-scoped resolution silently skip the second account?** NO.
   `resolveLifecycleTarget` is invoked INSIDE the per-target-account loop (app.ts:3627, and
   again at :4059), so each linked account resolves its own trade through its own
   `trade_origins` row. The `trade_origins.account_id = ?` filter is correct by design; a
   two-account fan-out resolves both accounts independently.

Still outstanding for the reviewers when limits reset: whether the gate is genuinely the only
path to queue insertion/lease (requeue, auto-release, guardian unpause, manual push, retry,
EA-offline release, the lifecycle path at :3887), and whether any genuine instruction can now
be LOST rather than held — the risk direction that inverted with this commit.


Updated: 2026-07-26 (v1.59.0 evidence-gated execution step 3 safety follow-up)

## Evidence-gated execution step 3 (unreleased; version held at 1.59.0)

- `approveSignal` is gated by default for automatic ingestion and accepts an explicit `operator` bypass for manual approval. The queue requeue path remains operator-controlled.
- VIP Gold uses structured copier-new plus novel provider order IDs; KAL VIP uses complete prose geometry. Forwarded signals hold, provider order IDs are checked provider-wide across durable origins, and inline quotes require an exact same-provider fingerprint mapped through `trade_origins` to exactly one active trade.
- Holds create `EVIDENCE_*` queue records, preserve same-symbol lifecycle candidates as suggestions, alert operators, and audit the verdict. Drops create ignored records and a distinct evidence-drop audit, including first-week close/cancel/delete vocabulary marking.
- Ingestion now disposes `NO_SIGNAL` and `TRADE_SETUP` through the evidence layer: ordinary noise is audited `IGNORED` without alerts, while risk-off close/cancel/delete vocabulary is held and alerted. Step 4 resolution tightening/close-all deletion and step 5 parser guard deletions were not changed.
- Identity-less held OPEN releases now route through scoped operator approval, materializing a logical trade and `trade_origins` row before PENDING delivery. The EA_OFFLINE reconnect auto-release orphan path was pre-existing since v1.51.0 and is now closed. Evidence-held lifecycle releases require an explicitly selected ACTIVE `logicalTradeId`, then enrich from that trade and bind broker targets; missing or inactive selections stay HELD/409.
- Real corpus API tests now exercise reply-link and inline-quote resolution, release/reconciliation, reconnect release, and NO_SIGNAL disposal. Pure evidence budgets updated for the risk-off hold rule: no-resolution floor `provider_15k9j3v` `24/26/18`, `provider_1gfxfwd` `290/368/1219`; simulated-resolution `49/1/18` and `395/263/1219` respectively (EXECUTE/HOLD/DROP). Command-type tallies remain byte-identical.
- Command-type tallies remain byte-identical: `NO_SIGNAL 1411`, `OPEN_TRADE 348`, `MARK_TP_HIT 138`, `CANCEL_PENDING 29`, `CLOSE_TRADE 15`, `MOVE_SL_TO_BE 4`. Version release metadata remains deferred to 1.60.0.

## v1.59.0 evidence corpus budget (2026-07-26)

- Replaced provider-shape test probes with 14 verbatim real provider messages from the committed 1,945-message corpus. The two original compact incident repros and reviewer-only states without real equivalents remain explicitly labelled synthetic in `apps/api/src/execution-evidence.test.ts`.
- The pure `evaluateExecutionEvidence` corpus budgets are recorded separately:
  - No-resolution floor: `provider_15k9j3v` EXECUTE 24, HOLD 26, DROP 18; `provider_1gfxfwd` EXECUTE 290, HOLD 368, DROP 1219.
  - Simulated-resolution expected (reply id -> `reply-link`; `Quoted signal:` -> `inline-quote`, one active trade): `provider_15k9j3v` EXECUTE 49, HOLD 1, DROP 18; `provider_1gfxfwd` EXECUTE 395, HOLD 263, DROP 1219.
- Real API corpus tests also drive `resolveLifecycleTarget` for reply-link and inline-quote fingerprints; the pure simulated budget remains a verdict-count control, not resolution proof.
- `inline-quote` is first-class hard evidence only for an exact single-provider origin fingerprint mapping to exactly one active trade; unmatched or ambiguous resolution holds and never falls back to same-symbol matching.
- These budgets are evidence-module counts only; the corpus command-type replay remains byte-identical to its pre-change baseline. No runtime version, deployment, or push changed.

## Evidence-gated execution steps 1-2 (unreleased; no version bump)

- Captured Telegram forward provenance (`forwarded_from` JSON metadata and `forward_date`) through the GramJS adapter and every raw-message INSERT path, with idempotent in-code columns and null ordinary-message values.
- Added parser evidence facts only (`structuralKind` and `demotionMarkers`) and the unwired pure `evaluateExecutionEvidence` module with adversarial and provider-shape tests. No approval gate, close-all change, parser guard deletion, or MT5 contract change landed.
- Remaining sequence: step 4 resolution/close-all tightening, step 5 parser guard deletion and corpus harness, then operator UX and v1.60.0 release metadata.

## v1.59.0 — structure-first classification

- Structural lifecycle evidence wins before prose guards; reply-only Telegram comments hydrate from the stored provider message so `Closed ✅` resolves deterministically.
- Present-tense close-all instructions and past-tense ALL-quantified close reports (for example, `All positions closed ✅`) fan out one CLOSE_TRADE per active provider trade across enabled linked accounts, with `signal.close-all` audit evidence, fan-out counts, alerts, and reconciliation holds for missing tickets.
- OPENED/LIVE activation comments stay lifecycle context while complete LIVE-branded entries remain opens; runner-preserving provider closes verify the configured remainder and queue its SL strategy.
- EA and the runnable flatten model hold PERCENT closes with `targetRemainingVolume <= 0`; non-VIRTUAL_TP lifecycle holds/requeues strip runner payloads.
- **Recompile and reattach `mt5/TelegramTC_EA.mq5`; build the EA binary from the final 1.59.0 source before enabling live execution. Nothing was pushed or deployed.**

## v1.58.1 — close-safety follow-up

- Provider close detection is structural: `{ CLOSED }`, `CLOSED - <SYMBOL>`, standalone `CLOSED`, explicit partial-sounding close wording, trade-context close wording, and provider IDs close fully; casual prose is held for review.
- Activation detection handles symbol-between-side/order and status-first forms, removes `ALREADY` as a historical veto, keeps historical recap lines safe, and does not mistake `GOLD BUY LIMIT ... LIVE` for an activation.
- EA partial slices below broker minimum/step return zero and remain retryable; only the runner close caller falls back to a full close. Successful runner closes exclude their marked remnant from incomplete-flatten counting and report `EXECUTED` with `remainingVolume`.
- Close payloads apply the current runner only when the persisted logical trade execution mode is `VIRTUAL_TP`; legacy `SPLIT_ORDER` trades close fully.
- **Recompile and reattach `mt5/TelegramTC_EA.mq5`; build the EA binary from the final 1.58.1 source before enabling live execution. Nothing was pushed or deployed.**

## v1.58.0 — simplifying close semantics

- Provider CLOSED prose always produces `CLOSE_TRADE`, including partial-sounding amounts and TP wording; only TP-leg allocation or explicit operator/manual commands produce `CLOSE_PARTIAL`.
- `CLOSE_TRADE` closes the full position unless the provider runner is enabled and the non-runner slice meets broker minimum/step; otherwise it closes fully, including 0.01-lot positions.
- EA close idempotency now requires a confirmed fill or observed volume delta, and runner survival is reflected in the app flatten model.
- Activation, executed, opened, and live pending-order notices never open trades; historical recap lines do not suppress a complete new order.
- **Recompile and reattach `mt5/TelegramTC_EA.mq5`; build the EA binary from the final 1.58.0 source before enabling live execution. Nothing was pushed or deployed.**

## v1.57.5 — NO-GO review fixes

- Activation notices accept symbol, order, and label prefixes plus trailing order/price text; complete Entry/SL/TP new-order blocks win over leading recap prose.
- Quoted and raw CLOSED messages use one conservative classifier: TP legs, quantities, fractions, and ambiguity never become a full close; the live VIP Gold msg-547 profit percentage remains part of `CLOSE_TRADE`.
- Open-signal parameter deduplication is account-scoped; duplicate linked accounts are recorded while clean accounts continue to queue.
- The runnable partial-close model requests the EA-equivalent PERCENT, LOTS, or TP_LEG slice and marks a ticket executed only when filled volume covers the request.
- **Recompile and reattach `mt5/TelegramTC_EA.mq5`; build the EA binary from the final 1.57.5 commit. Nothing was pushed or deployed.**

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
