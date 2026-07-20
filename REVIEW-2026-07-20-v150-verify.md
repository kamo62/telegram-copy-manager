# CONFIRMED

## Critical — no-quote pending-order fail-safe is still broken

Item 7’s principal fix fails. The exact KAL-style signal was approved and leased as MARKET without a broker quote:

```text
no_quote_away_entry:
parsed.orderType = MARKET
approval.status = 200
status=WORK
commandType=OPEN_TRADE
orderType=MARKET
entryFrom=4028
```

Root cause: approval checks manual-review status before inference at [app.ts](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:3288). Inference later adds `missingFields: ["orderType"]`, but the caller converts the absent inferred type back to MARKET and never repeats the review check at [app.ts](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:3300). The MARKET command is then built at [app.ts](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:3371).

This can repeat the live incident: an intended away-from-market pending entry executes immediately.

## Low — the tree is not versioned as v1.50

Executed output:

```text
package.json:3:  "version": "1.40.0"
mt5/TelegramTC_EA.mq5:6:#property version   "1.40.0"
changelog.md:3:## 1.40.0 - 2026-07-20 (Minor)
```

The application and EA agree with each other, but this is a v1.40.0 tree, not the requested v1.50 release: [package.json](/Users/kamogelo/Code/telegram-tc/package.json:3), [TelegramTC_EA.mq5](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:6), [changelog.md](/Users/kamogelo/Code/telegram-tc/changelog.md:3).

No additional new money-path defect was confirmed beyond the failed no-quote fix.

# Verification items

## 1. Mismatched provider order ID — PASS

Executed trace:

```text
mismatched_explicit_id:
  status=UNMATCHED confidence=0.2 requiresManualReview=true

matching_explicit_id:
  status=MATCHED tradeId=trade-111 confidence=0.99 requiresManualReview=false

legacy_trade_without_recorded_id:
  status=MATCHED tradeId=legacy-trade confidence=0.92 requiresManualReview=false

incident_close_300424022:
  status=MATCHED tradeId=trade_nX8RHUbhVl confidence=0.99 requiresManualReview=false
```

A mismatched explicit ID cannot fall back to another identified trade. Matching IDs, legacy unidentified trades, and the original incident close still route correctly.

## 2. Partial market opens — PASS

Exact 0.03-requested/0.01-filled backend trace:

```text
partial_market_open:
  queuedRequestedVolume=0.03
  executionReport:
    status=PARTIAL
    requested_volume=0.03
    filled_volume=0.01
    remaining_volume=0.02
  brokerOrder:
    requested_volume=0.03
    filled_volume=0.01
  logicalTradeStatus=OPEN
  legs:
    TP1 volume=0.01 allocation=100 status=OPEN
    TP2 allocation=0 status=SKIPPED
    TP3 allocation=0 status=SKIPPED
```

Pending acceptance:

```text
pending_acceptance:
  queuedRequestedVolume=0.03
  executionReport:
    status=EXECUTED
    requested_volume=0.03
    filled_volume=0
    remaining_volume=0.03
  brokerOrder:
    requested_volume=0.03
    filled_volume=0
    position_ticket=0
    deal_ticket=0
  logicalTradeStatus=PENDING
```

The targeted backend tests passed `2 pass, 0 fail`; the EA reporting source-contract test passed `1 pass, 0 fail`.

## 3. EA version/capability handshake and migration — PASS

No-version EA, including both close and cancel:

```text
q-no-version-close:
  status=HELD held_reason=EA_CAPABILITY_UNAVAILABLE lease_count=0 has_lease=0

q-no-version-cancel:
  status=HELD held_reason=EA_CAPABILITY_UNAVAILABLE lease_count=0 has_lease=0

poll:
  status=NO_WORK
```

Observed outbound alerts:

```text
Telegram TC held queue item q-no-version-close: EA_CAPABILITY_UNAVAILABLE
Telegram TC held queue item q-no-version-cancel: EA_CAPABILITY_UNAVAILABLE
```

Capable EA:

```text
status=WORK
queueItemId=q-capable-close
commandType=CLOSE_TRADE

queue status=LEASED lease_count=1
```

Existing database with two pre-existing accounts:

```text
afterCanonicalMigrationSql:
  eaColumnsPresent=false

afterApplicationStartup:
  eaColumnsPresent=true
  mt5-live-a ea_version=null ea_capabilities_json=[]
  mt5-live-b ea_version=null ea_capabilities_json=[]
  integrity_check=ok

neverReportedExistingAccount:
  poll=status=NO_WORK
  queue.status=HELD
  held_reason=EA_CAPABILITY_UNAVAILABLE
  lease_count=0
```

The SQL file alone does not alter an existing `mt5_accounts` table; application startup’s `ensureColumn` path performs the upgrade safely, preserves both rows, and defaults them fail-closed.

## 4. Ticket-scoped split-close marker — PASS at source-contract level

Executed interruption trace, derived after verifying the relevant production-source patterns:

```text
sourceContract:
  ticket_in_marker_key=true
  retry_loop_skips_ticket_marker=true
  success_marks_same_ticket=true

firstAttempt:
  ticket=184237971 action=CLOSE
  [crash]

retry:
  ticket=184237971 action=SKIP_ALREADY_EXECUTED
  ticket=184237972 action=CLOSE
  ticket=184237973 action=CLOSE
```

The completed ticket is not reclosed; untouched tickets remain actionable. The EA source-contract test also passed.

## 5. Curly apostrophe normalization — PASS

```text
ASCII "don't miss":
  commandType=NO_SIGNAL
  matchedPatternIds=[noise.deferred-or-negated]
  reviewRequired=true

Typographic "don’t miss":
  commandType=NO_SIGNAL
  matchedPatternIds=[noise.deferred-or-negated]
  reviewRequired=true

Both genuine signals with SL 4010 / TP 4040:
  commandType=OPEN_TRADE
  direction=BUY
  stopLoss=4010
  takeProfits=[4040]
  reviewRequired=false
```

## 6. Quoted-block isolation — PASS

```text
"I will be back on Monday":
  commandType=NO_SIGNAL
  matchedPatternIds=[quote.reply-context, noise.no-signal]
  reviewRequired=true

<EMPTY>:
  commandType=NO_SIGNAL
  matchedPatternIds=[quote.reply-context, noise.no-signal]
  reviewRequired=true

"Put this back on":
  commandType=OPEN_TRADE
  entry.from=4023.8
  providerOrderId=300424022
  matchedPatternIds includes quote.reinstated-signal
  reviewRequired=false
```

## 7. Pending-order inference — FAIL

No-quote fail-safe fails as documented above.

The remaining subcases pass:

```text
Explicit NOW/MARKET/CMP/INSTANT:
  approval.status=200
  leased orderType=MARKET
```

```text
allowedOrderTypes=["MARKET"]:
  inferred LIMIT approval.status=422
  error="LIMIT orders are not allowed by settings"
  poll=status=NO_WORK
```

```text
allowedOrderTypes=["LIMIT","STOP"]:
  approval.status=200
  status=WORK
  orderType=LIMIT
  entryFrom=4028
```

# SUSPECTED

No new suspected financial defect.

I could not run the MQL inside an actual MetaTrader terminal. Item 4 therefore has an executed source-contract test and concrete retry trace, but not a real terminal-crash reproduction. Item 2 likewise executes the complete backend report/persistence path and verifies the EA source contract, not a live broker partial fill.

# Checks and repository state

```text
bun run typecheck → PASS
bun run lint      → PASS
targeted core     → 6 pass, 0 fail
targeted API      → 2 pass, 0 fail
targeted EA       → 1 pass, 0 fail
isolated suite-order test → 1 pass, 0 fail
```

The full test command reached all 482 tests: `445 pass, 37 fail`. The sandbox blocked temp-directory creation with `EPERM`; the sole visible non-EPERM suite-order failure passed in isolation. Build was not rerun because it writes artifacts during this review-only task.

Git status exactly matches the starting baseline. No files or probe artifacts were created or modified.

# Final verdict

1. **Is this tree safe to deploy to the live accounts? NO.** The no-quote KAL-style signal still becomes a leased MARKET order, and the tree is labeled v1.40.0 rather than v1.50.

2. **Is the backend safe to deploy before the EA is recompiled? NO.** The capability guard correctly prevents legacy EAs from leasing lane-2 close/cancel work, but the backend still contains the confirmed no-quote MARKET exposure path.

The matcher change does close today’s operational gap where a provider cancel could not find a PENDING trade. However, with the legacy EA attached, the capability guard will deliberately hold that cancel until the recompiled EA reports `lane2-close-contract`.

Codex session ID: 019f7f33-98f4-7dc1-8fbf-51da118a69dc
Resume in Codex: codex resume 019f7f33-98f4-7dc1-8fbf-51da118a69dc
