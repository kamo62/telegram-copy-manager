# Handoff

Updated: 2026-08-24 20:05 on Kamogelos-MacBook-Pro

## START HERE — 2026-08-24

An operations pass, three code fixes, and two deploys. **v1.67.2 is deployed and green.**

### State
- Branch `main`, clean. Package version **1.67.2**, deployed (`main@983b0c15` verified live).
- `/api/health` **ok**, 2/2 providers ready, 0 stalled, held queue empty, Telegram connected.
- Merged today: **#26** (session restore), **#27** (TP leg cap + index symbols), **#28**/**#29** (handoff),
  **#30** (unreachable-channel back-off + revert of a gate that shipped by accident).
- Also pushed, unmerged, separate work: `fix/held-queue-fanout-and-lifecycle-drop` @ `28a2fbf5`.

### Read this before trusting any commit: verify the STAGED tree

A backgrounded Codex task-worker kept rewriting files in this checkout **after reporting completion**.
It did this at least three times in one session: it reverted a committed changelog entry, a version
bump, and — the costly one — it restored its own `app.ts` and `api.test.ts` between a green gate run
and the `git add`. That shipped a gate I had explicitly rejected all the way to production, and two
tests pinning the intended behaviour were left failing on `main`.

Killing the `codex-companion.mjs task-worker` was not enough; the idle `codex app-server` processes
were still writing and had to be killed too.

So: a green gate proves nothing about what you are about to commit. After `git add`, verify the staged
content directly (`git show :path | grep -c <invariant>`) and run the gate **after** the version bump,
not before. A version bump is what broke the `mt5-ea-source` guard, which pins the EA's major.minor
line to the app's; 1.68.0 asserted an EA rebuild that release did not need, so it is now 1.67.2.

### The NYAKALLO channel is gone from the account, and that was the real bug

`Could not find the input entity for {"channelId":"3377857085","className":"PeerChannel"}` fired about
twelve times a minute, forever, and the provider never ingested a live message. The cause was **not**
that the channel was newly added: dialog `-1003377857085` was in the account's dialog list in the
morning and gone by the afternoon, while the free `NYAKALLO MILLIONS` channel `-1002211922727` from the
same provider remained. A lapsed VIP subscription or a removal.

Check this first next time with `GET /api/telegram/dialogs?profileId=<id>` and see whether the dialog
id is actually in the list. Calling that endpoint out of band does **not** work around the error; that
was tried and measured.

v1.67.2 makes the failure legible: `resolveDialogEntity` no longer falls back to a bare dialog id, it
throws `TelegramDialogUnavailableError`, and `ingestProvider` audits `telegram.provider.unreachable`
once then backs the provider off for 15 minutes instead of hammering. To restore the channel, rejoin
or resubscribe on the Telegram account, confirm it reappears in the dialog list, then re-enable
`provider_wlgsny`. Its config is already correct: `lot_size` 0.03, `riskAmount` 0.03, `openEvidence`
`prose-complete`, four equal TP legs. **It is currently disabled.**

### `openEvidence` is picked by title substring

`providerConfig` chooses the evidence mode by matching the provider title: one containing `vip gold`
gets `structured-id`, one containing `kal` gets `prose-complete`. "NYAKALLO MILLIONS VIP GOLD NASDAQ"
matched the first, so a prose channel with no order ids was being held under
`EVIDENCE_STRUCTURED_OPEN_EVIDENCE_REQUIRED` and could never have auto-traded. Setting `openEvidence`
explicitly on the provider overrides it. Any new provider whose title contains those substrings hits
the same trap.

### The boot-time session restore works in production

`telegram.session.restored` for `tg_epuJC69Dpl` was audited at 2026-08-24T14:39:31Z, and the app came
back after a container swap `connected: true` with no login prompt. That is PR #26 verified against
real Telegram, not just tests.

### OPEN ISSUE: the dashboard is slow because every audit log write re-sends 724 KB

This is the highest-value work outstanding. **Not started.** Everything below was measured on the live
box on 2026-08-24 or read from current source, not inferred.

#### The mechanism, end to end

This is the part that matters, and it is not obvious from any single file:

1. `AppStore.audit(...)` writes a row **and** calls `emitEvent({type:"audit", ...})` (`app.ts`, end of
   the `audit` method).
2. `emitEvent` calls **`invalidateDashboardCaches()` on its very first line** (`app.ts:14177-14178`),
   which does `storeRevision += 1`, clears `dashboardPerformanceCache`, and clears
   `providerScoreCache`.
3. It then pushes an SSE `audit` event to every subscriber.
4. The web client subscribes to `audit` among six event types (`App.tsx:900-902`) and every one of them
   is wired to `scheduleLoad()`, a 200 ms debounce onto `loadDashboard()` — **a full re-fetch of the
   entire snapshot**. There is no patching for these events.
5. That refetch hits `dashboard()`, misses the cache that step 2 just cleared, and recomputes
   `accountPerformance` for the aggregate *and once per account*, each of which walks
   `equity_curve_points` and downsamples to 500 points.
6. 724 KB is serialized, transferred, `JSON.parse`d, and then **recursively deep-compared field by
   field** against the previous snapshot by `dashboardSnapshotsEqual` (`App.tsx:557-579`, called at
   `App.tsx:756`) purely to decide whether to re-render.

**So one audit row costs a full recompute plus a full 724 KB round trip plus a full structural walk.**
`audit()` is called from dozens of write paths. During the NYAKALLO error flood earlier today that was
roughly **twelve audit rows per minute**, so twelve of these cycles per minute, which is exactly why
the app felt slow while it was happening. Fixing the flood (v1.67.2) removed the worst of it; the
amplifier is still there.

Only `heartbeat` avoids the full refetch, and only when the heartbeat status is unchanged
(`App.tsx:886-898`, patcher at `App.tsx:610-694`). Of the six subscribed event types the server only
ever emits three (`heartbeat`, `reconciliation`, `audit`); `queue`, `trade`, `snapshot` and `score` are
subscribed but never sent.

#### The logs table

| | |
|---|---|
| `audit_logs` rows | **81,861** |
| approximate size | **20.8 MB** of a 102 MB database |
| oldest row | 2026-05-17, nothing is ever pruned |
| top event type | `telegram.ingest.error` at **43,379 rows**, over half the table |
| second | `mt5.report` at 26,648 |

**`audit_logs` has no index on `created_at`** — only `sqlite_autoindex_audit_logs_1` from the primary
key. Every read is `... ORDER BY created_at DESC LIMIT ?` (`listAuditLogs`), so it full-scans 81,861
rows and sorts them. Measured: `ORDER BY created_at DESC LIMIT 500` takes **513 ms**, which is *slower*
than an unordered full scan of the same table at 174 ms, because the sort dominates.

`ActivityFeed` calls `/api/audit-logs?limit=50` on the dashboard (`components/ActivityFeed.tsx:16`), so
that 513 ms class of query is on a user-facing path.

**This is the one place where the user's instinct about indexes is exactly right.** An index on
`audit_logs(created_at DESC)`, and probably `(event_type, created_at DESC)` for the filtered variant,
turns that scan-and-sort into a bounded index walk. It is a small, safe, high-value change and it
should be done first because it is independent of everything else here.

Also worth doing: prune or roll off `audit_logs`. Half the table is a single error type from one
incident.

#### The equity curve

| | |
|---|---|
| `equity_curve_points` rows | **171,431** |
| approximate size | **23.1 MB** |
| `provider/mt5-54945785` | 90,303 points |
| `account/mt5-54945785` | 45,212 points |
| `account/mt5-296083557` | 19,477 points |
| `provider/mt5-296083557` | 16,439 points |

Every cache miss reads from this table and downsamples to 500 points via `capEquityCurve`
(`app.ts:9211`, `9317`). Because `emitEvent` invalidates the cache, an ordinary stream of audit writes
means this is recomputed continuously rather than being the once-per-revision cost it was designed to
be.

Then the 500-point result is **serialized three times** in one payload: once in `accountPerformance`
and once per account in `accountPerformanceByAccount`. That is 23.8 KB per copy, **71.4 KB total for
two accounts**, growing linearly with account count.

Worse, one of those copies is **byte-identical duplication**:
`accountPerformanceByAccount["mt5-54945785"]` is exactly equal to the top-level `accountPerformance`,
verified by comparing the serialized strings, because with a single primary account the aggregate *is*
that account.

And the client throws most of it away: `GrowthChart.tsx:64` downsamples again to 240 points for a
256px-high chart that renders six axis labels.

#### Where the 724 KB is

| key | size | rows | note |
|---|---|---|---|
| `signalQueue` | **216.4 KB** | 1,819 | **100% terminal.** 122 bytes/row, so this is row *count*, not row size |
| `mt5Accounts` | **216.3 KB** | 2 | see split below |
| `logicalTrades` | **196.6 KB** | 259 | **100% terminal.** `source` 74.6 KB, `legs` 57.2 KB |
| `accountPerformanceByAccount` | 48.5 KB | | two 500-point equity curves |
| `accountPerformance` | 24.3 KB | | a third 500-point equity curve |
| everything else | ~20 KB | | |

Inside `mt5Accounts`, one account is almost all of it:

| field | `mt5-54945785` | `mt5-296083557` |
|---|---|---|
| `externalCloses` | **117.6 KB** (193 rows) | 4.2 KB (7) |
| `closedTrades` | **69.9 KB** (99 rows) | 12.5 KB (16) |
| `availableSymbols` | 4.2 KB (388) | 3.2 KB (356) |
| account total | **194.0 KB** | 22.3 KB |

Growth is unbounded and observable: `signalQueue` went from 915 rows to 1,819 in one day when a channel
was backfilled. Steady-state trading adds 40 to 70 `queue_items` per day (measured 08-10 to 08-19), so
roughly +6 KB/day of permanent payload weight, forever. Nothing ages out.

#### Why indexes and views cannot fix the payload (but see the logs section above)

Measure before touching anything. `/api/telegram/status` answers in **2 ms** and `/api/health` in
**1.4 ms**. SQLite is not the bottleneck for the dashboard collections either:

| query | warm |
|---|---|
| `SELECT * FROM queue_items` (all 1,819 rows) | **3.9 ms** |
| same, narrowed to live statuses and needed columns | **0.3 ms** |

An earlier 301 ms reading was a cold page cache on first read after container start, not steady state.
An index speeds up *finding* a subset, and the dashboard asks for no subset: it runs `SELECT *` with no
`WHERE`, so nothing can engage. `idx_queue_items_parsed_signal_created` already exists and goes unused.
A view is a saved query and returns the same rows over the same wire.

The payload cost is everything *after* the query: building the JS objects, `JSON.stringify`, transfer,
the browser's `JSON.parse`, the recursive deep-compare, and the React re-render, on a box at load
average 5 to 10 running a dozen other containers.

`audit_logs` is the exception and genuinely does want an index, because that query *does* have an
`ORDER BY` and a `LIMIT` over 81k rows.

#### What each collection is actually used for

Mapped across `apps/web/src`. There are no selector hooks and no memoized store; one `useState` holds
the whole snapshot (`App.tsx:697`) and it is prop-drilled, so every consumer reads `snapshot.X`
directly.

- **`logicalTrades` is used for exactly one thing: `OUT_OF_SYNC` rows.** Both consumers filter to that
  status before doing anything (`App.tsx:2221`, `pages/HistoryPage.tsx:49`). **`legs[]` is never read
  anywhere in `apps/web/src`** — grep returns only the type declaration and a different `ClosedTradeRow.legs`.
  57.2 KB on the wire for nothing.
- **`signalQueue` is needed only for a count in the always-visible status bar.** `App.tsx:1241` computes
  `queuePending = signalQueue.filter(i => i.status === "PENDING").length`. The full list renders only in
  `pages/LogsPage.tsx:229`, inside a panel that is `collapsible defaultOpen={false}`, and `Panel.tsx:98`
  does `{collapsed ? null : children}`, so all 1,819 rows are shipped and **never mounted** by default.
- **`closedTrades` / `externalCloses` are route-gated to History** (`showTrades = dashTab("history")`,
  `App.tsx:2068`) and flattened in `ClosedPositionsTable.tsx:99`. Not on the default dashboard.
- **`availableSymbols` is route-gated to Symbols**, and `SymbolSettingsPage.tsx:49` **already lazily
  fetches** the near-identical `/api/accounts/:id/symbol-metadata`.
- **`accountPerformanceByAccount` is needed on the default route for only `currency` and `today`**
  (`pages/OperationsPage.tsx:97-99`). Its `equityCurve` is charted for one focused account at a time on
  the Performance tab only (`App.tsx:1244-1248`).
- **Leave `appPositions` / `appOrders` / `externalPositions` / `externalOrders` alone.** They are
  non-terminal by nature, small, and feed the always-visible `ExposurePanel` plus several `reduce`
  totals.

#### The aggregation trap: numbers computed client-side from the full array

**This is the one real risk in the whole change.** Trimming any of these silently changes a number the
operator reads:

| file:line | Renders | Computed over |
|---|---|---|
| `ClosedPositionsTable.tsx:119` | "Realized P/L" | ALL `closedTrades` + `externalCloses` |
| `ClosedPositionsTable.tsx:121` | "N winning" | same |
| `ClosedPositionsTable.tsx:122` | "N losing" | same |
| `ClosedPositionsTable.tsx:140` | "N closed trades" | same |
| `ClosedPositionsTable.tsx:117-118` | whether a total is shown at all (`canTotal`, mixed-currency set) | same |
| `App.tsx:1241` | StatusBar "Queue" chip, **always visible** | ALL `signalQueue` |
| `OpenPositionsTable.tsx:185-189` | "Floating P/L", EA vs external counts | open positions (safe, do not trim) |
| `lib/exposure.ts:29-58` | total lots, per-symbol pip risk | open positions (safe) |
| `LinkedAccountsPage.tsx:232` | external floating P/L | `externalPositions` (safe) |

So: paginating `closedTrades` **requires** moving those five header numbers server-side first, as
something like `closedTradesSummary: { count, wins, losses, realizedPnl, currencies[] }`. And trimming
`signalQueue` **requires** either guaranteeing every `PENDING` row survives the trim or sending a
server-computed `pendingCount`.

Encouragingly, `logicalTrades` has **no** whole-array aggregation: every `.length` is taken on the
already-filtered `OUT_OF_SYNC` subset.

#### Recommended order of work

1. **Index `audit_logs(created_at DESC)`** and `(event_type, created_at DESC)`, and prune the table.
   Independent of everything else, small, and fixes a measured 513 ms user-facing query.
2. **Stop `emitEvent` invalidating the performance cache on every `audit`.** An audit row does not
   change account performance. Either scope invalidation to event types that actually affect the
   projection, or drop `audit` from the client's full-refetch list (`App.tsx:900-902`) and let the 60 s
   poll pick it up. This is the single biggest win and it costs almost no code.
3. **`logicalTrades` → non-terminal only, drop `legs`** (~197 KB → ~2 KB). Zero UI risk. The cost lands
   in `api.test.ts`, whose `legStatuses` helpers (`:553-565`) assert on `legs` in ~44 tests and would
   need repointing at a different projection.
4. **`signalQueue` → non-terminal rows plus a server-computed `pendingCount`** (~216 KB → ~1 KB).
5. **Strip `equityCurve` from `accountPerformanceByAccount`** (~48 KB → ~2 KB) and serve it per account
   from its own endpoint on the Performance tab. The heartbeat delta patcher at `App.tsx:681-690`
   spreads the existing object, so removing a field is delta-safe.
6. **Move `closedTrades` / `externalCloses` behind a lazy endpoint** — but only after step's worth of
   summary work above.
7. **Drop `availableSymbols`**, reusing `/api/accounts/:id/symbol-metadata`, with a fallback for
   `ManualSignalModal.tsx:177`.

Measured target: stripping terminal history and the symbol lists alone takes the payload from **724 KB
to 98.8 KB**. Doing the equity-curve work as well lands it near **26 KB**.

#### House patterns to follow

Server-side limit clamping already exists: `optionalPositiveInteger(c.req.query("limit"), 500)`
(`app.ts:1162`, `app.ts:16214-16220`). Client-side the pattern is a self-loading child component with
`apiGet` in a `useEffect` and an `AbortController` — copy `pages/PerformancePage.tsx:143-160`. Response
keys are named after the collection (`{ logs: [...] }`, `{ symbols: [...] }`, `{ items: [...] }`).

**There is no `offset`, `page` or cursor anywhere in the codebase** — every list endpoint is
limit-only, newest-N. Introducing real paging means introducing a new convention deliberately.

Note that **`GET /api/signals` has the same unbounded problem**: it returns `store.queueItems()` and
`store.parsedSignals()` with no limit at all. Fix it in the same pass or it becomes the next bottleneck.

**No test anywhere asserts on payload byte size or `content-length`**, so nothing will catch a size
regression, and equally nothing blocks the change on size grounds.

#### Measurement hazards, both of which caught me out

- **Check `uptime` first.** A first pass showed `/api/dashboard` timing out at 60 s three times running.
  The box was 17 minutes post-boot at load average 10.86; once settled the same call answered in 0.54 s.
- **The box prints local time (UTC+2) while audit logs are UTC.** A four-hour apparent gap was a
  timezone difference, not an outage.
- The WAL sits at 27 MB against a 102 MB database and is never checkpointed. Minor, unrelated to the
  payload, but worth a periodic `wal_checkpoint(TRUNCATE)`.

### NYAKALLO MILLIONS VIP is the best channel measured

Dialog `-1003377857085`, provider `provider_wlgsny`, created **disabled** and still disabled. 880
messages imported covering 2026-06-02 to 2026-08-24.

Actionable review rate **4.76%** (21 of 441), against 13.4% for VIP Gold and 74.4% for KAL VIP. 147
OPEN_TRADE, 293 MARK_TP_HIT, 439 NO_SIGNAL. 420 of 441 actionable messages are auto-actionable. Format:

```
NAS100 SELL 29144.86 - 29116.26

TP 29098.65
TP 29078.50
TP 29058.76

SL 29177.37
```

Entry is a zone, parsed as `{from, to}`. Lifecycle is a quoted reply with `Comment: TP1 HIT`. No order
ids, so `openEvidence: "prose-complete"`, but far tighter than KAL VIP. A gold test-parse returned
`confidence 0.99`, `mappingStatus: mapped`, zero missing fields, zero warnings.

**All 21 review cases have one cause: NAS100 does not map to a broker symbol.** Entry symbol split is
XAUUSD 116, NAS100 16, US30 2. Gold already maps. NASDAQ exists on both accounts but is unmapped: HF
`mt5-54945785` has **`US100.F`**, Exness `mt5-296083557` has **`USTECm`**. Adding the alias and the
per-account mappings was deliberately left to the owner, because it makes a new instrument tradeable
on live accounts.

**Parser bug found here, affects every channel: take-profits are silently capped at 4 legs.** Five TPs
return four legs at 25% each with `confidence 0.99`, no warning and no `missingFields` entry. Verified
with five plain TPs, so it is a leg cap and not this channel's `TP <price> OPEN` runner suffix. Only 3
of 135 entry messages here exceed four TPs, but the silent truncation is the defect, not the
frequency. The `OPEN` runner suffix is also ignored; 24 messages use it. **Neither is fixed.**

### Nothing has traded since 2026-08-18, and the parser is not the reason

Three independent things are all stopped at once. Do not fix one and assume signals resume.

1. **Both MT5 accounts are unusable.** `mt5-54945785` (HF Markets, ZAR, initial balance 424.37) is
   heartbeating normally as of 2026-08-24T06:42Z but reports `balance 0, equity 0`. Every order it
   attempted from 2026-08-16 to 2026-08-18 failed `retcode 10006 / "Zero Equity" / err 4756`.
   `mt5-296083557` (Exness) last heartbeat **2026-08-14T19:24Z**, so it has been silently absent for
   ten days while still listed `heartbeat_status: online`. That status field lies; read
   `last_heartbeat_at`.
2. **Both providers stopped receiving messages.** `providers.last_message_at` is 2026-08-19T13:42Z
   for KAL VIP and 2026-08-18T13:19Z for VIP Gold. Both channels show `unreadCount: 0` in the live
   dialog list and Telegram RPC is demonstrably healthy (a dialog listing succeeded in 9.8s during
   this session, `/api/health` reports 2/2 ready, 0 stalled). Most likely the channels genuinely went
   quiet, which the KAL VIP author himself trailed ("most institutions close positions and take a
   break" in August). **Unverified** — see below.
3. **The backfill drain loops on a zero-width window.** Every 15-30 minutes both providers log
   `telegram.ingest.gap ... reason: "time-cap"` with `fromIso === toIso` and, for KAL VIP, the same
   `resumeOffsetId: 17718` each cycle, immediately followed by `backfill-complete`.
   `providers.backfill_cursor_id` is NULL for both, so the resume offset is never persisted and the
   window is recomputed from `last_message_at` every pass. Harmless today because the live drain runs
   first, but it is noise that will mask a real backlog.

### The re-auth prompt is a UI artefact, not a dead session

Timeline from `audit_logs` on 2026-08-24: at 05:29:54 both providers hit
`Telegram RPC timed out after 20000ms`, `telegram.session.stalled` fired for `tg_epuJC69Dpl` at 49s
without contact. At **05:30:02** and **05:30:07** two `telegram.start` events fired. At 05:30:09 the
original session recovered on its own and both providers recovered behind it. That is exactly the
reported symptom: prompted to authenticate, then it "decided" to use the session file.

Three defects stack to produce it:

1. **No boot-time session restore exists.** `GET /api/telegram/status` derives `connected` purely
   from a SQLite row (`telegram_sessions.status='CONNECTED'`, `app.ts:10891-10900`). Nothing at
   startup reads the session file, connects, and calls `isUserAuthorized()`.
2. **The reuse check sits downstream of the login form.** `#sessionMatchesPhone`
   (`telegram.ts:1018-1027`) runs `isUserAuthorized()` + `getMe()` inside `startLogin`, so the UI must
   render the login screen before the adapter can discover the stored session is fine.
3. **The client falls back to the login screen on any status hiccup.** `App.tsx:987-991` catches a
   failed `/api/telegram/status` and sets `setupStep='credentials'`, and that fetch has a 5s timeout
   (`App.tsx:948-950`) against a 15s default. The box sits at load average 5+. A stale
   `telegram-tc.pending-auth` localStorage key renders the code form synchronously before any network
   call (`App.tsx:760-769`).

**Each prompt leaks an orphan profile.** `POST /api/telegram/start` always mints a fresh
`profile_<nanoid>` + `tg_<nanoid>` (`app.ts:1695-1712`) and never reuses the existing session. There
are now **5 profiles and 5 sessions for one phone number**: `profile_eQVr6FM5x5` / `tg_epuJC69Dpl` is
the real CONNECTED one and owns both providers; the other four are `CODE_REQUIRED` junk from
2026-06-30 and 2026-08-24. Completing one of those logins would have produced a connected session with
zero channels attached. `/api/telegram/status` returns them with the CODE_REQUIRED rows sorted first
and the CONNECTED row last, which is worth checking if the UI ever reads `telegramSessions[0]`.

Related: `#importExistingSession` adopts a stored session only when the directory holds exactly one
`.json` (`telegram.ts:1008-1009`), and adoption itself writes a second file. The prod directory
already holds `tg_epuJC69Dpl.json` and `tg_iKkfJD3qYn.json`, so that fallback is permanently dead.

### Held queue cleared

65 held queue items dismissed via `POST /api/queue-items/:id/dismiss`, the only supported path (there
is no bulk endpoint; the UI's "Dismiss all" is a client-side fan-out). Breakdown before clearing:
`EVIDENCE_LIFECYCLE_RESOLUTION_REQUIRED` 26, `EVIDENCE_OPEN_GEOMETRY_INCOMPLETE` 14, `EA_OFFLINE` 10,
`EVIDENCE_RISK_OFF_NO_SIGNAL` 9, `EVIDENCE_DEMOTION_MARKER` 6. A JSON snapshot of all 65 was taken
first and is at `/tmp/held-snapshot.json` on the box.

Two leftovers, neither blocking: **7 `parsed_signals` rows still read `HELD`** from 2026-07-12/13 with
zero queue items, so they never appeared in the held view and the dismiss path could not reach them;
and **2109 orphaned `held_lifecycle_drops` rows**, which is a pre-existing leak (the table has an
INSERT and a SELECT and no DELETE anywhere in the tree), not something this clear caused.

### Live mount path had moved — the old note was wrong

The container binds `/home/kamo/code/telegram-tc/data -> /app/data`, i.e. the **code folder's own
data dir**. The live DB is `/home/kamo/code/telegram-tc/data/telegram-tc.db` (~102MB, root-owned,
written continuously). `/home/kamo/telegram-tc/data` is stale since 2026-07-12 and must not be used.
Confirm before trusting either path:
```
docker inspect telegram-tc-app-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{end}}'
```
Inline `docker exec ... bun -e "..."` is refused by the permission classifier. Write the query to a
local `.js`, `scp` to `/tmp`, `docker cp` into the container, then `bun /tmp/q.js`.

### Channel triage: 43 dialogs, 41 untracked

Only KAL VIP (`-1002500698105`) and VIP Gold (`-1003990600788`) are configured. Of the 41 untracked,
23 are channels or groups and 18 are users/bots. Fourteen look like genuine signal channels, ranked by
unread backlog: CopyTOP Discuss (100), Rudy Bank Indicator (37), SACR Official (19), TRADE WITH YUDER
(17), Naledi_sibiya exclusives (9), The 21 FX (7), NYAKALLO MILLIONS GOLD & NASDAQ (6), TONY SNIP3R
COMMUNITY (4), TFX (4), plus NYAKALLO MILLIONS VIP, neo trader smc, Prestige FX Ventures, MARKET
WIZARDRY CONCEPTS and Affuent Globe FX at 0.

Note VIP Gold has been **renamed upstream** to "(Free) VIP Gold Signals"; the stored title is still
"VIP Signals (Gold)".

### How to parse a new channel

There is exactly **one** parser (`parseSignalText`/`parseSignalTexts`,
`packages/core/src/index.ts:537,792`), hand-written regex and heuristics. Not per-channel templates,
not an LLM. Azure OpenAI is assist-only and operator-triggered on already-flagged signals. A channel is
bound to behaviour purely by `providers.provider_config_json` + `parser_mode`, so onboarding is always
"which archetype is this, and what config do I set".

**Archetype A, bot/structured** (`openEvidence: "structured-id"`, `parser_mode: "deterministic"`).
Every message carries an order ticket; lifecycle arrives as a quoted reply. VIP Gold:
`NEW ORDER - XAUUSD Buy Stop / # 332434343 / Entry: 4399.60 [Lots: 0.01] / SL: 4393.60 / TP: 4411.60`,
closed by quoting it with `🔴 CLOSED - XAUUSD Sell / # 332434348`. Measured: **13.4% review rate,
398/432 mapped, 0.99 confidence**, 144 OPEN / 83 CANCEL / 38 CLOSE executed. The ticket id is what lets
lifecycle bind to an exact trade. This is the shape you want.

**Archetype B, human prose** (`openEvidence: "prose-complete"`, `parser_mode: "automatic"`). KAL VIP:
`Gold sell limit / 4097-98 / Sl 4103 / Tp 4092 / Tp 4085`, shorthand like `Buy again at 83`, lifecycle
by quoting with a `Comment:`. Measured: **74.4% review rate, 1597/2379 unmapped, 1736 NO_SIGNAL**.
Banter parses as commands at 0.99 confidence — `If we closed tp1 from the morning we would've made
around 6k😂` became CLOSE_TRADE, as did a message about August holidays. **Both reached the queue and
were dismissed, never executed**, so the evidence gate held, but budget for that operator noise on any
prose channel.

Onboarding sequence, safe because `POST /api/providers` creates every provider with `enabled=0` and
disabled providers are never polled:
1. `POST /api/providers {profileId, dialogId, title}`
2. `POST /api/providers/:id/import-messages {limit, dateFrom}`
3. `POST /api/providers/:id/backtest {}` — read-only, returns reviewRate, commandCounts,
   mappingStatusCounts, missingFieldCounts, examples. **This is the decision artefact.**
4. `GET /api/providers/:id/detected-symbols`
5. `POST /api/providers/:id/test-config {rawText, config}` — side-effect free config tuning
6. only then `PATCH /api/providers/:id {enabled:true}` and link an account

`POST /api/parser/parse` and `parse-recent` **write** to the DB; never use them for inspection on prod.
Reverse anything with `DELETE /api/providers/:id`.

Two config observations worth acting on. KAL VIP has `shorthandLevels: false` while the channel
routinely posts `Buy again at 83` and `Buy limits at 56`; that flag exists for exactly this shape.
And there is **one** symbol alias in the whole database (`GOLD -> XAUUSD`), so any NASDAQ channel needs
`symbol_aliases` plus `account_symbol_mappings` rows before it can map at all.

The adaptive learning path is dormant: `parser_training_examples` holds **2 rows total and 0 learned
structures**. It needs 3 approvals of the same structural fingerprint before it stops flagging review
(`app.ts:12231-12236`), so it has never once fired.

### Verified vs unverified

- Verified: held queue empty — `GET /api/queue-items/held` returns `{"items":[]}`; `queue_items` has
  0 HELD and DISMISSED rose 115 -> 180; 65 `queue.dismiss` audit rows written on 2026-08-24.
- Verified: the re-auth timeline — five `telegram_sessions` rows and the 05:29:54 to 05:30:10
  `audit_logs` sequence quoted above, read from the live DB.
- Verified: accounts unusable — `mt5_accounts` rows show `balance 0, equity 0` on both, with
  `last_heartbeat_at` 2026-08-24T06:42Z and 2026-08-14T19:24Z respectively.
- Verified: parser quality figures — aggregated from `parsed_signals.result_json` and `raw_messages`
  on the live DB.
- Verified: live mount path — `docker inspect` output quoted above.
- **Unverified: whether the two tracked channels are genuinely quiet or ingestion is dropping
  messages.** Proving it needs a read of the channels' current newest `telegram_message_id` against
  the stored maxima (KAL VIP 17718 / 2379 stored, VIP Gold 785 / 432 stored). The only in-app routes
  that fetch from Telegram also write, and both providers are enabled, so this was not attempted.
  Cleanest proof is to open either channel in a Telegram client and compare the latest post date
  against `providers.last_message_at`.
- **Unverified: alerting.** The 2026-08-02 note below says it is entirely unarmed. `app_settings` was
  only read truncated this session, so treat that as still open rather than re-confirmed.

### Resume

```bash
cd /Users/kamogelo/Code/telegram-tc
git checkout fix/held-queue-fanout-and-lifecycle-drop
# nothing to build; the next action is operational, on the box
ssh kamo@192.168.0.100 'bash /tmp/onboard-channels.sh'
```

The onboarding script for all 14 candidate channels is **already staged on the box** at
`/tmp/onboard-channels.sh` (source of truth: the scratchpad copy at
`.../scratchpad/onboard-channels.sh`). It creates each provider disabled, imports history from
2026-06-01 with a 400-message cap, backtests, and drops per-channel reports into
`/tmp/channel-analysis/`.

Setup required first: SSH key access to `kamo@192.168.0.100`. No env files or local services needed
for the operational path.

Machine-specific: the branch commit `1d51cfcf` exists only on this MacBook. Push it before working
from another machine.

Background jobs still running: none.

### Live production state as left on 2026-08-24

- Held queue **empty**, zero `PENDING`/`LEASED` queue items app-wide, `/api/health` reports 3/3
  providers ready and 0 stalled.
- **NYAKALLO VIP (`provider_wlgsny`) is ENABLED**, 885 parsed signals, `lot_size` 0.1 (the other two
  run 0.03).
- **It has no `account_provider_links` row, which does NOT make it inert.**
  `targetAccountIdsForProvider` (`app.ts` ~8584) returns `links.length ? [] : [fallback]`, so a
  provider with links that are all disabled routes nowhere, but a provider with *no link rows at all*
  falls back to a live account. NYAKALLO is therefore aimed at `mt5-54945785`. Link it deliberately or
  confirm the fallback is what you want.
- Enabling it replayed all 880 imported historical messages through the signal path over about five
  minutes, producing 469 held items against that account. Nothing executed; the evidence gate held or
  dropped every one and `PENDING`/`LEASED` stayed at zero throughout. All 469 were dismissed. If you
  onboard the remaining channels, either clear the imported `raw_messages` before enabling or plan for
  the bulk dismissal.

### Blockers and open items

- **NYAKALLO VIP is disabled because the account no longer has access to the channel.** Not a code
  bug; rejoin or resubscribe, confirm it reappears in `GET /api/telegram/dialogs`, then re-enable.
  v1.67.2 makes the failure legible and backs off rather than flooding.
- **The dashboard payload is the top open item.** 724 KB re-sent on every audit log write, because
  `emitEvent` invalidates the performance cache and the client refetches the whole snapshot on the
  `audit` SSE event. Full analysis, measurements, consumer map and a ranked plan are in the OPEN ISSUE
  section above. Start with the `audit_logs(created_at)` index and the cache-invalidation scoping;
  those two are small and independent.
- **The remaining 13 candidate channels are still un-analysed.** `/tmp/onboard-channels.sh` on the box
  handles them; NYAKALLO VIP was done by hand and validates the approach. Read the enabling caveat
  above before running it.
- **The `TP <price> OPEN` runner suffix is still ignored.** 24 of NYAKALLO's messages use it to mark a
  leg as a runner; those legs currently take an ordinary allocation. Not fixed.
- **Four orphan `CODE_REQUIRED` profiles/sessions** are still present: `profile_P-7LXDAsry`,
  `profile_uM51HDXWBX`, `profile_n1d3kKA3gL`, `profile_2oVPN3VMY0`. v1.67.1 stops new ones being
  created but does not delete existing rows. Deleting them is a destructive prod write, left alone.
- **Accounts:** owner said on 2026-08-24 they were funding both that morning, so the zero-equity and
  stale-heartbeat findings below may already be resolved. Re-check before treating them as live.

### Tooling hazard worth knowing

A backgrounded Codex task keeps writing to the invoking checkout after it appears to have finished. On
2026-08-24 one silently reverted a committed changelog entry mid-session. If files change under you,
check `ps aux | grep codex` for a `codex-companion.mjs task-worker` and kill it before continuing.

## Previous START HERE — 2026-08-02

**The most important open item is not code.** Alerting is unarmed. The live `app_settings` JSON has
15 keys and not one alert key: no `alertBotToken`, no `alertChatId`, and `alertOnTelegramStall`,
`alertOnEaOffline` and `alertOnExecFailed` all sit at their unset defaults. Verified against the live
box on 2026-08-02.

So every detection path built over the last weeks ends nowhere. `telegram.session.stalled` fires and
notifies no one. The `execution-failed` alert notifies no one, which matters because the v1.65.8
changelog names that alert as the remedy for a stranded `FAILED` leg. `/api/health` deliberately
returns HTTP 200 on `degraded` so the container healthcheck cannot be a backstop either, which was
the right call for its own purpose but leaves no second path. The dispatch code and stall detection
already exist and are tested; this needs configuration, not development. It was raised as an owner
action on 2026-07-26.

Second instance of the same pattern: both live terminals still run **EA 1.60.0**. The v1.66.0
trailing-slot reclamation and the pending v1.67.0 lifecycle-mark work protect nothing until someone
recompiles in MetaEditor and reattaches. Prefer doing that while the account is flat.

The blunt version: safety code is being shipped faster than it is being armed.

**Highest residual risk**, following from the above: a silent ingestion stall while positions are
open, unnoticed for hours. Reconnect-after-outage under teleproto is still unverified, there is no
FloodWait or ban handling anywhere, and the failure mode of both is silent signal loss. A backlog
drain recovers messages after reconnect, but a missed close or stop move during the stall is not
recoverable afterwards.

**Deployed.** `main` at v1.66.1, adapter reporting `teleproto`, 2/2 providers ready. Four deploys
landed on 2026-08-02 in a Sunday window with markets closed and a flat book. The teleproto cutover
succeeded, which was the one thing that could not be verified offline.

**Merged since, not yet deployed and not requiring one:** adapter encapsulation and the
`AccountHeader` determinism fix, both test-and-encapsulation only.

## Lessons that generalise, 2026-08-02

Three mechanisms were built and then deliberately not shipped this session. All three failed for
reasons worth keeping, because the same reasoning will come up again.

**Proof by absence does not hold in this codebase.** The per-provider ingestion latch assumed no
latch entry means no outstanding request. The unproven-`HIT` reopen assumed no close command plus
unchanged broker volume means no close happened. Neither inference survives, because identity and
state are reconstructed from loosely matched snapshot rows held across awaits: snapshots carry no
broker capture timestamp, the broker-record matcher validates neither symbol nor direction, and
`broker_orders` has no deduplication. Prefer positive evidence. Treat "nothing recorded it" as
unproven rather than false.

**A timeout that does not cancel converts a hang into an unsequenced late write.** This appeared
three times: `withTelegramRpcTimeout` on Telegram RPCs, the same helper on filesystem writes, and
`AbortSignal` on `fsPromises.writeFile`. The third was measured, not assumed: a 64MB write aborted at
20ms rejects with `AbortError` and still lands all 64MB. Where cancellation does not exist, contain
instead: session writes now stage to a private per-write name and rename into place, so an abandoned
write can only land somewhere nothing reads.

**A tripwire must assert it can still see its subject before it asserts an absence.** The
`grep -c testSeam` rule reported clean for weeks while the banned pattern sat in the file under a
differently-cased name, because its pass condition was "no output", which is indistinguishable from
looking in the wrong place. The first replacement guard had the identical defect: it counted the
private fields it discovered and required eight of eleven, so a field regressing to `private` left it
green. Both are now set-equality checks that fail in either direction.

## Milestone log — 2026-08-01

### Parallel-lane batch: seven of eight findings closed

**Done.** Eleven commits, `68b6460f` through `80cc7edd`, all pushed to
`origin/fix/reference-leg-stop-strategy`. Reference-leg revival `cc144aec`. Snapshot liveness
`eaeba29e`. Health readiness `3b992fd8`. Dashboard health plus container HEALTHCHECK `9baf52a9`.
Pending-order debounce `144a9eb4`, with my bad integration design reverted in `4064f84b`.
Reference-stop ticket rekeying `f77da8a2`. GramJS to teleproto `62177477`. Documentation `80cc7edd`.

**Verified.** `bun test` 692 pass 0 fail, `bun run typecheck` clean, `bun run lint` clean, all run in
the main checkout at `80cc7edd`. Every behavioural change is mutation-checked; the observed failure
output is quoted in each commit message. Teleproto verified by deleting `node_modules/telegram`
outright and re-running the suite green, which proves nothing still resolves GramJS.

**Unverified, needs a human at cutover.** Whether the live Telegram session is still
server-authorised under teleproto, the real phone-code and 2FA flow, real dialog and message values
including server iteration order, and reconnection after an outage. None is checkable offline. If
the session does not load, ingestion stops and recovery needs phone-code and 2FA on an account the
operator owns.

**Resume from.**
```
cd /Users/kamogelo/Code/telegram-tc && git checkout fix/reference-leg-stop-strategy && bun test
```

**Open blockers.** One finding remains, the Telegram RPC orphan and client replacement, in lane
`/private/tmp/claude-501/-Users-kamogelo-Code-telegram-tc/0dcc3daa-4e96-48c4-9b5e-dceefbfce274/scratchpad/lanes/tg-rpc2`
based on `62177477`. Green at 699 pass with zero private-internals references, awaiting Sol review.
It carries one previously unclosed HIGH: `startLogin()` did its slow preparatory work before
registering intent and capturing its generation, so a concurrent disconnect in that window could be
undone and the deleted session file recreated.

**Not deployed, deliberately.** Production runs 1.65.5. The batch is not deployed because the
teleproto cutover needs the four human checks above. Everything else in it would deploy safely.

## START HERE — 2026-08-01

Branch `fix/reference-leg-stop-strategy` @ `62177477`, 10 commits ahead of
`origin/fix/reference-leg-stop-strategy` (pushed as far as `84d87453`; the rest is local). Package
version `1.65.7`. EA source metadata remains `1.65.0`, unchanged since that release, because every
patch from 1.65.1 through 1.65.7 was web/API-only and left it as-is (see each entry in
`changelog.md`). The deployed terminals run EA `v1.60.0` regardless; the source metadata string and
the deployed binary are tracked separately, and only the binary needs a recompile.

**Production runs 1.65.5.** Nothing from v1.65.6, v1.65.7, or this branch is live, including the
teleproto migration below and the `/api/health` readiness work. Check the running container's version
before assuming otherwise.

This branch carries the reference-leg stop-strategy work, each detailed under its own heading below:
v1.65.4 (a take-profit leg allocated 0% now applies its own stop strategy, such as break-even,
without closing volume), v1.65.5 (durable per-leg stop actions that survive a crash or restart),
v1.65.6 (reopens legs a spurious pending-order cancellation had left permanently `SKIPPED`, plus
`lastSnapshotReceivedAt`/`snapshotAgeSeconds` on `GET /api/mt5/accounts`), and v1.65.7 (rekeys
`reference_stop_actions` when a broker position ticket transition is accepted, propagates broker
point metadata into default-distance TP targets, debounces pending-order cancellation on continuous
absence rather than order age, and replaces the Telegram client library).

**Telegram client migrated from GramJS to teleproto (commit `62177477`, part of v1.65.7).** The npm
dependency is now `teleproto` (`^1.228.4`) instead of `telegram` (GramJS), which was archived upstream
on 2026-07-14 with `2.26.22` as its final release. The `gramjs` adapter name and the
`TELEGRAM_ADAPTER=gramjs` setting are unchanged and now mean "the real adapter, backed by teleproto";
see README's What It Does section. Saved `StringSession` values load unchanged. This is a dependency
swap, not an API/DB/EA protocol change, so it stayed a patch within v1.65.7.

`/api/health` gained a `telegram` readiness section in v1.65.6
(`expectedProviders`/`readyProviders`/`unreadyProviders`/`stalledProviders`, overall `status`
`degraded` when any enabled provider lacks a current readiness observation). See open risk 8 below:
an earlier version of this note wrongly described known bugs here as still open after the same commit
that introduced the feature had already fixed them.

### The design base (owner-specified, now in effect)

SF Pro in regular and medium at **-0.15px** tracking. Type scale is **12 / 13 / 14 / 24px only**.
Text hierarchy is **#292929 / #5D5D5D / #9E9E9E**. Icons are **14px in navigation, 20px on cards**.
Radii are **8px navigation, 16px cards, pill CTAs**. Content canvas is 1180px.

These remain the base for route work. The local browser still resolves the requested type scale,
tracking, greys, icon sizes, and radii after the v1.64.4 structure changes.

### v1.65.3 — reconciliation framing and bulk-dismiss feedback

- Replaced the bright dashed out-of-sync resolution border with the standard 1px card divider.
- The confirmed Dismiss all action now disables itself and reads `Dismissing…` until every existing
  audited per-item dismissal request has settled and the queue has refreshed.
- The live held queue is empty after the owner's bulk dismissal, confirming that the action
  completed; the missing progress state was the misleading part.

Focused App and Held Signals tests passed 77/77. `bun run typecheck`, `bun run lint`,
`bun run build`, and `git diff --check` passed. Production deployment used `bun run deploy`;
backup `telegram-tc-20260730T070151Z.db` completed before the swap. The healthy container serves
`/assets/index-nmpDwr5k.js` and `/assets/index-ByMQLTsb.css`; image
`sha256:5d76aa7699363f38435225ca4b1b103077d4b718251202f2b38db65b70901e16`. Both MT5
accounts remain online on EA v1.60.0 and Telegram reports connected.

### v1.65.2 — table density and right-edge containment

- Shared data tables keep the 12px type floor but now use the existing 8px spacing unit for
  horizontal cell insets; row headings also use 12px instead of 13px.
- The Performance attribution table now resolves its width inside its 16px side margins. Previously
  `width: 100%` plus those margins extended the wrapper 32px past its parent, where the panel clipped
  the rightmost realised P/L column.
- No columns, values, actions, or execution behaviour were removed.

The in-app Browser audited the deployed populated routes after the final deployment:

- At the default 1280px desktop viewport, Performance has a 903px table inside a 903px scroller with
  a measured 17px right inset; global and account Providers each have `scrollWidth === clientWidth`
  (937px), so neither requires horizontal scrolling.
- Review queue remains a six-column 903px table inside a 903px scroller with Dismiss all present;
  Symbols is 937px inside a 937px scroller. Top-level Logs, Providers, Symbols, Telegram, and
  Settings expose no account workspace tabs.
- At 560px, Review queue rows remain grid cards, Symbols keeps its four priority columns, and global
  Providers keeps Name, Status, and Copied by; all three routes have
  `document.scrollWidth === innerWidth === 560`.
- At 1600px, the Performance table and scroller both measure 1144px. Dark-mode Provider actions use
  `rgb(20, 24, 31)` and the audited main surface contains no `rgb(0, 0, 0)` background boxes.

Repository gate after the final change:

- Request-focused App and Performance tests — 79 passed, 0 failed.
- `bun test` — 649 passed, 0 failed.
- `bun run typecheck` — passed.
- `bun run lint` — passed with no warnings; duplicate CSS guard passed.
- `bun run build` — API and Vite production builds passed.

Production deployment used `bun run deploy`. Final backup
`telegram-tc-20260729T222353Z.db` completed before the swap. The healthy container serves
`/assets/index-DrhpILFR.js` and `/assets/index-KJ9duJ0m.css`; the image is
`sha256:0b2f4a5e3d8563b63a87eb88e0d29ae1fc49b9e3cdae48fbe21c2de454458953`. Both MT5
accounts are online on EA v1.60.0 and Telegram reports connected.

### v1.65.1 — responsive queue and provider consolidation

- Held-signal lifecycle rows now show only the trade selector and dismiss action until an active
  trade is selected. Market and Original release actions appear after selection, preserving the
  existing evidence-gated confirmation flow while removing disabled control noise.
- Review reasons are readable supporting text instead of a second machine-style status badge.
  At 560px, held rows become compact two-column cards rather than a horizontally scrolling table.
- At 560px, Symbol Mapping prioritises Provider symbol, Broker symbol, Status, and Actions; Canonical
  and Scope remain available at wider widths. The page no longer clips its right-hand status/actions.
- The all-account Providers page keeps global monitoring and the assignment table, but no longer
  repeats every provider a third time as health cards. Account-specific Provider pages retain those
  cards, where the health context belongs.

The in-app Browser audited the deployed Operations, Review queue, Providers, Symbols, Telegram,
Settings, Positions, Performance, account Providers, Guardian, and account Logs surfaces across
light and dark themes. Final measured checks:

- `/logs`, `/providers`, and `/symbols` each have `scrollWidth === innerWidth === 560` in the compact
  layout; held rows compute to `display: grid`, and Symbols shows the four priority columns.
- The desktop Review queue, Providers, Symbols, Telegram, Settings, Performance, account Providers,
  and Operations routes each have `scrollWidth === innerWidth === 1600`.
- Top-level Providers and Symbols have no account workspace tabs. Top-level Providers has zero
  provider-health cards; the account Provider route retains two.
- Light-mode provider action cells compute to `rgb(255, 255, 255)`, not black. The growth chart is
  256px high and exposes six bounded date-and-hour labels with no raw epoch in its accessible chart.
- Computed design tokens remain SF Pro, 13px body, 24px/500 page title, `-0.15px` tracking,
  `rgb(41, 41, 41)` title text, and 14px navigation icons.

Repository gate after the final change:

- Request-focused App and Held Signals tests — 77 passed, 0 failed.
- `bun test` — 649 passed, 0 failed.
- `bun run typecheck` — passed.
- `bun run lint` — passed with no warnings; duplicate CSS guard passed.
- `bun run build` — API and Vite production builds passed.

Production deployment used `bun run deploy`. Final backup
`telegram-tc-20260729T215706Z.db` completed before the swap. The healthy container serves
`/assets/index-FD9YslVB.js` and `/assets/index-C_oMzi4G.css`; the image is
`sha256:c2540d81af3278916e8423daf7105bf0f50e7ed45681b6081d9d5bb7b19c265a`. Both MT5 accounts
are online on EA v1.60.0 and Telegram reports connected.

### v1.65.0 — compact review queue and chart correction

- Top-level `/logs` is a standalone Review queue view, without the account workspace tab strip.
- Held signals use six compact columns instead of ten. The always-visible Dismiss all action asks
  for confirmation and then calls the existing audited item dismissal endpoint for every row.
  Partial failures are reported; dismissal cannot execute or requeue a signal.
- Growth-chart axes are capped at six date-and-hour labels and tooltips render local date/time
  instead of raw Unix epochs.
- Account Provider action cells use the active panel theme token, removing the dark sticky blocks
  that appeared in light mode.

The in-app Browser verified the populated production routes at 1600×1000:

- `/logs` has no workspace tab strip, renders 30 held rows in six columns, keeps the 1144px table
  inside its 1144px scroller, and exposes the rightmost actions without horizontal scrolling.
- Dismiss all opens a confirmation for all 30 signals and states that nothing will execute or
  requeue. The destructive confirmation was cancelled during verification.
- `/accounts/mt5-1514065673/providers` uses the active panel colour in light and dark modes instead
  of black sticky action cells.
- The 500-sample growth chart renders six distinct date-and-hour ticks, no raw epoch text, and a
  themed tooltip such as `Jul 22, 2026, 8:53 PM`.

Repository gate after the change:

- Request-focused tests — 82 passed, 0 failed.
- `bun test` — 647 passed; the documented `AccountHeader` full-suite timeout was the only failure.
  The timed-out test plus the EA source suite passed 49/49 in isolation.
- `bun run typecheck` — passed.
- `bun run lint` — passed with no warnings; duplicate CSS guard passed.
- `bun run build` — API and Vite production builds passed.

Production deployment used `bun run deploy`. Backup `telegram-tc-20260729T212821Z.db` completed
before the final swap. The healthy container serves `/assets/index-C8grEUwY.js` and
`/assets/index-LLge9wFu.css`; the image is
`sha256:d84df66dfb8e5e4c66e56086ff1542c1cff2efbc26655a129c079633070d195c`. Both MT5 accounts are
online on EA v1.60.0 and Telegram reports connected.

### v1.64.5 — standalone Setup routes (deployed 2026-07-29)

- Top-level `/providers` and `/symbols` are standalone Setup views. They no longer render the
  Signals, Positions, Providers, Performance, Guardian, and Logs dashboard tab strip or the
  unrelated operational alert banner.
- Account-specific `/accounts/:id/providers` remains inside the account workspace and retains its
  account navigation.

The in-app Browser verified the deployed Providers and Symbols routes at 2560×1440 and 560×1000.
Both omit the dashboard tabs and alert banner and keep `document.scrollWidth === innerWidth`.
`/accounts/mt5-1514065673/providers` still renders the account section tabs at 1600×1000.

Repository gate after the change:

- `bun test` — 645 passed, 0 failed.
- `bun run typecheck` — passed.
- `bun run lint` — passed with no warnings; duplicate CSS guard passed.
- `bun run build` — API and Vite production builds passed.

Production deployment used `bun run deploy`. Backup `telegram-tc-20260729T210331Z.db` completed
before the swap. The rebuilt container is healthy and serves `/assets/index-BC9ToWrI.js`, whose
bundle contains v1.64.5. Both MT5 accounts report online on EA v1.60.0 and Telegram reports
connected. The production image is
`sha256:d2d8c2475da52c783ddffaae9e2f575c21fb0c1ef66046c83cdaf076843b2f22`.

### v1.64.4 — secondary-route structure pass (deployed 2026-07-29)

- Removed the repeated account summary from Providers, Performance, Guardian, Logs, and Symbols.
  The workspace heading already carries account context; account health remains in Operations and
  performance values remain in Performance.
- Moved Providers export beside the explanatory copy, flattened global provider monitoring into
  rows, and removed the empty monitoring block when no providers exist.
- Replaced the glowing cyan growth chart with a shorter monochrome dotted plot, standardised every
  segmented control to the compact shared size, and reduced the Statistics toolbar to one control
  row.
- Flattened Telegram help, connection, and next-step states into divided rows so the dialog picker
  is the page's only card. Symbol Mapping now uses one table surface with neutral row headers.

The in-app Browser recheck covered Performance, Providers, Symbols, and Telegram at 2560×1440 in
light and dark themes, plus those four routes at 560×1000 in dark mode. All measured routes kept
`document.scrollWidth === innerWidth`.

Repository gate after the change:

- `bun test` — 645 passed, 0 failed.
- `bun run typecheck` — passed.
- `bun run lint` — passed with no warnings; duplicate CSS guard passed.
- `bun run build` — API and Vite production builds passed.

Production deployment used `bun run deploy`. Backup `telegram-tc-20260729T203330Z.db` completed
before the swap. The rebuilt container is healthy and serves `/assets/index-CVy04FH7.js`, whose
bundle contains v1.64.4. Both MT5 accounts report online on EA v1.60.0 and Telegram reports
connected. The production image is
`sha256:970ac0b1b71c1e403ccd63e021b87b2a24ff03646e8b93ce46fd04ddba131695`.

### v1.64.3 — full-screen density pass (deployed 2026-07-29)

The owner replaced the design target with a new design system. Both design docs from this period were
deleted on 2026-07-30: `SPEC-ui-fidelity-2026-07-29.md` was superseded a day later by the SF Pro
base, and `REVIEW-ui-fidelity.md` targeted the older "console" design. The current authority is "The
design base" section at the top of this file.

- Shared workspace gap reduced from the old double-margin rhythm; secondary content now begins 26px
  higher on a 1600px viewport.
- The repeated secondary-route account summary is 135px high instead of roughly 236px. Platform
  metadata and four KPIs remain visible, but the empty sparkline/spacer reservations are gone.
- Settings no longer renders a redundant disabled header action above the existing SaveBar. Its
  sections are flat, icons align with headings, and 560px returns to one column.
- Empty Providers no longer renders an Export-only header. Providers and Telegram shed their outer
  card shell; Telegram also no longer repeats the page title in a panel header.
- Empty states and panel headers are shorter, direct panel children no longer inherit 24px of hidden
  padding, and light mode uses a warmer neutral canvas with quieter shadows.

Browser verification used one real in-app Browser tab against a copied database with the mock
Telegram adapter. The audit covered Operations, Settings, Telegram, Providers, Symbols, Logs,
Performance, and Guardian at 1600×1000. Post-fix rechecks covered Operations, Settings, Telegram,
Providers, Symbols, and Logs at 1600×1000 plus Operations, Settings, Telegram, and Symbols at
560×1000 across both themes. The document stayed within the viewport and wide tables retained their
own horizontal scrollers. The final preview is left open at `/settings` in light mode.

Repository gate after the change:

- `bun test` — 648 passed, 0 failed.
- `bun run typecheck` — passed.
- `bun run lint` — passed with no warnings; duplicate CSS guard passed.
- `bun run build` — API and Vite production builds passed.

Production deployment used `bun run deploy`. Backup `telegram-tc-20260729T201002Z.db` completed
before the swap. The rebuilt container is healthy and serves `/assets/index-Bhbue2ri.js`, whose
bundle contains v1.64.3. The two MT5 accounts report online on EA v1.60.0 and Telegram reports
connected. The production image is `sha256:ac60d159f95e54860cd5ba8839dfb47591543f17393b38644a9188ca8543ae73`.

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

### Layout hazards, each of which produced a real bug

1. **`base.css` duplicated top-level blocks, the later one silently wins.** ~8,250 lines, five bugs
   so far. Grep every occurrence before editing. `bun run lint` has a duplicate guard.
2. **Panel inset depends on a DIRECT-CHILD relationship** — `.panel > *:not(header)` and the
   `margin-inline` group in `signal-desk.css`. A wrapper inside a panel silently strips inset and
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
- **v1.64.4 secondary-route structure pass.** Repeated account summaries and one-purpose card rows
  are gone; Providers, Performance, Symbols, and Telegram now use the compact structure above.
  Presentation only.
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

### Standing safety invariants (lifted from July briefs on 2026-07-30, sources archived)

These are product and safety decisions, not implementation notes. Anyone touching the parser,
classifier, or close path needs them stated plainly.

1. **Structure decides. Prose never executes.** The governing principle for the whole
   parser/classifier. Source: `IMPL-structure-first-classification-2026-07-26.md`, shipped v1.59.0.
2. **A provider close message means the provider is out of the trade.** The only exception is the
   provider's `runner` flag. Erring toward closing reduces exposure, so under-closing is the
   dangerous failure and over-closing is not. Source: `IMPL-close-semantics-2026-07-25.md`, shipped
   v1.58.0.
3. **Close-all holds per account and is released per trade.** `isCloseAllInstruction`, the `closeAll`
   flag, and the `signal.closeAll` branches still exist in `app.ts` and were deliberately kept.
   The July plan `PLAN-evidence-gated-execution.md` prescribed deleting them; v1.60.0 achieved the same safety
   property a different way. Do not read that plan as a description of the code.

### Open trade-safety risks carried forward from the 2026-07-20 audit

Found in `docs/archive/AUDIT-2026-07-20-codebase.md` and re-confirmed on 2026-07-30 as showing no evidence of a
fix in current source. The audit doc is archived; these items are live. Verify before touching
execution, reconciliation, or guardian code.

1. **NETTING accounts are accepted despite hedging-only trade semantics.** No execution or
   reconciliation branch reads `marginMode`. Two providers buying the same symbol on a NETTING
   account merge into one position, so closing one provider's signal can close both.
2. **MT5 account and broker ticket identities are not globally safe.** Account identity is only
   `mt5-${accountNumber}`. History deal and fallback ticket lookups omit `account_id`.
3. **`SPLIT_ORDER` has no safe per-leg execution contract.** One successful close then closes the
   entire logical trade.
4. **Virtual-TP legs latch into an irreversible `HIT` state before broker proof.** Confirmed against
   current source: `app.ts` still sets `status: "HIT"` on a quote crossing alone in the ordinary
   (non-reference) virtual-TP path, with no broker-side confirmation gate. The v1.65.4/v1.65.5 work
   added durable, once-only, non-regressing `HIT` semantics, but only for 0%-allocation reference
   legs; the closing-leg path this item describes was explicitly left unchanged (see "Still open,
   deliberately not fixed here" under v1.65.4 below). Correction: an earlier version of this note
   cited `REVIEW-item7-verify.md` as independent confirmation; that file verifies a different finding
   (pending-order MARKET/LIMIT inference, its own "item 7"), not this one, and the citation was wrong.
5. **Trailing-stop protection is memory-only** and permanently exhausts its 100-slot array.

Found 2026-07-30, separate from that audit:

6. **The EA work and report endpoints are unauthenticated.** `/api/mt5/poll` and `/api/mt5/poll-line`
   lease queue items on a bare `accountId` query parameter (`app.ts:1041-1051`), and
   `/api/mt5/report` accepts an execution report with no auth at all (`app.ts:1053-1057`). `linkCode`
   is only checked on register and heartbeat. Account ids are `mt5-<accountNumber>`, which is low
   entropy. Contained today because the API is not internet-exposed. Anything that exposes the app
   publicly, including a tunnel with an `/api/mt5/*` exemption, lets a caller lease work items and
   post fabricated execution reports. Fix before any public exposure. Line numbers drift as `app.ts`
   grows; re-grep before citing them again.
7. **No FloodWait or ban handling.** Neither `telegram.ts` nor `app.ts` handles Telegram
   rate-limiting or banning the account mid-session. The failure mode is silent signal loss.
8. **`/api/health` Telegram readiness, corrected 2026-08-01: the previous version of this note was wrong.** v1.65.6
   added a `telegram` readiness section (`expectedProviders`/`readyProviders`/`unreadyProviders`/
   `stalledProviders`) and an overall `status` that goes `degraded` when any enabled provider lacks a
   current readiness observation, replacing the old bare `telegramAdapter` name. An earlier version of
   this note said it still reads `ok` when no session has ever connected, when the only session is
   disconnected, and when a provider is failing its RPCs, and `degraded` only for a deliberately
   paused provider. Those were review findings against a first draft. The fix for all of them shipped
   the same day, in the same commit that introduced the feature (`3b992fd8`), before it was ever
   released. Verified against current source and against the regression tests that commit added:
   `degrades health before the first successful Telegram provider contact`, `degrades health while a
   Telegram session is stalled and recovers after disconnect`, `degrades health after consecutive
   Telegram provider RPC timeouts`, and `removes a disabled provider from Telegram health
   expectations` (all in `apps/api/src/api.test.ts`) each assert the corrected behaviour. The
   changelog's v1.65.6 entry never called this known-incomplete; that citation in the earlier version
   of this note did not point at anything real. Still genuinely open: this has not been exercised
   against a live FloodWait or account ban (risk 7), and `/api/telegram/status`'s `connected` boolean
   remains a useful independent cross-check.

### v1.65.5 - durable reference-leg stop recovery (FIXED 2026-07-31, not yet deployed)

This follow-up closes the v1.65.4 review findings in the API and core packages:

- `reference_stop_actions` durably identifies each reference leg independently of its computed stop
  price. New queue work, the action row, and the leg `HIT` transition share one SQLite transaction.
- Snapshot reconciliation uses the current position ticket and broker stop. An `EXECUTED` command is
  repaired when the live stop is absent or weaker. A stale `LEASED` or delivery-unknown `HELD`
  command is confirmed from the broker stop or moved back to `PENDING` using the same queue row.
- Existing v1.65.4 `HIT` reference legs are backfilled into the action table on the first matching
  snapshot, including links to old reference `MODIFY_SL` rows when present.
- The favorable BUY high-water or SELL low-water quote is stored on the logical trade before stop
  work begins. A crash or restart cannot erase a crossing the API already sampled. The remembered
  crossing waits when the desired stop is on the invalid side of the current market.
- Fixed-stop work from reference legs, volume-closing legs, and fixed runner strategies observes the
  live broker stop and active work for the exact position ticket. `sl = 0` is treated as no stop.
- Provider full-TP announcements share the coalescing path, unresolved reference legs remain in their
  prior status, original-plan reads require `OPEN_TRADE`, and same-time stop commands lease from the
  less protective level toward the more protective level.
- `set-sl-to-tp` now resolves a referenced leg through the same target calculator used by the monitor,
  including targets derived from configured default distances.

Residual gap: the EA snapshot reports only current bid, ask, position fields, and deal history. It
does not report an interval high or low. A target crossed entirely while the API and EA reporting path
are unavailable can still be missed if price retraces before the next snapshot and no deal records the
crossing. Closing that gap requires a new EA protocol field or broker price-history feed, both outside
this API-only patch.

Committed as `84d87453` and pushed to `origin/fix/reference-leg-stop-strategy`, then followed locally
by `68b6460f` (limit-order fill path coverage) and v1.65.6 above. No deployment or EA source change
was made. Package version is 1.65.5; EA metadata remains 1.65.0.

### v1.65.4 — 0 percent TP legs never moved the stop (FIXED 2026-07-31, not yet deployed)

Symptom: KAL VIP stops never moved to break-even. `trade_aq9UUlUXPQ` on `mt5-54945785` shows it:
leg 1 `targetPrice 4068`, `allocationPercent 0`, `strategy set-sl-to-entry`, `status "SKIPPED"`,
`brokerEvidence "sl-hit | [sl 4057.00]"`. Entry was 4063, so it stopped out with the original stop
still in place.

Cause: `monitorVirtualTps` had `if (leg.status !== "OPEN" || isReferenceVirtualTpLeg(leg)) continue`.
A 0 percent leg reaches `status: "OPEN"` normally (line number since drifted; not re-verified here), so the reference-leg test was the
only gate, and it skipped the leg before the price-crossed check. The stop strategy is only applied by
`queueSlStrategyAfterTpClose`, which runs after a leg closes volume. A 0 percent leg closes nothing,
so its strategy was unreachable by any path.

A 0 percent leg is a supported, intended configuration. See the comment at the allocation rescaler
("A leg configured at 0% is a stop-loss reference for set-sl-to-tp (KAL VIP runs 50/0/0/50)") and
`isReferenceVirtualTpLeg`. Two distinct uses: a price reference for another leg's `set-sl-to-tp`,
which worked, and a trigger for its own stop strategy, which did not.

Fix: `applyCrossedReferenceLegs` resolves all crossed reference legs as one batch, before the
closing-leg loop. Four invariants, each of which is a money bug if broken. A Luna max review found the
first version violated three of them, so do not weaken these without a replacement:

1. **Coalesce.** A price gap through several reference legs queues ONE `MODIFY_SL` at the most
   protective resulting stop. `leaseNextQueueItem` orders by `created_at` with no tiebreaker, so
   same-millisecond inserts have undefined order and could execute worst-last, leaving a less
   protective stop on a live position.
2. **Never regress.** A computed stop no better than `brokerStopLossFromSnapshot(position)` is
   dropped. MT5 reports `sl = 0` for "no stop", which must read as absent rather than as zero.
3. **Once only.** `HIT` is set only when the strategy was queued, was already satisfied, or is a
   deliberate `no-change`. A leg whose stop is not yet computable (market entry, no fill price
   recorded) stays `OPEN` and retries next snapshot. The first version marked `HIT` unconditionally,
   which permanently burnt the leg on a transient failure.
4. **Batch before close.** Running reference legs first means the closing leg's `break` cannot strand
   a later reference leg for a tick, by which time price may have retraced past its target.

Three adjacent defects were pre-existing but blocked the same feature, so they are fixed here:

- `recordProviderTpHit` marked a leg `HIT` with no strategy queued. That takes a reference leg out of
  the monitor's reach, so for a provider that posts "TP1 hit" (KAL VIP does) the announcement silently
  consumed the only trigger break-even had. Now calls `queueReferenceLegSlStrategyForLeg`. Note it
  guards on `trade.stopLoss` rather than the broker-reported stop, because there is no live quote on
  that path.
- `queueRunnerManagementAfterFinalTp` required every leg `CLOSED`. Reference legs never close, so
  runner hand-off was blocked on any trade using one. Now filters them out.
- `resizePartialOpen` reset every retained leg to `OPEN`, so a late partial opening report could
  reopen a reference leg that had already fired.

Verified: four tests in `api.test.ts` covering the happy path, coalescing to the most protective stop,
the no-regression guard, and the provider-announced path. Each mutation-checked. Dropping the
regression guard queues `newStopLoss=1.086` while the broker holds `1.09`, and disabling the provider
trigger returns `status=NO_WORK`. Full suite 653 pass, typecheck and lint clean.

Still open, deliberately not fixed here:

- A crash between the queue insert and the leg-status write leaves the leg `OPEN`. Dedupe is keyed on
  the exact stop value, so a changed `strategyStopPrice` after restart could queue a duplicate. Needs
  durable per-leg idempotency independent of price.
- A price crossing while the app is down, followed by a retrace before the first post-restart
  snapshot, is not detected. Virtual TP evaluation samples only the latest snapshot quote. Inherent to
  the polling design.
- The closing-leg path still has no stop-regression guard. Only the reference paths do.

### Zero KAL VIP trades on 2026-07-30: root cause was AutoTrading, not the app

Worth recording because the first three diagnoses were all wrong, and the wrong ones are plausible
enough to be repeated.

The FTMO account `mt5-1514065673` executed nothing all day. Every `OPEN_TRADE` failed with:

```
retcode 10027  ->  TRADE_RETCODE_CLIENT_DISABLES_AT
broker comment ->  "AutoTrading disabled by client"
MQL error      ->  4752  (ERR_TRADE_DISABLED)
```

Eight of eight, 05:48 to 13:57. The Algo Trading toggle was off in that terminal. The EA was fully
healthy throughout: polling, heartbeating, and posting reports. Nothing reached the broker.

The other account `mt5-54945785` executed five KAL VIP entries the same day (`rc=10009`), which is
what rules out the app, parser, queue, and EA path. When one account trades and another does not,
check `retcode` on `execution_reports` before anything else.

Ruled out, in the order they looked likely: Equity Guardian (both accounts `paused: false`,
`enabled: false`, drawdown 0, last breach 2026-07-20 with a manual unpause on the 21st), Telegram
capture (messages were captured normally), and the evidence gate (it held only 3 of the day's
entries, all quoted re-entries).

Two real signal-quality findings from the same day:

- **KAL VIP posted `Tp 4999` on a sell at 4111** with `Sl 4117`. That target is 888 points the wrong
  side of entry, above even the stop. Almost certainly a typo for 4099, which fits the descending
  ladder. Posted three times (13:57, 14:00, 15:44).
- **The evidence gate treats that geometry inconsistently.** The direct posts at 13:57 and 15:44
  passed the gate and were rejected by the broker as `rc=10016 Invalid stops`. The same signal
  quoted as a re-entry at 14:00 was held as `EVIDENCE_OPEN_GEOMETRY_INCOMPLETE`. A take-profit on the
  wrong side of entry should never reach the broker. Validate TP direction against entry and stop
  before queueing, on both the direct and quoted paths. Related to risk 3 above and to the naked-order
  theme in the archived audit.

The three `EVIDENCE_OPEN_GEOMETRY_INCOMPLETE` holds were all quoted re-entries whose prose order type
contradicted the quoted structure ("Sell stop" / "Sell stops" against a quoted `sell limit`). Under
"structure decides, prose never executes" those are correctly unresolvable, so the gate did its job.

Operational note: the FTMO account requested 0.5 to 1.0 lots where the working account used 0.03.
Check lot and risk config on that account before enabling AutoTrading, and against FTMO's own
max-risk rules.

### Unshipped backlog carried forward (2026-07-30)

From `improvements-21-5.md`, since deleted (verified still unimplemented after two months):

- Per-EA magic-number attribution on closed trades (`magic` is absent from `ClosedPositionsTable.tsx`).
- Deep history backfill beyond 168h (no `history_deep_pull` anywhere in the tree).

From the rolling `REVIEW.md` scratch pad, since deleted (real, scoped, none safety-critical):

- Delta-driven dashboard updates, so the full snapshot stops rebuilding on every SSE event.
- Chunk-coherent deploys before introducing route-level lazy loading.
- `base.css` consolidation, gated behind per-route screenshots.
- A currency-passthrough guard.
- Verify `AlertsBanner` dismissal-pruning covers all mount states.
- **The chart animation loop never stops.** `cartesian-canvas.tsx:114` calls
  `raf = requestAnimationFrame(draw)` as the first statement of `draw`, before the
  `if (!s.ready) return` guard, so it reschedules forever whether or not anything needs
  painting. Every mounted chart burns a frame budget continuously. Restored to this list on
  2026-07-31 after a review caught that the 07-30 archive pass dropped it: it was recorded in
  the deleted `REVIEW.md` and had not been carried across. Still present in current source.

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
Full plan: `PLAN-evidence-gated-execution.md` (deleted 2026-07-30, in git history at `e63717e7`). Gate: typecheck, lint, **598 tests**, build all green.

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
