# Changelog

## 1.67.1 - 2026-08-02 (Patch)

Release impact: Patch. One new refusal on an existing endpoint. No API shape change, no database
schema change, no parser change and no EA change, so the EA stays at 1.67.0 and no live terminal
needs a recompile or reattach. Nothing in the deployment or environment changes.

- Requeueing a held close or cancel is now refused once the idempotency key it would replay is more
  than 21 days old. `requeueQueueItem` mints a new queue row but keeps the payload's existing key,
  and `recoverStaleLeases` sends every leased lifecycle command to `HELD/DELIVERY_UNKNOWN`, so an
  operator could replay a key at any age. That key is the name of the EA's duplicate guard. Past the
  guard's life the replay lands as a fresh command and the EA can close or cancel a second time.
  1.67.0 left this open on the EA side deliberately, noting that the bound belongs in the app.
- The 21 days come from the EA rather than from a round number. MQL5 deletes a terminal global
  variable four weeks after its last use, and a `CANCEL_PENDING` mark carries ticket 0, so the EA
  never tracks, refreshes or adopts it and its whole life is those 28 days. Subtracting one 7-day
  refresh cycle leaves 21 and gives the requeued command a week to reach a terminal that is off when
  the operator clicks. The derivation sits next to the constant in `apps/api/src/app.ts`.
- The ceiling covers only the three command types the EA actually marks: `CANCEL_PENDING`,
  `CLOSE_TRADE` and `CLOSE_PARTIAL`. Stop management carries no mark and stays releasable at any
  age, as do app-managed virtual-TP closes, which carry no key of their own and get a fresh one on
  every requeue.
- Age is measured from the queue row that minted the key, not from the held row. Requeue keeps the
  key while creating a younger row, so measuring the held row would have let an operator walk a
  command past the ceiling in a chain of shorter hops.
- The refusal is a 409 naming the command type, the key's age and the limit, and it writes a
  `queue.requeue-refused` audit entry against the operator. Nothing is queued and the item stays
  `HELD`, so it can still be dismissed and reissued as a fresh command after reconciling the broker
  position. Auto-release on guardian unpause and on EA reconnect is unaffected: both cap age at 60
  and 15 minutes respectively, far inside this ceiling.

## 1.67.0 - 2026-08-02 (Minor)

Release impact: Minor because EA behaviour changed. This release requires an EA recompile and
reattach. Build `mt5/TelegramTC_EA.mq5` from this commit in MetaEditor and reattach it to the
chart. The command contract, capability strings, API shape, parser and database schema are all
unchanged, so an old EA keeps working exactly as it does today, including the leak below. There
is one upgrade note: the recompile changes the name every idempotency mark is stored under, and
while the new EA still reads the old names, prefer recompiling when the account is flat.

- **EA recompile and reattach required.** Until a terminal is rebuilt it keeps the old behaviour.
- Lifecycle idempotency marks are now reclaimed. `MarkLifecycleExecuted` writes a terminal global
  variable per lifecycle command and per ticket so a redelivered close cannot close twice, and
  nothing ever deleted one: the set grew with trading history and drained only on the terminal's
  own four-week expiry. A mark is now deleted once the position it guards has been absent from the
  broker for five minutes, which bounds the set by live work instead of by history.
- Reclamation cannot drop a mark that is still needed. A ticket-scoped mark is only ever read for a
  ticket `CollectPositionTickets` returned, and that function only returns positions the terminal
  can still select, so a mark for a closed position can never be consulted again. The five-minute
  window and a connection check keep a reconnect blip from reading as a closed position.
- Marks are scoped to the account that wrote them, and a mark is deleted only when this EA wrote it
  in this session. Terminal global variables are shared by every account a terminal logs into, but
  position tickets are not, so without this a switch to a second account read the first account's
  open positions as closed and deleted their marks: switching back left live positions with no
  duplicate-close protection at all. Reclamation is now positive. Rather than trying to prove a mark
  belongs to somebody else and deleting whatever fails the test, the EA deletes only what it can
  prove is its own, which makes cross-account deletion impossible by construction rather than
  dependent on reading an account back out of a name. Marks left by an earlier session are still
  adopted so their weekly refresh continues, but adoption grants the right to extend a mark's life
  and never to end it.
- An account is identified by login, server and company together. The same account number at two
  brokers is a real configuration, so a login-only identity would have collided every time rather
  than rarely. That identity scopes the hash, so a name computed on one account cannot match a mark
  written on another, and every removal decision compares it exactly. A mark whose account is not
  the current one is skipped and kept, not dropped, so returning to that account resumes where it
  left off without needing a reinitialisation, and an owned mark keeps being refreshed even while
  the terminal sits on another account.
- Nothing is adopted when the terminal reports no account login yet, which would otherwise have
  matched every mark written under the same blank identity. `OnInit` runs before the terminal has
  necessarily resolved an account, so adoption now retries on the timer until a real login appears
  instead of being skipped for the whole session, which would have left every mark from the
  previous session unrefreshed until it expired.
- A disconnection no longer stops marks being refreshed. Rewriting a terminal global needs no
  server connection; only deciding that a position is gone does. Both were behind the same gate, so
  a long disconnection stopped every refresh, and the refresh clock itself ran on server time,
  which stops advancing while disconnected. Refresh now runs on local time and is not gated on
  connectivity; reclamation still requires both a connection and a live-position check.
- Reclamation no longer reads a clock. A mark is deleted after its position has been absent on ten
  consecutive sweeps rather than for five minutes, so a backward wall-clock correction, whether an
  NTP step or a manual change, cannot collapse the window and delete a mark guarding a live
  position. Refresh still uses elapsed time, which is safe at a three-week window where five
  minutes was not, and a backward jump there now reads as due rather than as not yet due.
- A full mark registry is reported rather than passed over. A dropped registration used to be
  invisible: the mark still guarded its trade, but nothing refreshed it and it expired at four weeks
  with the position still open, while adoption counted it as a success and never retried. Adoption
  now counts only what it tracked, retries while anything is outstanding, and a mark this session
  wrote takes the last slot ahead of one adopted from a previous session, since adoption is what
  fills the registry and live positions never will.
- The poll interval is clamped in the EA. It drives the only timer, so it is also the refresh
  cadence, and a startup value beyond the four-week expiry meant the sweep never ran in time to
  save a mark. The backend caps what it sends but cannot correct the interval before the first
  timer event.
- `CANCEL_PENDING` marks are no longer reclaimed on a timer. They carry no ticket to watch, and a
  held item can be requeued by an operator at any age carrying its original idempotency key, so
  there is no age at which the EA can say the mark is finished with. They keep the pre-1.67
  behaviour: the terminal expires them after four weeks without a read, and a read renews that, so
  one still being consulted survives. This is the one category still bounded by cancel volume rather
  than by live work, at one variable per cancel command. Putting a maximum age on requeue would
  bound it properly, and that belongs in the app rather than the EA.
- The mark name can no longer be truncated. MQL5 caps a global variable name at 63 characters and
  keeps only the first 63; the name was built by pasting the backend's idempotency key in plaintext
  and cutting the result to 63. Today's keys are 16 characters and cannot reach the cap, but a
  close or cancel carrying one of the longer app-managed keys, which are already 48 to 50
  characters and today only ever attach to `MODIFY_SL`, would have pushed the ticket out of the
  name entirely and made every position under one command share a single mark. The first close
  would then have been recorded and every other position silently skipped, and a silently skipped
  close is an unmanaged position. Every component of the name is now fixed width except the ticket,
  which a `ulong` bounds at 20 digits, holding the whole name to 60 characters at absolute worst
  whatever the backend sends.
- A mark guarding a position that stays open for more than four weeks, a runner for example, is
  rewritten weekly so the terminal's inactivity expiry cannot delete it while it is still needed,
  and only a rewrite the terminal confirmed advances the clock.
- Marks survive a terminal restart as they always did, and the EA now adopts the ones a previous
  session left behind on startup so they are reclaimed rather than orphaned. Adoption validates
  every segment of the name, so a variable that merely starts with the reserved prefix is left
  alone.
- **Positions open for more than four weeks lose duplicate-close protection during the transition.**
  Marks written by an EA older than 1.67.0 are still read, so a close executed just before the
  recompile keeps its protection. Those older names carry no account, so this release deliberately
  never adopts, refreshes or deletes one: acting on them would mean acting on a mark that may belong
  to another account, which is the failure above. They therefore rely on the terminal's four-week
  expiry, which renews on every read. A position that stays open beyond four weeks with no lifecycle
  command against it in that time loses its pre-upgrade mark. Recompiling when the account is flat
  avoids this entirely.
- A full mark registry no longer stops a mark being recorded. The global variable is written first
  and the bookkeeping second, so the worst case is that one mark waits for the terminal's expiry
  instead of the sweep, which is exactly the old behaviour.

## 1.66.2 - 2026-08-02 (Patch)

Release impact: Patch. Test seam and encapsulation only. No runtime behaviour change, no API change,
no database schema change, no parser change and no EA protocol change, so the EA stays where it is and
no live terminal needs a recompile or reattach. Nothing in the deployment or environment changes.

- The Telegram adapter's session-keyed state is now unreachable from outside the class. `pending`,
  `clients`, `sessionClients`, `sessionEpochs`, `sessionFileEpochs`, `unremovedSessions`, `teardowns`
  and `sessionFileLocks` are ECMAScript `#`-private fields, along with the write sequence, the session
  directory and the client factory. Everything that decides which client an RPC reaches, or whether a
  session may be restored at all, is covered. Seeding any of it from a test is now a runtime
  TypeError.
- The nineteen methods that read or publish that state are `#`-private too, `publishedClient` and
  `connectedClient` among them. Private state alone was not enough: a method left on the prototype is
  shadowed by an own property of the same name, so assigning `publishedClient` on an instance handed
  `fetchRecentMessages` any client the caller liked, with no login and no session. That is the
  original bypass one door along, and it worked until this release. `this.#publishedClient()` resolves
  a private name rather than a property, so the assignment is ignored and the call falls through to
  the real path.
- The three helpers that only touch the dialog-entity cache and the contact timestamps stay
  TypeScript-private, as do the two caches themselves. They hold values, not identity, so priming any
  of them could never stand in for a login.
- The reply-capture and pagination tests sign a client in through `startLogin` and `submitCode` rather
  than writing one into the adapter's client map. They use the client factory `createTelegramAdapter`
  already accepts, so they drive the real login path with no socket. This is the shape that let the
  same post-login lookup defect ship four separate times: a test that seeds a client never runs the
  code that publishes one, so the defect was fixed for the seeded case each time and stayed broken for
  the real one. Removing the login registration from the adapter now fails ten of these tests, where
  before it failed none of them.
- Three guards replace the review rule that was supposed to prevent this and did not. They assert the
  adapter's private members are exactly the thirty that must stay unreachable, that none of them
  answers to its name on an instance or on the prototype, and that no call site reaches one by
  property name. Reverting any one of the thirty to `private` fails at least one guard, which was
  checked by doing it thirty times. The old check could not manage that: it was a grep whose pass
  condition was "no output", so a misspelt identifier and a clean codebase looked identical, and it
  reported clean for weeks with the banned pattern in the file.
Release impact: Patch. Test-only, so no shipped code changed. The EA stays on 1.66.0, no terminal needs
a recompile, and there is no API, database, parser, or protocol change.

- Fixed the intermittent failure in `AccountHeader.test.tsx` that fired on a loaded machine and passed
  in isolation. The cause was in the test, not the component. Both waits were written as
  `waitFor(() => expect(view.queryByLabelText("Account name")).toBeNull())`, and `waitFor` runs its
  first poll synchronously, before the microtask that commits the rename. That first poll therefore
  always failed, and a failing bun matcher whose received value is a live happy-dom element serialises
  the whole attached document into its failure message, which measures at about 2.7s of CPU per call.
  The wasted poll, not the component, was the entire wait.
- Both waits now drive the component's own async boundary with `act()` and assert synchronously
  afterwards. The assertions are unchanged: after saving, the rename field is gone. Nothing now depends
  on a clock, so machine load cannot move the result. The file went from 8 to 10 seconds, with observed
  failures at 10.4s, 16.9s, 17.4s, 23.5s and one run of 200s, to a steady 0.8 to 1.1 seconds at a load
  average of 530 on 8 cores.
- Removed the 15 second per-test budget, which was the only per-test budget in the web suite. The test
  no longer needs one, and a genuine regression now surfaces as the assertion that failed rather than
  as an opaque timeout.
Release impact: Patch. App only. No EA protocol change and no parser change, so the EA stays on 1.66.0
and no live terminal needs a recompile or reattach. One additive table, `provider_tp_announcements`,
is created on startup; nothing existing is altered or backfilled. `GET /api/dashboard` gains a
`providerAnnounced` boolean on each logical-trade leg. Trades already carrying a provider-announced
`HIT` keep it: this release changes what new announcements write, and does not rewrite history.

- Fixed a provider take-profit announcement marking a volume-closing leg `HIT` on message text alone.
  `MARK_TP_HIT` queues no command, so nothing had closed, and `HIT` is what the virtual-TP monitor,
  cancellation, readopt, archive and startup recovery all read as already dealt with. The leg left the
  monitor's reach still holding its full volume, so when price later reached that target the app
  queued no close and the volume rode on to the stop. Two announcements on a two-leg trade took both
  legs out, and the position closed at a loss having reached both of its targets.
- A volume-closing leg now stays `OPEN` when the provider announces it. The announcement is recorded
  in its own ledger instead, and the price monitor stays the only thing that can retire the leg, so a
  real crossing still produces a real close. A `0%`-allocation reference leg is unchanged: it closes
  no volume, so its stop work being queued or already satisfied is still the completed work, and it is
  still consumed once and only once.
- Which leg a bare announcement lands on now comes from the announcement ledger rather than from leg
  status. Leg status used to double as that pointer, which only worked because an announcement burned
  a leg. A second bare announcement now advances to the next leg without anything having been
  falsely recorded.
- Also fixed a `Full TP` announcement pulling a leg that had a genuine broker close booked against it
  back from `CLOSED` to `HIT`.
- The dashboard reports each leg's announcement separately from its status, so an announcement that
  correctly retires nothing is still visible on the trade.

## 1.66.1 - 2026-08-02 (Patch)

Release impact: Patch. App only, so the EA stays on 1.66.0 and no terminal needs a recompile beyond the one 1.66.0 already requires. A Telegram disconnect now takes effect against anything that would restore the
session behind it, whether that is a login still preparing, a message poll rebuilding a saved session,
or a legacy session import, and it holds that ground until its session file is gone rather than only
until it has cleared memory. A message poll that lands during a disconnect waits for it to finish and
then finds nothing to restore, instead of failing; the wait is bounded by the disconnect itself. No API
removals, no database schema change, no parser change, and no EA protocol change, so the EA stays on
1.65.0 and no live terminal needs a recompile and reattach. `createTelegramAdapter` gains an optional
second argument, and `TELEGRAM_DISCONNECT_TIMEOUT_MS` and `TELEGRAM_SESSION_FILE_TIMEOUT_MS` are new
optional settings; existing callers and deployments are unaffected. Saved session values keep working,
and a `pending` subdirectory now appears under the session directory where writes are staged.
One behaviour change worth planning for: `POST /api/telegram/disconnect` now fails, rather than
reporting success, when the session file cannot be removed, and leaves the session's stored status
alone so nothing records a disconnect that did not happen. Retrying it once the filesystem allows the
removal completes the disconnect.

- Fixed a race where disconnecting a Telegram session during login restored it. `startLogin` did all
  of its slow work first, reading the saved session, building the client, and on phone reuse
  connecting and calling `isUserAuthorized`, and only then registered the session in the adapter's
  maps. A disconnect arriving in that window found nothing to remove, so it unlinked the session file
  and returned success while the login went on to rewrite that file and install its client. The
  operator saw the session as disconnected and the account stayed logged in and polling.
- Every session id now carries a lifecycle counter that `disconnect` advances in its own synchronous
  prefix, before its first await. Anything that would put the session back, a login, a message poll
  restoring a saved session, or a legacy session import, reads that counter before its awaits and
  refuses to publish once it has moved, with the check in the same turn as the state it guards.
  Disconnect wins in every case, including for callers that hold no login at all.
- A message poll arriving on a cold cache used to rebuild the session with no cancellation check
  anywhere along it: with `TELEGRAM_SESSION_FILE` configured, a poll whose legacy read was in progress
  when the operator disconnected would copy the session file back and install a connected client
  afterwards. It now abandons the restore and closes the client it had already connected.
- Two logins racing on one session id are both retired by a single disconnect. Previously only the
  later of the two was tracked, so the earlier one survived and restored the session.
- A message poll that started while a disconnect was still tearing the session down could put an
  authorised client back. The lifecycle counter could not stop it, because the poll started after the
  counter moved and so held the disconnect's own value: it read the session file that was still on
  disk, passed every check with a value nothing had invalidated, and installed a client that the same
  disconnect then left running with its session file deleted. On infinite retries that client
  reconnects for the life of the process with nothing on disk to explain it. A session id is now
  closed to session restores from the moment a disconnect starts until its session file has gone, and
  a restore that arrives in that window waits the disconnect out and then finds nothing to restore.
  The window is closed even when the teardown throws or is cut short by its timeout, so a failed
  disconnect cannot leave a session refusing work.
- `disconnect` waits for every session-file write in flight before it unlinks, not just the most
  recent one, and it clears the in-memory client and pending login even when the client teardown
  itself fails or hangs. That ordering now comes from a single lock on the session file, which also
  covers the gap between deciding not to remove a file and removing it: a login that saved its own
  session in that gap used to have it deleted underneath. The unlink under `data/telegram-sessions`
  remains the only place a session file is removed.
- A session file is recorded as belonging to a login only once its bytes are on disk. Recording it
  first meant a write that then failed still counted, and the disconnect spared the earlier file
  believing it had been replaced, leaving a disconnected account for the next boot to re-import.
- A session file the disconnect could not remove is no longer treated as removed. The removal's
  failure used to be discarded and the ownership record dropped before it was even attempted, so a
  permission or IO problem produced a successful disconnect over an authorised session still sitting
  on disk with nothing recorded against it, and the next message poll adopted it. A file that is
  already gone still counts as removed; anything else fails the disconnect, keeps the ownership
  record, and puts the session id out of service until the file is genuinely gone or a login has
  replaced it. The refusal is immediate rather than a wait, so a session that cannot be cleaned up
  never holds a caller open.
- A disconnect now closes every client the session id has open, not only the most recent. Two logins
  on one id share a single pending slot, so the second displaced the first and the first client stayed
  signed in and reconnecting after the operator disconnected, with no session file to explain it.
- Writing the session file is bounded, at 10 seconds by default and overridable with
  `TELEGRAM_SESSION_FILE_TIMEOUT_MS`. A write that never returns used to hold the session's file lock,
  and with it the disconnect queued behind it and every message poll waiting on that disconnect, for
  the life of the process. A write that passes the bound claims nothing and leaves the session
  restorable, so a slow filesystem costs a login rather than the session.
- Session files are now written to a staging file under `data/telegram-sessions/pending` and renamed
  into place, so the session file is only ever whole or absent. The bound above is a timeout on a
  race, and a race does not stop the work it gave up on: a write in place could still finish
  afterwards and leave a valid session on disk for an id whose disconnect had already completed,
  putting the account back. A write that has been abandoned can now only finish onto a staging name
  that nothing reads, and the rename happens only once the write is seen to finish. A restore also can
  no longer read a half-written session.
- Removing the session file is deliberately not bounded. The same race that makes an abandoned write
  safe once it has a target of its own cannot make an abandoned removal safe, because a removal's
  target is the live session path: it would land later and delete the file of whichever login had
  replaced the session by then. A removal that never returns instead holds the session's file lock,
  which is where it was held before this release.
- `disconnect` no longer deletes a session file that belongs to a login which started after it. That
  used to leave a signed-in account whose saved session was gone, which the next restart lost for
  good.
- A transport that hangs while closing no longer holds the disconnect open. The teardown is bounded at
  10 seconds, overridable with `TELEGRAM_DISCONNECT_TIMEOUT_MS`, after which the session file is
  removed anyway. A hung close used to leave the file on disk for the next boot to re-import and
  re-authorise, and left the operator's request waiting.
- Left EA source metadata at 1.65.0 because this patch does not change EA behaviour or protocol.

## 1.66.0 - 2026-08-02 (Minor)

Release impact: Minor because EA behaviour changed. This release requires an EA recompile and
reattach. Build `mt5/TelegramTC_EA.mq5` from this commit in MetaEditor and reattach it to the
chart before relying on trailing stops. The command contract, capability strings, API shape and
database schema are all unchanged, so an old EA keeps working exactly as it does today, including
the defect below.

- **EA recompile and reattach required.** Until a terminal is rebuilt it keeps the old behaviour.
- Trailing-stop slots are now reclaimed when the position they track closes. `trailingStopStates`
  holds 100 entries and `trailingStopStateCount` only ever grew: a closed position's slot was marked
  inactive but never reused, so after 100 trailing-stop registrations in a terminal's lifetime every
  later `TRAILING_STOP` command silently registered nothing. The one-shot stop still went in, then
  nothing moved it again, leaving live positions with a frozen stop while the app showed trailing as
  active. State is memory-only, so a terminal restart reset the counter and hid the pattern.
- Releasing a slot clears its queue item, logical trade id, symbol, direction, ticket and distance,
  so a recycled slot can never trail a new ticket using a finished position's state. Slots are
  recycled in place rather than compacted, which keeps `ManageTrailingStops` safe: it walks the array
  by index and can release an entry mid-pass without shifting the entries after it.
- A genuinely full slot array now reports `FAILED` on the queue item and prints the count to the
  Experts log instead of returning silently. That only happens with 100 positions trailing at once.

## 1.65.8 - 2026-08-01 (Patch)

Release impact: Patch. A dashboard rendering lifecycle fix plus one virtual-TP leg accounting
correction. No API change, no database schema change, and no EA protocol change, so the EA stays on
1.65.0 and no live terminal needs a recompile and reattach.

- Recorded a broker-rejected take-profit close on the leg it targeted. A virtual-TP leg is marked
  `HIT` the moment its close is queued and `CLOSED` only when the broker confirms the fill, so an
  `Invalid volume` or `Market closed` rejection used to leave the leg sitting in `HIT` with its
  volume still on the position. `HIT` is what the dashboard, an unnumbered provider "TP hit"
  message, cancellation, readopt and startup recovery all read as already dealt with, so the app
  was booking volume the broker had explicitly refused to take off. A rejection is direct evidence
  the close did not happen, and the leg now reads `FAILED`, with a `virtual-tp.close-rejected`
  audit entry naming the trade, leg and position ticket alongside the execution-failed alert the
  report already dispatches. This corrects the record rather than the stranding: a `FAILED` leg is
  skipped by the monitor exactly as a `HIT` one is, and is recovered only once the trade reaches
  `OUT_OF_SYNC` or an operator readopts it. It is deliberately not reopened, because re-queueing
  against a broker that has just refused would send a close per EA round trip. The "position gone"
  rejection keeps its existing terminal handling.
- Parked the chart paint loop when there is nothing to paint. `startCartesianLoop` called
  `requestAnimationFrame(draw)` as the first statement of `draw`, ahead of the `if (!s.ready) return`
  guard, so every mounted chart held a frame at the display refresh rate for its whole life whether or
  not a pixel changed. The loop now schedules the next frame only while something is genuinely in
  motion (the entrance reveal, a surface easing toward new data, the hover lift settling, winking
  stars) and otherwise waits to be woken. Every other paint input reaches the canvas through a React
  commit, and the commit effect that refreshes the loop's refs now also wakes it, so late readiness,
  resize, data changes, accent changes, hover and selection all repaint as before. The account growth
  chart passes `animate={false}`, so it now costs nothing once settled instead of burning a frame
  budget continuously.
- Repaint the dither fill when a series colour or kind changes. The paint signature only tracked the
  stack type and area variant, so a settled chart that switched accent colour or swapped between area
  and line kept the old fill. Previously masked by the loop repainting unconditionally.
- Cancel the outstanding animation frame on teardown rather than a stale handle, and ignore wake
  requests after the loop has stopped.
- Bounded `GET /api/providers/:id/messages` with the same Telegram RPC timeout the ingestion loop
  uses. It called `fetchRecentMessages` unwrapped, so against a wedged client the await never
  settled: the request hung open indefinitely, its own error fallback never ran, and each operator
  retry started another RPC. The timeout rejection lands in the existing `catch`, so the endpoint
  degrades exactly as it already did on a fetch failure. Capture semantics, the backlog cursor and
  `last_message_at` are untouched.
- Closed the last two ways the parked loop could show stale pixels. The paint signature now carries
  each series key, so reordering the chart config repaints: a layer's dither sparsity comes from its
  position in the key list, and two series matching on kind, variant and colour used to produce a
  byte-identical signature after a swap, leaving the cached fill painted in the old order. Animation
  settings are also read per frame instead of being captured when the loop starts, so switching to
  `animate={false}` stops the winking stars and lets the chart park, and a new `animationDuration`
  lands mid-entrance. The entrance reveal stays pinned once it has finished, so turning animation
  back on resumes the sparkle without re-wiping a revealed chart.

## 1.65.7 - 2026-08-01 (Patch)

Release impact: Patch. The Telegram client dependency moves to the maintained teleproto fork and
`/api/health` gains a `degraded` status, both of which leave every consumer contract intact. No API
removals, no database schema change, and critically no EA protocol change, so the EA stays on 1.65.0
and no live terminal needs a recompile and reattach. Saved session values keep working.

- Replaced GramJS with teleproto for the Telegram runtime, and externalized teleproto in the
  production API bundle. `gram-js/gramjs` was archived on 2026-07-14 and `2.26.22` published
  2025-02-12 is its final release, so the client we depended on will never see another Telegram
  protocol update. Saved `StringSession` values load unchanged, verified against a session string
  built from raw bytes rather than round-tripped through teleproto itself. Both `connectionRetries`
  and `reconnectRetries` are now set explicitly to infinite so a future default change cannot
  reintroduce the bounded-retry bug that previously caused silent live-signal loss.
- Debounced missing pending-order cancellation from the first observed absence for each account and
  broker order ticket. The in-memory clock resets when the order reappears and is cleared on fills,
  cancellations, terminal trade states, and account deletion. The existing order-creation grace is
  kept, and cancellation now requires continuous absence past `max(10 seconds, polling interval x 3)`.
  Previously the grace measured age since order creation, so any order older than it was cancelled by
  a single omitted snapshot. That is how a 35-hour-old limit order lost its stop management.
- Rekeyed `reference_stop_actions` rows when a position ticket transition is accepted. Nine sites can
  replace a matched ticket, and without rekeying a reference leg that had already fired left the
  replacement ticket holding a less protective stop, permanently and silently.
- Passed broker point metadata through reference-stop strategy resolution for default-distance TP
  targets, including the post-close and runner `last-tp` paths. Instruments whose broker point
  differs from the pip fallback, such as index CFDs, previously resolved those stops to roughly entry.
- Made same-time stop ordering fall back to the logical trade direction when a payload omits it, so a
  SELL tie can no longer execute protective-first.
- Labelled the SQL migration file as a historical bootstrap snapshot; the runtime schema in
  `apps/api/src/app.ts` remains the source of truth.

## 1.65.6 - 2026-07-31 (Patch)

Release impact: Patch. Restores stop management on a revived trade and adds snapshot liveness
reporting. No API removals, no parser change, no EA protocol change.

- A pending order that disappears from one snapshot has its trade cancelled and every unresolved
  leg marked `SKIPPED`. When the broker later fills that order the trade revives to `OPEN`, but the
  leg map only promoted `PLANNED` legs, so the skipped legs stayed skipped for the trade's whole
  life. Every virtual-TP gate keys on a leg being `OPEN`, so the evaluator ran on every snapshot,
  wrote its watermark, and silently discarded the legs. A live gold trade crossed its break-even
  trigger by 7 points with the stop never moving. Legs skipped by a cancellation now reopen when a
  real open deal proves the cancellation wrong.
- Added `lastSnapshotReceivedAt` and `snapshotAgeSeconds` per account on `GET /api/mt5/accounts`.
  `mt5_snapshots.updated_at` has been a structural-change watermark since v1.52.1 and stops moving
  while the book is idle, which is not a liveness signal. The new fields are in-memory only and add
  no write to the snapshot path.

The `/api/health` Telegram readiness contract is built: enabled providers define expected ingestion,
status reads `degraded` when any expected provider is not ready, HTTP stays 200, and the `telegram`
object reports `expectedProviders`, `readyProviders`, `unreadyProviders`, and `stalledProviders`.

## 1.65.5 - 2026-07-31 (Patch)

Release impact: Patch because this hardens the existing virtual-TP stop workflow without changing
the API or EA protocol. The SQLite action table is additive and created automatically on startup.

- Added durable per-leg reference-stop actions. The queue insert and leg `HIT` transition now commit
  together, and live snapshots repair an `EXECUTED` command whose stop is absent or replay the same
  delivery-unknown `HELD` or stale `LEASED` command.
- Persisted each trade's most favorable observed quote so a sampled crossing survives a crash or
  restart. A remembered crossing waits until the desired stop is valid relative to the current bid or
  ask before it queues work.
- Made every virtual-TP fixed-stop path compare against the live broker stop and active stop work for
  the same position ticket. MT5 `sl = 0` remains an absent stop for BUY and SELL positions.
- Coalesced provider full-TP reference actions at the most protective stop, preserved unresolved
  reference legs in every status, selected only the original `OPEN_TRADE` plan, and ordered
  same-time stop work so the most protective command executes last.
- Made `set-sl-to-tp` resolve referenced targets derived from default distances as well as explicit
  Telegram prices, so those stop strategies no longer remain permanently uncomputable.
- Added restart compatibility for v1.65.4 trades whose reference legs were already `HIT` before the
  durable action table existed.
- Restricted the already-satisfied stop skip to app-generated strategies. A provider or operator
  `MODIFY_SL` can deliberately widen a stop to give a trade room, and the skip was swallowing those
  and recording them as executed without ever sending them to the EA.
- Recorded a provider-announced take-profit hit on the trade's favorable-price watermark when the
  desired stop cannot be placed yet. The announcement is durable evidence that the target was
  reached, and discarding it meant break-even was never applied after a crossing seen only while the
  app was down.
- Left EA source metadata at 1.65.0 because this patch does not change EA behaviour or protocol.

## 1.65.4 - 2026-07-31 (Patch)

Release impact: Patch because this restores intended stop-management behaviour without changing API,
parser, database, or EA contracts. `MODIFY_SL` is an existing command the EA already handles.

- A take-profit leg allocated 0 percent now applies its own stop strategy when price reaches its
  target, without closing any volume. This is how break-even is configured when the operator does not
  want to give up a partial at TP1, and the virtual-TP monitor was skipping those legs entirely, so
  the stop stayed at the provider's original level for the life of the trade.
- Crossed reference legs are resolved as one batch before any volume-closing leg, so a price gap
  through several of them queues a single stop modification at the most protective resulting level.
  The queue is read in `created_at` order with no tiebreaker, so two commands in the same millisecond
  could otherwise have executed worst-last and left a less protective stop on a live position.
- A reference strategy is dropped when it would not improve on the stop the broker already reports,
  so a late or out-of-order leg can no longer widen risk on an open position.
- A reference leg is marked `HIT` only once its strategy was queued, was already satisfied, or is a
  deliberate no-change. A leg whose stop price is not yet computable, such as a market entry with no
  fill price recorded, stays open and is retried on the next snapshot instead of being consumed.
- A provider-announced take-profit hit now also applies a reference leg's stop strategy. Marking the
  leg hit had taken it out of the monitor's reach, so for providers that post "TP1 hit" the
  announcement silently consumed the only trigger break-even had.
- Runner hand-off no longer waits for reference legs to close, which they never do, and a late partial
  opening report no longer reopens a reference leg that has already fired.
- Left EA source metadata at 1.65.0 because this patch does not change EA behaviour or protocol.

## 1.65.3 - 2026-07-30 (Patch)

Release impact: Patch because this improves operator feedback and corrects reconciliation styling
without changing API, execution, parser, database, or EA contracts.

- Replaced the bright dashed out-of-sync resolution border with the standard card divider.
- Added an explicit disabled `Dismissing…` state while bulk held-signal dismissal is completing.
- Left EA source metadata at 1.65.0 because this patch does not change EA behaviour or protocol.

## 1.65.2 - 2026-07-30 (Patch)

Release impact: Patch because this corrects table density and clipping without changing API,
execution, parser, database, or EA contracts.

- Reduced shared data-table horizontal padding and aligned row headings to the 12px table scale so
  dense provider and performance columns use the available desktop width.
- Corrected the performance attribution table wrapper sizing so its 16px side margins no longer
  push the rightmost realised P/L column behind the clipped panel edge.
- Left EA source metadata at 1.65.0 because this patch does not change EA behaviour or protocol.

## 1.65.1 - 2026-07-29 (Patch)

Release impact: Patch because this corrects responsive presentation and removes redundant provider
summary content without changing API, execution, parser, database, or EA contracts.

- Reflowed held-signal rows into compact two-column cards on narrow screens, hid lifecycle release
  buttons until a target trade is selected, and changed machine-style review reasons into readable
  supporting text.
- Kept the compact Symbol Mapping table inside the viewport by prioritising provider symbol, broker
  symbol, status, and actions on narrow screens.
- Removed the duplicate provider-health card strip from the all-account Providers page while
  retaining health cards in account-specific Provider views.
- Left EA source metadata at 1.65.0 because this patch does not change EA behaviour or protocol.

## 1.65.0 - 2026-07-29 (Minor)

Release impact: Minor because this adds a backward-compatible bulk review workflow while keeping
the existing API, execution, parser, database, and EA contracts unchanged.

- Added a confirmed Dismiss all action that uses the existing audited per-signal dismissal path and
  reports partial failures instead of hiding them.
- Made top-level Logs a standalone review view and condensed the held-signal table from ten columns
  to six so row actions stay visible on desktop.
- Replaced raw chart epochs and repeated day-only ticks with bounded date-and-time labels, and fixed
  provider action cells to use theme tokens instead of a hard-coded dark fallback.
- Kept the EA source version metadata aligned at 1.65.0; no EA behavior or protocol changed.

## 1.64.5 - 2026-07-29 (Patch)

Release impact: Patch because this corrects route presentation without changing API, execution,
parser, database, or EA contracts.

- Made top-level Providers and Symbols standalone Setup views without the unrelated dashboard tab
  strip or operational alert banner.
- Preserved account workspace navigation on account-specific Provider routes.

## 1.64.4 - 2026-07-29 (Patch)

Release impact: Patch because this removes redundant presentation and standardises existing controls
without changing API, execution, parser, database, or EA contracts.

- Removed the repeated account summary from secondary routes so Providers, Performance, Guardian,
  Logs, and Symbols begin with their actual content.
- Moved provider export beside its explanatory copy and flattened provider monitoring and Telegram
  setup status into compact rows instead of one-purpose card sections.
- Standardised segmented controls, compacted the statistics toolbar, simplified Symbol Mapping
  framing, and replaced the glowing growth chart with a shorter monochrome plot.

## 1.64.3 - 2026-07-29 (Patch)

Release impact: Patch because this reduces presentation density and redundant framing without
changing API, execution, parser, database, or EA contracts.

- Compacted the shared account summary and workspace spacing so secondary-route content sits above
  the fold on full-screen displays.
- Removed redundant Settings, Providers, and Telegram panel headers and flattened nested page
  shells while preserving their existing controls and accessible labels.
- Reduced empty-state and panel padding, aligned Settings section icons with their headings, and
  restored a single-column Settings layout on compact screens.
- Shifted light mode to a warmer neutral canvas with quieter shadows while preserving the requested
  SF Pro type, text hierarchy, icon sizes, and radii.

## 1.64.2 - 2026-07-29 (Patch)

Release impact: Patch because this standardises presentation and controls without changing API,
execution, parser, database, or EA contracts.

- Applied the Settings type, colour, spacing, card, and responsive containment system to
  Operations, Logs, Providers, Symbols, Telegram, History, Performance, and Equity Guardian.
- Replaced route-specific numeric, boolean, and two-or-three-way controls with the shared number
  field, switch, and segmented control components.
- Kept wide tables and ledgers inside their own horizontal scrollers and preserved direct panel
  children so desktop and mobile insets remain intact.

## 1.64.1 - 2026-07-29 (Patch)

Release impact: Patch because this changes only presentation, density, and responsive layout
without changing API, execution, parser, database, or EA contracts.

- Expanded the centred desktop content canvas from 880px to 1180px while preserving the existing
  compact and mobile layouts.
- Standardised the interface on SF Pro regular and medium, a 12px/13px/14px/24px type scale,
  -0.15px tracking, and the requested light-mode text hierarchy.
- Restored 14px navigation icons and aligned card icons, card corners, navigation corners, and CTA
  pills to the new sizing and radius system.

## 1.64.0 - 2026-07-29 (Minor)

Release impact: Minor because this adds backward-compatible Settings controls and dirty-state
workflow without changing API, execution, parser, database, or EA contracts.

- Added the canonical light/dark token layer and mapped the legacy palette names onto it.
- Rebuilt Settings with reusable switches, stepped number fields, live risk thresholds, segmented
  choices, and a discardable dirty-state save bar.
- Centred the application content in an 880px column with the new 264px shell and card treatment.
- Added focused control and Settings dirty-state regression coverage.

## 1.63.1 - 2026-07-29 (Patch)

Release impact: Patch because this only corrects console presentation and panel layout without
changing API, execution, parser, database, or EA contracts.

- Replaced plain top-bar dots with green sync/Telegram and blue database icon treatments while
  keeping mock, offline, and failure states amber or red.
- Standardised panel-level controls in panel headers across Settings, History, Logs, Providers, and
  Symbols.
- Removed the tab-content wrapper that bypassed direct-child panel inset rules, with a regression
  check for tabbed panel content.

## 1.63.0 - 2026-07-29 (Minor)

Release impact: Minor because suppressed duplicate signals now appear in the held-queue API and UI
with an explicit non-actionable state. The MT5 command contract is unchanged, so no EA recompile is
required; its source version moves only to stay aligned with the app.

- Stopped parked `HELD` opens from suppressing fresh provider posts while preserving in-flight and
  live-trade duplicate protection.
- Kept real Telegram re-ingestion idempotent through raw-message conflict handling and
  parse-only-unparsed selection, without widening fingerprint dedup to suppress genuine reposts.
- Rejected ordinary lifecycle prose such as `entries` as an instrument while preserving the
  provider cancel command and configured symbol fallback.
- Treated unmapped held lifecycle symbols as absent during release, while retaining genuine
  cross-instrument mismatch rejection.
- Surfaced `DUPLICATE` queue rows as suppressed, dismissible, and never releasable.
- Added mutation-checked parser, API, re-ingestion, release-safety, and held-table regressions.

## 1.62.0 - 2026-07-28 (Minor)

Release impact: Minor because Telegram ingestion now exposes a resumable backfill workflow. No EA
recompile is required for this release. The EA source version string moves with the release line but
no EA behaviour, command contract, or capability string changed. The recompile still outstanding is
the one v1.61.0 asked for, whenever it suits.

Fixes silent permanent signal loss after a capture outage. A single poll fetched one page of 50
messages, newest first, then advanced the provider watermark to the newest of them, so everything
older in the gap was never fetched again.

- Paginated Telegram drains backwards through the backlog until they reach the provider watermark,
  bounded by page, message, and time budgets.
- Added a resume cursor and a floor so a backlog too large for one poll continues on the next one
  instead of being skipped. The floor is the watermark as it stood when the backlog opened, and the
  backfill drains down to it. Both clear once the backlog is fully drained.
- Split ingestion into a live pass and a backfill pass, live first, so capturing new signals is
  never starved behind a backfill.
- The provider watermark now only ever moves forward, so an older backfill batch cannot drag it
  back and re-open a gap that was already closed.
- A second outage keeps the older floor and takes the newer resume point, so a fresh truncation
  cannot discard an outstanding backlog.
- Collapsing duplicate provider rows carries the outstanding backlog across instead of dropping it.
- A message already folded into another message's anchor no longer returns as a row of its own when
  a pass boundary separates it from that anchor.
- A truncated drain reports the un-fetched window and audits it, including when the truncated pass
  captured no text at all.
- The page and message caps bound a poll, not every caller, so a dated bulk import is no longer
  silently cut to the poll's budget.

## 1.61.0 - 2026-07-27 (Minor)

Release impact: Minor because the EA gains an input and must be recompiled and reattached. The command contract and capability strings are unchanged.

- **EA recompile and reattach required.** Build from this commit before relying on the new setting.
- Added the `TradeComment` EA input, a dropdown choosing what the BROKER sees in the order comment: `Tagged` (`ttc:<id>`, the default and previous behaviour), `Hidden` (no comment), or `Custom` (operator text from `CustomTradeComment`). Suffixes are tagged-mode only, so hiding can never leak a bare `:close` or `:tp1` and a custom label is never corrupted; custom text is stripped of any stray `ttc:` and truncated to the MT5 comment limit.
- The logical trade id is now written to the Experts log at every open, TP and close regardless of the mode chosen, so what the broker sees never changes what can be reconciled. This matters because the tag is the backend's FIRST attribution key: it falls back to the position then order ticket in `broker_orders`, and the EA identifies its own deals by magic number, but hiding the tag removes the last-resort path and this log line becomes it.
- Alerting now defaults to off. It cannot deliver without a bot token and chat ID, and defaulting the toggles on presented an enabled channel that silently discarded every message.
- Settings explains how to obtain a bot token from @BotFather and how to read a chat ID from getUpdates, including the sign convention for direct messages versus groups and channels.

## 1.60.1 - 2026-07-27 (Patch)

Release impact: Patch because only presentation changes; no execution, approval, gating or MT5 contract behaviour is affected.

- Realised P/L no longer clips mid-glyph at the container edge, and negative money is red in the attribution tiles as it is everywhere else.
- Gain and loss bars use the gain/loss tokens instead of teal and blue, survive colour-accent mode, and a zero value draws no bar.
- Zero is neutral rather than green, fixed in the shared sign-tone helper so every consumer inherits it.
- Empty tables show an empty state instead of a bare header row; the pending-order price column is labelled TRIGGER.
- Held signals sort newest-first, reason chips are toned by kind so a transient EA_OFFLINE reads differently from a symbol-mapping config error, and the dropped count distinguishes zero from unknown.
- Sidebar accounts show broker and equity; the review badge is a solid chip; the external-activity panel matches the dark console; Telegram no longer reports connected and not connected at once; segmented controls share one treatment.
- Removed dead components, four legacy view branches the router never emits, and ~600 lines of duplicated CSS blocks.

## 1.60.0 - 2026-07-27 (Minor)

Release impact: Minor because automatic approval is now fail-closed behind an evidence gate, the held-signal release workflow became transactional, and provider-wide close fan-out was removed. The MT5 command contract is unchanged.

- Wired the default-gated `approveSignal` path with operator bypass, provider-specific structured-id/prose-complete open evidence, forward provenance, provider-wide order-id novelty, and strict lifecycle resolution.
- Added explicit `EVIDENCE_*` held queue items with alerts and operator suggestions, audited evidence drops, and stopped ingestion from silently skipping actionable review-required lifecycle signals.
- Routed identity-less held OPEN releases, including EA reconnect auto-release, through scoped approved-open materialization; lifecycle releases require an explicitly selected active trade and broker binding.
- Disposed ordinary `NO_SIGNAL`/`TRADE_SETUP` ingestion results as audited `IGNORED` records while holding and alerting risk-off vocabulary.
- Fixed the risk-off vocabulary net, which required a literal `CLOSE` and so never matched `closing`, `cancelling`, `deleting` or `removing`. A genuine misclassified close was previously dropped silently. The first-week drop audit had the same class of hole and was widened.
- Fixed multi-account release: the approval dedup judged all rows sharing a parsed signal, so with two linked accounts releasing either one returned 409 and both stayed held forever. The guard is now account-scoped.
- Made every held-signal release transactional with deferred alerts, so a failed release no longer leaves an orphaned trade, a wrong parsed status, or an alert for work that rolled back.
- Releasing a held `MARK_TP_HIT` now records the TP leg instead of queueing a command the EA rejects and dismissing the card as handled.
- Added compare-and-swap on every held release: exactly one HELD row must transition, so a crash or concurrent release can no longer leave both an executable row and the original hold.
- Removed provider-wide close fan-out and its operator-approval path. Close-all now holds per account and is released per trade, with remaining active trades re-held so an incomplete close is visible.
- Ambiguous closes no longer resolve to an arbitrary first match; only trades genuinely sharing one provider order id still close together.

## 1.59.0 - 2026-07-26 (Minor)

Release impact: Minor because signal precedence, reply hydration, and provider-wide close-all change live lifecycle behaviour while preserving the existing MT5 command contract.

- Structural close/open evidence now outranks prose, with reply-only close reports hydrated from stored Telegram context.
- Added bounded provider-wide close-all fan-out for both present-tense instructions and past-tense ALL-quantified close reports, with per-trade reconciliation holds and operator audit/alert evidence.
- Recognized OPENED/LIVE lifecycle comments without reopening quoted orders, queued the configured runner SL strategy, and rejected invalid zero target-remaining PERCENT closes.
- **Recompile and reattach `mt5/TelegramTC_EA.mq5`; the EA must be rebuilt from the final 1.59.0 source.**

## 1.58.1 - 2026-07-26 (Patch)

Release impact: Patch because this restores structural lifecycle detection and corrects close-volume and runner execution without changing the public payload contract.

- Held casual `CLOSED` prose for review while preserving structural provider closes, including the live msg-547 close and full-close semantics for partial-sounding wording.
- Fixed activation detection for symbol-between-side/order forms, status-first forms, recap lines, and `LIVE` entry wording.
- Kept sub-minimum partial slices held instead of escalating them to full closes; runner-only fallback still closes fully when there is no room.
- Reported successful runner closes as `EXECUTED` with the remnant volume and ignored newly enabled runners for legacy `SPLIT_ORDER` trades.
- **Recompile and reattach `mt5/TelegramTC_EA.mq5`; the EA must be rebuilt from the final 1.58.1 source.**

## 1.58.0 - 2026-07-25 (Minor)

Release impact: Minor because provider close messages now close the traded position by default, with only an explicitly configured runner left open.

- Simplified CLOSED parsing to one provider-close event; prose amounts no longer create partial closes.
- Made CLOSE_TRADE runner-aware and fail closed to a full close when the non-runner slice cannot meet broker volume rules.
- Required filled-volume or observed-volume confirmation before marking a close slice executed.
- Classified EXECUTED, OPENED, and LIVE pending-order notices as lifecycle events while preserving genuine new orders after historical recaps.
- **Recompile and reattach `mt5/TelegramTC_EA.mq5`; the EA must be rebuilt from the final 1.58.0 source.**

## 1.57.5 - 2026-07-25 (Patch)

Release impact: Patch because this closes parser, account-routing, and partial-close sizing defects without changing the MT5 payload contract.

- Recognized prefixed activation notices while letting complete new-order blocks win over recap prose.
- Shared conservative CLOSED classification across quoted and raw messages; live VIP Gold msg-547 remains a full close despite its profit percentage.
- Scoped parameter deduplication per account and queued clean linked accounts while recording duplicate accounts.
- Mirrored PERCENT, LOTS, TP_LEG, target-remaining-volume, and requested-versus-filled partial sizing in the runnable flatten model.
- **Recompile and reattach the EA; build from the final 1.57.5 commit.**

## 1.57.4 - 2026-07-25 (Patch)

Release impact: Patch. Completes the CLOSE_PARTIAL safety hardening and removes the unsafe pending-close version fallback.

- Mirrored aggregated partial-close semantics in the runnable flatten model: only DONE slices become idempotently executed; failed, PLACED, and DONE_PARTIAL slices remain held and retryable.
- Added regressions for quoted CLOSED classification, line-anchored activation detection, capability-only pending flatten gating, and aggregate partial-close reporting.
- **Recompile and reattach the EA. Build the EA binary from the final 1.57.4 commit only. Intermediate 1.57.1/1.57.2 builds carry the CLOSE_PARTIAL regression; CLOSE_PARTIAL is deliberately not capability-gated.**

## 1.57.3 - 2026-07-25 (Patch)

Release impact: Patch. Repairs three CLOSE_PARTIAL regressions introduced by the 1.57.1 flatten rewrite. The EA must be recompiled and reattached.

`ExecuteClose` serves both CLOSE_TRADE and CLOSE_PARTIAL, but the flatten rewrite applied CLOSE_TRADE semantics to both. A partial close therefore cancelled every working pending order for the logical trade, which destroys the remaining entries of a multi-entry setup; it also reported PARTIAL and stayed held even when it fully succeeded, because the surviving position looked like an incomplete flatten; and it was never marked idempotently executed, so a replay could close a second slice of the same position.

Partial closes now run their own path: they never touch pending orders, they report EXECUTED on a DONE deal, and they mark the ticket executed so a replay cannot double-close. Full closes keep the 1.57.2 hardening, where a ticket completes only once the broker confirms the position is gone and PLACED or DONE_PARTIAL stays retryable. Covered by EA source-contract regressions and a partial-close case in the runnable flatten model; all three fixes were mutation-checked.

## 1.57.2 - 2026-07-24 (Patch)

Release impact: Patch because this closes four trade-safety defects without changing the public API shape; the EA must be recompiled and reattached before the new pending-close contract can execute.

- Added the unique pending-close-flatten-v1 EA capability and gated pending-trade CLOSE_TRADE flattening on a fresh compatible register/heartbeat or EA version >=1.57.1; older EAs remain held.
- Rejected requeue of unbound LIFECYCLE_RECONCILIATION:* items and made the EA reject empty lifecycle identities instead of treating them as wildcards.
- Kept PLACED and DONE_PARTIAL closes retryable until broker state confirms the position is gone, preserving idempotency without over-closing.
- Added runnable flatten-state regression coverage for pending removal, fill rescan, partial retry, and idempotent replay, plus server and EA-contract regressions.
- **Operators must recompile and reattach mt5/TelegramTC_EA.mq5 before using pending-trade flattening.** The new capability is pending-close-flatten-v1; no push or deployment was performed.

## 1.57.1 - 2026-07-24 (Patch)

Release impact: Patch because this closes trade-safety review gaps without changing the public API shape; the EA close implementation must be recompiled and redeployed before pending-trade flattening is enabled.

- Classified every status word in quoted NEW-order comments before open detection and constrained provider ticket extraction so TP numbering and short hashtags cannot become order identities.
- Made provider order IDs take precedence over open-signal deduplication, ignored terminal trades for deduplication, and preferred fresh in-memory EA quotes over stale durable snapshots.
- Held unmatched, ambiguous, incomplete, and incompatible lifecycle commands with explicit reconciliation evidence instead of dropping them.
- Changed provider CLOSE handling for pending logical trades to a capability-gated flatten command that cancels pending orders and closes positions, reporting UNKNOWN/PARTIAL when exposure is not confirmed gone.
- Added regression coverage for all six findings and aligned app and EA metadata at 1.57.1.
- **Operators must recompile and reattach `mt5/TelegramTC_EA.mq5` before using the pending-trade flattening path.** Legacy EAs remain held by the existing capability gate.

## 1.57.0 - 2026-07-24 (Minor)

Release impact: Minor because this adds broker-agnostic duplicate-open, naked-order, and provider-order lifecycle safety behavior without changing the MT5 payload contract.

- Classified provider activation/status replies as lifecycle context, including the live Sell Stop trailing-price format.
- Held duplicate provider order IDs and malformed pending or market orders before EA delivery.
- Persisted provider order IDs on logical trades and fanned provider closes across every active logical trade for that order ID.
- Added live VIP Gold 545/546/547 regression coverage and aligned application and EA metadata at 1.57.0.

## 1.56.2 - 2026-07-24 (Patch)

Release impact: Patch because this corrects account attribution and canonical mapping validation without changing execution or held-for-review behavior.

- Correlated held symbol-mapping alert counts to the queue item's account after provider relinking.
- Rejected blank canonical broker input unless an account rule is intentionally dirty for a rules-only save.
- Added regression coverage for relinked multi-account attribution and both canonical save outcomes.
- Aligned application and EA source version metadata at 1.56.2.

## 1.56.1 - 2026-07-24 (Patch)

Release impact: Patch because this closes symbol-mapping and alert correctness gaps without changing the MT5 execution protocol or held-for-review behavior.

- Fixed quoted-symbol ranking, provider-scoped alert suppression, actionable blocked-signal counts, malformed suppression requests, and dashboard alert query fan-out.
- Mapped actionable alerts through canonical account overrides and require broker-picker inventory selections in both mapping modes; affix suggestions now require backend-equivalent confidence.
- Preserved unmapped-token approval as HELD for review with `SYMBOL_MAPPING_*` reasons.
- Kept application and EA source version metadata aligned at 1.56.1.

## 1.56.0 - 2026-07-24 (Minor)

Release impact: Minor because this adds broker-symbol discovery and actionable symbol-mapping workflows while preserving the MT5 execution and held-for-review contracts.

- Added a searchable, quote-aware broker-symbol picker with ranked matches, affix guesses, keyboard access, and refresh-safe selection state.
- Structured unmapped-symbol alerts by provider and account, including blocked signal counts and suggested quoted broker symbols.
- Added persisted per-provider "not an instrument" suppression with audit logging; suppression only quiets mapping alerts and never changes execution handling.
- Aligned application and EA source version metadata at 1.56.0; no EA recompile is required because the MT5 payload contract is unchanged.

## 1.55.1 - 2026-07-23 (Patch)

Release impact: Patch because this hardens nickname updates, preserves dashboard identity, and corrects chart and provider workflow regressions without changing the MT5 execution protocol.

- Preserved account nicknames in dashboard responses and made account rename PATCH validation explicit.
- Reset rename state across account switches, corrected flat-chart band painting, and anchored account actions away from KPI cards.
- Kept provider monitoring and removal on the Providers page with parity and end-to-end coverage.

## 1.55.0 - 2026-07-23 (Minor)

Release impact: Minor because this adds account nicknames, a new provider hub workflow, and client-only trade visibility controls while preserving the MT5 execution protocol.

- Removed the Signal ledger from Operations and kept Telegram Setup focused on authentication, dialogs, and provider addition.
- Added global provider performance, health, lifecycle controls, and account-scoped execution configuration under Providers.
- Added account rename, remove, and link-management actions with nullable account nicknames surfaced across the UI.
- Added client-only dismissal for external trades, honest stale account presentation, neutral and amber offline styling, chart and locale fixes, a `/review` redirect, and a favicon.
- Aligned application and EA source version metadata at 1.55.0; no EA recompile is required because the MT5 payload contract is unchanged.

## 1.54.2 - 2026-07-23 (Patch)

Release impact: Patch because this fixes account-scoped Guardian presentation without changing Guardian persistence, API, database, or MT5 execution contracts.

- Show only the selected account's Equity Guardian controls inside account detail while retaining the all-account Guardian overview.
- Added regression coverage preventing another account's Guardian settings from leaking into the focused account page.
- Aligned application and EA source version metadata at 1.54.2; no EA recompile is required because the MT5 payload contract is unchanged.

## 1.54.1 - 2026-07-23 (Patch)

Release impact: Patch because this corrects route-level scroll restoration without changing account navigation, API, database, or MT5 execution contracts.

- Reset the document scroll position before painting a newly selected workspace route, so switching account pages cannot land midway through the destination.
- Extended the live-navigation regression to cover top-of-page restoration.
- Aligned application and EA source version metadata at 1.54.1; no EA recompile is required because the MT5 payload contract is unchanged.

## 1.54.0 - 2026-07-23 (Minor)

Release impact: Minor because this changes the account-detail navigation workflow while preserving API, database, and MT5 execution contracts.

- Removed the redundant Signals tab from account-detail pages while retaining Signals on the all-account Operations desk.
- Made Performance the canonical account landing page, including redirects from legacy account Signals URLs.
- Moved production navigation to the data router and committed user-triggered route changes synchronously, so live dashboard updates cannot leave the old page rendered after the URL changes.
- Restored native table-cell layout for Performance attribution dates, keeping Opened and Closed values in their correct columns.
- Added regression coverage for immediate account tab navigation, legacy account route redirects, the account tab set, and subtle table-cell layout.
- Aligned application and EA source version metadata at 1.54.0; no EA recompile is required because the MT5 payload contract is unchanged.

## 1.53.3 - 2026-07-23 (Patch)

Release impact: Patch because this reduces dashboard notification noise without changing review actions, API contracts, or the MT5 execution protocol.

- Replaced individual Operations review blockers with one attention summary showing total items, signal-review count, and operational-alert count.
- Kept review-required signals out of the live signal ledger while retaining their full detail and actions in the review queue.
- Collapsed operational alert messages behind a single count summary while preserving persistent per-alert dismissal.
- Updated the Review queue badge to include active parsed signals as well as held signals.
- Added regression coverage for attention counts, collapsed alerts, and the complete review badge.
- Aligned application and EA source version metadata at 1.53.3; no EA recompile is required because the MT5 payload contract is unchanged.

## 1.53.2 - 2026-07-23 (Patch)

Release impact: Patch because this preserves operator dismissals and correctly honors existing terminal signal states without changing the API or MT5 execution protocol.

- Stop resurfacing persisted `IGNORED` and `DISMISSED` signals in the Operations ledger or blocking banner.
- Treat only active parsed or held signals as requiring review, so approved signals no longer inherit stale review warnings.
- Persist dismissed operational notifications in browser storage until their underlying condition clears.
- Added regression coverage for ignored-signal refreshes and notification dismissal across remounts.
- Aligned application and EA source version metadata at 1.53.2; no EA recompile is required because the MT5 payload contract is unchanged.

## 1.53.1 - 2026-07-23 (Patch)

Release impact: Patch because this corrects frontend fidelity and mixed-currency presentation without changing the API or MT5 execution protocol.

- Replaced the invented green-grid console skin with the supplied artifact structure: a compact MT5 operations rail, exception-first account posture, signal ledger, working orders, and provider strip.
- Added the requested Codex-LB-inspired light mode while keeping the dark theme faithful to the supplied Telegram TC dashboard artifact.
- Reordered the Performance overview around attribution metrics and account growth without removing the existing statistics, provider, account, guardian, history, settings, or recovery workflows.
- Keep mixed USD and ZAR Performance summaries in separate native-currency cards instead of presenting a combined FX headline.
- Added regression coverage for native-currency Performance summaries and aligned application and EA source version metadata at 1.53.1; no EA recompile is required because the MT5 payload contract is unchanged.

## 1.53.0 - 2026-07-22 (Minor)

Release impact: Minor because this introduces a new Operations-first frontend, persistent theme behaviour, and corrected reporting-currency provider metrics without breaking the API or MT5 execution protocol.

- Rebuilt the default desk around operational exceptions, native-currency account truth, the signal execution path, working orders, and provider health instead of generic dashboard totals.
- Reorganized navigation around Operations, Review queue, Accounts, and Setup while retaining the existing performance, provider, position, history, guardian, symbol, Telegram, linked-account, settings, parser, and recovery workflows.
- Added a persistent light/dark theme and moved the frontend to TypeScript 7 with explicit module paths.
- Eagerly mount workspace routes so a click changes both the URL and visible screen immediately without requiring a manual refresh.
- Keep USD and ZAR account cards, open positions, and closed trades in their native currencies; mixed native amounts are no longer displayed as one false total.
- Convert global provider P/L, profit, and gain calculations into the configured reporting currency before aggregating across USD and ZAR accounts, while account-scoped provider views remain native.
- Added browser-routing, mixed-currency, theme, and provider-aggregation regression coverage plus a frontend workflow parity contract.
- Aligned application and EA source version metadata at 1.53.0; no EA recompile is required because the MT5 payload contract is unchanged.

## 1.52.1 - 2026-07-22 (Patch)

Release impact: Patch because this removes redundant MT5 snapshot persistence without changing the API, EA protocol, or execution behaviour.

- Kept tick-level position P/L and market quotes in memory so the live dashboard and execution safety continue to use the freshest MT5 snapshot.
- Persist MT5 snapshots and symbol metadata only when positions, orders, stops, or symbol specifications change, avoiding one-second SQLite rewrites for quote and floating-P/L ticks.
- Added regression coverage proving volatile P/L remains live while structural broker changes are persisted immediately.
- Aligned application and EA source version metadata at 1.52.1; no EA recompile is required because the MT5 payload contract is unchanged.

## 1.52.0 - 2026-07-22 (Minor)

Release impact: Minor because this adds an operator-triggered pending-order cancellation workflow.

- Added `POST /api/trades/:id/cancel-pending` to enqueue `CANCEL_PENDING` for a PENDING logical trade so an operator can cancel a live pending order.
- Recognize conservative remove, scrap, take-off, pull, and delete pending-order cancellations. Guards exclude SL/TP/target/partial/percentage edits, negations ("don't remove"), future or tentative intent ("I'll remove later", "might scrap it"), teaching framing ("for example"), and chart chatter ("pull back to entry"); a cancel only fires with a quoted pending order or an explicit order noun.

## 1.51.0 - 2026-07-22 (Minor)

Release impact: Minor because this adds a configurable automatic reconnect release for held pending orders.

- Automatically requeue fresh EA_OFFLINE LIMIT and STOP items on an EA register or offline-to-online heartbeat transition, retaining their original pending-order payload.
- Keep stale and MARKET EA_OFFLINE items held for operator review, with audit records explaining each skip.
- Added `releaseHeldOnEaReconnect`, enabled by default; no EA source behavior changed, so an EA recompile is not required for this release.

## 1.50.1 - 2026-07-21 (Patch)

Release impact: Patch because this hardens backend Telegram health reporting, logging, and pending-order reconciliation without changing the MT5 protocol.

- Raised the default Telegram RPC timeout to 20 seconds and require two consecutive RPC timeouts before raising the provider-stalled alert; a recovered one-off timeout remains visible at warn level.
- Configured GramJS client logging through `TELEGRAM_LOG_LEVEL` (default `error`) so reconnect chatter no longer drowns structured application events.
- Keep zero-fill LIMIT/STOP placements pending even if the EA reports an incidental position ticket, and defer missing-order reconciliation through the existing pending-order grace window while the next snapshot arrives.
- Kept the application and EA source version metadata aligned at 1.50.1; this backend-only release does not require deploying a recompiled EA.

## 1.50.0 - 2026-07-20 (Minor)

Release impact: Minor. Trade-safety release following a live incident that cost ~R397 on account
mt5-3049603. Adds an EA capability handshake, changes execution and parsing behaviour on the money
path, and requires an MT5 EA recompile.

**REQUIRED: recompile and reattach `mt5/TelegramTC_EA.mq5` in MetaEditor.** The backend now emits
fields (`targetRemainingVolume`, `idempotencyKey`) that only the rebuilt EA understands. Accounts
running an older build are detected and held rather than sent commands they would misinterpret;
after reconnecting, confirm the dashboard shows an EA version and the `lane2-close-contract`
capability for each account.

Incident fixes (the ~R397 loss):
- Provider lifecycle notices ("Buy Stop activated") no longer parse as new entries and no longer
  create phantom duplicate trades or dispatch duplicate orders.
- A quoted-reply cancellation can now carry one explicit comment-only replacement entry; it is
  parsed after the cancellation and still follows normal symbol, review, and pending-order inference.
- Lifecycle commands route by provider order id (symbol-checked) then reply linkage; a mismatched
  explicit order id can no longer close a different trade on the same symbol.
- Dropped lifecycle commands raise an operator alert at error severity by default instead of a
  warn-level audit row nobody sees.
- Closing a pending trade now cancels the broker order and only terminalizes after confirmation,
  instead of marking the trade closed while the order stayed live.

Execution and take-profit correctness:
- VIRTUAL_TP orders now carry a real broker take-profit at the last actionable leg as a survival
  backstop; the server only stops managing that leg once the live snapshot confirms the broker TP.
  Suppressed when a runner is enabled.
- Take-profit close volumes are authoritative over percentages; a single actionable leg is forced to
  100%; zero-percent legs are retained as stop-loss trailing references and never given volume.
- Partial fills record requested, filled and remaining volume separately; logical legs are sized
  from the actual fill. Partial closes floor to the broker volume step and refuse rather than
  rounding up into a full close.
- Lost execution reports hold as delivery-unknown and reconcile instead of replaying a close.
- Split-close idempotency markers are ticket-scoped so an interrupted close can still finish.

Parsing safety:
- Quoted/reply blocks are context only; nothing but an explicit "put this back" reopens them.
- Negated and deferred prose ("wait for NFP", "not now", "education only") can no longer open,
  close or move stops. Typographic apostrophes are normalised.
- A signal with an explicit entry away from market and no order-type keyword is inferred as
  LIMIT/STOP rather than fired at market; where the symbol is unquoted it is held for review.
- Cached performance projections now re-evaluate heartbeat freshness, so a silent EA cannot remain
  displayed as online with stale balance or equity.
- New OPEN_TRADE work for a stale or offline account is held instead of waiting to execute after
  a reconnect; lifecycle commands retain their existing routing behaviour.
- Conversational prose no longer produces MODIFY_TP commands with arbitrary words as symbols.

Routing, mapping and operations:
- Signals resolve per linked account, so one account's unmapped symbol no longer blocks accounts
  that map correctly.
- Broker prefix/suffix inference requires majority agreement instead of a single symbol.
- The symbol mapping modal keeps its state across dashboard refreshes and validates that configured
  take-profit splits are executable at the account's lot size.
- Equity Guardian defaults to off rather than an unreachable threshold.

## 1.40.0 - 2026-07-20 (Minor)

Release impact: Minor because this adds a broker-side virtual-TP backstop and an EA command field.

- Attached the final tradeable TP to VIRTUAL_TP orders as a broker-side survival backstop, while the app continues to manage earlier partial closes and leaves runner orders TP-free.
- Kept zero-percent TP legs as stop-loss strategy references, forced a single actionable TP to 100%, retained unconfigured signal targets with warnings, and avoided zero-volume TP closes.
- Fixed VIP Gold lifecycle safety: quoted activation/cancel notices no longer open trades, lifecycle matching prefers provider order IDs then reply links, and dropped lifecycle commands now alert.
- Provider configuration now rejects TP allocations that do not total 100% or cannot produce one minimum 0.01-lot close per positive leg, and lets single-lot configurations choose the working TP.
- Equity Guardian now starts explicitly off; it only evaluates drawdown after an operator enables it with a threshold, while existing configured guardians remain active.
- **Operators must recompile and reattach `mt5/TelegramTC_EA.mq5` in MetaEditor before using 1.40.0.**
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.40.0`.

## 1.39.0 - 2026-07-18 (Minor)

Release impact: Minor because this adds fields to the heartbeat SSE payload and changes dashboard synchronization behavior without breaking existing event consumers.

- Added balance, equity, floating profit, heartbeat status, and timestamp fields to heartbeat SSE events.
- Applied stable-status heartbeats as client-side account and performance deltas, while retaining full dashboard reloads for invalid payloads, unknown accounts, status transitions, and all other state-changing events.
- Emitted an audit event when Equity Guardian first latches paused so heartbeat-driven drawdown breaches still force a prompt full dashboard refresh.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.39.0`.

## 1.38.1 - 2026-07-18 (Patch)

Release impact: Patch because it trims payload and render churn without changing behavior or contracts.

- Capped dashboard equity curves at 500 extreme-preserving points server-side; raw snapshot curves (~6k points) made every `/api/dashboard` response ~664 KB and each EA heartbeat re-transferred and re-parsed it all.
- Moved the sync clock (`lastSyncAt`/`refreshing`) out of App state into an external store subscribed by the status bar, so the every-few-seconds heartbeat reload cycle no longer re-renders the whole tree when data is unchanged; held-queue items also keep their identity when unchanged.

## 1.38.0 - 2026-07-18 (Minor)

Release impact: Minor because this adds persistent asset retention during deploys and backward-compatible route-level code splitting without changing API, SSE, database, or EA protocol contracts.

- Archived the outgoing and current web build assets under the existing mounted data volume, served missing hashed assets from that archive, and capped retention at 256 files so clients can finish loading across deploy swaps.
- Split the nine workspace pages into lazy-loaded route chunks behind a shared Suspense fallback, and made the React/ReactDOM vendor split include the actual runtime modules.
- Coalesced concurrent dashboard loads, skipped dashboard state replacement for deep-equal snapshots, and cached aggregate, per-account, and provider-score dashboard projections per store revision.
- Made the combined Bun test environment deterministic by draining active Telegram ingestion before teardown and restoring Bun's native streaming primitives after DOM setup.
- Removed eight verified exact duplicate top-level CSS rule blocks and added a lint-stage duplicate guard.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.38.0`.

## 1.37.1 - 2026-07-17 (Patch)

Release impact: Patch because this removes idle UI work and confirmed dead code without changing public contracts.

- Renamed the SSE transport keepalive so idle connections no longer trigger a full dashboard rebuild every 10 seconds, and capped header sparkline inputs with the existing 96-point sampler.
- Replaced the chart tooltip's animation dependency with native CSS transitions and stopped shipping the root package manifest to the browser.
- Removed import-graph-confirmed dead web components and helpers, narrowed internal-only core exports, and dropped the unused `zod` dependency.

## 1.37.0 - 2026-07-17 (Minor)

Release impact: Minor. Consolidates the parser template to two modes and folds the shorthand-level parser into the default path behind an opt-in capability; existing providers map to Automatic and behave as before.

- Template modes reduced to Automatic (default) and Aggressive. The old deterministic / kal-vip / kal-vip-extended values normalize to Automatic; the menu drops the KAL VIP names and adds an Aggressive tooltip.
- Aggressive executes the parser's "guessed" opens (low-confidence and geometry-inferred direction/entry) that Automatic holds for review. Both modes still hold on an unmapped symbol, a missing pending-order level, conflicting stop geometry, and lifecycle commands that cannot be tied to one open trade.
- The shorthand-level ("ladder") parser is folded into the default path but gated by a per-provider `shorthandLevels` capability (off by default) plus a live reference price, and never runs on quoted replies. Ladder and zone expansions are capped at 5 entries per message.

## 1.36.0 - 2026-07-17 (Minor)

Release impact: Minor because this recovers signals that were misclassified as result recaps, without changing genuine recap handling.

- A signal that spells out "Stoploss"/"Take Profit" and annotates a target with pips ("Take Profit : 4037 ( 70pips )") no longer trips the pip-based results-recap filter. Bare pip recaps ("XAUUSD +250 pips") are still ignored. Recovered ~113 signals on the Premium (Gold + Forex) channel; its remaining unresolved signals are symbol-less gold posts that resolve once the provider's traded symbol is set to XAUUSD.

## 1.35.0 - 2026-07-17 (Minor)

Release impact: Minor because this recovers FX-cross symbols the parser previously missed without affecting other resolution paths.

- Recognise a currency cross that sits on its own line, away from the direction word (Elliott Wave: "CHFJPY 4H" then "Buy @ ..."). A 6-letter token is only treated as a pair when it is two known ISO currency codes, so commentary words like "SHOULD"/"MISSED" are not mistaken for tickers. Cut this channel's unparsed signals from 188 to 42 (the remainder are results summaries and non-tradeable synthetics).

## 1.34.0 - 2026-07-17 (Minor)

Release impact: Minor because this recovers stop-loss values the parser previously dropped without changing correctly-parsed signals.

- Stop-loss extraction now handles a label with no separator before the price ("SL2286", "STOPLOSS2286") and the "=" and "S.L" variants, in addition to the existing "SL 2286" / "SL: 2286" / "S/L" forms. Pip annotations stuck to the price ("SL 28750(250pips)") were already tolerated. Signals that genuinely omit a stop still fall back to the provider default stop loss.

## 1.33.0 - 2026-07-17 (Minor)

Release impact: Minor because the traded-symbols filter is opt-in per provider and off by default; providers with no traded symbols are unaffected.

- Per-provider "traded symbols" (backend): optional `tradedSymbols` list. When set, symbol-less signals fill from the first symbol and open trades whose symbol is not in the list are HELD for review (SYMBOL_NOT_TRADED), never auto-executed; manual approval of an off-list symbol returns 422. Empty/absent = trade everything (unchanged); `lockedSymbol` still works as the fallback when no traded symbols are set.
- New read-only endpoint `GET /api/providers/:id/detected-symbols` returns the symbols a channel actually posts (with counts) via the connected session without persisting messages, for the config picker.

## 1.32.0 - 2026-07-17 (Minor)

Release impact: Minor because this recovers symbols the parser previously missed without changing behaviour for signals that already resolved.

- Extract a recognised ticker even when it is not adjacent to the direction word: on its own line, in a "SYM/SYM" pair, or tagged like "XAUUSD (ELVIS)". The scan is guarded to real signals and takes the earliest occurrence, so noise and locked/default providers are unaffected. Recovered ~116 missed symbols in one multi-symbol channel's history alone.
- Excluded common commentary words (OPPORTUNITY, POSITIONS, FOLLOW, EMOTION, OUTLOOK) from being mis-read as tickers.

## 1.31.0 - 2026-07-17 (Minor)

Release impact: Minor because this adds shadow-only correlation logging behind a per-provider gate that is off by default and changes nothing that queues or executes.

- Phase 2a signal correlation: per-provider `correlationMode` ("off" | "shadow"); a bounded, account-scoped reply-chain resolver over the Phase 1 alias/origin tables; a pure lifecycle action-vs-state evaluator; and a shadow hook in ingestion that logs `correlation.shadow` (intended lifecycle action next to the legacy matcher) without executing. Errors are contained (`correlation.shadow-error`) so ingestion is never affected.

## 1.30.0 - 2026-07-17 (Minor)

Release impact: Minor because this fixes VIP Gold lifecycle classification and broadens symbol coverage without changing behaviour for existing correctly-parsed signals.

- VIP Gold order lifecycle: "Deleted <side> ... on <symbol> # <id>" now classifies as CANCEL_PENDING (previously misparsed as a new open with the order id read as an entry price), "CLOSED - <symbol> <side>" classifies as CLOSE_TRADE, and the provider order id (# <id>) is captured on the parsed signal for correlation keying.
- Stock index coverage: US30/US100/NAS100/SPX500/GER40/UK100/JP225 canonicals plus common aliases (SP500, DAX, FTSE, NIKKEI, NDX, USTEC, etc.) and open-trade classification, so index signals parse instead of falling through to NO_SIGNAL.

## 1.29.0 - 2026-07-17 (Minor)

Release impact: Minor because this adds WTI crude oil symbol recognition without changing behaviour for existing instruments.

- Added USOIL canonical with WTI/WTIUSD/XTIUSD/CRUDE/OIL aliases and open-trade classification, so crude signals parse as opens mapped to USOIL. Broker symbol mapping for live execution is still per-account configuration.

## 1.28.0 - 2026-07-17 (Minor)

Release impact: Minor because this extends the parser to recognise French-language signals without changing behaviour for existing English providers.

- Added gated French vocabulary normalization: ACHAT/VENTE/VENDRE map to BUY/SELL, French articles and prepositions (LE/L'/MAINTENANT/À) are stripped, and comma decimals convert to points. Only fires when a French buy/sell verb is present, so English text (and every current live provider) parses byte-identically.
- French market commentary without price levels stays classified as non-signal.

## 1.27.0 - 2026-07-17 (Minor)

Release impact: Minor because this adds backward-compatible, forward-only signal-correlation persistence without changing parsing, queueing, or execution behaviour.

- Captured Telegram reply target ids and persisted them with raw messages.
- Added raw-message aliases for every folded capture constituent and provider/account-scoped indexed trade-origin mappings.
- Added migration and persistence coverage for reply links, aliases, and trade origins.

## 1.26.0 - 2026-07-15 (Minor)

Release impact: Minor because this adds backward-compatible parser inference and queue dedup for single-symbol providers without changing MT5 or public API contracts.

- Inferred direction and symbol for directionless signals from providers with an explicitly configured locked symbol: a message carrying an entry zone, stop loss, and take profits promotes to an open trade only when the SL and every TP sit on consistent sides of the entry (the KAL VIP "limits here 4023-22, Sl 4017, Tp 4028/4035/4041" miss).
- Matched plural "limits"/"stops" order-type keywords; "And limits here" previously fell through to MARKET, which would have filled immediately instead of resting at the zone.
- Resolved order type for inferred signals from keywords first, then entry versus reference price; no reference price and no keyword routes to operator review, never MARKET.
- Forced operator review when an inferred signal also references short-level pending stops ("stops for 60" expands to 4060), so both legs reach the operator instead of one being silently dropped.
- Skipped geometry inference on quoted signal bodies, pips recaps, and restatement wording so forwarded or recapped trades cannot re-open.
- Deduplicated re-worded open signals at the approval layer by provider, symbol, direction, order type, digits-rounded entry, and stop loss against pending, active, or 24-hour-recent queue items; duplicates land as DUPLICATE queue entries with a 409.
- Expanded short levels to the nearest hundred block so boundary cases resolve correctly (reference 4005 with "95" gives 3995, not 4095).

## 1.25.1 - 2026-07-14 (Patch)

Release impact: Patch because this fixes Telegram retry behavior, settings data loss, and UI validation/rendering defects without changing MT5 or public API contracts.

- Restored unbounded GramJS reconnect attempts after the prior capped-retry permanent-disconnect incident; retry delay remains capped, and provider ingestion is timeout-bounded and concurrent so Telegram outages cannot serially hold the polling pass.
- Recorded provider-level timeout/stall state immediately, with operational alerts independent of other providers completing.
- Reorganized symbol mapping into Global and focused Account tabs while preserving existing mapping payloads and account-rule safety.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.25.1`.
- Prevented unrelated Settings saves from clearing a configured alert bot token, while making the dashboard report configuration state without returning the token.
- Rejected invalid manual force-push prices and volumes, removed fabricated equity-chart growth, and hardened empty command-palette navigation.

## 1.25.0 - 2026-07-14 (Minor)

Release impact: Minor because this adds backward-compatible execution-safety behaviour across the API queue and MT5 EA.

- Parsed `STOP LOSS`, `STOPLOSS`, `STOP-LOSS`, and `S/L` as protective stop-loss wording without consuming their price as an entry; standalone pending `STOP` tokens remain supported, and conflicting stop-loss labels require review.
- Reject duplicate manual force-push retries for exactly 10 seconds using comparable timestamps and provider/raw-message identity, without suppressing later or genuinely distinct signals.
- Keep Equity Guardian latched while a drawdown is breached or the latest equity heartbeat is stale; automatic guardian-held requeues preserve the original account and logical trade, and skip stale open-trade signals.
- Ignore client-supplied guardian drawdown values on PATCH, require an entry for pending orders, and retain explicit entries that appear after SL/TP labels.
- Require the EA to heartbeat before polling and abort execution when no fresh symbol tick arrives, preventing a naked market order.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.25.0`.

## 1.24.0 - 2026-07-14 (Minor)

Release impact: Minor because this adds backward-compatible ParseLab and execution-log diagnostics without changing MT5 execution contracts.

- Surfaced parsed trade fields, parser diagnostics, symbol-resolution details, lifecycle state, held reasons, and full execution-report detail in the operator dashboard.
- Made Parse recent process newest unparsed messages first and report each provider's capture, parse, and error outcome.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.24.0`.
- Corrected ParseLab corrective-push account/mode projection, lifecycle state transitions, and action-race handling so operator UI state cannot create or mislabel live queue work.
- Added the parsed-signal queue lookup index and limited held-reason lookups to visible dashboard rows.

## 1.23.0 - 2026-07-13 (Minor)

Release impact: Minor because this adds a backward-compatible per-account direct provider-symbol-to-broker-symbol mapping.

- Added direct account broker overrides, accurate mapping previews, and broker-inventory dropdown selection for provider symbols that do not have a reusable canonical symbol.
- Fixed direct override saves and deletes to preserve account safety rules, and made direct resolution obey account include, exclude, and broker-inventory checks.
- Fixed attribution trade-table column sizing so Opened, Closed, and Realized P/L stay aligned.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.23.0`.

## 1.22.0 - 2026-07-13 (Minor)

Release impact: Minor because this adds a backward-compatible phone/tablet workflow and responsive UI states without changing API, database, or EA protocol contracts.

- Made the operations workspace usable below 768px without an override screen, with command-palette navigation for global pages, linked accounts, and pending slots.
- Contained workspace tabs and wide tables, kept provider and Telegram actions reachable, compacted secondary account tabs, and moved the Settings save action to a sticky, early position on narrow screens.
- Fixed linked-account metadata collisions, narrow-screen touch targets, and ZAR/other account currencies on the Performance growth chart axis and tooltip.
- Stopped non-animated dither charts from repainting sparkles and bloom canvases while idle.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.22.0`.

## 1.21.4 - 2026-07-13 (Patch)

Release impact: Patch — fixes an SSE reconnect loop; no API contract, DB, or EA protocol change; the EA `#property version` is bumped only to stay aligned.

- Fixed the `/api/events` live-update stream being closed mid-connection. `Bun.serve` used the default ~10s idle timeout while the SSE heartbeat was 25s, so idle connections were dropped and the browser's `EventSource` reconnected in a loop (visible in Chrome as repeated `ERR_INCOMPLETE_CHUNKED_ENCODING` and reconnect churn/jank; Safari tolerated the silent reconnects). Set `idleTimeout: 255` and heartbeat every 10s so idle SSE connections stay alive.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.21.4`.

## 1.21.3 - 2026-07-13 (Patch)

Release impact: Patch because this reduces chart rendering and static-asset reload work without changing public contracts.

- Downsampled dithered account chart series while retaining bucket peaks and drawdown lows, and cached content-hashed build assets for one year.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.21.3`.

## 1.21.2 - 2026-07-12 (Patch)

Release impact: Patch because this refines visual chart and operational-status clarity without changing public contracts.

- Replaced the wide Summary trend with a dithered area chart while retaining lightweight SVG strips for repeated KPI and provider cards.
- Widened the desktop sidebar and made online, offline, and pending account states colour-gated and shape-distinct.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.21.2`.

## 1.21.1 - 2026-07-12 (Patch)

Release impact: Patch because this fixes visual colour-toggle and status-accessibility regressions without changing public contracts.

- Fixed monochrome sparkline colours, persistent narrow-layout poll-failure visibility, and warning-toast severity glyphs.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.21.1`.

## 1.21.0 - 2026-07-12 (Minor)

Release impact: Minor — adds a client-side display preference without changing API, database, or EA protocol contracts.

- Added a persisted Colour accents setting for meaningful chart, operational-status, and notification colour; monochrome remains available per browser.
- Tightened the top bar into brand, status, and action zones; the app version is now the brand tooltip and the redundant UTC clock is removed.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.21.0`.

## 1.20.0 - 2026-07-12 (Minor)

Release impact: Minor — a full visual redesign to a clean monochrome white theme plus a new
charting dependency (dither-kit). No API contract, database, or EA protocol change; the EA
`#property version` is bumped only to stay aligned with the app version.

- Re-skinned the operator dashboard to a monochrome white theme: cool-white surfaces, flat
  cards with 1px hairline borders (shadows reserved for overlays), a three-tier type system,
  larger tabular KPI numbers, a readability floor, black-pill segmented controls, and
  normalized radius/spacing. Near-black is the only accent; cobalt and Telegram-blue are
  neutralized.
- Reserved green/red strictly for signed financial deltas. Operational state that previously
  used colour (connection, Equity Guardian meter, toasts, pending slots, source badges,
  activity severity, alerts) now conveys meaning through shape, border weight, hollow/pulsing
  dots, glyphs, and labels. Strengthened the focus ring for visible outlines on white.
- Tokenized previously-unstyled surfaces (`CommandPalette`, `ConfirmDialog`) and replaced a
  native `window.confirm` with the shared themed dialog.
- Fixed two styling bugs: card titles (`.panel > header h2`) were rendered as tiny uppercase
  eyebrows, and `.kpi-label-currency` referenced a nonexistent token.
- Replaced the account-growth chart with the vendored dither-kit ordered-dither area chart
  (monochrome grey growth, red drawdown), keeping the growth/drawdown toggle and time/trade
  labelling; removed the now-unused `uplot` dependency.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.20.0`.

## 1.19.0 - 2026-07-11 (Minor)

Release impact: Minor — adds recoverable held-signal handling, account-slot lifecycle controls,
out-of-sync resolution, outbound alerting, database backups, and the supporting operator UI. No API
contract break, database migration, or EA protocol change; the EA `#property version` is bumped only
to stay aligned with the app version.

- Added HELD/DISMISSED queue states, audited held-item requeue/dismiss actions, guardian and late
  signal recovery, stale OPEN_TRADE delivery safety, and the release-held setting.
- Added account-slot expiry and deletion guards.
- Added flat held-item payloads with dropped lifecycle visibility and requeue warnings.
- Added OUT_OF_SYNC close-from-history, readopt, and archive resolution plus terminal handling for
  plain close/modify reports targeting missing positions.
- Added optional Telegram bot alerting, alert-test delivery, SQLite backup/list endpoints, and the
  documented restore/nightly backup procedure.
- Added the Held signals operator view (requeue at market / as original order / dismiss, with
  price-drift and dropped-lifecycle context), guardian unpause-with-requeue, slot deletion, an
  out-of-sync resolve menu, and alerting/backup controls in Settings.
- Fixed the force-push trade modal so a parsed signal pre-fills every field (direction, order type,
  entry, stop loss, take profits, volume) instead of forcing full manual re-entry.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.19.0`.

## 1.18.1 - 2026-06-27 (Patch)

Release impact: Patch — fixes a virtual-TP retry loop in execution reconciliation. No API contract,
database schema, or EA protocol change; the EA `#property version` is bumped only to stay aligned.

- Treat a FAILED close/SL-modify report whose broker comment says the position is gone
  (`virtual TP position ticket not found`, `No matching position`) as terminal: the targeted
  leg(s) are marked `CLOSED` (the close intent is already satisfied) instead of being left in a
  non-terminal state. Previously a vanished position could leave a virtual-TP command being
  re-issued every poll, producing tens of thousands of identical FAILED execution reports from a
  handful of stuck queue items and bloating `audit_logs` / `execution_reports`.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.18.1`.

## 1.18.0 - 2026-06-27 (Minor)

Release impact: Minor — adds backward-compatible dashboard UI states (a default Summary tab, a
collapsible Today/Week/Month KPI window, dismissible operational-alert banners) and relocates the
external-activity panel to the History tab. No API contract, database schema, or EA protocol change;
the EA `#property version` is bumped only to stay aligned with the app version.

- Added a lightweight **Summary** tab as the default account landing. The persistent account header
  (Balance / Equity / Trading P/L KPIs) and the exposure panel now sit above a clean summary with a
  single glanceable equity trend, while the full growth chart, P/L attribution, and statistics stay
  one click away under **Performance** — decluttering the busy landing.
- Collapsed the six KPI cards to four: Balance, Equity, and Trading P/L plus one windowed P/L card
  with a Today / Week / Month toggle, cutting header density by a third.
- Removed the redundant **External activity** panel from the Performance overview. External/manual
  broker positions are already surfaced (with a Manual chip) in the **History › Open** positions
  table, so the separate panel only added clutter to the landing.
- Made operational-alert banners (unmapped symbols, Equity Guardian latched, Telegram stalled)
  dismissible. Dismissal is session-scoped — a reload re-shows any still-active trade-blocking
  condition so a safety-critical alert can never be permanently hidden.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.18.0`.

## 1.17.1 - 2026-06-27 (Patch)

Release impact: Patch — fixes operator-facing noise and styling regressions from 1.17.0 without
changing the API contract, database schema, or EA protocol.

- Fixed the unmapped-symbol alert spamming the dashboard with hundreds of entries: it was scanning
  the EA's entire reported instrument catalog (every broker CFD/index). It now only flags symbols
  the operator's providers have actually posted that still do not resolve to a broker symbol, and it
  clears once a mapping exists.
- Re-themed the new 1.17.0 UI (toasts, onboarding, Activity feed, provider health cards, exposure
  panel, volume badges) to the application's light design tokens — they were rendering with dark
  hardcoded fallback colours because they referenced non-existent CSS variables.
- Removed the duplicate "Recent activity" card from the Live overview; the operator/system activity
  feed now lives only under the Logs view.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.17.1`.

## 1.17.0 - 2026-06-26 (Minor)

Release impact: Minor because this adds backward-compatible real-time push, new read-only API
endpoints, additive `symbol_metadata` and `parser_training_examples` tables created with
`CREATE TABLE IF NOT EXISTS`, and dashboard UI without changing EA command contracts or requiring a
migration of existing data.

- Added a Server-Sent Events stream at `GET /api/events` backed by an in-process AppStore event bus;
  the dashboard now refreshes from `audit`, `reconciliation`, and `heartbeat` events via
  `EventSource` with a polling fallback (feature-detected) instead of a fixed 15s poll.
- Added multi-message correlation in `@telegram-tc/core` (`correlateMessages`) so a directional
  signal and a rapid same-sender SL/TP follow-up inside a per-provider window merge into one signal.
- Extended `this.audit()` with an `actor` field and added `GET /api/audit-logs?event=prefix*`, surfaced
  as an Activity feed in Logs and a Recent activity card on the overview.
- Added a reusable `ConfirmDialog` + `useConfirm()` gating provider/account deletion (type-to-confirm
  for accounts), replacing `window.confirm`.
- Added adaptive parser learning: operator-approved signal structures are stored in
  `parser_training_examples`; a number-stripped fingerprint with >=3 examples relaxes the review gate.
  Learned-pattern count and a Reset-learning control surface per provider.
- Persisted EA symbol metadata (point/digits/pip) in `symbol_metadata` and added an unmapped-symbol
  operational alert that clears once the symbol is mapped.
- Added an app-side volume preview (`computeVolumePreview`) shown as a per-queue-item badge and an
  aggregate exposure panel (open lots + volume-weighted pip risk per symbol).
- Added provider scoring at `GET /api/providers/:id/score` (rolling win rate, streak, avg pips,
  review rate, learned patterns) surfaced as Provider Health cards with traffic-light badges.
- Routed self-healing reconciliation status transitions through SSE and the audit log
  (`logical-trade.reconciled`).
- Added data export endpoints `GET /api/export/trades` and `GET /api/export/journal` (JSON + CSV)
  with an Export journal button on the History view.
- Added a dependency-free toast system, optimistic approve/ignore UI, and a first-run onboarding card.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.17.0`.

## 1.16.0 - 2026-06-06 (Minor)

Release impact: Minor because this adds backward-compatible account performance attribution API
data and in-place dashboard UI without changing EA command contracts or requiring a database
migration.

- Added `GET /api/accounts/:accountId/attribution` to split account realized P/L into
  provider-linked, manual/external, and unknown/EA buckets with close-source and top-trade detail.
- Enhanced the existing Performance overview with attribution cards, compact P/L bars,
  close-source breakdown, and a largest contributing trades table instead of adding another tab.
- Fixed account-scoped Performance charts to use the focused account performance series and label
  sampled time-series points as samples rather than trades.
- Added regression coverage for attribution bucket classification, range filtering, focused account
  chart data, and the enhanced Performance overview.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.16.0`.

## 1.15.0 - 2026-06-05 (Minor)

Release impact: Minor because this adds a backward-compatible provider parser mode, provider symbol
lock field, and dry-run parsing behavior without changing EA command contracts or requiring a
database migration.

- Added a `KAL VIP extended` provider parser mode that expands terse Gold/XAUUSD level commentary
  into one pending-limit signal per level only when a fresh EA snapshot supplies the current
  reference price.
- Added a provider-level locked symbol setting to the provider config modal and API payloads so a
  provider can be constrained to one symbol before shorthand parsing is allowed.
- Updated provider config dry-runs to use the multi-signal parser path and return the parsed signal
  count, so operators can test multi-level posts before saving.
- Added regression coverage for Automatic-mode gating, missing-reference-price gating, provider
  symbol lock persistence, dry-run testing, and queued KAL VIP extended short levels.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.15.0`.

## 1.14.1 - 2026-06-05 (Patch)

Release impact: Patch because this tightens dashboard accounting, queue reconciliation, and README
coverage without changing public API or EA command contracts.

- Fixed mixed-currency aggregate performance so unsupported currencies and partially offline account
  sets do not publish misleading current totals.
- Added a freshness guard before cancelling accepted pending orders that disappear from MT5
  snapshots.
- Expired parsed-signal state together with stale open-trade queue work so deduplication no longer
  blocks a reissued signal after the executable queue item has expired.
- Used per-account performance rollups for focused account Trading P/L instead of heartbeat-only
  floating profit.
- Updated the README to cover the current operator surfaces, API endpoints, replay guard, reporting
  currency settings, provider export, and EA version snippet.
- Added regression coverage for the PR review fixes.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.14.1`.

## 1.14.0 - 2026-06-05 (Minor)

Release impact: Minor because this adds a backward-compatible stale Telegram replay safety setting
and tightens MT5 pending-order reconciliation without breaking API or EA command contracts.

- Added a configurable open-trade expiry guard so refetching recent Telegram messages can skip stale
  open signals instead of queuing trades after a relaunch.
- Marked accepted pending orders that disappear from the latest MT5 snapshot as cancelled instead of
  leaving their logical trades permanently out of sync.
- Added regression coverage for stale Telegram replay expiry, missing pending-order reconciliation,
  and current-month KPI windows.
- Kept `package.json` and the MT5 EA `#property version` aligned at `1.14.0`.

## 1.13.2 - 2026-05-27 (Patch)

Release impact: Patch because this fixes account-level broker symbol resolution and diagnostics
without changing API or EA command contracts.

- Added HF-style `XAUUSDr` as a recognized `XAUUSD` broker variant when the EA reports that symbol.
- Preserved EA-reported account symbol inventories and existing overrides when saving account-level
  mapping edits from the symbol settings UI.
- Added account-level mapping prefix support to the symbol mapping modal.
- Included the target account and symbol mapping reason when approval is blocked for operator
  confirmation.

## 1.13.1 - 2026-05-26 (Patch)

Release impact: Patch because this corrects account-scoped dashboard currency rendering without
changing API, database, or EA command contracts.

- Fixed account-scoped Live routes to use the selected MT5 account currency instead of the overview
  reporting currency.
- Prevented aggregate reporting-currency performance data from being relabeled as account-local
  currency on account-specific pages.
- Added regression coverage for the ZAR account Logs route.

## 1.13.0 - 2026-05-26 (Minor)

Release impact: Minor because this adds configurable mixed-currency reporting settings and new
dashboard summary behavior without breaking existing API, database, or EA command contracts.

- Added reporting currency and USD/ZAR rate settings, defaulting mixed-currency account summaries to
  USD at 1 USD = R16.
- Added mixed-currency account performance aggregation so ZAR and USD account balances, equity, and
  P/L windows are normalized before dashboard display.
- Fixed overview KPI liveness checks for aggregate account performance so mixed-currency summaries
  are not hidden because the first account row is offline.
- Added regression coverage for mixed-currency conversion, settings persistence, settings UI payloads,
  and aggregate KPI rendering.

## 1.12.3 - 2026-05-26 (Patch)

Release impact: Patch because this fixes account selection for parsing and dashboard summaries
without changing API or EA command contracts.

- Fixed provider parsing to prefer the freshest online linked MT5 account, so old linked accounts
  no longer force clean Gold signals into GPT/operator review because their symbol list is stale.
- Fixed the Live dashboard money summary to prefer the active/funded account instead of the lowest
  account number.
- Fixed the Performance growth chart to use the active performance currency instead of the first
  account row's currency.
- Included account currency, balance, equity, profit, and initial balance in the dashboard account
  rows for reliable account-scoped rendering.

## 1.12.2 - 2026-05-25 (Patch)

Release impact: Patch because this fixes Telegram bootstrap state and slow GramJS dialog refresh
handling without changing API or EA command contracts.

- Added a lightweight Telegram status endpoint so the web app can confirm saved server sessions
  before the full dashboard snapshot finishes loading.
- Kept the first screen in a checking state instead of showing the phone login while a connected
  Telegram session is already stored on the server.
- Increased the Telegram dialog refresh timeout for slow GramJS `getDialogs` calls.

## 1.12.1 - 2026-05-25 (Patch)

Release impact: Patch because this reduces dashboard execution-log query cost and adds supporting
SQLite indexes without changing API or EA command contracts.

- Limited dashboard execution-log reads to the recent rows the dashboard renders instead of
  materializing the full execution report history on every refresh.
- Added optional bounded `limit` support to the execution-log API and avoided full-log loading when
  reading one execution report's details.
- Added execution-report recency indexes for fresh and existing SQLite databases.

## 1.12.0 - 2026-05-25 (Minor)

Release impact: Minor because this adds backward-compatible provider TP strategy validation,
allocation previews, and normalized web payload behaviour without changing API or EA command
contracts.

- Simplified provider TP strategy controls to Move SL to BE, Move SL to prior TP, and Leave SL
  unchanged while preserving the existing structured strategy payload shape.
- Added fixed-lot TP allocation previews that reserve runner lots before distributing the TP close
  pool across configured TP rows.
- Added provider-config validation for invalid TP percentages, runner lot sizing, fixed lot sizing,
  and prior-TP strategy availability before save or test actions can run.

## 1.11.0 - 2026-05-25 (Minor)

Release impact: Minor because this adds backward-compatible account-scoped provider routing,
per-account provider config persistence, route-driven dashboard navigation, and provider snapshot
fields without changing the EA command protocol.

- Added account-scoped provider configuration overrides on account-provider links while preserving
  provider defaults as the inheritance source.
- Added route-driven Live/account/provider navigation and read-only aggregate Provider overview
  behavior.
- Added per-account provider performance rows to the dashboard snapshot and account-scoped Provider
  table behavior.
- Fixed disabled provider copy links so they no longer fall back to the default MT5 account.
- Fixed split-order runner validation to use the target account's resolved provider config.
- Preserved per-account provider config overrides when duplicate Telegram provider rows are merged.
- Kept overview Provider CSV export aggregate while account-scoped Provider export still filters to
  the selected account.

## 1.10.0 - 2026-05-22 (Minor)

Release impact: Minor because this adds backward-compatible dashboard risk-threshold controls,
provider return percentage fields, frontend font/loading improvements, and development-server
collision protection without changing the EA command protocol.

- Added self-hosted dashboard fonts, reusable money/stat display
  primitives, and richer currency-aware performance/history/provider values.
- Tightened the Live header platform card so account metadata stays compact beside the KPI strip.
- Kept workspace pages in the initial app bundle so stale local dev-server tabs no longer fail when
  switching tabs with a dynamic page import.
- Added global and per-account drawdown display thresholds, keeping danger thresholds at or above
  warn thresholds and preserving omitted per-account overrides on partial updates.
- Resynced per-account risk override fields after backend normalization so clamped warn/danger
  values are reflected immediately in Settings.
- Kept the legacy provider performance `gain` API/CSV field while adding `gainPct`/`gain_pct` for
  initial-balance return percentages.
- Made the Vite dev server fail loudly if port `5173` is already occupied, avoiding misleading lazy
  module import failures from unrelated local services.

## 1.9.3 - 2026-05-21 (Patch)

Release impact: Patch because this removes an unused status-bar placeholder without changing
backend contracts or EA command behaviour.

- Removed the routing placeholder from the status bar because routing is not used by this
  application.

## 1.9.2 - 2026-05-21 (Patch)

Release impact: Patch because this adds status-bar visibility for dashboard sync and app version
metadata without changing backend contracts or EA command behaviour.

- Added a status-bar sync strip with last successful dashboard sync time, routing placeholder, and
  app version.

## 1.9.1 - 2026-05-21 (Patch)

Release impact: Patch because this fixes MT5 history reconciliation and schema bootstrap
correctness without changing public API or EA command contracts.

- Normalized MT5 broker-history `time` strings to ISO timestamps before persisting broker-order rows.
- Compared large MT5 deal tickets in exact integer space when ordering close-volume history.
- Kept external manual close summaries in sync when repeated history syncs repair existing deal rows.
- Added the `external_closes` table to the canonical SQL migration.

## 1.9.0 - 2026-05-21 (Minor)

Release impact: Minor because this adds backward-compatible dashboard/API statistics, persisted
equity curve rows, provider copied-drawdown fields, and provider performance CSV export without
changing the EA protocol.

- Added heartbeat-sampled minute equity curve storage with account/provider state tables and sparse
  drawdown events so the Performance chart and statistics can reflect floating equity drift.
- Added account/provider statistics for Profit/Return, Win/Loss, Risk/Drawdown, Quality, Streaks,
  and Timing, fetched only when the Performance > Statistics subview is opened.
- Calculated Provider tab average drawdown from active copied-provider exposure while excluding
  manual/external MT5 activity from provider attribution.
- Added provider performance CSV export from the Providers panel, including linked accounts, win
  rate, P/L, average drawdown, and copied drawdown.

## 1.8.1 - 2026-05-21 (Patch)

Release impact: Patch because this keeps the default parser expansion intact while fixing a
backward-compatible broker-history reconciliation issue.

- Upgraded existing app-recorded partial close rows to `FULL_CLOSE` when MT5 broker history confirms
  that cumulative closed volume covers the original broker open volume, so app-managed trades appear
  in History > Closed like MT5's Positions ledger.
- Kept replayed older MT5 open-history deals from reopening logical trades after a real full close has
  already been recorded.
- Added startup repair for already-open logical trades whose recorded close rows fully cover the
  broker open volume, allowing deployed databases to heal stale ledger rows after restart.

## 1.8.0 - 2026-05-21 (Minor)

Release impact: Minor because this adds backward-compatible default parser behaviour and additive
parser API response fields for multi-entry posts.

- Added default directional zone parsing so messages such as `4512 / 4500 / 4580 / Buy zones`
  produce one pending limit signal per standalone price line, using the provider default symbol plus
  the app default SL and TP distances.
- Kept quoted reply chatter around those zone posts non-queueable unless the comment explicitly
  reinstates the quoted signal.
- Added default support for broker-copier `NEW ORDER - XAUUSD Buy Stop` blocks, including entry,
  SL, TP, order type, symbol, and lot extraction without mistaking ticket numbers for entries.
- Extended parser insertion so one raw Telegram message can create multiple parsed signals while
  preserving the existing single-result response for current UI/API callers.

## 2026-05-20 (External partial-close history visibility)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.7.2` and kept the
  MT5 EA `#property version` aligned at `1.7.2` because this is a backward-compatible dashboard
  history bugfix.
- Included external/manual partial-close MT5 broker deal rows with realized P/L in History > Closed
  when the position is still open or the final close timestamp has not been recorded yet.
- Built external closed-history rows from broker close deal events when available, so expanded detail
  preserves the actual partial/full close legs and broker deal tickets instead of relying only on the
  aggregate `external_closes.close_at` row.

## 2026-05-20 (Broker history idempotency and API responsiveness)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.7.1` and kept the
  MT5 EA `#property version` aligned at `1.7.1` because this is a backward-compatible API
  responsiveness fix.
- Made repeated MT5 history syncs idempotent for unchanged existing deal tickets, so the EA can keep
  sending its lookback window without rewriting thousands of broker rows or logging no-op
  `mt5.history.repair` entries every minute.
- Limited large periodic MT5 history backfills to a recent overlap once an account already has broker
  history, while keeping small one-deal `OnTradeTransaction` syncs and first imports complete.
- Added broker-order indexes for deal-ticket dedupe, account performance, trade history, and
  ticket-based reconciliation lookups.
- Reworked account performance history loading to fetch an account's broker rows in one indexed query
  instead of one query per logical trade.

## 2026-05-20 (MT5 broker P/L truth and manual closed history)

- Release impact: Minor. Bumped the canonical app version in `package.json` to `1.7.0` and kept the
  MT5 EA `#property version` aligned at `1.7.0` because this adds backward-compatible EA/backend
  history and heartbeat payload fields plus dashboard behaviour.
- Made MT5 broker history the source of truth for realized currency P/L. Existing broker-order rows
  with the same deal ticket are now repaired from `DEAL_PROFIT + DEAL_COMMISSION + DEAL_SWAP +
  DEAL_FEE` instead of skipped, and app execution reports keep close P/L currency unset until broker
  history arrives.
- Added `DEAL_FEE`, `DEAL_TIME_MSC`, deal magic, and `ACCOUNT_PROFIT` to the EA payloads so backend
  ordering, daily P/L, and floating P/L diagnostics use broker-reported values.
- Surfaced closed external/manual MT5 history in History > Closed and account-level P/L while keeping
  provider P/L scoped to provider-owned logical trades.
- Reworked the live account header to show current MT5 Balance and Equity before Trading P/L, Today,
  This Week, and This Month.
- Stopped stale MT5 heartbeat/snapshot values from being presented as live Balance, Equity, Floating,
  or Trading P/L while still showing realized broker-history windows such as Today, This Week, and
  This Month.
- Tightened the six-card KPI layout so large Balance/Equity/P&L values reflow without clipping, with
  the account currency moved out of the monospaced amount text.
- Changed closed-history Result to a compact net chip (`Win`, `Loss`, `BE`) while keeping close reason
  such as `Mixed`, `SL hit`, `Manual`, or `TP hit` in the expanded detail and tooltip.

## 1.6.11 - 2026-05-21 (Patch)

Release impact: Patch because this tightens provider-config PATCH persistence and startup
close-coverage repair without changing the EA command protocol or public API contracts.

- Persisted null-only provider TP reset patches while preserving existing risk and runner config.
- Required every broker position ticket on a logical trade to be covered before startup repair treats
  partial-close history as terminal.
- Added regressions for null-only TP resets and multi-ticket close coverage.

## 1.6.10 - 2026-05-21 (Patch)

Release impact: Patch because this fixes provider-config review regressions without changing
the EA command protocol or public API contracts.

- Preserved `% of balance` provider risk amounts when opening and saving the provider modal without
  editing the risk field.
- Accepted `null` provider TP arrays as missing config and normalized them through the default TP
  fallback instead of throwing during provider update/read paths.
- Added focused API and UI regressions for the PR review fixes.

## 1.6.9 - 2026-05-21 (Patch)

Release impact: Patch because this fixes backend parser/reconciliation behaviour without changing
the EA command protocol or public API contracts.

- Restored the app default TP when provider TP filtering removes every Telegram TP leg from an
  otherwise valid signal.
- Prevented app-managed virtual TPs from queueing a close when the actual broker fill is fully
  reserved for the configured runner.
- Summed split broker OPEN fills before treating history or startup-repair closes as terminal.
- Added regressions for the provider TP fallback, runner-only virtual TP sizing, history close
  classification, and startup backfill coverage paths.

## 2026-05-20 (Provider modal TP allocation copy)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.8` and kept the
  MT5 EA `#property version` aligned at `1.6.8` for the repo version guard.
- Reworded the provider TP allocation hint and runner summary so they describe scaled TP
  percentages and the configured TP sequence instead of referring to a confusing "final TP".
- Tightened provider strategy dropdown sizing so "Leave SL unchanged" rows stay aligned with the
  delete control and use the same dropdown treatment as the rest of the modal.

## 2026-05-20 (Provider TP pickup and manual close accounting)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.7` and kept the
  MT5 EA `#property version` aligned at `1.6.7` because this corrects provider TP fallback logic and
  realized P/L accounting without changing the EA/backend payload schema.
- Corrected provider TP handling: empty provider TP config still falls back to the app-wide default
  TP, but a provider configured with TP levels now uses matching Telegram TP lines when they exist.
- Kept the single-TP/no-runner fallback to the app-wide TP only for messages that do not contain a
  provider TP to pick up.
- Included external/manual broker history deals in the EA history feed and recorded unmatched
  history deals under stable external trade ids so closed manual MT5 trades move from floating P/L
  into realized P/L, equity curve, drawdown, and monthly performance.

## 2026-05-20 (Provider TP cardinality and default TP fallback)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.6` and kept the
  MT5 EA `#property version` aligned at `1.6.6` because this fixes provider config semantics and
  frontend modal behaviour without changing the EA/backend protocol.
- Preserved empty provider take-profit configs as "no configured provider TPs" instead of silently
  recreating TP1-TP4. Explicit message TPs are then ignored for that provider and the app-wide
  default TP distance is used.
- Kept provider TP cardinality capped at four for now.
- Let the provider config modal delete the final TP row and reload saved provider TP/runner config
  from the dashboard snapshot.

## 2026-05-20 (Small-runner virtual TP close sizing)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.5` and kept the
  MT5 EA `#property version` aligned at `1.6.5` because this is a backwards-compatible backend
  virtual-TP sizing fix with no EA/backend protocol change.
- Fixed app-managed virtual TP close sizing for small trades with a configured runner. When the
  broker-filled volume minus runner volume leaves a managed TP slice smaller than the broker lot
  step, the backend now falls back to the already-planned TP leg volume instead of rounding the close
  request to zero and leaving TP1 unqueued.
- Added a regression for the live SELL 4488 / TP1 4483 shape: 0.02 lots with a 0.01 runner and a
  25% TP1 allocation must still queue a 0.01-lot TP1 close when price crosses TP1.

## 2026-05-19 (Stale-snapshot SL close reconciliation)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.4` and kept the
  MT5 EA `#property version` aligned at `1.6.4` because this is a backwards-compatible backend
  reconciliation fix with no EA/backend protocol change.
- Fixed MT5 history close classification when the latest snapshot is stale. If an SL/TP/history
  deal's close volume covers the remaining broker-open volume, the backend now records it as a
  terminal `FULL_CLOSE` instead of leaving it as a non-TP `PARTIAL_CLOSE`.
- Startup repair now heals older `OUT_OF_SYNC` trades whose recorded close rows cumulatively cover
  the open volume, including rows that were previously mis-recorded as `PARTIAL_CLOSE`.
- Added regressions for full-volume SL closes, TP1-then-SL remaining-volume closes, and startup
  healing of stale partial-close broker history.

## 2026-05-19 (PR review fixes: poll lease safety and filled-volume virtual TP sizing)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.3` and kept the
  MT5 EA `#property version` aligned at `1.6.3` because this fixes two backwards-compatible runtime
  bugs without changing the backend/EA command protocol.
- Stopped retrying `/mt5/poll-line` in the EA. Polling leases queue items server-side, so a lost
  response must not trigger another lease that could skip or reorder pending commands.
- Changed app-managed virtual TP close sizing to use the broker-reported OPEN filled volume for the
  matched position before falling back to the original requested queue volume. This keeps TP-leg
  partial closes correct when `BrokerMinLotMultiplier` changes the actual lot size sent by the EA.
- Added regressions for both PR review findings.

## 2026-05-19 (EA default link code update)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.2` and kept the
  MT5 EA `#property version` aligned at `1.6.2` because this updates the default EA link-code input
  without changing the backend/EA command protocol.
- Updated the EA `LinkCode` default from `-IF3QCYL` to `-UTN4-D6`.
- Added an EA source regression so the expected default link code is checked with the other EA
  packaging/source invariants.

## 2026-05-19 (EA lifecycle command Journal logging)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.6.1` and kept the
  MT5 EA `#property version` aligned at `1.6.1` because this adds observability without changing the
  backend/EA command protocol.
- Added MT5 Journal logging whenever the EA receives backend `status=WORK`, including command type,
  queue id, logical trade id, symbol, target position/order tickets, partial-close fields, and
  requested SL context.
- Added focused logs for `MODIFY_SL`, `CLOSE_TRADE`/`CLOSE_PARTIAL`, and `TRAILING_STOP` execution
  paths so recovered virtual-TP plans can be traced from backend recovery through EA-side work.
- Added an EA source regression to keep the lifecycle command logging contract in place.

## 2026-05-19 (Virtual TP recovery and operator-state guard)

- Release impact: Minor. Bumped the canonical app version in `package.json` to `1.6.0` and kept the
  MT5 EA `#property version` aligned at `1.6.0` because this adds persisted trade source lineage,
  startup virtual-TP recovery behaviour, and an operator-state startup guard.
- Approved logical trades now keep their source Telegram/raw-message lineage directly in
  `logical_trades.data_json` so a reload/redeploy can trace a broker trade back to the parsed signal
  and raw provider message without relying only on queue rows.
- Startup reconciliation now recovers still-live `OUT_OF_SYNC` virtual-TP trades when persisted
  broker open evidence exists, restoring the logical trade to `OPEN`, re-arming planned TP legs, and
  restoring the active-plan line payload with the known position ticket.
- Added a startup preservation guard for operator-owned routing/config state. Provider links,
  provider config/history, account symbol mappings, and symbol aliases are snapshotted before and
  after startup maintenance; any mutation raises an error instead of silently disappearing, and a
  preserved audit event is written when protected rows exist.
- Added regressions for source lineage, live virtual-TP recovery, and startup mapping/config
  preservation.

## 2026-05-19 (Runner breakeven after app-managed TP)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.5.1` and kept the
  MT5 EA `#property version` aligned at `1.5.1` for deployment/package traceability.
- Fixed app-managed virtual TP runner handling when MT5 reports a TP-leg partial close with a
  generic broker comment such as `Request executed`. The backend now queues the configured
  post-TP `MODIFY_SL`/runner strategy from the structured `CLOSE_PARTIAL` payload instead of
  relying on a broker comment that names `tp1`.
- Added a regression covering the live 200-pip default-TP runner path where TP1 closes the managed
  volume and the remaining runner must move to breakeven.

## 2026-05-19 (Source-available commercial licensing)

Documentation/legal metadata update; no runtime SemVer bump. `package.json` and
`mt5/TelegramTC_EA.mq5` remain at `1.5.0`.

- Added a custom source-available licence that allows free non-commercial use and reserves
  commercial rights for a separate royalty-bearing commercial agreement.
- Added the root `package.json` licence pointer to `LICENSE`.
- Added the README licence summary so users understand non-commercial use, personal trading use, and
  commercial licensing requirements.

## 2026-05-19 (README refresh and Markdown documentation pruning)

Documentation-only maintenance; no runtime SemVer bump. `package.json` and
`mt5/TelegramTC_EA.mq5` remain at `1.5.0`.

- Removed outdated supporting Markdown documents under `docs/` so the README is the primary
  project documentation surface.
- Rewrote the README from the current app implementation, covering the Telegram setup, provider
  configuration, MT5 link-code workflow, EA inputs, API surfaces, Docker deployment, runtime
  configuration, verification gate, and versioning rules.
- Kept `changelog.md` because this repo requires a changelog entry for every change.

## 2026-05-19 (App-owned default TP runners)

- Release impact: Minor. Bumped the canonical app version in `package.json` to `1.5.0` and kept the
  MT5 EA `#property version` aligned at `1.5.0` because this adds app-owned default-TP runner
  management while preserving the existing queue/report contract.
- Fixed no-provider-TP virtual trades so the app derives the TP target from the configured default
  distance and the actual broker open price, then queues a ticket-specific TP-leg partial close when
  live MT5 quotes cross that derived target.
- Runner-aware virtual TP closes now reserve the configured runner volume. For example, a `0.02`
  order with a `0.01` runner closes `0.01` at the default 200-pip TP instead of trying to close the
  whole position.
- Added app-side runner management after the final TP leg confirms: break-even/last-TP modes queue
  `MODIFY_SL`, and trail mode queues the existing EA `TRAILING_STOP` command against the broker
  position ticket.
- Removed the legacy EA-owned virtual-TP state machine, rehydration, and runner handling from
  `mt5/TelegramTC_EA.mq5`. The EA now stays focused on execution, snapshots, broker-history
  reporting, and explicit trailing-stop commands; virtual TP ownership lives in the app.
- Added regressions for the KAL-style default-TP runner path and for keeping virtual-TP ownership out
  of the EA source.

## 2026-05-18 (Closed trade reconciliation fixes)

- Release impact: Minor. Bumped the canonical app version in `package.json` to `1.4.0` and kept the
  MT5 EA `#property version` aligned at `1.4.0` because this adds a `CANCELLED` logical-trade state
  while preserving the existing EA/backend protocol.
- Fixed closed-trade rollups for pending limit/stop orders so the initial broker acceptance row is
  not counted as a filled position. Closed rows now use the actual MT5 fill for entry ticket,
  volume, and weighted open price.
- Hardened startup reconciliation for stuck `OUT_OF_SYNC` trades: persisted real broker close rows
  heal to `CLOSED`, duplicate synthetic snapshot-diff close rows are removed, and unrecoverable
  trades with no broker open evidence are marked `CANCELLED`.
- Fixed the current typecheck/lint blockers in the API tests and closed-history UI.
- Added regressions for pending-order close rollups, persisted startup backfill, and unrecoverable
  out-of-sync cancellation.

## 2026-05-18 (App-managed virtual TP)

- Release impact: Minor. Bumped the canonical app version in `package.json` to `1.3.0` and kept the
  MT5 EA `#property version` aligned at `1.3.0`.
- Moved default virtual TP ownership into the backend application. Pending limit/stop orders now
  remain `PENDING` with planned TP legs until MT5 history or a live position confirms the fill.
- Added app-side TP detection from MT5 quote snapshots, idempotent TP-leg `CLOSE_PARTIAL` queueing,
  post-close SL strategy queueing, and broker-history reconciliation for SL closes before TP
  confirmation.
- Changed the EA into a thinner executor/event reporter for virtual TP flow: it reports new deals
  immediately from `OnTradeTransaction`, keeps snapshots/polling at one second, and throttles
  heartbeat/history backfill work separately.
- Added API and EA source regressions covering pending-order arming, app-managed TP1 close queueing,
  SL strategy queueing, SL-history reconciliation, and transaction-driven history reporting.

## 2026-05-18 (Pending order side labels)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.2.2` and kept the
  MT5 EA `#property version` aligned at `1.2.2`.
- Fixed the History Open pending-orders table so MT5 pending order enums such as `BUY_LIMIT` and
  `BUY_STOP` render as BUY instead of being treated as SELL positions.
- Added a web regression test for mixed buy/sell pending order snapshots.

## 2026-05-18 (Compose restart policy)

- Release impact: Patch. Bumped the canonical app version in `package.json` to `1.2.1` and kept the
  MT5 EA `#property version` aligned at `1.2.1`.
- Added `restart: unless-stopped` to the Docker Compose app service so the container comes back after
  host or Docker daemon restarts.
- Added a deployment-config regression test that protects the Compose restart policy.
- Documented the restart policy in the home-server Docker notes.

## 2026-05-18 (Deployment and versioning documentation)

Documentation-only update; no runtime SemVer bump. `package.json` and the EA remain at `1.2.0`.

- Documented root `package.json` as the canonical app version source and the requirement that the
  MT5 EA `#property version` stays aligned.
- Documented home-server Docker Compose v2 usage via `docker compose up -d --build`, including why
  the legacy `docker-compose` v1 binary should not be used for rebuilds.
- Added MT5 demo-terminal verification guidance to check EA/package version alignment before
  compiling.

## 2026-05-18 (Manual position visibility and cashflow-aware performance)

- Release impact: Minor. Added root `package.json` as the canonical app version source at
  `1.2.0`, and kept the EA `#property version` aligned at `1.2.0` because this adds new EA
  snapshot fields, API response fields, and UI states.
- Surfaced MT5 positions and pending orders opened outside Telegram TC directly on the Performance
  view, while preserving the read-only external activity block under Linked Accounts.
- Changed account performance rollups to separate realised trading P/L, live floating P/L, and
  inferred net cashflow from deposits/withdrawals. Account growth now tracks trading equity instead
  of treating later account deposits as profit or hiding floating manual P/L behind closed
  broker-order history.
- Normalised MT5 broker-history timestamps such as `2026.05.18 09:00:00` when calculating current
  month/week/day performance buckets.
- Limited EA virtual-TP rehydration to live `OPEN` plans so failed or genuinely out-of-sync trades
  are not revived into the EA after a restart.
- Added API and web regression coverage for deposit-aware account performance and visible external
  manual positions.

## 2026-05-18 (MT5 virtual TP and sync recovery)

Hardens virtual TP management against broker comment truncation and makes sync uncertainty visible
to the operator instead of silently dropping follow-up TP work.

- Changed MT5 EA comments to compact stable IDs (`ttc:<shortId>` / `ttc:<shortId>:tpN`) while the
  backend resolves those short IDs back to the full logical trade id from persisted trade data.
- Made virtual TP state ticket-first in the EA. The EA now stores the position ticket when the trade
  opens and uses it for virtual TP partial closes, SL strategy moves, runner moves, and trailing
  before falling back to broker-comment matching.
- Added EA diagnostics for virtual TP early-return paths including missing symbols, missing
  position tickets, invalid close volume, invalid strategy prices, non-improving SL moves, invalid
  runner trailing distance, and close retcode failures.
- Fixed backend classification for generic virtual TP reports such as `Request executed` by matching
  the reported partial-close price/volume back to the intended TP leg and recording it as
  `PARTIAL_CLOSE`.
- Fixed `/api/mt5/history` handling for numeric MT5 `DEAL_ENTRY` values so entry deals stay `OPEN`
  and exit deals become `PARTIAL_CLOSE` or `FULL_CLOSE` based on the latest broker snapshot.
- Improved snapshot reconciliation to match live broker state by full comment, compact id, known
  order/position tickets, and broker-order mappings before marking a trade `OUT_OF_SYNC`.
- Extended dashboard trade data and the History UI with out-of-sync reasons, matched broker tickets,
  broker comments, last snapshot timestamps, and a warning presentation when broker evidence is
  partial or missing.

Verification added: EA source tests for ticket-first virtual TP and compact diagnostics, API tests
for generic virtual TP partial-close reports, numeric history entries, and truncated-comment
reconciliation, plus a web test for the History warning state.

## 2026-05-17 (MT5 trade lifecycle hardening)

Closes the lifecycle review gaps around default TP visibility, lifecycle command safety, TP-leg
partial closes, runner/trailing execution, broker-history attribution, and app verification.

- Wired provider TP strategy from the config modal into real execution: the freeform strategy text is
  now a structured dropdown/offset model, normalized by the API, sent in the MT5 line payload, and
  applied by the EA after virtual TP hits to move SL to entry or a prior TP without worsening the
  current stop.
- Added parser safeguards so `MODIFY_SL` without a new stop price and trailing-stop commands without
  a distance require review instead of queueing unsafe MT5 work.
- Default-only market trades now create a visible logical TP leg marked as a default-distance target,
  while the MT5 queue still sends the default TP distance for EA-side price calculation.
- Telegram auto-ingestion now processes clean lifecycle commands after clean open signals in message
  order, so safe commands like trailing-stop updates can be queued when they match exactly.
- Lifecycle approvals now match per linked account, fan out when every account has one clear active
  trade, and keep same-account ambiguous symbol commands out of the MT5 queue.
- TP-leg partial closes now carry the intended allocation/volume into the MT5 line payload, preventing
  `Close TP1` from becoming a full-position close.
- Provider runner config is now sent to MT5 for `VIRTUAL_TP` work. Split-order runner mode is blocked
  explicitly until a dedicated child-order design is implemented.
- The EA now uses ticket-led position/order collection for close, modify, cancel, and trail commands;
  adds persistent timer-managed trailing-stop state; and applies runner SL behaviour after final
  virtual TP handling.
- Broker history pips now respect trade direction, so profitable SELL closes report positive pips.
- Broker-order history labels now distinguish signal opens, app closes/modifies/trailing commands,
  TP/SL hits, manual terminal/mobile/web closes, stop-outs, and other broker reasons.
- Real Telegram session connection no longer creates the hidden demo provider unless demo seeding is
  enabled.
- Fixed the frontend resync test fixture so connected Telegram sessions include the active profile id.
- Added Docker build-context protection for runtime data, Telegram session files, local databases,
  logs, and env files so redeploys cannot read or package already-authenticated provider/session
  state.
- Externalized GramJS and websocket native optional modules from the API bundle so Docker builds use
  installed runtime dependencies without trying to inline Telegram's native websocket helpers.

Verification: focused core/API/EA/web suites pass after the red/green lifecycle hardening tests. Full
typecheck, lint, test, build, and Docker verification are run as part of this implementation pass.

## 2026-05-16 (Broker-aware symbols and Telegram auto-ingestion)

Fixes live provider messages not being picked up automatically and prevents stale demo symbol
settings from blocking OctaFX symbols such as `BTCUSD`.

- Added a backend Telegram ingestion loop for enabled providers. It polls connected GramJS sessions
  every 2 seconds, captures new messages, parses unparsed rows, dedupes repeated Telegram message
  IDs, and queues only clean `OPEN_TRADE` signals that do not require review.
- Added broker-aware symbol resolution. The resolver now prefers exact EA-reported symbols, then
  known broker variants such as `GOLD#`, `BTCUSDm`, and `BTCUSD.raw`, and only then configured
  prefix/suffix fallbacks.
- Replaced the stale demo account mapping defaults with empty broker-aware defaults and added repair
  logic for old `.raw` / `XAUUSD.r` / demo include-list mappings once the EA reports plain broker
  symbols such as `BTCUSD` or `XAUUSD`.
- Updated approval fan-out so each linked MT5 account re-resolves the signal against that account's
  symbol list before queueing.
- Fixed the dashboard status bar so `TG gramjs` is shown as healthy, added provider ingestion status
  hints, and changed the command-palette "parse recent" action to process enabled providers instead
  of the first provider only.
- Hardened GramJS message fetching so it resolves the dialog entity before polling even after a
  server restart.
- Updated the EA source to choose a broker-supported market-order filling mode from
  `SYMBOL_FILLING_MODE` instead of hard-coding IOC, which OctaFX rejected for BTCUSD with retcode
  `10030`.

Verification: focused parser/API/UI regression tests pass for OctaFX-style `BTCUSD`, `GOLD` /
`XAUUSD`, suffix/prefix variants, auto-ingestion queue safety, stale mapping repair, and GramJS
status rendering. Full gate and live deployment verification are tracked with this implementation
run.

## 2026-05-16 (MT5 EA HTTP 500 null-byte fix)

Fixes the live MT5 EA integration where Docker networking and `/api/health` were reachable, but
EA POST requests failed with `Telegram TC HTTP 500: Internal Server Error`.

- Added a root `/health` backend route that returns the same JSON as `/api/health`, so host checks
  no longer fall through to the React app shell.
- Added MT5-specific JSON parsing for `/api/mt5/register`, `/api/mt5/heartbeat`,
  `/api/mt5/report`, `/api/mt5/snapshot`, and `/api/mt5/history`. These routes now strip trailing
  null bytes from MT5-style POST bodies and return `400` for malformed JSON instead of uncaught
  parser `500`s.
- Updated `mt5/TelegramTC_EA.mq5` so `HttpPost()` trims the UTF-8 null terminator produced by
  `StringToCharArray(..., WHOLE_ARRAY, CP_UTF8)` before `WebRequest`.
- Documented the deployed EA base URL as `http://192.168.0.100:18787/api` and the matching MT5
  WebRequest allow-list requirement.

Verification: `bun run format`, `bun run typecheck`, `bun run lint`, `bun test` (97 pass),
`bun run build`, and `bun run docker:build` all pass. Remote host `192.168.0.100` was rebuilt
and redeployed as `telegram-tc:latest`; `/api/health` and `/health` return backend JSON health, a
null-terminated MT5-style register request now returns the expected bad-link `404` instead of a
JSON parser `500`, recent container logs no longer show the null-byte parser error, and the OctaFX
MT5 account is online with fresh heartbeat/snapshot timestamps.

## 2026-05-10 (Parser defaults, quote context, and 6-month KAL VIP backtest)

Parser and MT5 contract changes from the MVP parser pass:

- Added configurable default execution distances: default SL = 50 pips and default TP = 200 pips. The web Settings screen now exposes both values and the API persists them with the existing execution settings.
- Parser context now carries `defaultStopLoss` / `defaultTakeProfit` distances. Short open signals such as `Buy Gold now` no longer require extra normalization purely because SL/TP are omitted when defaults are configured.
- Telegram reply parsing now preserves quoted context for lifecycle replies. `Close half` on a replied-to signal inherits the quoted trade's symbol/account context and parses as `CLOSE_PARTIAL` with 50% close intent.
- `TRAILING_STOP` commands are now first-class supported lifecycle commands instead of automatically blocking execution. The EA still converts pips/points broker-side.
- MT5 poll-line payloads now include default SL/TP distance fields. The EA converts those distances into absolute prices from the execution/reference price using `SYMBOL_POINT`.
- Added a minimal `broker_orders` trail plus `GET /api/trades/:id/broker-orders`, populated from MT5 execution reports so logical trades can be linked back to broker order/deal tickets.
- Backtest reporting now includes `autoActionableMessages`, normalization reason counts, matched-pattern counts, and warning counts.
- Telegram history import can run in chunks via `TELEGRAM_CHUNKED=1`, `TELEGRAM_CHUNK_DAYS`, and `TELEGRAM_HISTORY_DAYS`, using Telegram `offsetDate` so older windows do not repeatedly scan from the latest message.
- GramJS session loading now supports importing an existing local session file with `TELEGRAM_SESSION_FILE`, or auto-importing the only `.json` session in `TELEGRAM_SESSION_DIR` for interim local workflows.
- Added Azure GPT-5.4 mini extraction at `POST /api/signals/:id/ai-review`. It only runs for parser outputs that need additional normalization, reads credentials from environment, and returns explicit `ENTRY`, `SL`, and `TP` fields plus advisory classification. Parser Lab exposes `Extract with GPT` only for those items.
- Added API coverage for GPT extraction: mocked Azure response verifies the hardcoded Foundry deployment name, prompt requirement for `ENTRY`, `SL`, and `TP`, returned field shape, and rejection for parser outputs that do not need normalization.
- Provider Configuration modal now sends full execution config to the API: risk mode/amount, TP allocation rows, and runner config. The backend persists provider execution config and applies TP allocation/risk sizing when building MT5 queue payloads.
- Parser Lab now has direct `Approve` and `Ignore` actions so parser outputs can move into the MT5 queue without leaving the Logs tab.
- Telegram auth now persists pending login state across refreshes/re-renders and exposes a "Wrong phone number? Start over" action on the OTP/2FA screens. Restarting disconnects the pending backend session and returns to phone entry.
- Real GramJS deployments no longer auto-create the demo/mock provider after login, and `/api/telegram/dialogs` no longer falls back to mock dialogs when no real connected session is available. Demo rows are hidden unless demo seeding is explicitly enabled.
- Legacy mock provider rows (`dialog-alpha`) are hidden in non-demo deployments so real Telegram logins do not show `Alpha FX Signals`.
- Implemented the current UI polish roadmap pass from `docs/ui-improvements.md`: motion utilities, account KPI stagger animation, sticky sortable provider-table headers, quieter row actions, glassier modal/status chrome, intentional empty/skeleton primitives, provider-table sorting, and clearer whole-row Telegram dialog selection.
- Extracted major app surfaces into `apps/web/src/pages/*` and added `useSortableTable`, `Skeleton`, and `EmptyState` building blocks. `App.tsx` now delegates Performance, Providers, History, Equity Guardian, Telegram Setup, Linked Accounts, Symbol Settings, Logs, and Settings to page components.
- Provider management polish: Telegram dialog rows are sorted with channels/groups before user dialogs, user rows are visually de-emphasized, adding a dialog now asks for confirmation, and Providers now has a Remove action backed by `DELETE /api/providers/:id`.
- Live account onboarding now appears directly inside the Live/Performance tab. When no MT5 account is connected, operators see the link-slot workflow immediately; created slots and connected MT5 accounts render in Live as account cards as well as under Linked Accounts.
- Added account-to-provider routing controls in Live and Linked Accounts. Each connected MT5 account can now be assigned to specific configured providers, and open signals fan out to every linked account for that provider when links exist.
- History can fetch and expand the broker-order trail for a logical trade through `GET /api/trades/:id/broker-orders`, showing order, position, and deal tickets.
- The MQL5 EA report contract now includes `positionTicket` on reports where a position ticket is known, including modify, close, virtual TP close, and best-effort post-open reports.
- Added account-slot/link-code API and Linked Accounts UI. The EA now has a `LinkCode` input and sends it on register/heartbeat; bad link codes are rejected and linked slots show the broker account once connected.
- Added Equity Guardian persistence, API, queue enforcement, and UI. Paused/breached accounts reject new `OPEN_TRADE` leases while allowing non-open lifecycle work to continue.
- Added basic account/provider performance data from MT5 account state and broker-order rows. Provider rows now display pips/P&L/profit/gain fields when data is available.
- Symbol Settings now uses real persisted alias/account mapping rows instead of static preview rows, with backend support for deleting aliases.
- Broker-order rows now include best-effort `pnl_currency` and `pnl_pips` attribution for close/partial-close actions when open and close fill prices are available.
- Settings now includes an Azure GPT API key field. The key is stored server-side in local SQLite `app_secrets`, and dashboard state only exposes whether a key is configured.
- Parser Lab Saved Fixtures now renders recent saved fixtures instead of a placeholder.
- Symbol Settings now supports provider aliases in the Add Mapping modal and can delete global/provider aliases from the table.
- Performance chart now prefers backend account-performance equity/drawdown series and falls back to placeholder data only when no series is available.
- Lifecycle queue payloads now include target broker order/position/deal tickets derived from `BrokerOrder`, and the EA consumes target order/position tickets for pending-order cancellation and position management.
- Snapshot reconciliation now records best-effort manual `FULL_CLOSE` broker-order rows when a previously reported EA-owned broker ticket disappears from MT5 positions/orders.
- Added provider config history and provider config test endpoints so backend strategy changes can be audited and dry-run against sample raw messages.
- Added execution-log detail endpoint returning the report, queue payload, and broker-order trail for drilldown.
- Added `/api/mt5/history` and EA-side `SendHistoryDeals()` so recent broker deal history is posted with deal/order/position tickets, close price, profit, commission, swap, and comments. The backend deduplicates by `deal_ticket` and records exact history-backed broker-order rows when it can match the deal to a logical trade.
- The EA no longer defaults to a loopback API URL. `BackendBaseUrl` is now a placeholder that must be set per environment, and `PollSeconds` defaults to 1 second.
- Improved backend performance rollups from broker-order P/L rows and added API coverage for exact broker-history close reconciliation.
- Disabled runtime demo seeding by default; local demo data now requires `SEED_DEMO_DATA=true` or explicit test options.
- Added queue lease timeout recovery/expiry with configurable `leaseTimeoutSeconds` and `maxLeaseAttempts`.
- Heartbeat freshness is now computed dynamically (`online` / `stale` / `offline`) from `last_heartbeat_at`.
- Heartbeats with invalid link codes are rejected, and linked non-legacy slots require the EA to keep sending its link code.
- GPT extraction is blocked for `NO_SIGNAL` parser outputs.
- Equity Guardian unpause now appends an audited `manual_unpause` event to breach history.
- Parser account context now uses the first linked MT5 account or `DEFAULT_MT5_ACCOUNT_ID` instead of silently relying on the demo account for real parser paths.
- EA risk-percent sizing now uses broker tick size/value and account balance when volume is not explicitly provided.
- Updated the main spec with MVP outstanding status, 6-month KAL VIP parser baseline, default SL/TP rules, quote/reply lifecycle behavior, and pip/point conversion rules.

Latest 6-month KAL VIP backtest (`2025-11-08` to `2026-05-10`):

- Total messages: 4,610
- `NO_SIGNAL`: 2,790
- `OPEN_TRADE`: 946
- `TRADE_SETUP`: 60
- Lifecycle commands: 897
- Actionable messages: 1,843
- Auto-actionable after parser rules: 1,710
- Actionable requiring GPT extraction/operator confirmation: 133 (7.22% of actionable)

Verification: `bun test packages/core apps/api apps/web` 72 pass · `bun run typecheck` clean · `bun run build:web` clean.

## 2026-05-10 (Symbol Settings cleanup — Add-Mapping modal)

Replaces the cramped two-form layout above the Symbol Settings table with the same modal-driven UX as Provider Config:

- Removed the inline `Alias raw / canonical` form and the 6-input `Mapping account / canonical / broker / suffix / include / exclude` form.
- New `apps/web/src/components/SymbolMappingModal.tsx` — accessible (`role="dialog"`, `aria-modal`, Escape, click-outside-to-close), uses the same `modal-form-clean` chrome as the Provider Config modal, with a `Global alias` / `Account-specific` segmented control toggle. Form fields render conditionally per scope, and the Save button label flips to match.
- Symbol Settings tab is now: `Add mapping` button (primary, top-right) + the `SymbolMappingsTable`. No more dead two-thirds-of-the-screen empty area when the panel was the only thing showing.
- Modal uses uncontrolled `defaultValue` inputs + `FormData` on save (same pattern as Provider Config) so test assertions for Alias/Mapping field values round-trip correctly.
- Dropped the now-unused `aliasForm` / `mappingForm` controlled state and the `commaList` helper from `App.tsx`. `useRef` import removed.
- Test 7 updated: opens the modal twice (once for global alias, once for account mapping switching to the Account-specific tab), asserts the same payloads as before.

Verification: `bun test apps/web/` 9 pass · `bun run --cwd apps/web build` clean (250 KB JS + 52 KB lazy uplot + 43 KB CSS).

## 2026-05-10 (Provider Config modal redesign + runner + e2e order tracking spec)

Two pieces of feedback addressed in one commit:

**Runner support** — operators can now leave a small remainder open after the final TP hits (the classic "let a runner ride with SL on BE" pattern):

- New `Runner` section in the Provider Config modal with: enabled toggle, runner lot size, SL behavior select (Move to break-even / Move to last hit TP / Trail by N pips). When trail is selected a "Trail pips" input appears.
- Order summary updated: shows total order, lots allocated to TPs, runner reservation, and a per-action timeline ("TP1 hit · close 0.02 lots · Set SL to ENTRY + 0 pips" → "After final TP · keep 0.01 lots open · SL at break-even").
- `ProviderConfigSubmission` now carries `runner: { enabled, lotSize, slBehavior, trailPips }`. Backend wiring is a follow-up — the UI shape is locked.

**Modal restyled to match the rest of the app**:

- Dropped the "1." / "2." / "3." section numbering, hand-styled green-soft pill toggles, and the gray "Order Resume" tutorial box.
- Risk-mode toggle is now a segmented control matching the Performance tab's chart toggle (`Fixed lots` / `% of balance`).
- Section headers use the same uppercase muted-grey label pattern as the data-table headers.
- TP rows use the same border / hover / monospace tokens as `data-table` rows; the steppers and strategy inputs share input chrome with the rest of the dashboard.
- Order summary is a compact stat-card (Total order / Allocated to TPs / Runner) above an interleaved timeline of TP closes and the runner finale, all using `tabular-nums` mono numerics.
- Modal width slightly wider (720 px max) to fit the 3-stat resume grid.

**Spec — End-to-end trade ↔ broker order linkage** (responding to "we need to map and link the trade taken to a orderID so we can track the order e2e"):

- New "End-to-end order tracking" section in the spec under Position State and TP Management, defining the `BrokerOrder` table that joins LogicalTrade ↔ TradeLeg ↔ broker tickets/deals.
- Captures `order_ticket`, `position_ticket`, `deal_ticket`, requested vs filled volume / price, retcode, broker comment, source (`signal` vs `manual`), and per-action P/L for every open / partial-close / full-close / modify / cancel / trail.
- Per-leg / per-trade / per-provider P/L are derived deterministically from BrokerOrder aggregation — no re-parsing broker history.
- EA `/api/mt5/report` payload contract extended to enrich every report with the broker-side identifiers so partial fills are not lost.
- Manual closes from the MT5 terminal are picked up via snapshot diff and recorded as `BrokerOrder { source: "manual" }` so History reflects reality.
- New `BrokerOrder` entity in Data Model. New `GET /api/trades/:id/broker-orders` endpoint added under Per-trade events API.

Verification: `bun test apps/web/` 9 pass · `bun run --cwd apps/web build` clean (247 KB JS + 52 KB lazy uplot + 43 KB CSS).

## 2026-05-10 (History + Symbol Settings tabularised; Signal Queue moved to Logs)

Brought the History and Symbol Settings tabs in line with the rest of the app:

- **History tab**: replaced the per-trade card-with-grid wall (`TradeCard` × N) with a single `HistoryTable` (`apps/web/src/components/HistoryTable.tsx`). Columns: Trade · Symbol · Side · Mode · Status · TPs · TP progress. Each row has tabular-nums monospaced cells, a green/red side chip, and an inline TP-progress strip showing each leg as a pill (HIT green / OPEN indigo / CLOSED faded / PLANNED neutral) with the target price + allocation %.
- **Symbol Settings tab**: replaced the bespoke `mapping-row` divs with `SymbolMappingsTable` (`apps/web/src/components/SymbolMappingsTable.tsx`) — same `data-table` styling as Providers. Columns: Raw symbol · Canonical · Broker symbol · Status. The two add-mapping forms above the table stay for now.
- **Signal Queue moved to Logs tab**: the queue panel previously lived under History but the spec (and the user's mental model) treats queue / parser / exec logs as the live operational feed. Logs tab now renders Parser Lab + Signal Queue + Execution Logs.
- **Single-panel views go full width**: Telegram Setup, Linked Accounts, and Settings (sidebar destinations) now use `wide-panel` so they fill the workspace instead of leaving two-thirds of the screen empty.
- Linked Accounts panel renamed from `MT5 Accounts` to match the sidebar label.
- Removed the now-unused `TradeCard.tsx`.

Verification: `bun test apps/web/` 9 pass · `bun run --cwd apps/web build` clean (244 KB JS + 52 KB lazy uplot + 36 KB CSS).

## 2026-05-10 (Sidebar dedup + TSC-style Provider Config modal)

Addresses the "sidebar/tabs are duplicated" and "Provider Config modal should look like the TSC screen" feedback:

- **Sidebar shrunk** to four top-level destinations only — `Live`, `Telegram Setup`, `Linked Accounts`, `Settings`. Old per-section items (Providers, Parser Lab, Trade Lifecycle, MT5 Accounts, Symbol Mapping, Execution Logs) are now exclusively in the WorkspaceTabs strip. Sidebar no longer repeats anything tabs already cover. `Dashboard` renamed to `Live`; `MT5 Accounts` renamed to `Linked Accounts` so the sidebar matches the spec.
- **Provider Config modal redesigned** to match the TSCopier "Configure Providers" screen:
  - Section 1 — Message Template: parser mode select labelled `Template` plus a `Test message` button.
  - Section 2 — Risk Management: single value field with two pill toggles ("Use fixed lots" / "Risk a % of your account balance"). Active pill shows the live lot/percent value in green-soft chip.
  - Section 3 — Take Profit Levels: editable rows with `TP #` / `Percentage` (with − / + steppers) / `Strategy` text input / delete-row button. "Distribute % equally" action splits across rows. "Add a new Take Profit level" appends a row.
  - Section 3.1 — Order Resume: derived plain-text summary that updates live as the user changes risk amount / TP percentages.
- **Risk Profile dropped** from the modal and from the PATCH payload. Sizing is now explicit per-channel (lot size or % balance) — no more abstract Balanced/Conservative/Aggressive buckets. Backend retains the column for backward compat but the UI never sends it.
- **`Risk` column removed** from the Providers table (no longer meaningful) — table is now Name · Lots · TP # · SL · Pips · W/L % · Avg.DD · P/L · Profit · Gain · Status · Actions.
- Modal save reads numeric inputs directly from `FormData` instead of React state to dodge the controlled-input flush quirks happy-dom showed under fireEvent.
- Tests adjusted: sidebar text assertions match the new top-level rail (`Linked Accounts` instead of `MT5 Accounts`, `Live` instead of `Dashboard`); provider-settings test no longer touches Risk profile and asserts the new payload `{parserMode, lotSize}`.

Verification: `bun test apps/web/` 9 pass · `bun test apps/api/` 35 pass · `bun run --cwd apps/web build` clean (242 KB JS + 52 KB lazy uplot + 35 KB CSS).

## 2026-05-10 (Spec sync with shipped UI + design corrections)

Brought `docs/superpowers/specs/2026-05-09-telegram-copy-app-design.md` back in line with what was actually shipped over the last five commits and what was decided in conversation:

- **Visual direction** rewritten — replaced the "modern dark terminal: cyan on near-black" wording with the actual implementation: light theme, body `#f5f6fa`, white panels, indigo `#5046e5` primary, Telegram-blue `#229ED9` reserved for sign-in chrome, green/red for direction, amber for warnings. Inter UI + JetBrains Mono for numerics, light shadows, 6–8 px radius, `uplot` for charts.
- **Frontend Screens** restructured into Sign-in screen + Live workspace, with the explicit non-duplication rule between sidebar and tabs (sidebar holds Live / Telegram Setup / Linked Accounts / Settings; everything else lives in WorkspaceTabs). Each tab now has a dedicated description.
- **Provider Configuration modal** description rewritten to match the TSC modal screen — Risk Management is a single-field with a fixed-lots / %-of-balance toggle (no abstract "Risk profile"), TP Levels are an editable per-row list with strategy lines, plus a derived Order Resume summary. Spec now explicitly states "There is no abstract Risk profile (Balanced/Conservative/Aggressive) — sizing is explicit per channel."
- **Telegram /api/telegram/start** documented to fall back to server-side `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` env so the browser never sees secrets.
- **Architecture** section now mentions the actual stack — React + Vite + Inter / JetBrains Mono, `uplot` lazy-loaded, served static from the API origin.
- New **MT5 ↔ EA account linking** section: link-code workflow (App pre-creates a named slot with a short code → operator pastes the code into the EA's `LinkCode` Input → EA includes `linkCode` in every register/heartbeat → backend matches to the slot). Removes the smoke-test pollution by giving each EA pairing an explicit, named, code-mediated slot.
- New `AccountSlot` entity in Data Model.

Verification: `bun test apps/web/` 9 pass · `bun test apps/api/` 35 pass · spec compiles to 627 lines.

## 2026-05-09 (Performance growth chart — TSC parity)

- New `apps/web/src/components/GrowthChart.tsx` — uplot-backed account-growth chart with a Growth / Drawdown toggle. Indigo line + faint area fill matching the rest of the theme (`#5046e5` for growth, `#ef4444` for drawdown), `tabular-nums` axis labels formatted as `$1,234` and `0.0%`.
- uplot lives in a dynamic `import()` inside the chart's `useEffect` so it never touches `document` at module-load. This keeps the build splitting clean (uplot becomes its own ~52 KB chunk only fetched when the user lands on the Performance tab) and dodges the happy-dom `doc.createElement` SSR-ish error that broke tests on first attempt.
- Replaces the "Performance charts coming next" empty state on the Performance tab with the live chart. Stub series generated client-side via `buildPlaceholderGrowth(executedCount)` so the visual lands now; will swap to real `GET /api/equity-curve` when that endpoint ships.
- Resize observer keeps the canvas sized to the container so the chart re-flows on window resize.

Verification: `bun test apps/web/` 9 pass · `bun run --cwd apps/web build` clean (main chunk 240 KB JS / 31 KB CSS, uplot lazy-loaded as its own 52 KB chunk).

## 2026-05-09 (Providers data table + config modal — TSC parity)

Replaces the cramped per-row provider cards with a proper TSC-style data table and a deep configuration modal:

- New `apps/web/src/components/ProvidersTable.tsx` — sortable-ready table with the TSC column set: `Name · Risk · Lots · TP # · SL · Pips · W/L % · Avg. drawdown · P/L · Profit · Gain · Status`. Numeric columns are right-aligned with `tabular-nums`. Per-row Configure (gear) and Pause/Enable buttons. Columns without backend support yet render `—` in muted grey so the shape matches TSC even before analytics endpoints land.
- New `apps/web/src/components/ProviderConfigModal.tsx` — accessible modal (`role=dialog`, `aria-modal`, Escape-to-close, click-outside-to-close) opened from the gear icon. First field is the operator-owned **Channel lot size** with live "Allocation 25/25/25/25 → 0.05 per TP leg" preview, plus parser mode and risk profile. Pivots to uncontrolled inputs + `FormData` read on save so locale-stable lot strings (`"0.2"`/`"0,2"`) round-trip correctly through happy-dom tests.
- App shell wires the modal: `configProvider` state, `onConfigure` opens it, `onSave` POSTs `/api/providers/:id` and refreshes the dashboard, modal closes on success.
- Removed the now-unused `apps/web/src/components/ProviderRow.tsx`.
- Tests updated: provider-settings test opens the modal first via the gear icon before changing parser/risk/lot fields. 9 web tests still green.

Verification: `bun test apps/web/` 9 pass · `bun test apps/api/` 35 pass · `bun run --cwd apps/web build` clean (236 KB JS, 30 KB CSS).

## 2026-05-09 (In-workspace tabs — TSC parity)

Added a tabbed workspace inside the dashboard to scope live operations sections instead of rendering nine panels simultaneously:

- New `apps/web/src/components/WorkspaceTabs.tsx` exposing six tabs: `Performance`, `Providers`, `History`, `Equity Guardian`, `Symbol Settings`, `Logs` (proper ARIA `role="tablist"` / `role="tab"`).
- App shell wires each panel to its tab — Providers panel under `Providers`, Symbol Mapping under `Symbol Settings`, Trade Lifecycle + Signal Queue under `History`, Parser Lab + Execution Logs under `Logs`. Performance and Equity Guardian show empty-state placeholders until charts and threshold controls land.
- Sidebar items remap onto tabs: clicking `Providers / Parser Lab / Trade Lifecycle / Symbol Mapping / Execution Logs` now switches the dashboard tab instead of rendering a one-off panel. `Telegram Setup`, `MT5 Accounts`, `Settings` keep their dedicated views.
- Default tab is `Performance` (with a "charts coming next" empty state) so the first thing operators see post-sign-in is calm summary chrome, not a wall of panels.
- Tests updated to navigate tabs and sidebar before asserting per-panel content; multi-panel "everything together" test split into per-tab assertions. 9 web tests pass.

Verification: `bun test apps/web/` 9 pass · `bun run --cwd apps/web build` clean (231 KB JS, 24 KB CSS).

## 2026-05-09 (Account header strip — TSC parity)

Replaced the four "Providers / Parser Review / Queue / MT5 Accounts" metric cards with a TSC-style account header strip at the top of the workspace:

- Added `apps/web/src/components/AccountHeader.tsx` with two regions: left = `Live` heading + Connected Platform card (Platform · Broker · Type · Expert Advisor + EA WORKING/EA OFFLINE badge), right = five KPI columns (Initial Balance, Total Profit, This Month, This Week, Today). Currency, amounts, and Δ% badges are formatted en-US locale-stable.
- Stub financial KPIs render as `—` with muted Δ chips until backend `/api/account/performance` lands. Connected Platform / EA status are computed from the existing `snapshot.mt5Accounts` (broker derived from server prefix, DEMO/LIVE inferred from server name, EA active = heartbeatStatus online).
- Removed the duplicate marketing topbar (`Live operations` eyebrow + `Telegram TC Operations` h1) — it was contradicting the StatusBar that already shows the app title.
- Promoted the StatusBar `<span class="brand">TG-TC · Operations</span>` to an `<h1>` so the page has a single canonical heading. Test updated to assert the new heading.
- Deleted unused `apps/web/src/components/MetricsGrid.tsx` and trimmed dead lucide-react imports / the unused `metrics` `useMemo`.

Verification:

- `bun test apps/web/` — 9 pass.
- `bun run --cwd apps/web build` — clean (229 KB JS, 23 KB CSS).

## 2026-05-09 (Sign-in & light theme)

Polished the first screen so it matches the TSCopier sign-in style instead of the dense dashboard:

- Added a full-viewport `SignIn` component (`apps/web/src/components/SignIn.tsx`) shown while no Telegram session is connected. Telegram-blue header bar, centered circular logo, "Sign in to Telegram" heading + subtitle, Material-style floating-label phone field, primary CTA. Replaces the previous in-dashboard `Telegram Setup` panel for the unauthenticated state.
- Pivoted the global theme from dark to light. `apps/web/src/styles.css` `:root` tokens now use white panels on `#f5f6fa`, indigo `#5046e5` primary, Telegram-blue `#229ED9` for the sign-in chrome, and Inter UI + JetBrains Mono. Sidebar active state, panel shadows, and card surfaces adjusted for the light palette.
- Stopped collecting Telegram API ID and API hash in the frontend. The backend `/api/telegram/start` handler now falls back to `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from the server env (`apps/api/src/app.ts`), so secrets never travel through the browser. The SignIn screen exposes only the phone-number field.
- Added a `setupStep` sync effect in `App.tsx` so the SignIn screen flips to the dashboard automatically once the polled snapshot reports a `CONNECTED` Telegram session.

Verification:

- `bun test apps/web/` — 9 pass.
- `bun test apps/api/` — 35 pass.
- `bun run --cwd apps/web build` — clean (228 KB JS, 20 KB CSS).

## 2026-05-09 (Doc work and design spec expansion)

- Added `docs/ui-improvements.md` — critical review of `apps/web` with TSC feature-parity scope, "modern dark terminal" direction, channel-lot-size UI surfaces, three-pass implementation sketch, and detailed file change list.
- Expanded `docs/superpowers/specs/2026-05-09-telegram-copy-app-design.md` with new sections for Analytics & Performance, Equity Guardian, and Provider Strategy Configuration; reworked Frontend Screens around a top-level rail and Live-workspace tabs; added matching Backend Responsibilities, Data Model entities, Product Scope items, and Success Criteria; replaced the contradictory Rantoniaina visual reference with the dark-terminal direction.
- Committed the entire MVP working tree (`apps/`, `packages/`, `migrations/`, `mt5/`, `scripts/`, root configs, supporting docs) as `feat: scaffold telegram-tc MVP` so the repo no longer has the bulk of the implementation untracked.

## 2026-05-09

Implemented and verified the Telegram/KAL VIP parser backtest workflow.

Changes made in this session:

- Added local Telegram environment configuration in ignored `.env` for GramJS login, phone-based auth, saved session reuse, and the target `KAL VIP` dialog.
- Added persistent GramJS session reuse so saved Telegram session strings can reconnect after the API process restarts.
- Added local Telegram flow script at `scripts/telegram-flow.ts` for starting login, submitting OTP/2FA, listing dialogs, selecting KAL VIP, importing history, and running parser backtests.
- Added package scripts: `telegram:start`, `telegram:dialogs`, `telegram:select`, `telegram:import`, and `telegram:backtest`.
- Authenticated Telegram successfully with OTP and selected the KAL VIP provider.
- Imported 2,215 KAL VIP messages from roughly the last 3 months into ignored local SQLite storage.
- Added provider history import endpoint: `POST /api/providers/:id/import-messages`.
- Added provider parser backtest endpoint: `POST /api/providers/:id/backtest`.
- Added backtest JSON report output under ignored `data/backtests/`.
- Updated Telegram capture to include quoted/replied message text when available, allowing parser context for comments such as `Put this back`.
- Added quote-aware parser handling for reinstated signals where a later comment reactivates a quoted signal.
- Added wall-of-text signal extraction for `Execution Model` and `Execution Plan` blocks containing entry, SL, and TP details.
- Added direction inference from entry, SL, and TP geometry when a signal block omits explicit BUY/SELL wording.
- Added support for KAL VIP shorthand gold signals such as `Gold buy limit`, `Gold sell limit`, compact entry zones, and compact TP ranges.
- Added `NO_SIGNAL` classification to stop treating ordinary channel chatter and result summaries as executable trade entries.
- Tightened lifecycle classification for TP hits, SL result updates, cancels, close commands, and modification commands.
- Added explicit `TRAILING_STOP` command parsing with pips/points preserved as data instead of converted prematurely.
- Added parser fixtures for education/analysis text, result updates such as `Buy 66 full TP 400pips`, TP-only lifecycle updates such as `TP 1`, executable KAL VIP gold limits, and trailing-stop pips/points.
- Added detection for conditional multi-scenario plans so posts with both buy and sell setups plus `only if`/`reaction-based` wording are treated as analysis, not executable orders.
- Applied KAL VIP's default Gold/XAUUSD provider context to symbol-less lifecycle updates such as `TP 1`, reducing false operator-confirmation items.
- Added Parser Lab fixture labelling controls in the dashboard so captured parsed messages can be marked as entry, management, noise, or unknown and saved as reusable parser fixtures.
- Added optional redacted fixture text capture in Parser Lab so sensitive names, links, or account details can be replaced before saving deterministic fixtures.
- Tightened Parser Lab fixture-redaction coverage so the saved fixture payload reflects the operator-edited text from the fixture row.
- Extended dashboard parser results with raw message IDs and classification metadata for fixture capture.
- Added provider auto-copy enable/pause controls in the dashboard, backed by the existing provider settings API.
- Added provider parser-mode and risk-profile settings through SQLite-backed API persistence and dashboard controls.
- Added configurable global symbol aliases and account symbol mappings through the API and dashboard controls.
- Added SQLite-backed execution settings for default lot size, default risk percent, MT5 polling interval, and allowed order types, with dashboard controls.
- Enforced allowed order types during signal approval so disabled market, limit, or stop orders cannot enter the MT5 queue.
- Propagated default lot size and risk percent into queued MT5 poll-line payloads, and updated the EA to use backend-provided command volume with its local default as a fallback.
- Added configured MT5 polling intervals to both work and no-work poll-line payloads, with EA timer refresh support.
- Persisted ignored and duplicate parser decisions as non-leaseable queue items so the dashboard can show those queue states without sending them to MT5.
- Reconciled MT5 execution reports back into logical trade state so executed opens mark TP legs open and virtual-TP broker comments close the matching TP leg on the dashboard.
- Recorded provider-announced `MARK_TP_HIT` lifecycle messages locally against the matched logical trade instead of queueing unsupported MT5 work.
- Persisted latest MT5 snapshots per account, surfaced broker position/order counts in the dashboard, and marked open logical trades out of sync when snapshots no longer contain matching broker records.
- Added deterministic parser extraction for optional lot size and risk percent as review metadata only; MT5 execution no longer trusts provider-sent lot/risk hints.
- Added per-Telegram-channel lot size persistence, API updates, and dashboard controls so each provider owns its execution volume.
- Added explicit per-TP volume splitting in queued MT5 line payloads, for example channel lot `0.20` across four TP targets sends `0.05` per TP leg.
- Updated the MQL5 EA to consume backend-provided TP leg volumes for split-order requests and virtual-TP partial closes.
- Added account-scoped MT5 log inspection at `GET /api/mt5/accounts/:accountId/logs`, with optional account filtering on `GET /api/execution-logs?accountId=...`.
- Added SQLite/D1-ready `symbol_aliases` persistence and parser-context merging so saved aliases affect subsequent parser resolution.
- Verified live fixture capture through the API: raw message classification update, fixture save, and fixture retrieval with Telegram/raw-message metadata and expected parser fields.
- Added local MT5 API/EA contract smoke script at `scripts/mt5-smoke.ts`.
- Added package script: `mt5:smoke`.
- Extended typechecking to cover `scripts/`, including Telegram and MT5 helper scripts.
- Verified the local MT5 contract smoke against the running API. The smoke registered a unique demo MT5 account, sent heartbeat, parsed and approved an `OPEN_TRADE`, leased the line-oriented `/api/mt5/poll-line` payload, reported execution through `/api/mt5/report`, then repeated the same flow for a `MOVE_SL_TO_BE` lifecycle command matched to the logical trade.
- Documented that `bun run mt5:smoke` proves the backend contract consumed by the EA, but does not replace a real MetaTrader terminal compile/run.
- Added `MODIFY_TP` dispatch and SL/TP modification handling to the MQL5 Expert Advisor.
- Fixed MQL5 execution report calls so every `Report(...)` call passes the explicit `volume` argument expected by the report function.
- Added static EA source tests for `MODIFY_TP` dispatch and compile-safer `Report(...)` call arity.
- Added MT5 smoke helper coverage for heartbeat payloads with terminal symbols.
- Tightened MQL5 broker-state matching so position management and pending-order cancellation check logical trade IDs embedded in broker comments, not only symbol plus magic number.
- Added static EA source coverage for logical-trade comment matching on positions and pending orders.
- Added MQL5 snapshot reporting to `/api/mt5/snapshot` with current EA-owned positions and pending orders, including tickets, symbols, type, volume, open price, SL, TP, profit, and broker comments.
- Extended MQL5 snapshots with selected-symbol bid/ask, point, digits, and broker volume min/max/step metadata for plan-vs-reality checks.
- Added static EA source coverage for snapshot reporting.
- Replaced chart-symbol-only MT5 `availableSymbols` payloads with a terminal symbol inventory built from `SymbolsTotal(false)` and `SymbolName(index, false)`.
- Added static EA source coverage so registration and heartbeat symbol reporting cannot regress to `_Symbol` only.
- Added pending-order price validation in the MQL5 EA against current bid/ask and broker `SYMBOL_TRADE_STOPS_LEVEL` distance before sending pending order requests.
- Added static EA source coverage for pending-order bid/ask and stop-level validation.
- Added MQL5 execution for `TRAILING_STOP`, converting pips or points with the broker symbol point size before improving SL.
- Added API approval support for configurable execution mode, so approved open signals can queue either default `VIRTUAL_TP` or explicit `SPLIT_ORDER`.
- Added MQL5 split-order execution that creates one child request per configured TP leg with per-leg volume allocation and TP-specific comments.
- Added MQL5 virtual TP monitoring that tracks TP1-TP4 legs after a virtual-TP open, watches live bid/ask on timer, and closes planned partial volumes when a TP threshold is hit.
- Added tests for trailing-stop line-poll payloads, split-order approval payloads, split child order source coverage, and virtual TP source coverage.
- Added `docs/mt5-demo-terminal-verification.md` with the remaining manual MT5 compile/demo-terminal verification runbook.
- Documented the important pips/points behavior in parser output: conversion must happen broker-side using the account symbol point size.
- Added parser tests for KAL VIP gold limit signals, result chatter, quote reinstatement, wall-of-text execution blocks, education text, TP lifecycle updates, and trailing stop pips/points.
- Updated Biome includes so ignored local Telegram session files under `apps/api/data/` do not break linting.

Latest KAL VIP backtest after parser improvements:

- Total messages: 2,215
- `NO_SIGNAL`: 1,233
- `OPEN_TRADE`: 729
- Lifecycle commands: 253
- Actionable messages: 982
- Actionable messages requiring review: 83
- Actionable review rate: 8.45%

Verification run after code changes:

- `bun run typecheck`
- `bun test`
- `bun run lint`
- `bun run build`
- `bun run docker:build`
- `bun run mt5:smoke`
- Live GramJS dialog listing against the saved Telegram session.
- Live KAL VIP parser backtest via `bun run telegram:backtest`.
- Playwright desktop and mobile screenshots for the dashboard fixture controls.

Latest MT5 local contract smoke:

- Account registered: unique `mt5-900...` demo account generated per smoke run.
- Heartbeat: account reported `online` through `/api/mt5/heartbeat`.
- Open command: `OPEN_TRADE` for `EURUSD.raw` leased from `/api/mt5/poll-line` and reported as executed with retcode `10009`.
- Lifecycle command: `MOVE_SL_TO_BE` for the same logical trade leased from `/api/mt5/poll-line` and reported as executed with retcode `10009`.
- Execution logs: both smoke queue items found in `/api/execution-logs`.

Known remaining parser gaps:

- Some educational messages can still resemble lifecycle instructions if they contain trade-management words in natural language.
- TP-only updates such as `Tp 1` still require matching to the most recent open logical trade before they can be safely acted on.
- More KAL VIP messages should be manually labelled as fixtures to calibrate false positives and false negatives.
- Image/OCR signal parsing remains deferred and is not implemented.

## 2026-05-09 (Web UI Milestone 1)

Completed Bloomberg-terminal-style dark UI rewrite for `apps/web` + 8 functional bug fixes.

Infrastructure & theming:
- Rewrote `apps/web/src/styles.css` with a dark-terminal palette (`--bg: #0c0f12`, `--panel: #12161b`, `--accent: #54b8ff`), flat 1 px borders, zero shadows, `tabular-nums`, `Inter`+mono stacks, and a maximum 4 px radius.
- Updated `apps/web/index.html` with `<meta name="color-scheme" content="dark">` and title `TG-TC · Operations`.
- Installed `uplot` (~40 KB) as the lightweight charting dependency for Milestone 3.

Structural rewrite:
- Created `apps/web/src/components/` with `Tag.tsx`, `StatusBar.tsx`, `Sidebar.tsx`, `Panel.tsx`, `SetupFlow.tsx`, and `DialogPicker.tsx`.
- Rewrote `App.tsx` shell around three new regions:
  - `StatusBar` (28 px sticky top bar): brand, DB/Telegram health chips, signal-queue count, UTC clock, live pulse dot, and wired refresh action.
  - `Sidebar` (200 px sticky nav): section switcher driven by `activeView` state.
  - Conditional panel rendering via `activeView`; default `"dashboard"` renders all panels simultaneously to preserve existing test DOM assertions.
- Replaced `StatusPill` with `Tag` component using 1 px border tone tokens (`good`/`warn`/`muted`/`up`/`down`).

Bug fixes:
- **(a)** Wired the refresh action into `StatusBar` so the top-right refresh button actually triggers `refreshDashboard()` instead of being a no-op.
- **(b)** Wired `activeView` sidebar navigation as a real section switcher (`showDashboard`, `showTelegram`, `showProviders`, etc.).
- **(c)** Fixed `mappingForm.accountId` syncing via `useEffect` + `hasSyncedMapping` ref so the mapping form defaults to the first live MT5 account instead of a hardcoded placeholder.
- **(e)** Replaced the DOM-hack fixture redaction with proper `redactedFixtureText` React state + ref map, fixing race conditions during fixture saves.
- **(f)** Replaced the static `"-"` placeholder with a live pulse dot in the status bar to indicate real-time connection health.
- **(g)** Added `lastPollError` and `refreshing` states with visual feedback (error chip, loading state on refresh button) so the operator knows when dashboard health is stale or reloading.
- **(h)** Ensured execution log timestamps render in a dedicated `timestamp` column instead of being omitted.

Form/test interop:
- Converged alias and mapping forms to controlled inputs for UI consistency, while reading from `FormData` on submit to remain compatible with existing `fireEvent.change` tests.
- Used `Map<HTMLTextAreaElement>` refs for fixture textarea values so `Save fixture` reads synchronously from the DOM, bypassing React state batching issues in the Happy DOM test environment.

Verification:
- `bun test`: 63 pass, 0 fail.
- `bun run typecheck`: clean.
- `bun run lint`: clean (warnings only).
- `bun run build`: web bundle 220 KB JS + 17 KB CSS.

Known remaining MT5 verification gap:

- The backend/EA HTTP contract has been smoke-tested locally, and the EA source is statically covered by tests, but the `.mq5` file still needs to be compiled and run inside a real MetaTrader 5 demo terminal to prove actual order placement, broker retcodes, and hedging/netting behavior.

Known remaining MT5 implementation gaps:

- EA-managed virtual TP1-TP4 monitoring is implemented in source but still needs demo-terminal proof under real broker ticks and volume constraints.
- Split-order mode creates TP child requests in source but still needs demo-terminal proof on hedging and netting accounts.
- `TRAILING_STOP` is implemented in source but still needs demo-terminal proof against symbol point sizes and broker stop-level rules.
