# Implementation brief — structure decides, prose never executes (2026-07-26)

Branch: `fix/vipgold-duplicate-open-prevention` (HEAD d565e540, v1.58.1). Two independent reviews
returned NO-GO. This replaces the regex-guard patching that has now failed across eight rounds.

## Why the previous approach keeps failing

Every remaining defect is the same mechanism: **prose heuristics run before, and override, structural
facts.** Confirmed by live probe at HEAD:

- A structural close is VETOED by unrelated prose: `🟢 CLOSED - XAUUSD Sell 🟢 / { CLOSED } /
  Profit: 2.21$ / Dont chase it now` -> `NO_SIGNAL`. The position stays open (the orphan outcome).
- Chart commentary is PROMOTED to a close by a proximity rule: `H4 candle closed above SL, still
  holding` and `Registration closed! Entry fee is $50, DM me` -> `CLOSE_TRADE`. A live position is
  flattened by educational chatter.
- Genuine instructions are missed: `Closing all positions now` -> `NO_SIGNAL` (dead code: the
  function gates on the literal word CLOSED so the CLOSING alternatives can never fire), and
  `Closed ✅` -> `NO_SIGNAL` (emoji defeats the standalone-line pattern).

Adding a ninth guard perturbs the chain again. Change the precedence instead.

## The rule

**Structure decides. Prose never executes.**

1. If a message carries STRUCTURAL evidence, that determines the command type and no prose heuristic
   (negation, education, recap, conditional, proximity) may veto it. Structural evidence is:
   a `{ CLOSED }` / `{ NEW }` block, `CLOSED - <SYMBOL>`, a `NEW ORDER` block, a provider order id
   (`# <n>`), or a resolvable reply/quote link to a known trade.
2. If a message carries NO structural evidence, it is free text. It may be held for operator review,
   or ignored as noise. **It must never auto-execute.**

## Owner's reading of the four probe cases (the target behaviour)

| Message | Verdict | Why |
| --- | --- | --- |
| `H4 candle closed above SL, still holding` | no action | educational; the subject is the candle/price |
| `Registration closed! Entry fee is $50` | no action | commentary; not about a position |
| `Closing all positions now` | **close ALL of that provider's trades** | a provider-wide risk-off instruction (see work item 2b) |
| `Closed ✅` | **close** | a close report, resolved against the trade it replies to |

The distinguishing test is the SUBJECT, which is what a person uses: CLOSED describing a
price/candle/timeframe ("closed above/below/under/over <level>", candle/daily/weekly/H1/H4) is
commentary; CLOSED describing a POSITION/TRADE/ORDER, or a bare close report arriving as a reply to a
known order, is an instruction. Do NOT go back to fraction/percentage parsing: the AMOUNT rule stays
simple (a real close closes fully; the `runner` config is the only exception; an unsplittable
position closes fully).

## Work item 1 — hydrate quote context from the reply link (enables everything else)

`telegramParserText` (`apps/api/src/app.ts:13174`) builds the rich
`Quoted signal:\n…\n\nComment:\n…` form ONLY when Telegram supplies `quotedText`. When Telegram
supplies only `replyToMessageId` (common; quote retrieval is unreliable), the parser receives a bare
string and loses the structural link.

We already have what we need: `replyToMessageId` is captured (`apps/api/src/telegram.ts:396`) and
stored on `raw_messages.reply_to_message_id`, the original message text is in `raw_messages`, and
resolution machinery exists (`apps/api/src/app.ts:2336-2380`, including the `raw_message_aliases`
gap-free mapping).

Change: when `quotedText` is absent but `replyToMessageId` resolves to a stored raw message for the
same provider, hydrate the quoted context from our own copy before parsing, so the reply path becomes
structurally identical to the quoted path. Fall back to the bare text only when nothing resolves.

This is what makes `Closed ✅` a deterministic close of the trade it replies to, instead of an
ambiguous bare string.

## Work item 2 — reorder classification so structure wins

In `packages/core/src/index.ts` `detectCommandType` / `classifyQuotedNewOrderStatus` /
`isProviderClosedStatus`:
- Evaluate structural evidence FIRST. The prose guards (`isDeferredOrNegatedInstruction`
  ~:1171, education/analysis, conditional-setup, and the CLOSED proximity rule ~:1303) must not run
  against, or be able to veto, a structurally identified message.
- Apply the subject test above to unstructured text; commentary about price/candles is never a close.
- Fix the dead code: the gate at ~:1291 requires the literal `CLOSED`, so the `CLOSING` alternatives
  at ~:1298 can never fire. Use `/\bCLOS(?:ED|ING)\b/`.
- Normalise the line (strip emoji/punctuation) before the standalone-CLOSED test, matching what the
  activation classifier already does at ~:1198, so `Closed ✅` and `Closed 🚀🚀` are recognised.
- Pluralise the trade nouns so `All positions closed`, `Positions closed`, `Both trades closed` match.
- Accept em/en dashes in `CLOSED — XAUUSD` alongside `-`/`:`.
- Unstructured text that looks like an instruction but cannot be resolved must HOLD with an explicit
  reason, never silently drop (today a review-required NO_SIGNAL raises no alert).

## Work item 2b — "close all" is a provider-wide flatten, not a single-trade close

`Closing all positions now` is materially different from an ordinary close: it targets EVERY open
trade for that provider, across all linked accounts, not the one trade a reply resolves to. Treat it
as its own scope rather than forcing it through the single-trade matcher (which today either picks
one trade or goes AMBIGUOUS and holds).

- Recognise a bounded imperative family: CLOSE/CLOSING + ALL|EVERY|EVERYTHING +
  POSITIONS|TRADES|ORDERS, plus "flatten everything" / "close everything" / "all out". Require the
  ALL-quantifier: a bare "closing positions" is not this.
- Scope: every ACTIVE (OPEN/PENDING) logical trade for that provider on every enabled linked account.
  Emit one close command per trade so each is independently reported and reconciled, and so the
  existing runner rule applies per trade.
- This is exposure-reducing and time-critical (providers send it before news), so it executes rather
  than holding — but the blast radius is the whole provider book, so: audit it distinctly
  (e.g. `signal.close-all`), raise an operator alert, and record the fan-out count. Anything that
  cannot be matched to a live broker ticket still holds for reconciliation rather than being dropped.
- Guard against false positives: it must NOT fire on commentary ("all positions closed in profit
  this week" is a RESULT report, not an instruction) — apply the same subject/tense test, and require
  the imperative/present-progressive form.
- Regressions: `Closing all positions now` and `Close all trades` with two open trades on two
  accounts -> a close per trade; `All positions closed ✅` (past-tense report) -> not a fan-out
  flatten; provider A's instruction never touches provider B's trades.

## Work item 3 — activation vocabulary gap

`Buy Stop opened` and `Buy Stop live` after a complete order block still parse as `OPEN_TRADE`
(verified), because OPENED/LIVE are only recognised after ORDER/IS/NOW. Recognise OPENED/LIVE
unconditionally inside a quoted/post-block comment, and support symbol-before and symbol-after order
type. Keep genuine LIVE-branded ENTRIES opening (`GOLD BUY LIMIT @ 3300 - LIVE` with a full level set).

## Work item 4 — runner remnant must get its configured SL behaviour (owner requirement, currently missing)

The owner asked that a runner left open after a provider close moves its stop to break-even. The
config default is already `slBehavior: "break-even"`, but only the final-virtual-TP path queues it
(`queueRunnerManagementAfterFinalTp`, `apps/api/src/app.ts:6024`). The provider-close path
(`reconcileExecutionReport` CLOSE_TRADE EXECUTED branch, ~:11045-11069) leaves the remnant OPEN with
its ORIGINAL stop and queues nothing. Fix: after a runner-preserving EXECUTED close, queue the same
SL-strategy command against the remnant position ticket.

## Work item 5 — remaining review findings

- Runner EXECUTED must verify the remnant: count a marked runner position complete only when its
  remaining volume is within broker-step tolerance of `runner.lotSize`; otherwise report PARTIAL and
  hold. Validate the same server-side before accepting EXECUTED (`app.ts:11045`).
- Apply the VIRTUAL_TP-only runner filter inside `holdLifecycleForReconciliation` (~:3890/3944/3958)
  and strip `runner` from non-VIRTUAL_TP payloads on requeue (~:4494), not just on the direct approve
  path (~:4003).
- EA PERCENT branch (`mt5/TelegramTC_EA.mq5:972`): treat `targetRemainingVolume <= 0.0` as invalid
  (hold) rather than computing a whole-position close; align the model fallback
  (`ea-flatten-state.ts:169-172`).

## Tests — use the real quoted mechanism

The owner's point: bare strings are not what production sees. Every close/activation regression must
exercise the REAL message shape, including the quoted/reply form, not just raw text:
- the exact live 545 / 546 / 547 VIP Gold messages;
- `Closed ✅` and `Closed +40 pips` as REPLY comments under a NEW ORDER quote (via the work-item-1
  hydration), asserting they close the replied-to trade;
- `Closing all positions now` -> close;
- `H4 candle closed above SL, still holding`, `Registration closed! Entry fee is $50, DM me`,
  `GOLD closed below our entry`, `The week closed above our entry` -> no action;
- `CLOSED - XAUUSD. Don't re-enter` and the structural close followed by `Dont chase it now` -> close;
- `Buy Stop opened` / `Buy Stop live` after an order block -> no open; LIVE-branded entry -> open;
- runner: disabled -> full close; 0.02 on 0.05 -> leaves 0.02 AND queues the BE move; on 0.01 ->
  full close.
Mutation-check each.

## Gate and release

`bun run typecheck && bun run lint && bun test && bun run build` green. Bump to 1.59.0 (minor:
classification precedence and reply-context hydration change behaviour). Align
`mt5/TelegramTC_EA.mq5` metadata (a test pins `#property version` exactly), update `changelog.md`
and `HANDOFF.md`. Do not touch the ponytail comments. Branch only: do NOT push or deploy.
