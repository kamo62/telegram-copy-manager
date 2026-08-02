# Incident: VIP Gold Buy Stop #300424022 — missed provider close, margin stop-out

Trade `trade_nX8RHUbhVl` · account mt5-3049603 · provider_15k9j3v (VIP Signals (Gold))
Provider result: **+3.98 USD (+0.38%)**. Our result: **-397.38** on 0.03 lots.

## Timeline (UTC; broker rows carry a +3h server offset)

| Time | Event |
|---|---|
| 07-19 22:15:00 | Provider posts Buy Stop #300424022: entry 4023.80, SL 4017.80, **TP 4035.80**, 0.01 lots |
| 07-19 22:15:02 | Parsed OK, queued, Buy Stop placed as ticket 184237973 at **0.03 lots** (provider config `riskMode: fixed, riskAmount: 0.03`) |
| 07-20 02:48:49 | Provider: "🚀 Buy Stop activated 🚀". **Our system parses this as a brand-new OPEN_TRADE** → creates phantom `trade_c0I8FfiSOs` + `queue_BHQS9LcbAR` |
| 07-20 02:48:52 | Phantom auto-approved and **sent to MT5 as a second order**. Broker rejects it: "Invalid pending order price for current bid/ask or stop level". Trade record survives as OUT_OF_SYNC |
| 07-20 02:48:58 | Provider: "🟢 CLOSED - XAUUSD Buy 🟢 Profit: 3.98$". Parsed correctly as CLOSE_TRADE |
| 07-20 02:49:02 | **Close refused**: audit `telegram.ingest.queue-failed` — *"Multiple open logical trades match this provider command"*. Two BUY trades matched (real + phantom). No queue item created. Parsed signal left at status `PARSED` |
| 07-20 05:48:49 | Our Buy Stop fills at 4026.38 (2.58 worse than provider's 4023.80) |
| 07-20 08:03:23 | **Margin stop-out** at 4018.36 — `[so 19.92%/79.46/398.95]`, deal 183546955. −397.38, −80.2 pips |

## Root cause 1 — the missed close (this is what cost the money)

The close was parsed perfectly. It was never actioned because the lifecycle matcher found
**two** open BUY trades for this provider and refused to guess.

The second one only existed because **"Buy Stop activated" is not recognised as a lifecycle
notification**. The parser matched `quote.reply-context` + `open.direction-symbol-entry` on the
*quoted* NEW ORDER block and emitted `commandType: OPEN_TRADE` with no SL/TP of its own
(fell back to `defaultStopLoss: 60 PIPS`, `defaultTakeProfit: 200 PIPS`).

Compare the CLOSED message 9 seconds later, which correctly matched `lifecycle.provider-closed`.
So the lifecycle vocabulary covers "CLOSED" but not "activated".

**Duplicate-open exposure:** the phantom was approved and dispatched to MT5. Only the broker's
price rejection stopped us opening a second 0.03-lot position. `hasDuplicateOpenSignal` did not
catch it because the activation parse carries different parameters (no explicit SL/TP) than the
original. This is the `duplicate-open` item from the trade-safety backlog, now confirmed live.

## Root cause 2 — why no TP was on the MT5 order

By design, and it is not a parse failure. The TP **was** parsed (`4035.80`) and **was** allocated
100% with volume 0.03 in the queue payload.

`executionMode` is `VIRTUAL_TP`, which is the default everywhere
(`buildExecutionCommand`, `packages/core/src/index.ts:922`; `apps/api/src/app.ts:3073`).
In that mode the EA deliberately sends no take profit to the broker:

```mq5
// mt5/TelegramTC_EA.mq5:342
double rawTp = command.executionMode == "SPLIT_ORDER" ? command.tp[0] : 0.0;
```

So the order sits at the broker with **SL only**, and the TP is supposed to be enforced
server-side by `evaluateVirtualTakeProfits` (`apps/api/src/app.ts:4480`), which only considers
trades with `status === "OPEN"` and a matched live position.

Consequence: if the server misses the exit (as it did here), there is **no broker-side safety net**.
Price never reached 4035.80 in any case — the provider took ~+4 points manually at ~4027.8 — so the
virtual TP was never going to fire. The manual close was the only exit, and we dropped it.

## Root cause 3 — why it was a stop-out rather than an SL exit

We traded **0.03 lots against the provider's 0.01** (fixed `riskAmount: 0.03`) on an account with
~R390 balance. Margin level hit 19.92% and the broker liquidated at 4018.36, marginally *before*
SL 4017.80. Loss was ~the same as an SL exit would have been, but the mechanism is margin, not SL —
and at this size any adverse move risks liquidating unrelated positions too.

## The "1 TP → 100%" request

Real bug, worth fixing, but **it is not what caused this loss** — VIP Gold's config is already a
single leg at 100%, and the queue payload confirms `allocationPercent: 100`.

Where it does bite is `applyProviderExecutionConfig` (`apps/api/src/app.ts:11384`):

```ts
const takeProfits = signal.takeProfits
  .filter((target) => configuredLegs.has(target.leg))
  .map((target, index) => {
    const level = levelsByLeg.get(target.leg) ?? config.takeProfitLevels[index];
    return { ...target, allocationPercent: level?.percentage ?? target.allocationPercent, ... };
```

Two defects:

1. **Under-allocation.** KAL VIP is configured 50/0/0/50. A signal carrying only TP1 gets
   `allocationPercent: 50` — the other 50% of the position has no target at all and rides to SL.
   The requested fix (single parsed TP ⇒ force 100%) is correct.
2. **Silent leg drops.** `configuredLegs.has(target.leg)` discards any signal leg the provider
   config doesn't define. VIP Gold defines leg 1 only, so a 3-TP signal from them loses TP2 and TP3
   with no warning.

Adjacent, seen in live data (`queue_JzVIMPsJ2-`): `splitVolumeByCent` gave legs `0.01 / 0.01 / 0.00`
on a 0.02 total — **leg 3 has volume 0 and can never close anything**.

## Current state — live risk right now

- **Account balance is down to R77.98** (equity 77.98), from ~R387 before this trade.
- **The paired Sell Stop is still live**: `trade_tA9HjZcsVn`, ticket 184237974, XAUUSD 3959.60,
  **0.03 lots**, status PENDING. If it triggers on a R78 account it is an immediate margin event.
- **The phantom trade is still open**: `trade_c0I8FfiSOs` (OUT_OF_SYNC, VIP Gold). It will make
  **the next VIP Gold close ambiguous in exactly the same way** — the bug is armed to repeat.
  A second phantom, `trade_Gx5NSniX13` (KAL VIP, OUT_OF_SYNC), is sitting there too.
- **The Equity Guardian is effectively disabled**: `threshold: 10000`, `current_drawdown: 0`,
  `paused: 0`. It did not and cannot fire at that setting.

## Recommended fix order

1. Teach the parser that "Buy Stop activated" / "Sell Stop activated" is a lifecycle activation,
   not a new entry. Highest value: it removes both the phantom trade and the duplicate-open risk.
2. Make close-matching prefer `providerOrderId` (all three messages carry `# 300424022`) before
   falling back to open-trade ambiguity, and never let an OUT_OF_SYNC/failed trade block a close.
3. Alert loudly when a lifecycle command is dropped. `telegram.ingest.queue-failed` was a `warn`
   in the audit log that nobody saw for 5 hours; a dropped close should page.
4. Single parsed TP ⇒ 100% allocation; stop silently dropping unconfigured legs; forbid zero-volume
   legs.
5. Revisit VIRTUAL_TP as the blanket default, or attach a broker-side TP as a backstop.
6. Review sizing: 0.03 fixed lots on this account is what turned a missed exit into a stop-out.

---

# Follow-on defects found live, 2026-07-20 (same day, after the above)

## A. Market-vs-limit: signals without an order-type keyword fire at market

Provider message (KAL VIP, 08:39):

```
Gold sell

4028-29

Sl 4034

Tp 4023
Tp 4016
Tp 4010
```

Parsed as `OPEN_TRADE SELL **MARKET**`, entry `{from: 4028, to: 4029}` (`parse_QxvwMpttBb`).
Because the text lacked the literal word "limit", the parser defaulted to MARKET and the EA filled
immediately at **4023.8** (`trade_HAHZJzrm7I`, ticket 6796761352) — 4-5 points worse than intended.
It closed at TP1 for **+R13.17**; entering at 4028 as intended would have been roughly R70 better.

The 08:09 message said "Gold buy limit" explicitly, which is the only reason it rested correctly.

Fix: when a signal carries an explicit entry price/zone away from current market and no order-type
keyword, infer the pending type from direction vs price — sell above market = SELL LIMIT, sell below
= SELL STOP, buy below = BUY LIMIT, buy above = BUY STOP. Never fire at market with an explicit
away-from-market entry. If market data is unavailable to compare, hold for review rather than
guessing MARKET.

## B. Quote coverage gates virtual TP silently

`evaluateVirtualTakeProfits` does `if (!quote) continue`. Quotes come from the EA's
`SymbolsTotal(true)` — MarketWatch-selected symbols ONLY. Live counts: Trive **4** symbols
(XAUUSD.raw, AUDCHF.raw, WS30, USDZAR.raw), HF **11**. Any trade on a symbol outside MarketWatch
gets placed and then has **no take-profit management at all**, with no alert. Gold is in both
watchlists, which is the only reason this has not bitten yet.
(`availableSymbols` for mapping is complete — 387 for HF — so the mapping list is NOT the limited one.)

Fix: ensure symbols with open/pending trades are quoted (select them in MarketWatch EA-side), and
alert when a managed trade's symbol has no quote.

## C. The unmapped-symbol alert is wrong three ways

`providerSymbolsNeedingMapping()` scans the last 300 parsed signals with **no status filter**:
1. Dismissing/ignoring a signal does nothing — the alert recomputes and returns. Confirmed live:
   `/api/signals/parse_h1NEXDk_z4/ignore` returned `IGNORED` and the banner was unchanged.
2. It counts **broker** symbols from manual force-pushes as unmapped provider symbols — pushing a
   trade with `brokerSymbol: XAUUSDb` added "XAUUSDb" to the alert.
3. It counts parser false positives ("technically", from conversational prose).

## D. Affix inference from a single symbol (fixed live by hand, code fix pending)

Saving a `XAUUSD → XAUUSDb` override made the server infer a global `suffix: "b"` for the HF account.
Exactly 1 of its 387 symbols ends in "b"; every major is plain. That suffix would have routed
EURUSD/GBPUSD/etc. to nonexistent symbols. Corrected the live row manually; inference still needs fixing.

## E. Symbol picker: uncontrolled select resets to the first option

`SymbolMappingModal.tsx` — the broker-symbol `<select>` is uncontrolled and shows the first option
(`EUBUND.F`) as checked rather than a placeholder. A dashboard refresh re-renders and the value snaps
back to the first entry, so scrolling 387 entries toward `XAUUSDb` gets interrupted. Needs a
searchable/filterable picker with retained state, not just a longer list.

## F. Trive cannot trade at its configured size

`queue_rTN5siq7Cv` failed with retcode **10019 "No money"** — 0.02 lots on a R77.98 balance. Every
KAL VIP signal will fail on that account until it is funded or resized.

## Confirmed working

The broker-side TP backstop functions: `trade_HAHZJzrm7I` closed with broker comment `[tp 4023.00]`,
i.e. the EA set a real take profit and the broker executed it. Under the previous VIRTUAL_TP-only
behaviour that position would have had no TP at all.
