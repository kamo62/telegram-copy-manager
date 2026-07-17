# Signal correlation and provider-aligned lifecycle handling

Status: design, pre-implementation. Author: orchestration session 2026-07-17.

## Problem

Providers post more than opening signals. They cancel pending orders, announce
TP hits, move stops, and recommend re-entries. Today the copier acts on the
opens and largely drops everything else, so our positions drift out of line with
the provider. The root cause is correlation: a follow-up message cannot be tied
to the specific open trade it refers to, so the matcher either guesses (unsafe)
or holds for review (never acted on).

Two channels were analysed against the live parser to size the gap.

### VIP Signals (Gold), dialog `-1003990600788`

Bot channel, 463 messages (2026-05-13 to 2026-07-16).

| Bucket | Count | Current outcome |
| --- | ---: | --- |
| Fresh `NEW ORDER` opens | 200 | Auto-actionable, map to XAUUSD.raw |
| Quoted follow-ups | 199 | Held for review, never acted on |
| Chatter / weekly reports | 64 | Ignored |
| Lifecycle commands recognised | 0 | None |

The 199 held items are the provider's lifecycle feed misread as opens: 140
`❌ Deleted ... # <id>` cancels where the parser takes the word "Deleted" as the
symbol and the order id (for example `297968962`) as the entry price, and 59
`🚀 activated` notices with no detectable symbol. So the app opens pending stop
orders but never cancels them when the source deletes them.

### KAL VIP, dialog `-1002500698105`, provider `provider_1gfxfwd`

Human discretionary channel, 1,780 messages (2026-05-17 to 2026-07-17).

| Bucket | Count | Notes |
| --- | ---: | --- |
| Chatter / education (`NO_SIGNAL`) | 1,340 | Correctly ignored |
| Opens | 294 | 284 (96.6%) mapped and auto-actionable; "Gold" maps to XAUUSD.raw |
| Lifecycle commands | 145 | 127 TP-hit, 9 cancel, 4 move-to-BE, 4 modify-TP, 1 partial close |
| Queue items ever created | 14 | 11 EXECUTED, 2 FAILED, 1 DUPLICATE |

The opens parse well. The lifecycle is the problem: `matchLifecycleCommandToTrade`
(`packages/core/src/index.ts:757`) matches on provider plus canonical symbol only,
so with several Gold trades open at once every lifecycle command matches multiple
candidates. All 145 resolve to `AMBIGUOUS` and are held. None auto-align.

Separately, only 11 of 284 auto-actionable opens executed. Those were not held by
review, so the shortfall points downstream at routing, account links, or the
equity guardian. That is tracked as a separate investigation, not solved here.

### The signal we already have and discard

The follow-ups are Telegram quote-replies. In `apps/api/src/telegram.ts:377` we
call `getReplyMessage()`, keep the quoted text, and throw away `quoted.id`, which
is the reply target message id. `message.replyTo?.replyToMsgId` gives the same id
without the extra fetch. Reply coverage of KAL VIP lifecycle messages is at least
65% (a floor, since the proxy misses replies to deleted or media-only messages,
which the structured id would still catch). Opens are 95% standalone, as expected
for anchors.

## Design

Three parts. Reply-link correlation is the substrate. Parser classification fixes
sit on top of it. The Automatic/Aggressive control governs what we do when a
signal is under-specified.

### 1. Reply-link correlation

- Capture the reply target at ingestion. Add `replyToMessageId?: string` to
  `TelegramCapturedMessage` (`apps/api/src/telegram.ts:17`), populated from
  `message.replyTo?.replyToMsgId`.
- Persist it. Add `reply_to_message_id` to `raw_messages` (migration; the table
  has no foreign keys today, so this is an additive column).
- Persist the origin. Store the opening message's `telegram_message_id` on the
  logical trade so a lifecycle reply resolves to a trade in one lookup.
- Resolve. For a lifecycle command with a reply target, walk the reply chain back
  (a reply may point at a prior update rather than the original open) until it
  lands on the message that opened a trade, then pass that trade id to the matcher
  as an explicit target.
- Fall back in order: reply link, then content fingerprint (VIP Gold order id;
  KAL VIP quoted entry plus stop), then hold. Where it is ambiguous or has no link
  to a single open trade, ignore it. Never widen to "close any XAUUSD".

`matchLifecycleCommandToTrade` gains an explicit-target path that bypasses the
provider-plus-symbol heuristic when correlation supplies a trade id. The existing
heuristic stays as the last resort, and `AMBIGUOUS` still means hold.

### 2. Parser classification fixes

- VIP Gold cancels. A quoted message whose comment reads `❌ Deleted <side> on
  <symbol> # <id>` classifies as `CANCEL_PENDING` keyed to `<id>`, not
  `OPEN_TRADE`. The comment is the operative instruction; the quoted `NEW ORDER`
  echo is context.
- Echo dedup. The quoted echo of an order id already seen must not open a second
  position. The order id makes `hasDuplicateOpenSignal` an exact check.
- Re-entries. Replies such as "place limits here" or "reenter at 26" carry open
  intent in the comment and parameters in the quoted original. They route to
  review, so a real re-entry surfaces for one-tap approval and a conditional
  aside ("consider re entering") stays ignored. This is where the reply link
  supplies the parameters, since the comment alone has no symbol or price.

### 3. Automatic and Aggressive

Replace the current template menu (`deterministic`, `kal-vip`, `kal-vip-extended`)
with two options under Message Template. Verified safe: the only live provider is
KAL VIP on `deterministic`, with no per-account override, so nothing changes
behaviour on removal. `kal-vip` has no code branch and is a no-op. The
`kal-vip-extended` ladder parser folds into the default path.

- Automatic (default). General, format-adaptive parsing: base parse, entry-zone
  splitting, and multi-level ladder detection, each falling back to the next and
  format-gated so ordinary messages are never split into phantom entries. A parsed
  ladder is capped at `maxEntriesPerSignal` (default 5, per-provider) with any
  truncation audited, so a false positive or an oversized ladder cannot spray
  unbounded orders. Handling is conservative: guessed entry and ambiguous
  correlation are held. Safe gap-fills keep nothing naked, a missing stop or
  take-profit is filled from provider defaults, and only a missing or ambiguous
  entry holds for review.
- Aggressive (opt-in, per channel). Same parsing. Signals missing an exact entry
  are also filled from provider defaults and executed rather than held. Symbol
  and correlation ambiguity still hold in both modes.

Placement keeps the field in the Message Template section
(`apps/web/src/components/ProviderConfigModal.tsx:522`). Tooltip on Aggressive:

> Aggressive: signals missing a stop, target, or exact entry are still executed
> using this provider's default settings (for example a 60-pip SL). Lifecycle
> commands that cannot be tied to one specific open trade are still skipped for
> safety.

Internally the stored value renames `deterministic` to `automatic`, so one name
maps to one behaviour (`ParserMode` at `packages/core/src/index.ts:3`,
`normalizeParserMode` at `apps/api/src/app.ts:10765`).

## Safety boundaries

- Two kinds of ambiguity, handled differently. Missing parameters (stop, target,
  entry) have safe defaults and are the Aggressive lever. Ambiguous correlation
  (which open trade) has no default and stays held in both modes. This is the
  double-close risk on the trade-safety backlog.
- Aggressive fills parameters. It does not bypass the equity guardian, exposure
  caps, or naked-order protection.
- Reply-link correlation is forward-only. Existing rows have no reply id, so it is
  validated on live traffic from deploy onward.
- A default stop replacing a broken value is protective. This morning's KAL VIP
  post carried `Sl 4975` on a buy at 3981 (a typo), which review catches today and
  a default stop would sanitise. It supports gating human channels to review by
  default rather than auto-firing.

## Change surface

| Area | File | Change |
| --- | --- | --- |
| Adapter | `apps/api/src/telegram.ts:17,377` | Add `replyToMessageId`, populate from `replyTo.replyToMsgId` |
| Schema | migration + `apps/api/src/app.ts` (`raw_messages`) | Add `reply_to_message_id` |
| Trade model | `apps/api/src/app.ts` (logical trade insert) | Store origin `telegram_message_id` |
| Correlation | `packages/core/src/index.ts:757` | Explicit-target path plus reply-chain resolver |
| Parser | `packages/core/src/index.ts` | Deleted-as-cancel, echo dedup, re-entry to review |
| Parser modes | `packages/core/src/index.ts:3,685`; `apps/api/src/app.ts:10765` | Fold ladder into default; rename to `automatic`; add `aggressive` |
| Provider field | `apps/api/src/app.ts` (providers) | Handling mode and `maxEntriesPerSignal` persisted alongside parser mode |
| UI | `apps/web/src/components/ProviderConfigModal.tsx:522` | Two options plus tooltip |

## Sequencing

1. Capture the reply link (adapter, migration). Forward-only, no behaviour change.
2. Correlation resolver and matcher wiring. Unblocks KAL VIP lifecycle safely.
3. VIP Gold parser fixes (cancel, echo dedup). Prerequisite before that channel
   is enabled, or Aggressive would fire echoes and cancels as opens.
4. Automatic/Aggressive control and UI cleanup.

Each phase is independently testable against the two channels' captured messages.

## Resolved decisions

- D1. Automatic applies safe gap-fills. A missing stop or take-profit is filled
  from provider defaults so nothing goes out naked; only guessed entry and
  ambiguous correlation are held.
- D2. A per-provider `maxEntriesPerSignal` cap (default 5) bounds ladder exposure.
  A parsed ladder beyond the cap is truncated to the first levels in listed order
  with an audit entry. This limits blast radius from a parsing false positive and
  from oversized ladders while clearing the observed single-entry and small-ladder
  norm.
- D3. The low-execution finding (11 of 284) runs as a separate routing and
  guardian investigation, outside this work.

## Out of scope

- Backfilling KAL VIP history beyond the two months already stored.
- The routing and guardian shortfall behind the low execution count (D3).
