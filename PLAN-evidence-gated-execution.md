# Plan: evidence-gated execution (target v1.60.0)

Agreed way forward after nine review rounds on `fix/vipgold-duplicate-open-prevention`.
Sources: Fable's plan (grounded in 30 days of live traffic), the 1945-message corpus replay,
and the owner's decisions. Sol's planning run crashed without output; Sol reviews the
implementation instead.

## Why

Nine rounds, ~25 findings, every one in natural-language classification, zero in the execution
layer. The parser cannot decide execute-vs-drop from surface text because identical surface forms
carry opposite meanings depending on context it cannot see. Moving the safety boundary means a
misread costs a click instead of money.

## Ground truth (measured, not assumed)

Corpus: 1945 messages all-time (KAL VIP 1877 / VIP Gold 68); Fable additionally sampled 30 days
(KAL 766 over 25 active days, VIP Gold 202 over 18).

- **Zero close-all phrasings in 1945 messages.** Neither provider has ever sent "close all",
  "closing all positions", "flatten", "all out".
- **VIP Gold sends zero standalone `{ CLOSED }` blocks in 30 days.** Its closes arrive as reply
  comments quoting the NEW ORDER; 25/26 lifecycle messages carry a reply id. Reply-link evidence
  covers that measured path. VIP Gold closes manually (broker sources: expert 8, manual 5,
  app-close 2, manual-mobile 1), so this path is the most important in the system.
- **KAL VIP does not ride the reply path.** Only 8/160 lifecycle messages carry a reply id; the
  other 152 use inline `Quoted signal: <verbatim original signal>\n\nComment: ...` text, including
  TP-hit and cancel messages. The provider carries **zero** `#` order ids. Broker close sources:
  sl-hit 12, tp-hit 3 — TP/SL are broker-managed, so TP-hit messages are bookkeeping, not commands.
- **40% of KAL noise (555/1393) is also `Quoted signal:` form** — the provider quotes its own
  signals while chatting, so the quote alone is not evidence.
- Current false-positive baseline at HEAD: 11/1945 (0.57%) noise-labelled messages produce an
  executable command; ~3 are genuinely dangerous.

## The model

Gate at `approveSignal` (`apps/api/src/app.ts:3419`), after signal/source/account load and before
command-type branching. Single choke point for both auto-ingest (`:2630`) and manual (`:685`).
Add `options.trigger: "ingest" | "operator"`; gated unless `"operator"`. Default gated, so future
callers are safe by default. Three verdicts: **EXECUTE / HOLD(tier, reason) / DROP (audited)**.

Parser keeps extraction only and gains an `evidence` block on `ParsedSignal` (facts, no verdicts):
`structuralKind: "copier-new" | "copier-closed" | "none"`, `providerOrderId`, `closeAll`,
`demotionMarkers[]`.

**Opens** (per-provider `openEvidence` config):
- `structured-id` (VIP Gold): copier-new block + full geometry + provider order id never seen for
  this provider in **any** status (widen `hasDuplicateProviderOrderId` `:10756` from account+active
  to provider-wide any-status, including `trade_origins`). This reverts the v1.57.1 "terminal trades
  do not block reposts" call: a re-seen id is an echo and holds; a genuine repost costs one click.
- `prose-complete` (KAL VIP): complete entry+SL+TP geometry, no activation vocabulary, no demotion
  markers, not forwarded, existing mapping/naked/expiry checks. This preserves KAL's ~11 opens/day.

**Lifecycle** (both providers), only via `resolveLifecycleTarget` (`:2303`):
- `provider-order-id` resolving to exactly one active trade -> EXECUTE.
- `reply-link` MATCHED to exactly one active trade -> EXECUTE. ("Active" = OPEN|PENDING|PLANNED per
  `:2320`, so cancel-pending works.)
- `inline-quote` is first-class hard evidence when the quoted block's `raw_messages.fingerprint`
  matches exactly one origin for the same provider, and that origin maps through `trade_origins` to
  exactly one active trade. No origin match, multiple origin matches, or zero/multiple active trades
  -> HOLD with a distinct reason; never degrade to the same-symbol guess.
- Everything else HOLDS: AMBIGUOUS, UNMATCHED, and the same-symbol fallback
  `matchLifecycleCommandToTrade` (`:3879`) becomes a *suggestion on the held card*, never an
  execution authorization. Delete the AMBIGUOUS->MATCHED close-all promotion (`:3851-3871`).
- `MARK_TP_HIT` stays auto when id/reply-resolved; `recordProviderTpHit` (`:11092`) is bookkeeping
  only, no broker command.

**Demotion rule (monotone).** Negation, education/example, recap and forwarded markers demote
EXECUTE -> HOLD. They may never promote and never drop. This is the piece the orchestrator kept
implementing backwards: structure alone must not override "Do NOT enter this yet".

**Close-all: DELETE.** Zero traffic in 1945 messages and the largest blast radius in the system.
Remove `isCloseAllInstruction`, the `closeAll` flag and `approveCloseAll` (`:4072`) rather than
maintaining a held fan-out preview for a feature neither provider uses. (Fable proposed hold; the
owner and orchestrator prefer deletion. An id-scoped multi-trade close of a single signal's ladder
is NOT close-all and keeps working.)

## Provenance

`telegram.ts:384-404` captures text, reply id, quoted text, sender but not the forward header.
Capture `message.fwdFrom` presence + peer/name + date into `raw_messages.forwarded_from` /
`forward_date` (additive, same pattern as `reply_to_message_id`). Forwarded messages never EXECUTE.
Needed because a forwarded copier block from another channel carries an id novel to us, which
order-id novelty alone cannot catch.

## Deletions (a smaller parser is the goal, not a side effect)

`packages/core/src/index.ts`: the `isProviderClosedStatus` subject-veto pile (`:1315-1352`) incl.
closed-above/below (`:1329`), REGISTRATION|MARKET|SESSION (`:1332`), the CANDLE/DAILY spanning veto
(`:1333` — this one currently causes a **silent drop** of a genuine `{ CLOSED }`), market-closed
pre-strips (`:1317-1318`); repurpose `isDeferredOrNegatedInstruction` (`:1504`) and
`isEducationOrAnalysisOnly` (`:1511`) as demotion markers (their regexes can shrink since
over-matching is now cheap); collapse `classifyQuotedNewOrderStatus` (`:1375-1431`) to candidate
labelling; drop the LIVE-branded counter-exceptions (`:1231`). `apps/api/src/app.ts`: close-all
promotion (`:3851-3871`), auto fallback (`:3879`), `approveCloseAll` (`:4072`).
Expect ~250-300 lines out of core and about a third of the 1.58/1.59 parser tests rewritten from
execute/drop to execute/hold/drop.

## Regression harness (orchestrator addition)

Make the 1945-message corpus a permanent harness with a measured budget, replacing adversarial
synthetic probing as the primary control. Store the corpus (redacted if needed) plus
`scratchpad/replay.ts`, assert: zero executes on noise-labelled messages except the known-correct
set; all 138 MARK_TP_HIT and 9 CANCEL_PENDING still resolve; VIP Gold's reply-comment closes all
resolve. The current pure evidence test records both the no-resolution floor and a simulated-
resolution expected budget: reply ids resolve via `reply-link`, and KAL `Quoted signal:` messages
resolve via `inline-quote` to one active trade. Track false-positive/false-negative counts as
numbers that must not regress.

## Operator load

~2-3 action-tier holds/day (KAL 1-2, VIP 0-1) plus 3-6 FYI. Two tiers: action-required (lifecycle
candidate while the provider book is non-flat) raises the high-priority alert; FYI raises none.
Held card shows the original message, the suggested match with why-held, price drift (`:4524-4527`),
one-click Execute/Dismiss. Unactioned action-tier close candidates re-alert while the book stays
open. FYI holds auto-expire when the book goes flat.

## Sequencing

1. Provenance capture (telegram.ts fwdFrom, migration, adapter test). Independent; ships first so
   data accrues.
2. Pure `evaluateExecutionEvidence` module + unit tests (the six broken probes, both original
   incidents, real VIP/KAL shapes). No wiring.
3. Gate wiring in `approveSignal` (trigger option, `EVIDENCE_*` hold reasons, alerts; ingest loop
   `:2624-2628` must stop silently skipping review-required items).
4. Resolution tightening: fallback -> suggestion, close-all promotion removed, close-all deleted.
5. Parser deletions + demotion markers + drop-audit; rerun the corpus harness; rewrite assertions in
   the same commit.
6. Operator UX (tiers, escalation, one-click release).
7. v1.60.0 version/changelog/HANDOFF. No EA change expected this round — verify no contract drift so
   no recompile is needed.

Full gate green at every commit. Steps 2-4 are the safety boundary; 5 is deletion under an already
safe gate; 6 can trail.

## Top risks

- A genuine risk-off close sitting in a hold while the market moves. Bounded: the dominant real
  close shapes auto-execute via reply/id. Residual is KAL top-level close prose (~1.2/day), where
  click latency is accepted and escalating alerts are the control.
- Silent drops are the one remaining non-click failure. Mitigate with a first-week drop-audit event
  logging every dropped message containing CLOS/CANCEL/DELETE vocabulary.
- Test-flip churn masking behaviour change: flip assertions in the same commit as the mechanism, and
  mutation-check the evidence module.

## Still outstanding from v1.59.0 review (not re-planned, must be re-verified)

Runner remnant verification, EA PERCENT `targetRemainingVolume <= 0`, VIRTUAL_TP filters on
hold/requeue paths — implemented per HANDOFF, to be re-verified in review.
