## 1. VERDICT

**NO-SHIP — (a)–(f) pass, but `inferPendingOrderType` is not fully production-safe: a 145-minute-old quote snapshot is treated as live and can still approve the KAL signal as MARKET.**

## 2. EXECUTED VERIFICATION

All probes used fresh in-memory databases and the real `createApi` parse → approve → `/poll-line` path. No repository files were created or modified.

### (a) Original failing case now holds — PASS

Account snapshot contained EURUSD quotes but omitted XAUUSD.

```text
a_other_quotes_missing_gold
parsed.commandType=OPEN_TRADE, parsed.orderType=MARKET, entryFrom=4028, brokerSymbol=XAUUSD
approval.status=422, approval.body={"error":"Signal needs GPT extraction or operator confirmation before queueing for mt5-777: Gold -> XAUUSD -> XAUUSD (missing-orderType)"}
poll=status=NO_WORK, commandType=<absent>, orderType=<absent>, entryFrom=<absent>
```

The pre-inference approval bypass is fixed: inference now precedes review and allowed-type validation at [apps/api/src/app.ts:3288](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:3288).

### (b) No over-correction with zero quote data — PASS

With no snapshot/quote data at all, the same KAL signal retains the previous MARKET behavior.

```text
b_no_quote_data
parsed.commandType=OPEN_TRADE, parsed.orderType=MARKET, entryFrom=4028, brokerSymbol=XAUUSD
approval.status=200, approval.body={"queueItemId":"queue_ZNoby1Ba-W","logicalTradeId":"trade_7ZCFpGA_gi","queueItems":["queue_ZNoby1Ba-W"],"logicalTradeIds":["trade_7ZCFpGA_gi"],"status":"PENDING"}
poll=status=WORK, commandType=OPEN_TRADE, orderType=MARKET, entryFrom=4028
```

A representative existing API test that approves and leases without a snapshot also passed:

```text
bun test v1.3.10 (30e609e0)

 1 pass
 177 filtered out
 0 fail
 8 expect() calls
Ran 1 test across 1 file. [261.00ms]
```

The current suite exercises genuine no-snapshot approval behavior, although it has no named permanent regression test for this exact KAL message.

### (c) Live quote inference and near-market tolerance — PASS

Away from a live ~4020 quote:

```text
c_far_live_quote
parsed.commandType=OPEN_TRADE, parsed.orderType=MARKET, entryFrom=4028, brokerSymbol=XAUUSD
approval.status=200, approval.body={"queueItemId":"queue_ZDpbjDKSfJ","logicalTradeId":"trade_Fzgmc8n8am","queueItems":["queue_ZDpbjDKSfJ"],"logicalTradeIds":["trade_Fzgmc8n8am"],"status":"PENDING"}
poll=status=WORK, commandType=OPEN_TRADE, orderType=LIMIT, entryFrom=4028
```

Inside tolerance, using a genuinely parsed 4020–4020.2 entry zone:

```text
c_near_live_quote_corrected
parsed.commandType=OPEN_TRADE, parsed.orderType=MARKET, entryFrom=4020, entryTo=4020.2, brokerSymbol=XAUUSD
approval.status=200, approval.body={"queueItemId":"queue_JrBcIX4k0o","logicalTradeId":"trade_SyLL-7SGKq","queueItems":["queue_JrBcIX4k0o"],"logicalTradeIds":["trade_SyLL-7SGKq"],"status":"PENDING"}
poll=status=WORK, commandType=OPEN_TRADE, orderType=MARKET, entryFrom=4020, entryTo=4020.2
```

### (d) Explicit market intent preserved — PASS

```text
d_explicit_market_now
parsed.commandType=OPEN_TRADE, parsed.orderType=MARKET, entryFrom=4020, brokerSymbol=XAUUSD
approval.status=200, approval.body={"queueItemId":"queue_0_HNRxi5wl","logicalTradeId":"trade_-OOL6Dt3gQ","queueItems":["queue_0_HNRxi5wl"],"logicalTradeIds":["trade_-OOL6Dt3gQ"],"status":"PENDING"}
poll=status=WORK, commandType=OPEN_TRADE, orderType=MARKET, entryFrom=4020
```

### (e) `allowedOrderTypes` uses the inferred type — PASS

`allowed=["MARKET"]` rejects the inferred LIMIT:

```text
e_market_only_rejects_inferred_limit
parsed.commandType=OPEN_TRADE, parsed.orderType=MARKET, entryFrom=4028, brokerSymbol=XAUUSD
approval.status=422, approval.body={"error":"LIMIT orders are not allowed by settings"}
poll=status=NO_WORK, commandType=<absent>, orderType=<absent>, entryFrom=<absent>
```

`allowed=["LIMIT","STOP"]` accepts it:

```text
e_pending_only_accepts_inferred_limit
parsed.commandType=OPEN_TRADE, parsed.orderType=MARKET, entryFrom=4028, brokerSymbol=XAUUSD
approval.status=200, approval.body={"queueItemId":"queue_XAM3WGamTw","logicalTradeId":"trade_u9Dqs_cJPu","queueItems":["queue_XAM3WGamTw"],"logicalTradeIds":["trade_u9Dqs_cJPu"],"status":"PENDING"}
poll=status=WORK, commandType=OPEN_TRADE, orderType=LIMIT, entryFrom=4028
```

### (f) Explicit LIMIT/STOP untouched — PASS

Both types passed unchanged with no quote data:

```text
f_explicit_limit_none
parsed.commandType=OPEN_TRADE, parsed.orderType=LIMIT, entryFrom=4010, brokerSymbol=XAUUSD
approval.status=200, approval.body={"queueItemId":"queue_uG0GFpjXKs","logicalTradeId":"trade_q9A6M6gI0b","queueItems":["queue_uG0GFpjXKs"],"logicalTradeIds":["trade_q9A6M6gI0b"],"status":"PENDING"}
poll=status=WORK, commandType=OPEN_TRADE, orderType=LIMIT, entryFrom=4010
f_explicit_stop_none
parsed.commandType=OPEN_TRADE, parsed.orderType=STOP, entryFrom=4010, brokerSymbol=XAUUSD
approval.status=200, approval.body={"queueItemId":"queue_en5ZyxcuE9","logicalTradeId":"trade_PDQXw_ooCq","queueItems":["queue_en5ZyxcuE9"],"logicalTradeIds":["trade_PDQXw_ooCq"],"status":"PENDING"}
poll=status=WORK, commandType=OPEN_TRADE, orderType=STOP, entryFrom=4010
```

With quotes for another symbol but not XAUUSD:

```text
f_explicit_limit_other
parsed.commandType=OPEN_TRADE, parsed.orderType=LIMIT, entryFrom=4010, brokerSymbol=XAUUSD
approval.status=200, approval.body={"queueItemId":"queue_nBa8zUrHEu","logicalTradeId":"trade_Dd0BQQm4Ip","queueItems":["queue_nBa8zUrHEu"],"logicalTradeIds":["trade_Dd0BQQm4Ip"],"status":"PENDING"}
poll=status=WORK, commandType=OPEN_TRADE, orderType=LIMIT, entryFrom=4010
f_explicit_stop_other
parsed.commandType=OPEN_TRADE, parsed.orderType=STOP, entryFrom=4010, brokerSymbol=XAUUSD
approval.status=200, approval.body={"queueItemId":"queue_FjQMKSjbQ1","logicalTradeId":"trade_lyILeXpSq3","queueItems":["queue_FjQMKSjbQ1"],"logicalTradeIds":["trade_lyILeXpSq3"],"status":"PENDING"}
poll=status=WORK, commandType=OPEN_TRADE, orderType=STOP, entryFrom=4010
```

With an XAUUSD quote:

```text
f_explicit_limit_gold
parsed.commandType=OPEN_TRADE, parsed.orderType=LIMIT, entryFrom=4010, brokerSymbol=XAUUSD
approval.status=200, approval.body={"queueItemId":"queue_-wei0GTNl1","logicalTradeId":"trade_l5x7QVueJ_","queueItems":["queue_-wei0GTNl1"],"logicalTradeIds":["trade_l5x7QVueJ_"],"status":"PENDING"}
poll=status=WORK, commandType=OPEN_TRADE, orderType=LIMIT, entryFrom=4010
f_explicit_stop_gold
parsed.commandType=OPEN_TRADE, parsed.orderType=STOP, entryFrom=4010, brokerSymbol=XAUUSD
approval.status=200, approval.body={"queueItemId":"queue_YXbvOJxyIL","logicalTradeId":"trade_Zg9OLYxNJT","queueItems":["queue_YXbvOJxyIL"],"logicalTradeIds":["trade_Zg9OLYxNJT"],"status":"PENDING"}
poll=status=WORK, commandType=OPEN_TRADE, orderType=STOP, entryFrom=4010
```

## 3. HEARTBEAT STALENESS ASSESSMENT

### Stored status never ages out

`heartbeat_status` is written as `"online"` during registration and heartbeat processing at [apps/api/src/app.ts:4164](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4164) and [apps/api/src/app.ts:4241](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4241). There is no offline update or aging job.

The account API ignores that stored column and derives freshness from `last_heartbeat_at`: online ≤10 seconds, stale ≤30 seconds, otherwise offline at [apps/api/src/app.ts:5758](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:5758) and [apps/api/src/app.ts:11732](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:11732).

### Dashboard becomes internally inconsistent

Executed 145-minute staleness probe:

```text
heartbeat_staleness_queue_probe
dashboard.immediate=online, dashboard.after_145m=offline, lastHeartbeatAt=2026-07-20T11:35:52.953Z
performance.after_145m heartbeatStatus=online, currentBalance=1000, currentEquity=1000, currentProfit=0
queue.before_reconnect status=PENDING, heldReason=<none>
poll.on_reconnect status=WORK, commandType=OPEN_TRADE, orderType=MARKET, queueItemId=queue_grsjBP_AhZ
queue.after_poll status=LEASED, leaseCount=0
```

The account row correctly aged to offline, but `accountPerformance` remained online with stale balance/equity because its cache is keyed only to store revision, not time: [apps/api/src/app.ts:8339](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:8339). A silent account does not mutate the store, so repeated dashboard requests can reuse the online projection.

The visible client refreshes every 60 seconds while SSE is healthy at [apps/web/src/App.tsx:800](/Users/kamogelo/Code/telegram-tc/apps/web/src/App.tsx:800), but that does not invalidate the server cache. Account cards use the freshly computed account status at [AccountRow.tsx:18](/Users/kamogelo/Code/telegram-tc/apps/web/src/components/AccountRow.tsx:18); performance/header surfaces can consume the cached performance status at [App.tsx:1041](/Users/kamogelo/Code/telegram-tc/apps/web/src/App.tsx:1041).

### Virtual TP evaluation stops

Virtual TP evaluation only runs when `/api/mt5/snapshot` is received at [apps/api/src/app.ts:4718](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4718). Missing positions, tickets, quotes, or price cause it to skip at [apps/api/src/app.ts:4830](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4830).

Therefore, a silent EA means:

- No early virtual TP closes are detected.
- A price crossing and reverting during the outage is permanently missed.
- On reconnect, only the then-current snapshot is evaluated.

The final actionable TP is installed broker-side when no runner is enabled, reducing but not eliminating exposure; runner mode has no broker TP backstop at [TelegramTC_EA.mq5:347](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:347).

### Routing and quote inference do not check heartbeat freshness

Enabled provider links determine routing without any heartbeat predicate at [apps/api/src/app.ts:5863](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:5863). Silent linked accounts continue receiving queue items.

More seriously, `latestQuote` reads only `symbols_json`; it does not read or validate the snapshot’s `updated_at` at [apps/api/src/app.ts:4768](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4768).

Executed stale-away quote probe:

```text
stale_snapshot_inference_probe
dashboard.heartbeatStatus=offline, snapshot.quote=XAUUSD bid=4019.8 ask=4020.2, simulatedAgeMinutes=145
parsed.orderType=MARKET, entryFrom=4028
approval.status=200, approval.body={"queueItemId":"queue_-OUyKS2pbF","logicalTradeId":"trade_8suJD4CPRu","queueItems":["queue_-OUyKS2pbF"],"logicalTradeIds":["trade_8suJD4CPRu"],"status":"PENDING"}
poll=status=WORK, orderType=LIMIT, entryFrom=4028
```

Executed dangerous stale-near quote probe:

```text
stale_near_quote_market_probe
dashboard.heartbeatStatus=offline, staleSnapshotMid=4028.0, simulatedAgeMinutes=145
approval.status=200, approval.body={"queueItemId":"queue_EyYY6CUGEJ","logicalTradeId":"trade_k0_Dc_X0Wo","queueItems":["queue_EyYY6CUGEJ"],"logicalTradeIds":["trade_k0_Dc_X0Wo"],"status":"PENDING"}
poll=status=WORK, commandType=OPEN_TRADE, orderType=MARKET, entryFrom=4028
```

This is the deploy blocker: an account can be offline while an old 4028 quote causes the KAL 4028 entry to remain MARKET. If the real market moved away during those 145 minutes, the original incident class remains possible on reconnect.

### Guardian becomes stale

Balance/equity drawdown is refreshed only by register/heartbeat calls at [apps/api/src/app.ts:4208](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4208) and [apps/api/src/app.ts:4257](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4257). While silent:

- The stored drawdown does not change.
- A previously unpaused guardian does not detect new losses.
- Polling blocks opens only when the stored guardian is already paused; heartbeat freshness is not checked at [apps/api/src/app.ts:4324](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4324).
- Manual unpause is correctly rejected once the heartbeat exceeds 30 seconds at [apps/api/src/app.ts:4619](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4619).

Executed targeted guardian test:

```text
bun test v1.3.10 (30e609e0)

 1 pass
 177 filtered out
 0 fail
 2 expect() calls
Ran 1 test across 1 file. [244.00ms]
```

### Queue/reconnect behavior

A queued open remains PENDING while the EA is silent and is leased immediately when `/poll-line` resumes, as the 145-minute probe demonstrated.

The default `maxOpenTradeAgeSeconds` is `0`, disabling expiry at [apps/api/src/app.ts:185](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:185). If an operator configures a positive maximum age, polling checks and holds expired work before leasing at [apps/api/src/app.ts:4390](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4390).

On reconnect, the EA sends heartbeat → snapshot → polls work at [TelegramTC_EA.mq5:104](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:104). Execution itself obtains a fresh terminal tick and pending orders are revalidated against current bid/ask at [TelegramTC_EA.mq5:289](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:289) and [TelegramTC_EA.mq5:1219](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:1219). Thus it does not fill using the snapshot price directly—but a stale snapshot can already have selected MARKET versus LIMIT/STOP, after which a MARKET order uses the current reconnect price.

**Financial risk: HIGH.** Existing positions lose early virtual-TP and fresh guardian protection; new work accumulates and can execute late; stale snapshots can preserve MARKET intent incorrectly. Broker SL/final-TP protection and fresh-tick execution prevent a Critical ranking, but this tree is not safe for real-money deployment.

## 4. SUSPECTED (unverified)

- The exact live rows for `mt5-54945785` and `mt5-3049603` were not independently accessible. Read-only queries against the three local databases returned no matching rows:

```text
DB=data/runtime-check.db
DB=data/telegram-tc.db
DB=data/telegram-live.db
```

- Actual MetaTrader reconnect and broker execution were not run in a terminal. The server queue behavior and MQL execution path were verified, but not a live order.


Codex session ID: 019f7f49-9310-7c01-8e9e-b0a2d4f5f1f2
Resume in Codex: codex resume 019f7f49-9310-7c01-8e9e-b0a2d4f5f1f2
