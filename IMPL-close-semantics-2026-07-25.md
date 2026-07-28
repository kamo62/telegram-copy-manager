# Implementation brief — close semantics: read it like a person (2026-07-25)

Branch: `fix/vipgold-duplicate-open-prevention` (HEAD d1f755bf, v1.57.5). Replaces the
prose-ambiguity approach that failed three consecutive review rounds.

## The decision (from the owner)

Stop trying to infer a close AMOUNT from provider prose. Read the message the way a person does:

> A provider close message means the provider is out of the trade. A person copying it closes
> their position. The only reason to leave anything open is a deliberate **runner** configured
> on the provider.

Concretely:
1. **Default: a close message closes the trade completely.**
2. **The only exception is the provider's `runner` flag.** If `runner.enabled`, close everything
   except `runner.lotSize` and leave that running under its configured SL behaviour.
3. **If the volume cannot support leaving a runner, close fully.** On a 0.01 lot position there is
   nothing to split, so "close half" means close it. Never a no-op.

Why this is the safe direction: erring toward closing REDUCES exposure. The incident that started
this work was exposure left OPEN (an orphan). Under-closing is the dangerous failure; over-closing
is not. The previous design had it backwards, and at v1.57.5 a `CLOSED 100%` on a 0.01 position
closed nothing at all (`NormalizeCloseVolume` returns 0.0 when the request covers the whole
position), recreating the orphan.

## Work item 1 — collapse the CLOSED prose classifier (packages/core/src/index.ts)

Delete the partial-vs-full ambiguity machinery added across v1.57.4/v1.57.5: the tri-state CLOSED
classifier, the qualifier veto lists (HALF / PARTIAL / percent / fractions / MOST / SOME / RUNNER /
KEEPING / …), and amount extraction from close prose.

Replace with: any provider message stating the trade is closed -> `CLOSE_TRADE`. This includes all
of the phrasings that have churned through review — `CLOSED - XAUUSD Sell`, `{ CLOSED }`,
`Closed half`, `closed 50%`, `Closed 25 percent`, `Closed 1/2`, `Closed most positions`,
`Partially closed at TP1`, `Position fully CLOSED`. They all mean the provider is out; we close.

Keep these DISTINCT lifecycle events, which already exist and are not close-amount parsing:
- `MARK_TP_HIT` for a TP-leg hit ("Tp 1 ✅", "TP1 hit"),
- `CANCEL_PENDING` for a deleted/cancelled pending order,
- activation notices -> no open (work item 3).

Do NOT let prose like "market closed, order not filled" close a live trade: that is not a statement
that the provider's position closed. Keep a narrow guard for non-trade uses of the word (market
closed / session closed / closed for the day) -> no action. That is a small, bounded list about the
WORD, not about amounts.

`CLOSE_PARTIAL` should now only originate from mechanisms that carry a real amount (TP-leg
allocations, an explicit operator/manual partial), never from inferring a fraction out of prose.

## Work item 2 — runner-aware close (apps/api + mt5 EA)

`CLOSE_TRADE` execution must consult the provider's runner config
(`runner: { enabled, lotSize, slBehavior, trailPips }`, already on the provider config and already
used for TP allocation at `packages/core/src/index.ts:2028`):
- `runner.enabled === false` (default) -> close the entire position.
- `runner.enabled === true` -> close `remainingVolume - runner.lotSize`, leave the runner open with
  its configured SL behaviour.
- If `remainingVolume - runner.lotSize` is below the broker minimum lot / volume step, or
  `remainingVolume <= runner.lotSize`, -> **close the entire position**. Never emit a request the
  broker will reject and never leave a silent no-op.

In the EA, a close whose computed volume covers the whole remaining position must execute as a FULL
close, not a rejected partial. `NormalizeCloseVolume` currently returns 0.0 in exactly that case
(`mt5/TelegramTC_EA.mq5` ~:1638), which is the silent-no-op bug; a whole-covering close must fall
through to the full-close path. Also require confirmed filled volume (or an observed volume delta)
before marking a slice executed (`~:1010`).

Update `apps/api/src/ea-flatten-state.ts` so the model mirrors this: whole-covering close -> full
close; runner-enabled close -> leaves exactly the runner lot; sub-minimum residual -> full close.

## Work item 3 — activation must never open (still outstanding from review)

Independent of the close work, and still broken at HEAD. Confirmed current outputs:
- a COMPLETE order block followed by `Comment:\nXAUUSD Buy Stop activated\n# id\nXAUUSD @ price`
  -> `OPEN_TRADE` (must be lifecycle/no-open). This is the original incident shape; the live msg 546
  is safe today ONLY because it carries a `Quoted signal:` prefix, which is absent when Telegram
  quote retrieval fails (`apps/api/src/app.ts` ~:13144).
- `XAUUSD Buy Stop executed\n# 1\nEntry: …\nSL: …\nTP: …` -> `OPEN_TRADE` (vocabulary gap).
- a genuine shorthand new order PRECEDED by `BUY STOP FILLED yesterday` -> wrongly `NO_SIGNAL`.
Decide from message STRUCTURE, not substring presence: a status line that sits after the order block
(or in a `Comment:` section) is lifecycle; a historical recap preceding a complete new instruction
must not suppress it. Extend vocabulary to EXECUTED / OPENED / LIVE alongside
ACTIVATED / TRIGGERED / FILLED.

## Regressions required

Every phrasing above, both directions, plus these must-not-regress cases:
- the exact live msg-547 close (with its `Profit: 0.21%` line) -> `CLOSE_TRADE`;
- `XAUUSD Buy Stop activated #306947863 @4051.30` and `Order filled: Buy Stop XAUUSD @4051.30`
  -> no open;
- a genuine entry containing a `BUY STOP FILLED yesterday` recap line -> `OPEN_TRADE`;
- runner disabled -> full close; runner enabled with room -> leaves exactly the runner lot;
  runner enabled without room, and 0.01 minimum lot -> full close, never a no-op.
Mutation-check each new test.

## Gate and release

`bun run typecheck && bun run lint && bun test && bun run build` green. Bump to 1.58.0 (minor: this
changes close semantics). Align `mt5/TelegramTC_EA.mq5` metadata (a test pins `#property version`
exactly), update `changelog.md` and `HANDOFF.md`, noting the EA recompile requirement. Do not touch
the ponytail comments. Branch only: do NOT push or deploy.
