# Implementation brief — searchable symbol picker + actionable alerts (2026-07-24)

Branch: `feat/symbol-picker-and-actionable-alerts` (off main @ v1.55.1). These raise two modals to the
"interface redesign proposal" artifact (6cd745cc): the symbol picker and operational alerts. Design
language and tokens match the shipped console (blue accent; `--unknown` violet is for the attribution
bucket only). No em dashes in code/UI copy.

## SAFETY (parser/symbol-adjacent — read carefully)
- The symbol area is trade-sensitive. These changes are operator-driven mapping + alert presentation.
  They MUST NOT change execution semantics. In particular:
  - Unmapped symbols must still be HELD for review at execution time exactly as today. Nothing here may
    cause a real signal to silently execute or silently skip execution.
  - "Not an instrument" suppression only quiets the operational ALERT / unmapped-symbol nagging for that
    token. It must NOT be consulted anywhere on the execution/queue/guardian path. If a suppressed token
    ever appears in an actual parsed signal, it still follows the normal held-for-review safety path.
- Keep `FRONTEND_PARITY.md` capabilities intact and tested. Full gate green before finishing:
  `bun run typecheck && bun run lint && bun test && bun run build`. Bump version (minor, 1.56.0), align
  `mt5/TelegramTC_EA.mq5` metadata (EA contract unchanged), add changelog + HANDOFF entries. Do NOT push.

## Feature 1 — searchable, ranked, quoted-first broker-symbol picker
File: `apps/web/src/components/SymbolMappingModal.tsx` (currently bare text inputs; the account/direct
broker-symbol field is where a broker symbol is chosen from the account's list). Backend already provides
the data:
- `GET /api/accounts/:accountId/symbol-metadata` -> `store.symbolMetadata(accountId)` gives broker symbols
  with quote info (bid/ask). `availableSymbols` on the account is the full broker list (can be ~387).
Requirements (from the proposal):
- Replace the broker-symbol text field with a combobox: a search input that filters the account's broker
  symbols as you type.
- Rank results by likeness to the canonical symbol being mapped (e.g. substring/prefix match on the
  canonical, then fuzzy), and surface QUOTED instruments (have bid/ask in symbolMetadata) ABOVE unquoted
  ones. Label unquoted symbols clearly ("not quoted") since TP management cannot run on them.
- Selection is held while the modal is open: a background dashboard refresh must not reset the chosen
  symbol (keep selection in local state, do not re-derive from props on each refresh).
- Prefix/suffix affix guessing is shown as a CONFIRMABLE suggestion ("looks like a `b` suffix — apply to
  all?"), never auto-applied. Confirming is an explicit click.
- Keyboard accessible (type to filter, arrow to move, enter to select), focus-visible rings, works in
  light and dark. Add/extend `SymbolMappingModal.test.tsx`: filtering, quoted-first ordering, selection
  surviving a props refresh, affix suggestion is opt-in.

## Feature 2 — actionable operational alerts (resolve in place)
Backend: `operationalAlerts()` (`apps/api/src/app.ts:2831`) currently emits one lumped `unmapped-symbols`
alert from `providerSymbolsNeedingMapping()` (`:2946`, returns `string[]`). Frontend: `AlertsBanner.tsx`
renders dismissible message rows only.
Backend work:
- Make the unmapped-symbols alert STRUCTURED: one entry per unmapped provider symbol carrying the token,
  the provider(s)/account(s) it affects, how many signals it is currently blocking (the "cost"), and a
  suggested broker symbol (best match from that account's `availableSymbols`, quoted-first) when one is
  obvious. Keep a back-compat lumped `message` string too.
- Add a persisted per-provider "not an instrument" suppression list (new small table, e.g.
  `suppressed_provider_symbols(provider_id, token, created_at)` via `ensureColumn`/create-if-not-exists in
  `migrate()`), plus `POST /api/providers/:id/not-an-instrument { token }` and store method.
  `providerSymbolsNeedingMapping()` (and the structured alert) must EXCLUDE suppressed `(provider, token)`
  pairs. Scope is per-provider (a token noise for one provider may be real for another). Audit-log the action.
- Do NOT let suppression touch execution: it is only read by the alert/needs-mapping surface.
Frontend (`AlertsBanner.tsx` + a small item component):
- Each unmapped-symbol alert becomes an actionable row that NAMES the account and the cost ("HF Markets ·
  1 signal stopped"), with a primary "Map to <suggested>" action (opens the SymbolMappingModal pre-filled
  for that account/canonical, or applies the suggested mapping directly if unambiguous) and a secondary
  "Not an instrument" action (calls the suppress endpoint; the row stays gone, not recomputed).
- Keep the existing persistent dismissal for the other alert kinds (guardian/telegram/etc.). "Not an
  instrument" is a permanent server-side suppression, distinct from client dismissal.
- Tests: structured alert shape, suppression removes the token from subsequent alerts, "Map to" opens the
  mapping flow, and suppression does not affect execution/held-for-review (add/extend an api.test.ts case).

## Acceptance
- Symbol picker: searchable, quoted-first ranked, selection survives refresh, affix confirm-only.
- Alerts: per-symbol, costed, "Map to" resolves in place, "Not an instrument" permanently suppresses that
  provider token; execution safety unchanged (unmapped still held).
- Gate green; no console errors; parity contract satisfied; version bumped; changelog + HANDOFF updated.
- In the final report: files changed, tests added, gate numbers, and an explicit note confirming the
  execution/held-for-review path is unchanged.
