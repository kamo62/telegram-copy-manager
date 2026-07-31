## Verdict

**NO-SHIP for unattended real-money trading.** I confirmed 21 new defects or unsafe design paths in the current worktree. The first ten can directly create, retain, over-close, or misroute broker exposure.

I excluded every issue named in the request. No files were modified.

## Confirmed findings

1. **Critical — Closing a pending trade leaves the broker order live but marks the logical trade closed.**

   Evidence: the intended rule correctly says close-on-`PENDING` means cancel at [app.ts:1272](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:1272), but it is used only for shadow logging at [app.ts:2295](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:2295). Production queues the original close command at [app.ts:3463](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:3463). The EA searches positions, finds none, and reports failure at [TelegramTC_EA.mq5:724](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:724). “No matching position” is treated as successful terminal state at [app.ts:9814](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:9814) and [app.ts:10580](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:10580).

   Scenario: a provider closes an untriggered Buy Stop. The logical trade becomes closed, but the pending order remains and later activates into an unmanaged position.

   Fix: apply lifecycle action-state routing in production; translate close-on-pending to `CANCEL_PENDING`, cancel every associated order ticket, and terminalize only after broker confirmation.

2. **Critical — SPLIT_ORDER has no safe per-leg execution contract.**

   Evidence: lifecycle routing chooses one latest ticket at [app.ts:9946](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:9946); EA collectors short-circuit to that ticket at [TelegramTC_EA.mq5:814](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:814) and [TelegramTC_EA.mq5:838](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:838). One successful close then closes the entire logical trade at [app.ts:9886](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:9886). Opens also emit several reports with one queue ID at [TelegramTC_EA.mq5:397](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:397), while every report overwrites the parent status at [app.ts:4557](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4557).

   Scenario: three split positions exist; “close trade” closes one, after which the app says the entire trade is closed. Alternatively, legs 1 and 3 open while leg 2 rejects; whichever report arrives last determines the parent state.

   Impact: live broker legs become invisible or logically failed, and later close/SL/trailing commands miss them.

   Fix: create per-ticket child queue items and reports, aggregate the parent only after all children reach verified terminal states.

3. **Critical — Broker partial fills are recorded as complete fills.**

   Evidence: `TRADE_RETCODE_DONE_PARTIAL` counts as success at [TelegramTC_EA.mq5:1389](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:1389). Close reports send `request.volume`, not `result.volume`, at [TelegramTC_EA.mq5:794](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:794). The backend records that as filled volume at [app.ts:9932](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:9932) and terminalizes full closes at [app.ts:9886](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:9886).

   Scenario: an IOC close requests 0.03 lot but fills 0.01. The app records 0.03 and marks the trade closed while 0.02 remains exposed.

   Fix: report requested, actual filled, and remaining volume separately; represent `PARTIAL` explicitly and keep the trade live until cumulative broker evidence covers the requested action.

4. **Critical — A lost execution report replays non-idempotent partial closes.**

   Evidence: `/report` is posted only once at [TelegramTC_EA.mq5:1399](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:1399), while stale lifecycle leases return to `PENDING` at [app.ts:4228](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4228). Percentage closes are recalculated from the current remaining volume at [TelegramTC_EA.mq5:748](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:748).

   Scenario: 50% of 0.04 closes successfully, but the report request never reaches the backend. Retry closes 50% of the remaining 0.02, then possibly repeats again. Fixed-lot or TP-leg retries can flatten the full remainder.

   Fix: treat lifecycle delivery as unknown, reconcile snapshot/history before replay, and use a durable broker-side idempotency key plus an absolute target remaining volume.

5. **Critical — Ordinary or negated prose can open, close, or move stops automatically.**

   Evidence: any qualifying message beginning `BUY`/`SELL` is treated as an open at [index.ts:1241](/Users/kamogelo/Code/telegram-tc/packages/core/src/index.ts:1241); any message beginning `CLOSE` is a close at [index.ts:1231](/Users/kamogelo/Code/telegram-tc/packages/core/src/index.ts:1231); broad `SET … SL` prose becomes `MODIFY_SL` at [index.ts:1162](/Users/kamogelo/Code/telegram-tc/packages/core/src/index.ts:1162), with the last unrelated number used as the stop at [index.ts:1621](/Users/kamogelo/Code/telegram-tc/packages/core/src/index.ts:1621). Mapped results with defaults bypass review and are auto-approved at [app.ts:2480](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:2480).

   Direct probes returned `review=false` for:

   - `Buy Gold only after confirmation — not now.` → market `OPEN_TRADE`
   - `Close watch on Gold today; wait for NFP.` → `CLOSE_TRADE`
   - `Education only: always set your SL below structure. Gold invalidation is 4000.` → `MODIFY_SL 4000`

   Impact: banter or analysis can create a position, liquidate one, or worsen its protection.

   Fix: require bounded positive imperative grammar, add hard negation/deferral vetoes, and require SL prices to be syntactically attached to the SL instruction.

6. **Critical — Common partial-close quantities become full closes.**

   Evidence: partial detection only understands `HALF`, `PARTIAL`, TP legs, or a percentage followed by whitespace/end at [index.ts:1155](/Users/kamogelo/Code/telegram-tc/packages/core/src/index.ts:1155) and [index.ts:1682](/Users/kamogelo/Code/telegram-tc/packages/core/src/index.ts:1682). Although the EA supports `LOTS`, the parser never emits it.

   Verified results:

   - `Close Gold 50%.` → full `CLOSE_TRADE`
   - `Close Gold 25%🔥` → full `CLOSE_TRADE`
   - `Close Gold 0.01 lot` → full `CLOSE_TRADE`
   - `Close quarter Gold` → full `CLOSE_TRADE`

   Impact: a requested scale-out or runner preservation becomes complete liquidation.

   Fix: detect quantities before selecting full versus partial close; support lot units, fractions and punctuation/emoji after percentages; fail closed when close text contains an unrecognized quantity.

7. **Critical — EA volume normalization can turn a valid partial close into a full close.**

   Evidence: partial-close volume is normalized at [TelegramTC_EA.mq5:748](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:748), while normalization clamps upward to the broker minimum and hardcodes two decimals at [TelegramTC_EA.mq5:1378](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:1378).

   Scenario: closing 50% of a 0.01-lot position produces 0.005, which is clamped to 0.01 and closes everything. On a broker with 0.001 lot steps, requests can become zero or be rounded upward incorrectly.

   Fix: never minimum-clamp close volumes. Floor to the broker step, reject if the partial action cannot be represented, and derive volume precision from `SYMBOL_VOLUME_STEP`.

8. **Critical — Percentage risk sizing silently falls back to `DefaultLots`.**

   Evidence: when risk calculation returns zero, `CommandBaseVolume` falls through to `DefaultLots` at [TelegramTC_EA.mq5:1203](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:1203). Risk calculation returns zero when stop distance, tick size, or tick value is unavailable at [TelegramTC_EA.mq5:1285](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:1285). `DefaultLots` is currently 0.10 at [TelegramTC_EA.mq5:15](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:15).

   Scenario: a 1% risk order on a small ZAR account encounters a temporary zero tick value. Instead of failing, it opens 0.10 lot, with no relationship to the requested rand risk.

   Fix: fail and page whenever percentage sizing cannot be computed; never substitute fixed lots. Also reject a calculated risk lot below broker minimum rather than silently clamping it upward.

9. **Critical — NETTING accounts are accepted despite hedging-only trade semantics.**

   Evidence: registration explicitly accepts and stores `NETTING` at [app.ts:4044](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4044), and the EA reports it at [TelegramTC_EA.mq5:1434](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:1434). No execution or reconciliation branch uses `marginMode`.

   Scenario: Provider A and Provider B each buy XAUUSD on a netting account. MT5 merges them into one position. Closing A can close both providers’ combined exposure; an opposite signal can reduce or reverse an unrelated logical trade.

   Fix: fail closed for live copying on NETTING accounts until an account+symbol aggregate exposure ledger and delta-based lifecycle model exists.

10. **Critical — MT5 account and broker ticket identities are not globally safe.**

   Evidence: account identity is only `mt5-${accountNumber}` at [app.ts:4063](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4063), while server/company are merely overwritten on conflict. The EA uses the same login-only identity in snapshots and reports at [TelegramTC_EA.mq5:157](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:157) and [TelegramTC_EA.mq5:1414](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:1414). History deal and fallback ticket lookups omit `account_id` at [app.ts:4917](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4917) and [app.ts:10044](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:10044).

   Scenario: two brokers issue login 123456, or two broker servers reuse deal/position ticket 184237973. One EA can lease the other account’s queue; history from account B can update account A’s trade.

   Fix: use a backend-issued immutable account UUID plus authenticated EA credential. Treat every broker identifier as `(account_id, ticket)` in queries and constraints.

11. **High — Split Telegram signals are processed backward and can open with default risk levels.**

   Evidence: the adapter passes GramJS messages directly without chronological reordering at [telegram.ts:355](/Users/kamogelo/Code/telegram-tc/apps/api/src/telegram.ts:355). Correlation only attaches a fragment that follows an anchor in input order at [index.ts:1934](/Users/kamogelo/Code/telegram-tc/packages/core/src/index.ts:1934), and explicitly does not persist correlation across batches at [app.ts:2310](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:2310). Parser defaults are supplied at [app.ts:9004](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:9004).

   Scenario: Telegram posts `BUY GOLD`, then five seconds later `SL 2290 TP 2320`. The newest-first poll sees the fragment first; it becomes `NO_SIGNAL`, while `BUY GOLD` becomes an auto-approved market trade with global 50-pip SL and 200-pip TP.

   Fix: sort oldest-first, persist recent anchors across polls, and delay incomplete directional anchors until the correlation window expires.

12. **High — Virtual-TP legs enter an irreversible `HIT` state before broker proof.**

   Evidence: crossing a target queues a close and immediately changes the leg to `HIT` at [app.ts:4671](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4671). Future evaluation only considers `OPEN` legs at [app.ts:4657](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4657), while ordinary close failures do not restore state at [app.ts:9836](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:9836).

   The parser also treats any line beginning `TP` as a hit at [index.ts:1260](/Users/kamogelo/Code/telegram-tc/packages/core/src/index.ts:1260). A direct probe of `TP2 is next, hold runners` returned `MARK_TP_HIT`, `review=false`; the backend then persists `HIT` at [app.ts:9774](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:9774).

   Impact: a requote, invalid volume, or ordinary commentary permanently disables that app-managed exit.

   Fix: introduce `EXIT_PENDING`; reserve `HIT` for broker-confirmed fills, restore/retry failed exits, and require explicit provider completion wording such as “hit” or “done.”

13. **High — More than 50 Telegram messages after a stall silently loses the older backlog.**

   Evidence: ingestion defaults to 50 at [app.ts:2371](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:2371), fetches only that newest page at [telegram.ts:367](/Users/kamogelo/Code/telegram-tc/apps/api/src/telegram.ts:367), then advances `last_message_at` to the newest returned timestamp at [app.ts:2357](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:2357).

   Scenario: a banter-heavy channel posts 80 messages during an outage and a close is among the older 30. Recovery captures the newest 50, advances the cursor, and never requests the other 30.

   Fix: paginate from a durable message-ID cursor until exhaustion before advancing it; detect full pages and alert on backlog/gaps.

14. **High — One account without a matching trade blocks valid lifecycle work on all accounts.**

   Evidence: lifecycle matches are built for every account at [app.ts:3382](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:3382). Any one unmatched account returns 422 before any queue is inserted at [app.ts:3419](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:3419); insertion only begins at [app.ts:3463](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:3463).

   Scenario: account A has the provider’s live Gold trade; account B’s entry previously failed. A provider close matches A but not B, so A receives no close.

   Fix: produce per-account outcomes: queue A, separately hold and alert B, and return a partial-success result.

15. **High — A pending-order fill can disappear between the EA’s two snapshot reads.**

   Evidence: the EA serializes `PositionsJson()` and then `OrdersJson()` separately at [TelegramTC_EA.mq5:157](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:157). The backend cancels an older pending logical trade after one missing snapshot at [app.ts:9526](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:9526), then skips `CANCELLED` trades on future snapshots at [app.ts:9511](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:9511).

   Scenario: a pending fills after the positions scan but before the orders scan. That snapshot contains neither form, causing logical cancellation; the next snapshot contains a live position that is no longer reconciled.

   Fix: require consecutive misses plus history confirmation, attach a snapshot revision/time boundary, and re-adopt cancelled trades when a matching ticket/comment subsequently appears.

16. **High — Trailing-stop protection is memory-only and permanently exhausts its 100-slot array.**

   Evidence: state lives only in `trailingStopStates[100]` at [TelegramTC_EA.mq5:67](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:67). Restart initialization does not restore it at [TelegramTC_EA.mq5:84](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:84). Inactive slots are never reused, and capacity failure silently returns at [TelegramTC_EA.mq5:586](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:586). The backend treats an executed trailing queue as durable and suppresses resending at [app.ts:5276](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:5276).

   Scenario: MT5 restarts after a runner’s trailing command, or the EA has seen 100 lifetime tickets. The broker SL freezes while the application still believes trailing is active.

   Fix: persist/replay trailing plans or move ownership to the backend; reuse inactive slots and explicitly report capacity failure.

17. **High — App-managed SL strategy offsets use guessed pip sizes instead of account symbol metadata.**

   Evidence: SL strategy prices use `brokerPipSize()` at [app.ts:5294](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:5294), hardcoded to Gold, JPY, or `0.0001` for everything else at [app.ts:10649](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:10649). The EA’s own trailing calculation uses the broker point at [TelegramTC_EA.mq5:1303](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:1303).

   Scenario: a 10-pip break-even offset on NAS100, BTCUSD, XAGUSD, or oil becomes `0.001` instead of an instrument-appropriate distance. Normalization can make it negligible or invalid.

   Fix: derive offsets from per-account `point`/`digits` metadata or send the distance instruction and let the EA calculate it.

18. **High — Genuine lifecycle commands are swallowed by arbitrary-word symbol extraction and narrow vocabulary.**

   Evidence: the lifecycle symbol regex accepts any 6–12-letter word at [index.ts:1355](/Users/kamogelo/Code/telegram-tc/packages/core/src/index.ts:1355), before provider-default fallback at [index.ts:1369](/Users/kamogelo/Code/telegram-tc/packages/core/src/index.ts:1369). The real captured message `Close 70% profits` exists at [provider backtest:266](/Users/kamogelo/Code/telegram-tc/data/backtests/provider_lq0q4f-2026-05-10T15-01-28-194Z.json:266); `profits` becomes an unmapped symbol and the close is held.

   Direct probes also returned `NO_SIGNAL` for `Exit Gold now`, `Move stop loss to entry on Gold`, and `Set your stop to breakeven on Gold`.

   Impact: real exits and stop protection require manual discovery while positions remain exposed.

   Fix: only accept known aliases, canonical symbols, or validated FX pairs as symbols; otherwise use the provider default. Add narrowly bounded observed aliases for `exit`, `stop loss`, and `breakeven`.

19. **Medium — Auto-queueable `PARSED` rows are not durably processed.**

   Evidence: ingestion inserts parsed rows at [app.ts:9272](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:9272), then approves only the returned in-memory list at [app.ts:2446](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:2446). Later passes select only raw messages with no parsed row at [app.ts:9204](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:9204).

   Scenario: the process exits after recording a valid close as `PARSED` but before approval. It remains there permanently and is not retried.

   Fix: use a durable worker over `PARSED AND review_required=0`, with transactional/idempotent state transitions or an outbox.

20. **Medium — Snapshot-only manual closes remain permanently `OUT_OF_SYNC` when history is unavailable.**

   Evidence: a missing position becomes `OUT_OF_SYNC` at [app.ts:11895](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:11895). Snapshot reconciliation writes a synthetic manual full-close row at [app.ts:10011](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:10011), but does not terminalize the logical trade. Synthetic `manual` rows are deliberately excluded from full-close proof at [app.ts:9656](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:9656).

   Scenario: the operator manually closes in MT5 while `/history` is failing or an older EA does not report history. The logical trade stays `OUT_OF_SYNC`, contaminating later matching and completion checks.

   Fix: use a visible pending-confirmation state, then terminalize after repeated absence; allow later history to enrich the close reason and P&L.

21. **Medium — The overall dashboard reports only one of two same-currency accounts.**

   Evidence: aggregation runs only when currencies differ at [app.ts:6133](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:6133). With two ZAR accounts it selects one “primary” account at [app.ts:6138](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:6138), chosen by [app.ts:8208](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:8208).

   Scenario: account A is up R1,000 and account B is down R5,000; the overall card can show only A, concealing the actual combined loss.

   Fix: aggregate whenever `accounts.length > 1`; currency conversion should be conditional, not aggregation itself. I found no separate directional error in the USD/ZAR multiplication/division logic.

## Suspected or deployment-dependent

- **Older EA compatibility:** current registration and heartbeat payloads carry no EA version or capability flags at [app.ts:4044](/Users/kamogelo/Code/telegram-tc/apps/api/src/app.ts:4044) and [TelegramTC_EA.mq5:1434](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:1434). Historical EA source before app-owned virtual TP ran its own TP manager, so a sufficiently old compiled EA can race the backend. I could not confirm which binary is attached to either live terminal. Add a mandatory version/capability handshake and refuse incompatible work.

- **Entry zones:** `entryTo` is serialized and parsed, but execution and risk calculations use `entryFrom` at [TelegramTC_EA.mq5:402](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:402) and [TelegramTC_EA.mq5:1287](/Users/kamogelo/Code/telegram-tc/mt5/TelegramTC_EA.mq5:1287). I could not determine whether “first zone boundary only” is intentional.

- **Comma-formatted prices:** numeric extraction does not support values such as `4,023.80`; probes reduce them to the wrong number. The corpus contains comma-formatted analysis, but I did not confirm a live executable provider signal using that format.

Verification was static call-path tracing plus direct Bun parser probes against the current source and historical EA-source inspection. No test/build commands or writes were performed because this was an audit-only request.

Codex session ID: 019f7ea4-ede6-7822-b890-9cb08cf76bb5
Resume in Codex: codex resume 019f7ea4-ede6-7822-b890-9cb08cf76bb5
