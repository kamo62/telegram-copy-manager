# UI consistency review — 2026-07-28

Method: local instance on a copy of the live DB (2 accounts, 2 providers, 32 review-queue
items), driven through the real sidebar and tab controls in Chrome. Findings come from
measuring rendered boxes, not from judging screenshots.

Checks per route: panel-child edge alignment, children overrunning their panel, rows
holding a single control, repeated headings, document horizontal overflow, panel header
height consistency, near-empty blocks over 80px tall.

Routes swept: `/` · `/logs` · `/providers` · `/symbols` · `/telegram` · `/settings` ·
`/history` · `/performance` · `/equity-guardian`.

Clean on every structural check: `/` (Operations), `/symbols`, `/telegram`, `/history`,
`/performance`.

## F1 — Settings sections are full-bleed while their siblings are inset · CONFIRMED

`/settings`, panel box `226 → 1582`:

| child | left | right |
|---|---|---|
| `.panel-intro` | 243 | 1565 |
| `.settings-form-layout` | 243 | 1565 |
| `.settings-section` | **227** | **1581** |

Same root cause as the Providers panel: `signal-desk.css` lists which panel children take
`margin-inline: 16px`, and `.settings-section` is not a member.

## F2 — "New manual ticket" sits alone in a 74px row · CONFIRMED

`/logs`, `.panel-toolbar` is 74px tall and holds one button. Same pattern as the Providers
Export button: `.panel > *:not(header)` applies `var(--space-5)` to every direct child, so
a toolbar wrapping one control costs ~74px.

## F3 — Panel header heights vary within one page · CONFIRMED

`/logs` renders panel headers at `[51, 37, 37, 37, 37]`. One is 14px taller than the other
four on the same screen.

## F4 — Page title and panel title repeat the same word · CONFIRMED

`/providers` "Providers" ×2, `/settings` "Settings" ×2, `/equity-guardian` "Equity
Guardian" ×2. The workspace tab already names the section, so the panel header is the third
statement of the same word. Needs a product call rather than a mechanical fix.

## F5 — `/logs` is 26,214px tall · CONFIRMED

Against 739px for Operations and 1,422px for Providers. This is why held signals sit
thousands of pixels below the fold, which the handoff already flags as an operator problem.
Needs a product call.

## F6 — The document outline is inverted · CONFIRMED

Measured on `/logs`:

| element | role | size / weight |
|---|---|---|
| `h1.brand` "TG-TC · Signals & logs" | status-bar chrome | **15px** / 650 |
| `h2` "Signals & logs" | actual page title | **30px** / 650 |
| `h2.account-header-title` "Last known" | account card | 28px / 500 |
| `h2` "Parser Lab", "Held signals", … | panel titles | 18px / 600 |

The only `h1` on the page is the smallest text on it, and it names the app rather than the
page. One heading level (`h2`) then covers three roles at three sizes. Screen readers get
"TG-TC · Signals & logs" as the document's top-level heading.

Fix is to promote the page title to `h1` and demote the status-bar brand to a non-heading
element. Three tests query the brand via `getByRole("heading")` (`App.test.tsx:505`, `:2471`,
`:2496`) and would need updating, which is why this is not in the mechanical batch.

## F7 — Two H3 treatments

`h3` renders at 13px/650 on Operations and 15px/500 on Settings. Minor next to F6 but part
of the same absent scale.

## Fixes applied

**F1** — `.settings-section` joined the `margin-inline` inset group in `signal-desk.css`,
both at full width and at the narrow breakpoint. Only the instance rendered directly under
the panel was affected; the ones nested inside the form were already inset.

**F2 and F3 shared a root cause**: there was no standard home for panel-level actions, so
each page invented its own row. `Panel` now takes an `actions` prop rendered right-aligned
in the header. Providers' Export and the Signal Queue's "New manual ticket" both moved
there, and the one-button toolbars are gone. `.panel > header` also gained a `min-height`
so a header carrying actions or tabs matches one carrying only a title.

This also replaced the earlier fix that embedded Export inside the intro block, so there is
now a single pattern rather than two.

Re-audited after the change: **zero structural findings on all ten routes.**

## Status

- [x] F1 · [x] F2 · [x] F3
- [ ] F4 · [ ] F5 — need a product decision

## Known flake, not caused by this work

`AccountHeader > shows honest stale state and exposes account actions` times out at 10s in
roughly 1 run in 5. Verified against a clean baseline with these changes stashed: it fails
there at the same rate.

---

# Review: apps/web UI speed + repo dead code (2026-07-24, completed)

Two independent passes (Fable + Codex sol xhigh), synthesized at the end.

## Synthesis (read this first)

Codex ran in rescue mode and applied low-risk fixes directly (79+/361- across 21 files, uncommitted, version bumped to 1.37.1). Fable verified the diff: typecheck clean, frontend 118/2 (both failures pre-existing from the 1.37.0 parser consolidation, confirmed at HEAD), backend 308/0 per Codex run, real MT5 `heartbeat` events untouched.

### Applied by Codex (verified)
1. SSE keepalive renamed `heartbeat` -> `ping` (`apps/api/src/app.ts:940`) — idle clients no longer refetch the full dashboard every 10s. Genuine EA heartbeats (`app.ts:3966`) still emit `heartbeat`. Biggest single win; Fable's pass missed that the keepalive shared the event name.
2. `motion` dependency removed; tooltip now CSS transitions. Root `package.json` no longer bundled (vite `__APP_VERSION__` define). Main JS 612->486 KB, gzip 190->148 KB.
3. Header sparklines cap long series at 96 points via the existing sampler.
4. Dead code purged: `ErrorPanel.tsx`, `dither-kit/dot.tsx`, `dither-kit/legend.tsx`, `parseLegacyStrategy`, `LineChart`/`Line`, `easeOutCubic`, `isDitherColor`, `isKnownBrokerSymbol`, `zod` dep; `normalizeSymbolText`/`canonicalKey` de-exported.

### Where the passes disagreed, and the resolution
- Route lazy-loading: Fable recommended it (F3); Codex found `App.test.tsx:169` explicitly forbids lazy pages because past deploys served stale chunks. Codex is right — fix chunk-coherent deploys first, then split. The ineffective `react-vendor` manualChunks (3.6 KB chunk) from Fable's pass stands as a real follow-up regardless.
- Render identity: Fable flagged `setLastSyncAt`/`setRefreshing` forcing whole-tree renders with zero `React.memo`; Codex flagged the adjacent refetch-on-every-event pattern. Both stand; they compound. Codex added the React Compiler angle (chart code assumes memoization the toolchain never enables).

### Top priorities (combined, not yet applied)
1. Delta-driven updates: stop rebuilding the full `DashboardSnapshot` on every queue/trade/audit/score event (`App.tsx:616`, `app.ts:7752`); coalesce in-flight requests; skip `setSnapshot` on deep-equal payloads.
2. Chunk-coherent deploys (retain old hashed assets), then route-level `React.lazy` + fix the dead `react-vendor` split.
3. base.css consolidation behind route screenshots (8.3k lines, duplicated selector blocks, one cascade bug already) + a duplicate-selector lint guard.
4. Stabilize the combined `bun test` lane (SQLite teardown vs ingestion races) and repair the two stale `kal-vip-extended` provider-config tests.
5. Cache dashboard aggregates per store revision (`app.ts:7752`, O(providers x trades) on every request).

## Fable pass — Phase 1: apps/web UI speed

### F1. Whole-tree re-render on every poll/SSE event (high)
- `apps/web/src/App.tsx:592-668` — App holds all dashboard state (28 `useState`) and every SSE event triggers a full `DashboardSnapshot` refetch (200ms debounce), then `setRefreshing(true/false)` + `setSnapshot` + `setLastSyncAt`.
- `setLastSyncAt(new Date().toISOString())` guarantees a state change on every successful load even when data is identical, and `setRefreshing` toggles add renders per cycle.
- Zero `React.memo` in the codebase; the visible page (up to 709 lines, charts included) re-renders top-down each cycle.
- Fix direction: skip `setSnapshot` when payload is deep-equal (or ETag/If-None-Match), move `lastSyncAt`/`refreshing` into a tiny status component or ref-backed store, memoize page components.

### F2. New object/array identities passed to pages every render (high, pairs with F1)
- e.g. `apps/web/src/App.tsx:2149-2155` — `snapshot.mt5Accounts.map(...)` inline in JSX; fresh arrays/lambdas each render defeat any future memoization.
- Fix direction: hoist derived arrays into `useMemo`, stabilize callbacks (most already `useCallback`).

### F3. Single 612 KB JS chunk, no route splitting (high)
- `apps/web/dist/assets/index-*.js` = 612 KB; `react-vendor` chunk is only 3.6 KB, so the manualChunks split in `apps/web/vite.config.ts:30-36` is not capturing React — everything ships in one chunk.
- All 9 pages are statically imported in `App.tsx:50-58`; no `React.lazy`.
- Fix direction: lazy-load pages (Settings/Performance/Logs are natural splits), fix or drop the manualChunks config after verifying with `vite build --report`.

### F4. `motion` dependency for one tooltip (medium)
- `motion` (framer-motion successor) appears once: `dither-kit/tooltip.tsx:3` (glide/fade of hover tooltip). Tens of KB gzipped in the main chunk for an effect CSS transitions can do.
- Fix direction: replace with CSS `transition` on transform/opacity, drop the dep from `apps/web/package.json`.

### F5. Perpetual rAF loop per mounted chart (medium)
- `dither-kit/cartesian-canvas.tsx:112` — `draw` unconditionally reschedules itself every frame for as long as the chart is mounted; paint work is guarded but the loop never idles, and multiple charts mean multiple loops.
- Fix direction: stop the loop when animations settle and no hover; restart on data revision/hover.

### F6. Root `package.json` bundled into the client (low)
- `App.tsx:4` imports `../../../package.json` (for the version string) — ships scripts/dep list to the browser; minor size + info leak.
- Fix direction: `define: { __APP_VERSION__: ... }` in vite config.

## Fable pass — Phase 2: repo dead code & improvements

### F7. Orphaned web modules (confirmed, never imported)
- `apps/web/src/components/ErrorPanel.tsx`
- `apps/web/src/components/dither-kit/dot.tsx`
- `apps/web/src/components/dither-kit/legend.tsx`

### F8. `zod` is a fully unused dependency
- Listed in root `package.json` (`zod@^4.2.1`), zero importers anywhere in apps/packages/scripts, tests included. Remove it.

### F9. Dead / over-exported core helpers
- `packages/core/src/index.ts` — `isKnownBrokerSymbol` is exported and never called anywhere (not even tests): dead function.
- `normalizeSymbolText`, `canonicalKey` are used only inside the same file; drop the `export` keyword.
- (Not a finding: `parseConnectionRetries`/`parseReconnectRetryDelay` in `apps/api/src/telegram.ts` look unused externally but are exported for `resilience.test.ts` — leave alone; trade-safety-sensitive area.)

### F10. base.css duplication (known bug source)
- `apps/web/src/styles/base.css` is 8,369 lines with repeated selector blocks (`.status-bar` ×4, `.account-header`/`.data-table-wrap`/`.account-platform-card` ×2-3). Already caused one cascade bug (modal-wide clipping). Feeds the 139 KB compiled CSS.
- Fix direction: dedupe pass, then a lint/CI guard against duplicate top-level selectors.

### F11. `apps/api/src/app.ts` is a 12,080-line monolith
- Single file holds effectively the whole API. Maintainability and merge-conflict hazard; split by domain (routes/queue/guardian/settings) behind the existing app entry.

### F12. Cosmetic: `"use client"` directives in 5 dither-kit files
- Next.js-ism with no meaning under Vite; harmless but misleading.

### F13. Root-level doc sprawl
- 5 stale `plan-*.md` + `improvements-21-5.md` at repo root; archive under `docs/` to keep root signal high.

---

# Review 2026-07-24: symbol picker + actionable alerts (WIP) and main v1.53.0..v1.55.1

Scope: uncommitted working-tree diff (in-progress implementation of IMPL-symbol-picker-and-alerts-2026-07-24.md) plus the UI-fix arc on main, commits 7e0bd03a (v1.53.0) through fcc6cfa7 (v1.55.1). Dual independent passes (Codex sol high + Opus deep-reasoner) with Fable synthesis. NOTE: the working tree was being actively modified during review (SymbolMappingModal.tsx changed mid-review); findings apply to the snapshot at review time.

## Fable orchestrator pre-pass (uncommitted diff)

### P1. Safety contract verified: suppression does not reach execution (pass)
- `isProviderSymbolSuppressed` (`apps/api/src/app.ts:2975`) is read only inside `unmappedProviderSymbolAlerts()` (`:3014`), which feeds `operationalAlerts()` and `providerSymbolsNeedingMapping()` only. No execution/queue/guardian call sites. Unmapped symbols still follow the held-for-review path.

### P2. `providerSymbolsNeedingMapping()` is now dead code (low)
- `apps/api/src/app.ts:2948` — after the refactor it has zero callers anywhere in the repo (operationalAlerts now uses `unmappedProviderSymbolAlerts()` directly). Either delete it or point the back-compat consumer at it; right now it exists but nothing reads it.

### P3. Brief deviation: lumped back-compat message dropped (low)
- The brief asked to keep a back-compat lumped `message` alongside structured entries. The lumped `unmapped-symbols` alert was replaced by up to 12 per-(provider,symbol,account) alerts. Each carries its own message so the banner still renders, but any consumer expecting a single alert of this kind now gets many.

### P4. Parser-context cache dropped in the alert path (medium, perf)
- Old code cached one `ParserContext` per provider across the 300-row scan; `unmappedProviderSymbolAlerts()` (`app.ts:2987`) now calls `this.parserContext(providerId, accountId)` per row x target account, plus a suppression SELECT per row. `operationalAlerts()` runs per dashboard snapshot, so this is a hot path; re-add a `(providerId, accountId)` context cache and hoist suppression lookups.

### P5. `symbolMetadata()` shape/perf change (low)
- `app.ts:3074` region — now merges live MT5 snapshot quotes (adds `bid`/`ask`, `updatedAt` can be `""`), and uses `rows.find(...)` inside a map over the union (O(n^2), ~387 symbols is fine but sloppy). Verify existing consumers of `GET /api/accounts/:id/symbol-metadata` tolerate the new fields and empty `updatedAt`.

### P6. Alert dismissal keys change format (info)
- `AlertsBanner.tsx` `alertKey` now appends `:token`; previously persisted dismissals in localStorage no longer match and the cleanup effect will drop them, so previously dismissed alerts can reappear once. One-time noise, acceptable.

### P7. No tests / version bump / changelog yet (expected, WIP)
- No test references `not-an-instrument` or `suppressProviderSymbol`; version still 1.55.1. The brief's gate (typecheck/lint/test/build, v1.56.0, changelog + HANDOFF) is outstanding.

## Opus (deep-reasoner) pass

Safety answers: (a) uncommitted diff does NOT touch execution/held-for-review — suppression is read only via `isProviderSymbolSuppressed` (`app.ts:2975`) from `unmappedProviderSymbolAlerts` (`:3014`); held path (`app.ts:3386/3540/3854`) resolves symbols independently. (b) v1.54.2 guardian scoping is display-only — `App.tsx` filters the `guardians` prop; no api change, server latch keeps rejecting globally (`app.ts:4571`).

### O1. MEDIUM — parser-context rebuild in hot alert path (confirms P4)
- `app.ts:3020`: `parserContext` (~7 sub-queries, `app.ts:6216`) rebuilt per signal x target account over 300 rows, no cache; `operationalAlerts` runs on every `/api/dashboard` fetch (SSE-driven). Fix: memoize per `(providerId, accountId)`.

### O2. LOW — nav count ignores optimistic suppression
- `AlertsBanner.tsx:49`: exported `visibleOperationalAlerts` (used at `App.tsx:1256` for the nav badge) filters `dismissed` only, not the component-local `suppressed` set; after "Not an instrument" the row hides but the badge count disagrees until the next refetch. Transient.

### O3. LOW — optimistic suppression hides one account row only
- Server suppression is per `(provider, token)` but the client `suppressed` set keys on `alertKey` (includes accountId); sibling rows for the same token on other accounts stay visible until refetch. Cosmetic.

### O4. main — base.css/signal-desk.css cross-file cascade bug (real)
- `signal-desk.css:35` and `base.css:54` both define `.app-shell` at equal specificity with different `grid-template-columns` (232px vs 208px); `main.tsx` imports base then signal-desk, so signal-desk wins and base.css edits to `.app-shell` (also `.sidebar`, `.workspace`, `.status-bar`, `.status-cluster`) are dead. Consolidate structural layout into one file.

### O5. main — v1.54.2 visibility caveat
- A guardian latched on a non-focused account is hidden from `EquityGuardianPage` while focus is set. Enforcement continues but the operator can miss a paused account; verify AlertsBanner covers latched-guardian state account-agnostically.

### Verified sound on main (Opus)
- v1.53.0 mixed-currency totals: per-order conversion then sum (`app.ts:6900/6936/6941`); only edge is orders whose accountId misses `accountsById` falling back unconverted — acceptable.
- v1.53.2 persisted dismissals: localStorage round-trip + prune effect correct; alertKey format change makes old lumped dismissals lapse (desired).
- v1.54.1 scroll reset and v1.53.3 attention counts: no loops/stale closures.
- New route validation/idempotency/audit consistent with siblings; quoted-first ranking correct on both server (`rankBrokerSymbols`, +10k bonus) and client (`brokerScore`, +1M bonus).

### Opus gaps-vs-brief
- Combobox is largely DONE (ranking, quoted-first, confirmable affix, keyboard nav, selection held locally). Missing: all tests (modal filtering/ordering/selection-survives-refresh/affix opt-in; structured alert shape; suppression-vs-execution api test), 1.56.0 bump + EA metadata, changelog/HANDOFF, gate run.

## Codex (sol high) pass

Safety answers agree with Opus: suppression read only inside `unmappedProviderSymbolAlerts` (execution reparses per account and HELDs unmapped at `app.ts:3453/3539`; queue/guardian at `:4529` never reads it); v1.54.2 filters the `guardians` prop only (`App.tsx:2334-2342`), backend enforcement per-account unchanged (`app.ts:4431-4447, 4800-4802`).

### C1. HIGH — suggested mapping has no relatedness threshold
- `app.ts:3054/:12885` — quoted bonus (+10,000) alone beats the `score > 0` filter, so with zero related broker symbols every quoted symbol qualifies and the tie-break picks one alphabetically. The banner then shows "Map to <unrelated>" one click away from a wrong trade-symbol mapping. Fix: require likeness > 0 before applying the quoted bonus.

### C2. HIGH — alert key collides across providers
- `AlertsBanner.tsx` `alertKey` uses `accountId ?? detail.accountId ?? providerId`, so unmapped alerts from two providers with the same token on the same account share a key: suppressing/dismissing one hides both rows while the server suppression covers only one provider. Include providerId AND accountId in the key.

### C3. MEDIUM — combobox active row is positional
- `SymbolMappingModal.tsx:141/150/194` — `activeIndex` indexes into `ranked`, which reorders when background metadata refreshes change the quoted set; Enter can then select a different symbol than highlighted. Track the active symbol by value, not index.

### C4. MEDIUM — non-string token crashes the endpoint
- `app.ts:485/2955` — `token` is only TS-typed; a JSON number/object makes `token?.trim()` throw, returning an uncontrolled 500 instead of 400. Validate `typeof token === "string"` at runtime.

### C5. Main — unsupported-currency passthrough inflates totals
- `app.ts:6754-6759/6803-6811/12871-12883` — amounts in currencies `convertForAccount` cannot convert are summed unchanged into the reporting-currency total. (Opus saw the same edge, rated it acceptable; Codex rates Medium. Synthesis: add a guard or exclude-and-flag.)

### C6. Main — MEDIUM (plausible) — dismissed guardian alert can hide a recurrence
- `AlertsBanner.tsx` dismissal pruning runs only while the banner is mounted; if an alert clears and recurs while the operator is elsewhere (component unmounted), the stale persisted dismissal still matches on return and the recurrence stays hidden. Opus rated the mechanism sound; the gap needs the unmount window, so severity depends on whether AlertsBanner is mounted on all routes. Verify, then either prune on mount or key dismissals by occurrence.

### C7. Main — LOW — attention count reads localStorage at parent render
- `App.tsx:1229-1238` vs banner updates: count stale until an unrelated rerender. Same family as O2 (badge vs suppressed set).

### C8. Main — LOW — provider P/L not rounded after reduce (float artifacts in UI).

### CSS adjudication (Codex vs Opus)
- Codex: duplicates are coherent overrides, no breaking bug. Opus: base.css structural blocks are dead. Both agree mechanically (signal-desk.css wins via import order, verified `main.tsx:22-23`). Synthesis: no live visual bug today, but the dead `.app-shell`/`.sidebar`/`.workspace`/`.status-bar` blocks in base.css are the same trap that caused the modal-wide bug — edits there silently no-op. Keep as maintenance debt: consolidate structural layout into one file.

## Synthesis — ranked actions

Uncommitted WIP (fix before finishing the branch):
1. C1 suggestion threshold (HIGH — wrong-mapping one click away, trade-adjacent).
2. C2 alertKey provider collision (HIGH).
3. P4/O1 restore parser-context cache in the alert scan (MED, hot path).
4. C3 combobox active-by-value (MED). 5. C4 runtime token validation (MED).
6. LOWs: O2 badge/suppressed mismatch, O3 sibling rows until refetch, P2 dead `providerSymbolsNeedingMapping`, P3 lumped-message deviation (confirm intent), P5 symbolMetadata consumers.
7. P7 gaps: tests, 1.56.0 bump + EA metadata, changelog/HANDOFF, full gate.

Main arc (follow-ups, nothing release-blocking):
- C5 currency passthrough guard (MED); C6 verify banner mount coverage for dismissal pruning (MED, plausible); O5 surface latched guardians account-agnostically; C7/C8 LOW; CSS consolidation debt.

Safety verdict (all three passes agree): the suppression feature cannot affect execution/held-for-review, and v1.54.2 guardian scoping is display-only — server-side enforcement remains global.
