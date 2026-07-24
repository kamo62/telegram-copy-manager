# Implementation brief — prevent duplicate-open orphans from provider "activated" messages (2026-07-24)

Branch: `fix/vipgold-duplicate-open-prevention` (off main @ v1.56.2). This is the MOST trade-safety-critical
change in the system. Full incident write-up is in the memory note and below. Reviewer is sol at HIGH effort.

## The incident (reproduce it first as a fixture)
Provider VIP Signals (Gold) `provider_15k9j3v`, order `# 306947863`, on 2026-07-24. Three messages:
- msg 545 (NEW): `NEW ORDER - XAUUSD Sell Stop 📉  # 306947863  ----------{ NEW }---------- Entry: 4051.30 [Lots: 0.01] SL: 4057.30 TP: 4039.30` → correctly parsed as an entry; placed one pending per account.
- msg 546 (ACTIVATED): `Quoted signal: NEW ORDER - XAUUSD Sell Stop 📉 # 306947863 ...{ NEW }... Entry: 4051.30 SL: 4057.30 TP: 4039.30 --- Comment: 🚀 Sell Stop activated 🚀 # 306947863 XAUUSD @ 4051.30` → **MISCLASSIFIED as a new entry**, spawned a DUPLICATE open per account. The duplicate parse also DROPPED the entry price (payload `orderType=STOP, entry=undefined`).
- msg 547 (CLOSED): `... Comment: 🟢 CLOSED - XAUUSD Sell 🟢 # 306947863 ...{ CLOSED }... Profit: 2.21$` → close correlated only to the msg-545 trades.

Outcome: on FTMO (`mt5-1514065673`, XAUUSD) the malformed duplicate OPEN was rejected (retcode 10015 invalid price) leaving an OUT_OF_SYNC phantom; on HF Markets (`mt5-54945785`, XAUUSDb) the duplicate pending was accepted (retcode 10009), FILLED into an orphan position (6798965900) that the CLOSE never covered, and the operator had to close it manually. Note there is ALREADY a `lifecycle.activation` pattern + passing test at `packages/core/src/parser.test.ts:1150`, but it only covers the BUY-stop format; the live SELL-stop-with-trailing-`XAUUSD @ <price>` format fell through to entry parsing.

## Guiding principle
Do NOT rely on the parser being perfect or on the broker rejecting bad orders (FTMO rejected, HF did not).
Enforce broker-agnostic execution invariants so a misread message can never become an unmanaged position.
Anything uncertain/malformed/duplicate must be HELD for review, never silently sent and never silently dropped.

## Scope (implement #1-#4 + #6; #5 is a noted follow-up, do NOT build it here)

### 1. Classification: "activated"/status messages are lifecycle, never entries
Broaden the existing `lifecycle.activation` pattern (find it near the VIP Gold lifecycle patterns in
`packages/core/src/index.ts`/parser) so it robustly matches ALL activation variants: Buy/Sell, with or
without the `🚀`/`📉`/`📈` emojis, and with or without a trailing `XAUUSD @ <price>` line after
`… activated … # <id>`. A quoted-`NEW ORDER … { NEW }` message whose Comment contains `activated` (or
`deleted`/`closed`/`modified`) must classify as lifecycle context and must NOT queue a new open. Extend the
existing `parser.test.ts:1150` describe block with the EXACT live msg-546 sell text as a fixture.

### 2. Idempotency by provider order id (broker-agnostic safety net) — MUST FIX BOTH DIRECTIONS
Even if a message is misread or re-sent, never OPEN a second position for a provider order id already held.
Extract the provider order id (`# <n>`) and persist it on the logical trade (and/or via `trade_origins`).
Before queueing an OPEN for `(provider, account, orderId)`, if an active PENDING/OPEN trade already exists
for that SAME order id, SUPPRESS the duplicate and HOLD it for review with a clear reason
(e.g. `DUPLICATE_ORDER_ID`), do not send it.

CRITICAL — the CURRENT dedup is a PRICE/PARAMETER dedup (`OPEN_SIGNAL_DEDUP_SECONDS` 24h) and it produced a
SECOND live incident (2026-07-24): a genuinely NEW Buy Stop #307138907 (entry 4141.10) was dropped as a
DUPLICATE because an EARLIER, already-CANCELLED Buy Stop at the same price (#306307354) was within the
window. It never reached HFM or FTMO. So the fix MUST work BOTH directions:
- SAME order id + an ACTIVE (pending/open) trade already exists  -> suppress (prevents the orphan).
- DIFFERENT order id (even identical price/direction/SL)          -> SEND IT (must not be suppressed).
- Prior matching trade is TERMINAL (cancelled/closed/archived)    -> never suppresses a new order.
Replace/subordinate the price-parameter dedup so a distinct provider order id is never swallowed and a
terminal prior order never blocks a new one. Add tests for both the false-positive (new order id at a
repeated price after a cancel -> SENT) and the true duplicate (same order id, active -> HELD).

### 3. Naked-order guard: never send an order missing required geometry
The duplicate went out as a STOP with `entry=undefined`. Validate the execution payload before it reaches
the EA: a PENDING (STOP/LIMIT) order with no valid entry price, or a MARKET order without a valid current
quote, must be HELD for review, never sent. Make correctness independent of broker leniency. This is the
"naked orders" trade-safety item.

### 4. CLOSE covers every position for the order id
When a provider lifecycle CLOSE arrives, close EVERY open app position tied to that provider order id (via
`trade_origins` / the persisted order id), not just the originating trade. Use/extend
`matchLifecycleCommandToTrade` (`packages/core/src/lifecycle.ts`). If any position for the order id is still
open when a CLOSE is processed, it must be queued for close (or held for review if it cannot be matched to a
live broker ticket) — never left orphaned.

### 6. Lock it with regression fixtures/tests
Add an end-to-end fixture from the three real messages (545/546/547) asserting: NEW → one pending per
account; ACTIVATED → NO new open queued (classified lifecycle) AND, independently, idempotency would suppress
a duplicate open for the same order id; a naked STOP with no entry is HELD not sent; CLOSE → every open
position for `#306947863` is closed. Keep all existing safety tests green.

## SAFETY constraints (hard)
- No change may cause a real signal to silently EXECUTE or silently SKIP. Uncertain/duplicate/malformed →
  HELD for review with a clear reason, surfaced to the operator.
- Do not weaken any existing held-for-review / lifecycle / resilience test.
- Guardian, queue, reconnect, and reporting behavior otherwise unchanged.
- Gate green: `bun run typecheck && bun run lint && bun test && bun run build`.
- Version bump MINOR to 1.57.0; align `mt5/TelegramTC_EA.mq5` metadata (EA payload contract unchanged);
  changelog + HANDOFF entries. Branch only; do NOT push or deploy.

## Final report
List files changed per item, tests added, gate numbers, and an explicit paragraph confirming that a
misclassified/duplicate/naked order now results in HELD-for-review (never a silent send or silent drop) and
that a provider CLOSE now flattens every position for the order id.
