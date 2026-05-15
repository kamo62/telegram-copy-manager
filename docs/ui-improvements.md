# Frontend UI Improvements

Last updated: 2026-05-11 · Branch: `feat/telegram-copy-mvp`

Sections in this document:

1. **[Premium UI overhaul — May 2026 roadmap](#premium-ui-overhaul--may-2026-roadmap)** — current plan. Supersedes the original "modern dark terminal" recommendation. Reflects what shipped in P1 and details P2 → P5.
2. **[Original audit (2026-05-09, historical)](#frontend-ui-improvements--proposal-historical-2026-05-09)** — the first review that recommended a Bloomberg-dark direction. Left in place for traceability. Many of its recommendations have been delivered already; others have been deliberately reversed (we are not pursuing a dark theme).

---

## Premium UI overhaul — May 2026 roadmap

### 0. Status & direction lock-in

**What was decided** in the most recent planning round:

| Decision | Choice | Rationale |
|---|---|---|
| Styling | Polished **vanilla CSS + design tokens** | Full aesthetic control, no framework dep, smallest bundle, easiest to keep on-brand. |
| Theme | **Light only** for now (tokens designed dark-ready) | Backend-facing operators run during market hours; dark theme can flip on later by overriding tokens at `[data-theme="dark"]`. |
| App.tsx scope | **Extract per-tab page components** | App.tsx is ~870 LOC and every tab change touches it. Page extraction unlocks per-tab iteration. |
| Aesthetic | **"Modern editorial finance"** | Editorial typography (variable serif headings + characterful grotesque body) + restrained palette + measured motion. Distinct from generic React SaaS dashboards. Avoids the `frontend-design` skill's explicit anti-patterns: Inter/Roboto/Arial, purple-on-white gradients, predictable component patterns. |

**Aesthetic specifics already shipped in P1** (`4d2d45a feat(web): P1 — HSL token system + editorial typography (Fraunces + Geist)`):

- Fonts loaded via Google Fonts in `apps/web/index.html`:
  - **Fraunces** (variable serif, `opsz 9..144`, `wght 400/500/600`) for `h1/h2/h3` defaults and explicit display selectors.
  - **Geist** (`wght 400/500/600/700`) for body UI chrome, with `font-feature-settings: "ss01" "cv11" "cv05"` so the otherwise neutral grotesque shows its character.
  - **JetBrains Mono** (`wght 400/500/600`) for every numeric / tabular cell, with `font-variant-numeric: tabular-nums slashed-zero`.
- Token system at `apps/web/src/styles/tokens.css` (HSL split-channel, three surface layers, deep cobalt accent `hsl(218 85% 42%)` replacing indigo, motion tokens, four shadow levels including `--shadow-glass`, prefers-reduced-motion neutralisation).
- Stylesheet moved `apps/web/src/styles.css` → `apps/web/src/styles/base.css`. `:root` stripped (tokens.css owns it). Component classes preserved so tests + JSX kept working unchanged.
- `:focus-visible` defaults globally to `2px solid var(--accent-ring)` with 2 px outline-offset.
- Heading swaps already in place: `.signin-title`, `.account-header-title`, `.chart-card-title`, plus all bare `h1/h2/h3`. Selectors that should stay grotesque (uppercase section labels, button labels, tab labels, table data, input chrome) keep their explicit `--font-ui` override.
- Verified: `bun test apps/web/` 10/10 · `bun run --cwd apps/web build` 45 KB CSS + 261 KB JS.

**Out of scope for the rest of this roadmap** (you're owning these in parallel):

- Link-code workflow backend / EA payload changes.
- BrokerOrder schema migration + EA report enrichment.
- Account-scope filtering on the dashboard endpoint.
- Equity Guardian threshold endpoints.
- Parser, EA, and migration changes.

The UI work below assumes existing class names and JSX prop shapes stay stable. Where new product surfaces have already landed during the parallel backend pass (Azure GPT key field in Settings, Saved Fixtures view, Approve/Ignore parser actions, Wrong-phone-number recovery, broker-trail expansion, provider aliases scope toggle, link-code Linked Accounts UI), they will inherit the new tokens automatically. The P2 polish pass below audits each new surface so nothing reads as second-class.

---

### 1. P2 — Component polish + motion (CSS-only, no JSX changes)

**Goal:** the dashboard feels alive without changing component logic. Every change in this pass is CSS, which means it cannot conflict with any in-flight component edits and the test suite stays green by construction.

**File touched:** only `apps/web/src/styles/base.css`, plus a new `apps/web/src/styles/motion.css`. `apps/web/src/main.tsx` adds the motion import.

#### 1.1 Motion vocabulary

New file: `apps/web/src/styles/motion.css`. Defines five keyframes and three utility classes.

```css
@keyframes reveal-up   { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes fade-in     { from { opacity: 0; } to { opacity: 1; } }
@keyframes scale-in    { from { opacity: 0; transform: scale(.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
@keyframes shimmer     { from { background-position: 200% 0; } to { background-position: -100% 0; } }
@keyframes pulse-soft  { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
@keyframes live-pulse  { 0%,100% { transform: scale(.95); box-shadow: 0 0 0 0 hsl(155 62% 32% / .6); } 70% { transform: scale(1); box-shadow: 0 0 0 4px hsl(155 62% 32% / 0); } }
```

Utility classes — opt-in, no automatic application that could break tests:

- `.anim-reveal` — runs `reveal-up` once on mount.
- `.anim-fade` — runs `fade-in` once on mount.
- `.anim-stagger > *` — applies `reveal-up` with `animation-delay: calc(var(--i, 0) * 60ms)`. Fallback delays for nth-child(1..8) so components don't need inline styles to benefit.

`@media (prefers-reduced-motion: reduce)` sets `animation: none !important` on all three utility classes, on top of the token-level duration neutralisation in `tokens.css`.

#### 1.2 Glass StatusBar

**Selector:** `.status-bar` (sticky brand chrome at the top of the Live workspace).

Changes from current rules:

- Add `position: sticky; top: 0; z-index: 30` so the bar floats over scrolled content (currently it just sits at the top of the grid).
- Background: `hsl(0 0% 100% / 0.72)` plus `backdrop-filter: blur(14px) saturate(140%)`. Vendor-prefix `-webkit-backdrop-filter` for older Safari.
- `box-shadow: var(--shadow-glass)` for the inner 1 px highlight + 1 px outer shadow combo.
- Height 28 px → 32 px, padding 12 px → 14 px so the brand and chips don't crowd.
- `letter-spacing: 0.03em` (was `0.02em`) for tighter typographic colour at small sizes.

`.status-bar > .brand`: swap to `var(--font-display)`, `font-size: 13px`, `font-weight: 500`, `letter-spacing: 0.01em`, drop the uppercase transform so the serif actually reads as a serif (uppercase + Fraunces is hostile).

`.status-bar .live-dot`: replace the simple `opacity` pulse with the `live-pulse` keyframe — pulse expands a ring of `hsl(155 62% 32% / .6)` outward, matching the green "EA WORKING" semantic. 2.4 s loop with `var(--ease-in-out)`.

`.status-bar .refresh-btn:focus-visible`: explicit ring using `box-shadow: 0 0 0 3px var(--accent-ring)` so the keyboard target is unambiguous.

#### 1.3 Sidebar

**Selector:** `.sidebar` and `.sidebar nav button`.

Changes:

- `.sidebar nav button` — padding raised to `8px 10px 8px 14px` (extra left padding to make room for the active-state rail without shifting label position), `font-size: 12px` (was 11 px), `gap: 10px` (was 8 px) so the icon and label have room. Transitions for `background / color / border-color / transform` all use `var(--duration-1) var(--ease-out)`.
- `.sidebar nav button:hover` — background `var(--panel-2)`, no border colour change, just background.
- `.sidebar nav button:focus-visible` — `box-shadow: 0 0 0 3px var(--accent-ring)`, border `var(--accent)`. Outline removed since the shadow ring is the visible affordance.
- `.sidebar nav button.active` — `color: var(--accent)`, `background: var(--accent-soft)`, transparent border (was a hard border). The active state now communicates through a token-soft fill instead of a heavy line.
- `.sidebar nav button.active::before` — left rail bumped to `3px` wide, `18px` tall, centred via `top: 50%; transform: translateY(-50%)`, animates in with `reveal-up var(--duration-2) var(--ease-out)` so the rail "slides in" rather than appearing instantly. The pseudo-element is anchored at `left: 0` and is positioned relative to the button (already `position: relative`).

#### 1.4 Tab strip

**Selector:** `.workspace-tabs`, `.workspace-tab`.

- Replace the per-tab underline (`.workspace-tab.active::after` currently 2 px under each tab) with a single moving slider element implemented via the existing per-tab pseudo-element, but with `transition: transform var(--duration-2) var(--ease-out)` on `.workspace-tab` so the colour swap eases in instead of snapping.
- Active tab text → `var(--accent)` with `font-weight: 600`. Inactive tabs → `var(--ink-3)`. Hover → `var(--ink)`.
- Tab labels get `letter-spacing: 0.005em` and an explicit Geist `font-feature-settings: "ss01"` so the active state has typographic weight (not just colour weight).

#### 1.5 Account header & KPIs

**Selector:** `.account-header`, `.account-header-title`, `.account-platform-card`, `.account-kpis`, `.kpi`, `.kpi-label`, `.kpi-amount`, `.kpi-delta`.

- `.account-header` — `padding: 22px 24px`, `border-radius: var(--radius-3)` (12 px), `box-shadow: var(--shadow-2)` (was `--shadow-sm`), `border: 1px solid var(--line-subtle)`. Lifts the whole card a half-step above the workspace.
- `.account-header-title` already display-serif from P1. Bump to `28px / weight 500 / letter-spacing: -0.015em` for newspaper-headline feel; size at small viewports clamps via `clamp(22px, 2.6vw, 28px)`.
- `.account-platform-card` — `background: linear-gradient(180deg, var(--bg-elevated), var(--bg))`, `border-radius: var(--radius-2)`. Subtle vertical gradient gives the card depth without a hard shadow.
- `.account-platform-card-icon` — 32 × 32 instead of 28 × 28, `background: linear-gradient(135deg, var(--accent-9), var(--accent-10))`, white icon. Replaces today's flat accent-soft fill.
- `.ea-badge.ea-on` — keeps green pill but adds a 4 px `outline: 1px solid hsl(155 62% 32% / .25)` and a tiny `live-pulse` dot before the label text for "alive" feedback.
- `.account-kpis` — gets `class="account-kpis anim-stagger"` (the `anim-stagger` class added in markup — minimal JSX touch). Inline `style={{ "--i": i }}` not needed because nth-child fallbacks in motion.css cover 1..8.
  - Falls back to no animation under reduced motion.
  - First-mount-only via `animation-fill-mode: backwards`; no looping.
- `.kpi-amount` — `font-size: 24px` for non-primary KPIs (was 22 px), `26px` for `.kpi-primary` (was 26 px). Slight bump so they read as headline numbers.
- `.kpi-delta` — adds a 1 px outline using the soft tone of the direction colour (`outline: 1px solid hsl(155 62% 32% / .2)` for up, `.../.2` for down). Currently fills are flat — the outline gives them definition against the white card.

(One tiny JSX touch needed: append `anim-stagger` class to the `.account-kpis` wrapping div. This is the only JSX change in P2 and is a one-line edit.)

#### 1.6 Data tables — sticky head + hover-lift

**Selectors:** `.data-table-wrap`, `.data-table thead`, `.data-table thead th`, `.data-table tbody tr`.

- `.data-table-wrap` — `max-height: calc(100vh - 240px)` so tables scroll inside the panel instead of pushing the whole workspace down. `overflow: auto` on the wrap; the table inside stays at natural height.
- `.data-table thead` — `position: sticky; top: 0; z-index: 5; background: var(--panel-2)`. So when you scroll a long Providers list, headers stay anchored.
- `.data-table thead th` — `backdrop-filter: blur(8px)` on top of the panel-2 fill so the sticky head still feels layered when content scrolls behind. Add `box-shadow: 0 1px 0 var(--line)` for a hairline that survives the sticky.
- `.data-table tbody tr` — already has `transition: background 0.08s`. Bump to `transition: background var(--duration-1) var(--ease-out)` so hover matches the motion vocabulary.
- `.data-table tbody tr:hover` — `background: var(--panel-2)`. Resist the temptation to use `transform: translateY(-1px)` on `<tr>` (illegal on tbody rows in many browsers); the background swap is enough.
- `.data-table-row-head strong` — keep monospaced when it's a numeric ID (Trade IDs in History). When it's a provider name (Providers tab), use `var(--font-display)` at `font-size: 14px / font-weight: 500 / letter-spacing: -0.005em` so the canonical column reads with editorial character. Distinguish via the existing `data-table-row-head` class plus a new modifier (`.data-table-row-head--name` for prose, plain for codes). No JSX change required if the existing markup already uses the same class — we just add a CSS-only descendant selector that targets `strong` when the parent has the name-like content. Simpler approach: keep all `data-table-row-head strong` mono for now and revisit if it reads poorly.
- Per-row gear icons (`.data-table-actions .icon-btn`) — currently visible always. Switch to `opacity: 0; transition: opacity var(--duration-1) var(--ease-out)` and `tr:hover .icon-btn { opacity: 1 }`. Keeps tables visually quiet until you intend to act. **`:focus-within` override** so keyboard nav still shows them.

#### 1.7 Modal

**Selectors:** `.modal-overlay`, `.modal`.

- `.modal-overlay` — change `background: rgba(15, 23, 42, 0.35)` to `background: hsl(220 30% 12% / .28); backdrop-filter: blur(8px) saturate(110%); -webkit-backdrop-filter: ...`. Cinematic scrim, on-brand for a finance product.
- `.modal-overlay` — `animation: fade-in var(--duration-2) var(--ease-out)`.
- `.modal` — `animation: scale-in var(--duration-3) var(--ease-out)` for a 96→100 % scale + 8 px slide-up. `transform-origin: center`. `box-shadow: var(--shadow-3)` (was `--shadow-md`).
- `.modal-head` — sticky inside the scrollable modal: `position: sticky; top: 0; background: hsl(0 0% 100% / .94); backdrop-filter: blur(6px); border-bottom: 1px solid var(--line-subtle)`. So if a modal grows tall (Provider Config with runner + many TP rows), the title and close stay visible.
- `.modal-head h2` — `font-family: var(--font-display); font-optical-sizing: auto; font-size: 18px; font-weight: 500; letter-spacing: -0.005em`. Inherits from the global `h1/h2/h3` rule already, but we re-state with the size adjustment because the global rule only sets the family.
- Footer CTAs: ensure `.btn-primary:hover { box-shadow: var(--shadow-2) }` so the primary action has a visible lift on hover.

#### 1.8 Sign-in screen polish

**Selectors:** `.signin-shell`, `.signin-main`, `.signin-logo`, `.signin-title`, `.floating-field`.

- `.signin-shell` — body background gets `radial-gradient(circle at top, hsl(199 75% 96%) 0%, var(--bg) 60%)`. Atmospheric tint that subtly references Telegram blue without overdoing it.
- `.signin-logo` — `box-shadow: inset 0 0 0 1px hsl(0 0% 100% / .25), 0 8px 28px hsl(199 75% 49% / .25)`. Inner ring for definition, soft Telegram-blue glow for warmth.
- `.signin-title` already display-serif from P1. Pull `letter-spacing: -0.02em` tighter and bump weight to 500 (was 600) — Fraunces at 34 px wants thinner strokes for elegance.
- `.signin-subtitle` — `max-width: 380px`, `line-height: 1.55`, `color: var(--ink-3)`. Slightly more breathable than today.
- `.floating-field input:focus` — switch the focus ring from current `box-shadow: 0 0 0 3px rgba(34, 158, 217, 0.12)` to `box-shadow: 0 0 0 4px hsl(199 75% 49% / .15)`. Slightly thicker, softer.
- `.signin-cta` — `letter-spacing: 0.06em` (was `0.04em`). `font-weight: 600` (was 700) — the heavier weight reads as small-caps once uppercase-d, lighter weight feels more refined.
- `.signin-cta:hover:not(:disabled)` — `box-shadow: 0 8px 20px hsl(199 75% 49% / .25)`. Lift on hover so the CTA feels pressable.

#### 1.9 Buttons — token-driven system

**Selectors today:** `.btn-primary`, `.btn-ghost`, `.btn-small`, `.row-btn`, `.icon-btn`, `.icon-btn-danger`, `.config-row-delete`, scattered button styles inside `.modal-form`, `.panel-toolbar button`, etc.

Goal: one source of truth, no per-component button styles.

New base class `.btn` (defined in `base.css`):

```css
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
  border: 1px solid transparent;
  border-radius: var(--radius-1);
  cursor: pointer;
  transition: background var(--duration-1) var(--ease-out),
              color var(--duration-1) var(--ease-out),
              border-color var(--duration-1) var(--ease-out),
              box-shadow var(--duration-1) var(--ease-out),
              transform var(--duration-1) var(--ease-out);
}
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
```

Variants:

- `.btn-primary` — accent fill, white text, `var(--shadow-1)` resting, `var(--shadow-2)` on hover, hover bg `var(--accent-10)`.
- `.btn-ghost` — transparent, `var(--ink-2)` text, `var(--line)` border on hover only, hover bg `var(--panel-2)`.
- `.btn-destructive` — `var(--down-9)` text, `var(--down-soft)` fill, hover fills slightly stronger.
- `.btn-icon` — square 32 × 32, padding 0, used by gear / X / refresh. `.btn-icon-sm` 28 × 28 for table-row gears.
- `.btn-small` — height 28 px, padding `0 12px`. Used in modal toolbars.

Migration path: rules are added without removing the legacy classes. Each component-level button keeps working. P3 sweeps through and consolidates JSX `className="btn-primary"` etc. to the canonical names.

#### 1.10 Empty states (preview for P4)

Not built in P2, but P2 establishes the visual mould:

- `.empty-state` — currently a flat `<div className="empty-state">Queue is empty</div>`. Update CSS to: `display: grid; gap: 6px; place-items: center; padding: 40px 24px; color: var(--ink-3); text-align: center; min-height: 120px`. Plus an SVG glyph slot.

P4 wraps this in a proper React component.

---

### 2. P3 — Page extraction + sortable tables

**Goal:** App.tsx becomes a routing shell ≤ 200 LOC. Per-tab JSX moves into discrete files so each tab can be iterated without rebuilding the whole tree. Tables get sortable headers without per-component logic.

This is a **JSX restructure** — coordinated against your concurrent backend pass. If you have other component edits in flight when P3 lands, we cherry-pick instead of rebasing.

#### 2.1 New hook: `useSortableTable`

`apps/web/src/hooks/useSortableTable.ts`

```ts
type Direction = "asc" | "desc";

export function useSortableTable<T, K extends keyof T>(
  rows: T[],
  defaultKey: K,
  defaultDir: Direction = "asc",
): {
  sortedRows: T[];
  sortKey: K;
  sortDir: Direction;
  toggle: (key: K) => void;
  sortAria: (key: K) => "ascending" | "descending" | "none";
};
```

Implementation notes:

- Stable sort via `[...rows].sort()` with a comparator that handles `string | number | null | undefined`. Null sorts last regardless of direction.
- `toggle(key)`: same key flips direction, different key sets direction to `defaultDir`.
- `sortAria(key)`: returns the value to put in `aria-sort` on the header.
- No persistence in v1 (sort state resets on tab switch). Optional localStorage persistence is a P5 stretch.

#### 2.2 Sortable header markup contract

Each data-table column header that wants to be sortable:

```tsx
<th
  scope="col"
  aria-sort={sortAria("pips")}
  onClick={() => toggle("pips")}
  className="data-table-th-sortable"
>
  Pips
  <span className="sort-indicator" aria-hidden="true" />
</th>
```

CSS additions (`base.css`):

- `.data-table-th-sortable` — `cursor: pointer; user-select: none`. Hover bumps colour to `var(--ink)`.
- `.sort-indicator` — 8 × 12 inline-block. `::before` and `::after` render up/down arrows via `border` triangles, dim by default.
- `[aria-sort="ascending"] .sort-indicator::before` — bright accent.
- `[aria-sort="descending"] .sort-indicator::after` — bright accent.
- `[aria-sort="none"] .sort-indicator::before`, `[aria-sort="none"] .sort-indicator::after` — both dim.

#### 2.3 Page extraction

App.tsx today owns:

- Snapshot polling (`useEffect` + fetch + interval).
- Setup-step state (sign-in / code / 2FA / connected).
- Form state for fixture classifications, redacted text, parser tabs.
- Provider toggle / save handlers.
- Alias / mapping save handlers.
- Settings (execution + Azure GPT key) save handler.
- Snapshot-derived `accountHeaderData` memo.
- Command palette state.
- Hotkey wiring.
- The 8-tab routing tree (Performance / Providers / History / Equity Guardian / Symbol Settings / Logs + sidebar destinations Telegram Setup / Linked Accounts / Settings).

After P3, App.tsx becomes:

```tsx
function App({ initialSnapshot, initialDialogs }) {
  const session = useTelegramSession(initialSnapshot);
  const dashboard = useDashboardSnapshot(initialSnapshot);
  const providerActions = useProviderActions(dashboard.refresh);
  const mappingActions = useSymbolMappingActions(dashboard.refresh);
  const settingsActions = useSettingsActions(dashboard.refresh);

  if (session.step !== "connected") return <SignIn {...session} />;

  return (
    <main className="app-shell">
      <StatusBar dashboard={dashboard} onCommandPalette={...} />
      <Sidebar activeView={view} onNavigate={navigate} />
      <section className="workspace">
        {view === "dashboard" && (
          <>
            <AccountHeader data={dashboard.accountHeader} />
            <WorkspaceTabs value={tab} onChange={setTab} />
            <PageRouter tab={tab} dashboard={dashboard}
                       providerActions={providerActions}
                       mappingActions={mappingActions} />
          </>
        )}
        {view === "telegram"  && <TelegramSetupPage session={session} dialogs={dialogs} />}
        {view === "mt5"       && <LinkedAccountsPage dashboard={dashboard} />}
        {view === "settings"  && <SettingsPage dashboard={dashboard} actions={settingsActions} />}
      </section>
      <ProviderConfigModal ... />
      <SymbolMappingModal ... />
      <CommandPalette ... />
    </main>
  );
}
```

Target App.tsx ≤ 200 LOC. Realistic estimate: ~180 LOC after extraction.

#### 2.4 Pages directory

```
apps/web/src/pages/
├── PerformancePage.tsx       (GrowthChart + future MonthlyBars + latency strip)
├── ProvidersPage.tsx         (ProvidersTable + ProviderConfigModal open trigger)
├── HistoryPage.tsx           (HistoryTable + broker-trail expansion state)
├── EquityGuardianPage.tsx    (current placeholder + threshold form + breach feed)
├── SymbolSettingsPage.tsx    (SymbolMappingsTable + SymbolMappingModal open trigger)
├── LogsPage.tsx              (Parser Lab + Signal Queue + Execution Logs combined feed)
├── TelegramSetupPage.tsx     (SetupFlow + DialogPicker + saved-fixtures pointer)
├── LinkedAccountsPage.tsx    (AccountRow list, link-code UI, slot rename + unlink)
└── SettingsPage.tsx          (Execution settings + Azure GPT key field + default SL/TP defaults)
```

Each page is a function component that receives the slice of state it needs as props. No global stores. No context (deliberate — keeps the dependency surface explicit). Props are typed via the same `DashboardSnapshot` already exported from `App.tsx`.

`<PageRouter />`: a thin switch over the `activeTab` string returning the right `<Page />`. Lives at `apps/web/src/pages/PageRouter.tsx`.

#### 2.5 Hooks directory

```
apps/web/src/hooks/
├── useDashboardSnapshot.ts   (poll + state + refresh + lastPollError + refreshing)
├── useTelegramSession.ts     (setupStep + form + start/code/password/dialogs)
├── useProviderActions.ts     (toggleProvider, saveProviderSettings, approveSignal, ignoreSignal)
├── useSymbolMappingActions.ts(saveGlobalAlias, saveAccountMapping, deleteAlias)
├── useSettingsActions.ts     (saveExecutionSettings, saveAzureGptKey)
├── useSortableTable.ts       (defined in §2.1)
└── useHotkeys.ts             (already exists; keep)
```

Each hook owns its own fetch handlers + any local state. Returns a typed object of (current values, actions). Pages call hooks at the top level via App.tsx; hooks don't call each other.

#### 2.6 Test impact

Tests today rely on accessible names (`getByRole("tab", { name: "Providers" })`, `getByLabelText("Channel lot size for Alpha FX Signals")`, etc.). Page extraction preserves accessible names so the existing 10 web tests remain unchanged.

Two new tests added in P3:

- Sortable Providers column toggles `aria-sort` and reorders rows.
- Per-row gear icon stays visible when focused via keyboard (regression for the opacity-0 hover-only change in P2).

#### 2.7 Risk and rollback

P3 is a real refactor. If it goes sideways we roll back the whole commit; tokens.css, motion.css, and the polish in P2 are unaffected.

---

### 3. P4 — Skeletons + empty states

**Goal:** loading and empty states feel intentional, not "the data didn't come". CSS-only shimmer plus two tiny components.

#### 3.1 `Skeleton` component

`apps/web/src/components/Skeleton.tsx`:

```tsx
export function SkeletonLine({ width = "100%", height = 12 }) { ... }
export function SkeletonRow({ columns = 4 }) { ... }        // wraps in <tr>/<td>
export function SkeletonStat() { ... }                       // for KPI placeholder
export function SkeletonChart({ height = 320 }) { ... }      // for GrowthChart placeholder
```

CSS (`base.css`):

```css
.skeleton {
  background: linear-gradient(
    90deg,
    var(--panel-2) 0%,
    var(--panel-hover) 50%,
    var(--panel-2) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.4s linear infinite;
  border-radius: var(--radius-1);
  color: transparent;
}
@media (prefers-reduced-motion: reduce) {
  .skeleton { animation: none; }
}
```

Wired into:

- `useDashboardSnapshot.refreshing === true && !snapshot.providers.length` → render `<SkeletonRow columns={12} />` × 6 inside `<ProvidersTable />`.
- Same for `<HistoryTable />`, `<SymbolMappingsTable />`, `<LogRow />` list.
- `<AccountHeader />` shows 5 × `<SkeletonStat />` instead of `—` placeholders on first load.
- `<GrowthChart />` shows `<SkeletonChart />` until uplot's lazy chunk + initial series resolve.

#### 3.2 `EmptyState` component

`apps/web/src/components/EmptyState.tsx`:

```tsx
export function EmptyState({
  glyph,         // line-art SVG, single colour, 32 × 32
  title,         // short heading
  body,          // optional one-line explanation
  action,        // optional <button> for "Add provider", "Connect EA", etc.
}: EmptyStateProps);
```

CSS:

```css
.empty-state-card {
  display: grid;
  place-items: center;
  gap: 12px;
  padding: 56px 24px;
  text-align: center;
  color: var(--ink-3);
}
.empty-state-card svg { color: var(--ink-faint); }
.empty-state-card strong {
  font-family: var(--font-display);
  font-optical-sizing: auto;
  font-size: 16px;
  font-weight: 500;
  color: var(--ink-2);
}
.empty-state-card p { max-width: 320px; font-size: 12px; line-height: 1.5; margin: 0; }
```

Used in:

- Logs tab → "No execution logs yet. Once the EA processes a signal it will appear here." with a tiny terminal-style glyph.
- Providers tab → "No providers configured. Select one from Telegram Setup." with an arrow glyph + the action button.
- Symbol Settings tab → "No symbol mappings yet." with a mapping glyph + "Add mapping" action.
- History tab → "No trades yet. Approved signals will appear here."
- Signal Queue → "Queue is empty."
- Equity Guardian → "No drawdown breaches recorded."

#### 3.3 Polling indicator

`useDashboardSnapshot.refreshing` already exists. P4 wires it into the StatusBar:

- When refreshing, the existing `.live-dot` overlays a thin 1 px ring scaling 0 → 1 outward (already partly captured by the `live-pulse` keyframe from P2 — extend it).
- When `lastPollError` flips true, the dot turns `var(--down-9)` for 4 s, then returns to `var(--up-9)` so transient blips read as a flash without scaring the operator.

#### 3.4 Test impact

- New test: providers table renders 6 skeleton rows when `refreshing && providers.length === 0`.
- New test: empty Logs tab shows the EmptyState glyph + body.

---

### 4. P5+ — Stretch (after P2-P4 ship)

Ordered by impact:

1. **Sortable persistence** — write each table's `(sortKey, sortDir)` to `localStorage` keyed by table name. Hydrate on mount.
2. **Tab content reveal** — wrap `<PageRouter>`'s active child in `<div key={activeTab} className="anim-reveal">` so tab switches fade their content in (not the chrome). One-line change in App.tsx after P3.
3. **Command palette refinement** — already exists. Pass: dim non-matching entries instead of hiding them, render a thin breadcrumb of recently used actions at the top, keyboard-loop on arrow-down.
4. **Equity Guardian + Linked Accounts + Settings polish pass** — these pages already exist in the JSX but haven't had a full polish pass. P5 audits each against the new tokens: card layout, field grouping, focus rings, copy.
5. **Dark mode** — already supported by the token system architecturally. Flip on by:
   - Adding `[data-theme="dark"]` overrides for `--bg`, `--bg-elevated`, `--panel`, `--panel-2`, `--line`, `--ink-*`, `--accent-soft`, `--shadow-*`, `--font-feature-settings` (Geist's stylistic set sometimes needs different alts on dark).
   - Adding a theme toggle to StatusBar (sun/moon icon, persisted to localStorage).
   - Auditing every backdrop-filter / shadow / glassmorphism rule for dark-mode contrast.
   - Should be ~1 day of work and ~80 lines of CSS overrides if P2 is done well.
6. **Brand favicon + theme-color meta** — tiny but cheap. Generate a 32 × 32 SVG favicon using the StatusBar's brand mark + Fraunces `T`.
7. **Page transitions via `<ViewTransition>` (View Transitions API)** — wrap `setActiveTab` in `document.startViewTransition()` for a Chrome / Safari TP fade-cross. Progressive enhancement only.

---

### 5. Out of scope (deliberate)

- Backend / parser / EA / migration changes — you own these.
- Replacing existing components with shadcn / Radix primitives. Rejected in favor of vanilla CSS + design tokens.
- Server-rendering / SSR — the app is a single SPA served static.
- Internationalisation — not required for the operator-facing tool.
- Mobile-first responsive refinement — the operator workflow is desktop-first. Existing media queries hold at 1024 px and 768 px and remain in place; we don't expand to phone.
- A typed API client module — Rantoniaina-style `apps/web/src/api/client.ts` was in the original audit. The current handler-per-page pattern works fine at this scale; revisit only if the hooks grow.

---

### 6. Commit hygiene

Per the workflow rule (one `changelog.md` entry per commit):

| Commit | Files | Risk |
|---|---|---|
| P1 (shipped `4d2d45a`) | `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/styles/tokens.css` (new), `apps/web/src/styles/base.css` (renamed) | Low — CSS-only. |
| P2 | `apps/web/src/styles/motion.css` (new), `apps/web/src/styles/base.css`, `apps/web/src/main.tsx`, `apps/web/src/components/AccountHeader.tsx` (single className edit only) | Low — CSS-only except one className touch on AccountHeader. |
| P3 | `apps/web/src/App.tsx` (gut), `apps/web/src/pages/*` (9 new files), `apps/web/src/hooks/*` (4 new files + 1 update), `apps/web/src/components/{ProvidersTable,HistoryTable,SymbolMappingsTable}.tsx` (sortable header markup), `apps/web/src/App.test.tsx` (+ 2 sortable tests) | Medium — real refactor; full test suite must stay green. |
| P4 | `apps/web/src/components/Skeleton.tsx` (new), `apps/web/src/components/EmptyState.tsx` (new), `apps/web/src/styles/base.css` (skeleton + empty-state styles), each page wires loading + empty branches, `apps/web/src/App.test.tsx` (+ 2 tests) | Low — additive components. |

Coordination rule with your parallel backend pass: I never commit files outside the table above without explicit ack. If a file I want to touch is already modified in your working tree, we resolve before the commit.

---

### 7. Verification matrix

Each commit must pass:

| Check | Command | Required outcome |
|---|---|---|
| Web tests | `bun test apps/web/` | All green (10 today; grows to 14 after P3 + P4). |
| API tests | `bun test apps/api/` | Untouched by UI work. Must still pass. |
| Typecheck | `bun run typecheck` | Clean. |
| Lint | `bun run lint` | Clean (warnings ok). |
| Build | `bun run --cwd apps/web build` | Clean. Bundle stays ≤ 280 KB main + 52 KB lazy uplot + ≤ 55 KB CSS. |

Visual walkthrough via Chrome MCP after each commit:

- **Sign-in screen** at 1440 × 900 — verify Fraunces title, atmospheric gradient, focus ring on phone field, soft Telegram-blue logo glow.
- **Live → Performance** — KPI stagger reveal on first mount, glass StatusBar holds on scroll, GrowthChart canvas size correct on resize.
- **Providers tab** — sticky header survives scroll, hover lifts the row, gear icon fades in on hover, modal opens with scale-in.
- **History tab** — sticky head, TP chip palette correct in light theme, broker-trail expansion still works.
- **Symbol Settings** — Add-mapping modal entrance, scope toggle (global/provider/account), all three forms keep their accessible names.
- **Logs tab** — Parser Lab + Signal Queue + Execution Logs combined feed, Approve/Ignore buttons styled, GPT extraction button visible.
- **Linked Accounts** — link-code workflow renders, slot rows readable.
- **Settings** — Azure GPT key field looks intentional, default SL/TP pip fields look intentional.
- **Reduced motion** — toggle in DevTools rendering; verify staggers, scale-in, shimmer, live-pulse all no-op.
- **Keyboard nav** — tab through entire Live workspace; every interactive element has a visible `:focus-visible` ring; modal traps focus on open.
- **1024 × 768 + 768 × 1024 resize** — account-kpis collapses 5 → 3 → 2, sidebar collapses on narrow.

---

## Frontend UI Improvements — proposal (historical, 2026-05-09)

The original audit below recommended a **modern dark terminal** direction. That recommendation has been **superseded** by:

- The TSC-style pivot to a **light theme** with indigo accent (committed in `b331ff1` and subsequent commits).
- The latest planning round which adopted the **modern editorial finance** direction with Fraunces + Geist + JetBrains Mono + cobalt accent (committed in `4d2d45a`).

The audit's *Pass 1 / Pass 2 / Pass 3* checklist below is largely delivered: status bar, in-workspace tabs, real Providers data table with gear-icon modal, provider config modal with channel-lot-size first field, refresh button wired, `activeView` properly filtering, exec log timestamps, lot-size locale-safe formatting, etc. The dark-theme palette and cyan accent values listed in *Pass 1* should be ignored.

The sections that follow are retained for traceability and historical context. Do not implement the dark palette specified in *Pass 1 — Visual language swap*; refer to the **Premium UI overhaul — May 2026 roadmap** above for the current direction.

---

# Frontend UI Improvements — proposal

Date: 2026-05-09
Status: proposal — not implemented yet

## Context

**Goal:** evolve `apps/web` into a Bloomberg-terminal-style operations console for the Telegram → MT5 copier — dense, data-first, but still navigable for an operator who isn't a power-user every day.

**References reviewed for this proposal:**

- `apps/web/src/App.tsx` (1077 lines, single file).
- `apps/web/src/styles.css` (760 lines).
- `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.test.tsx`.
- `telegram-signals-copier.com` — competing product. Marketing site is generic SaaS, but the **product screens** they show on it are a strong feature reference (provider P&L table, account performance strip, deep provider config, equity guardian, growth chart).
- `github.com/Rantoniaina/telegram-to-mt5` (`develop` branch) — referenced in `docs/superpowers/specs/2026-05-09-telegram-copy-app-design.md` line 395 as visual direction.

**Important reference correction:** the design spec currently says we should look like Rantoniaina's app *and* TSCopier. Those two pull in opposite directions — Rantoniaina is a soft, MUI-default, rounded-card consumer-automation feel (240 px floating sidebar with **20 px corner radius**, 16 px card radius, breathing-pulse status dots, 180 px CreateCard tiles). TSCopier is a dense data-table dashboard. Bloomberg-terminal aspiration sides hard with TSC. Recommend the spec drops the Rantoniaina reference (see §"Spec edits required" below).

## Verdict in one line

The current `apps/web` reads as a **light, friendly, mint-green wellness/SaaS dashboard** — closer in spirit to a Notion template than a trader workstation. To hit Bloomberg territory it needs a fundamentally different visual language *and* a denser information layout. Several functional bugs are also hiding under the polish.

---

## Critical review of the current frontend

### 1. Color palette is the wrong genre

- `--panel: #fbfdfb` (off-white), `--mint: #dff4eb`, body bg `#eef2f0` with mint linear-gradient overlay → reads as eco / wellness.
- Single-hue green-on-cream economy: `--green-dark: #096044` is reused for **every** primary affordance — Save buttons, Pause/Enable, status pills, eyebrow text, metric icons, dialog accept buttons. Color = no information.
- Bloomberg terminals use **black background, functional color**: amber/orange for headings/labels, white for static data, green for up, red for down, cyan for actionable, magenta/yellow for alerts. Color carries semantics.
- `--red: #ba3b3b` is declared but **used nowhere** in the stylesheet. There's no failure state.

### 2. Typography is humanist, not data-grade

- `Avenir Next` is a warm humanist sans designed for editorial use. Wrong DNA for tabular data.
- No `font-feature-settings: "tnum"` / `font-variant-numeric: tabular-nums` anywhere → numeric columns won't align (e.g. TP prices `1.090 / 1.095 / 1.100 / 1.105`, retcodes, confidence).
- Hierarchy is inverted: `h1` is 34 px hero-style ("Telegram TC Operations") with a marketing-style "Live operations" eyebrow above it; `h2` panel titles are only **15 px**. Bloomberg never spends a third of a screen on a page title.
- `SF Mono` is referenced but only for `.parser-source code`, `.mapping-row code`, `.log-row code`. Prices, lot sizes, retcodes, account numbers should all be tabular/mono.

### 3. Density is far too low

- `.metric-card { min-height: 126px }` for 4 cards displaying one number + one detail string each. That's ~500 px of vertical space for ~12 facts.
- `.workspace { padding: 28px }`, `.panel { padding: 18px }`, `.content-grid { gap: 16px }`, `box-shadow: 0 18px 50px` on every card → soft, airy, "marketing dashboard" feel.
- `.tp-grid { grid-template-columns: repeat(4, ...) }` with each leg in its own bordered card is wasteful — a TP ladder belongs in a 4-row tabular block.
- 3-column panel grid wastes width on 1440–1920 px monitors (most users). A terminal layout fills the screen with 5–8 columns of data + a status bar.

### 4. Visual chrome screams "SaaS"

- Every panel: `border-radius: 8px` + 1px line + `box-shadow: 0 18px 50px rgba(32, 48, 42, 0.12)`.
- Status pills use `border-radius: 999px` with icon + colored bg ("● Auto-copy enabled"). Trader UIs use single tokens: `ON` / `OFF`, `LIVE` / `IDLE`, no pill, no shadow.
- Lucide icons on every nav item, every panel header, every form button. Bloomberg is text-first; icons are reserved for true affordances (sort arrows, expand/collapse).

### 5. The header is a landing-page pattern

`<p class="eyebrow">Live operations</p>` + `<h1>Telegram TC Operations</h1>` is the Lyft/Linear marketing eyebrow stack. In an operations console the top strip should be a Bloomberg-style **status bar**: connection state, db latency, parser-adapter mode, last-poll timestamp, ticking clock, hotkey hints — not a hero.

### 6. Functional bugs hiding under the design polish

| # | File:line | Issue |
|---|---|---|
| a | `App.tsx:455-457` | The runtime-strip refresh button has `title="Refresh dashboard"` but **no `onClick`**. It's a dead button despite `refreshDashboard()` being defined right above it. |
| b | `App.tsx:413-437` | The sidebar `activeView` state is read, written, and **never used** to filter content. All 9 panels render simultaneously regardless of which nav item is "active". Either wire it up or drop the nav entirely. |
| c | `App.tsx:142-149` | `mappingForm` initial state reads `snapshot.mt5Accounts[0]?.id ?? "mt5-100200300"` at first render. Snapshot loads **after** initial render, so the field stays stuck on the hardcoded fallback `"mt5-100200300"` even when real accounts exist. Use `useEffect` to sync, or controlled-default. |
| d | `App.tsx:303-318` vs `App.tsx:358-399` | Provider-settings form uses uncontrolled inputs + `FormData`; alias/mapping forms use controlled state **and** `FormData` simultaneously (state is set but read from `FormData`). Pick one pattern. |
| e | `App.tsx:614-620` | "Save fixture" reads sibling textarea via `event.currentTarget.parentElement?.querySelector("textarea")?.value` — DOM traversal hack. The value is already in `redactedFixtureText[result.rawMessageId]`. Just use it. |
| f | `App.tsx:467` | `metrics.value` shows literal `"-"` while loading. Either skeleton-shimmer or a pulsing dot — `"-"` reads like a real value. |
| g | `App.tsx:122` | `loading` only flips false on the **first** poll; subsequent 15 s polls don't surface as "refreshing", so the user has no indication the data is live. |
| h | `App.tsx:823-833` | Execution log row renders without any timestamp. For a chronological log, time-of-event is the most important column. |

### 7. State / architecture

- `App.tsx` is 1077 lines. `SetupFlow`, `DialogPicker`, `Panel`, `Field`, `StatusPill` are co-located, which is fine at this size, but the giant Parser Lab JSX (~75 lines) and the Symbol Mapping panel (~115 lines including 8 form inputs) deserve their own files.
- No data-fetching abstraction — every handler hand-rolls `fetch(..., { method, headers, body })`. A typed client module (one per resource) would deduplicate ~150 lines and make endpoints discoverable.
- 15-second polling is fine for the current scope, but a streaming source (SSE on `/api/events`) would be both more "live" and simpler than `setInterval`. This is the right time to plan that boundary, not after the UI grows.
- Tests in `App.test.tsx` are good (assert real behavior, not snapshots) — keep that style.

### 8. Accessibility / micro-issues

- `.compact-form label` is **11 px** — below WCAG comfortable-read threshold for sustained use.
- `--muted: #68746f` on the cream panel is borderline (≈4.6:1) — check before any darker bg.
- The Lucide icons are mostly correctly `aria-hidden`, but several buttons rely on `title` alone for context (refresh icon, dialog accept). Add `aria-label`.
- No keyboard shortcuts. A terminal-aspirant tool should at minimum have `?` for help, `g d` / `g p` / `g l` for jumps, `r` for refresh, `/` for filter.
- No `<title>` updates per-view, no favicon, no themed `<meta name="color-scheme">`.

---

## Reference comparison

### TSCopier — what's worth stealing

From the dashboard, providers, and provider-config screens shared:

| TSC screen | What we should adopt |
|---|---|
| **Providers table (PnL per provider)** | Sortable performance table: `NAME · RISK · TP# · SL · OTHERS · PIPS · W/L% · AVG. DRAWDOWN · P/L · PROFIT · GAIN`. Chip filters (Name/Date/Status), per-row gear → config, "Provider Report" + "Add Provider" actions. |
| **Live account performance strip** | Horizontal strip across the top: `Connected Platform · Initial Balance · Total Profit Δ% · This Month Δ% · This Week Δ% · Today Δ%`, plus an EA-status badge tied to the MT5 heartbeat. Replaces our four oversized metric cards. |
| **In-view tabs** | Tab strip *inside* the account view: `Performance · Providers · History · Equity Guardian · Symbol Settings · Signal Strategy Rules`. |
| **Growth & Drawdown chart** | Equity curve over trade count with a Growth/Drawdown toggle. |
| **Top Providers / Monthly Returns bars** | Vertical bar chart with month labels and a Top Providers toggle. |
| **Provider config modal** | Deep per-provider editor: **Channel lot size (first field, e.g. `0.20`, with derived per-leg preview)**, Message Template (Automatic / Named template / Manual + Test Message), TP1/TP2/TP3 strategy ("when TP1 hits, set SL to ENTRY+offset" / "multiply SL pips by N"), TP manipulation (change to N pips / 1:R / random spread / fixed add). Strategy chips. Settings History audit log. |
| **Equity Guardian** | Per-account drawdown limit, current dd %, pause-on-breach toggle, breach event log. |

### Rantoniaina's `telegram-to-mt5` — what to deliberately *not* copy

(Repo: `github.com/Rantoniaina/telegram-to-mt5` on `develop`.)

- **Stack:** React 17 + Material UI (Emotion) + Vite + i18next.
- **Layout:** 240 px white sidebar floating on `#f5f5f5`, **`borderRadius: 20`** on the sidebar itself (very soft).
- **Nav:** three sections — Dashboard, MetaTrader, Settings. Active nav item = solid black `#292929` pill, white text + icon.
- **Dashboard content:** a grid of `SyncCard`s (one per Telegram chat being mirrored to MT5). Each has play / pause / stop and a status dot with a CSS keyframe **"breathing" animation** — green `#4CAF50` ACTIVE pulses every 2 s, orange `#FFA500` PAUSED every 4 s, red `#F44336` ERROR every 1.5 s. There's a 180×180 dashed-border `CreateCard` tile, hover lifts up `translateY(-5px)` with `0 8px 15px` soft shadow.
- **Functional scope** is narrower than ours — no parser lab, no symbol mapping, no execution logs, no provider analytics. Effectively a friendly Telegram-chat-to-MT5 mirror with state controls.
- **Why we don't take this aesthetic:** `borderRadius: 20`, soft shadows, breathing-pulse status dots, MUI defaults, friendly consumer-automation vibe — the *opposite* of "Bloomberg terminal". The breathing dots are charming and worth borrowing as a *very subtle* "data is live" cue, but the chrome around them isn't.

---

## Recommended direction

**"Modern dark terminal" — dense but navigable, with TSC feature parity.** Halfway between Bloomberg classic and a hybrid dense-light pass. Keep a dark theme, monospace-for-data, sharp 1 px borders and zero drop-shadows for the terminal feel — but use a restrained, modern palette (cool greys + one cyan accent + green/red for direction) rather than retro amber-on-black, and invest heavily in navigation so it stays approachable.

---

## Channel lot size — operator-owned execution volume

The design spec (`2026-05-09-telegram-copy-app-design.md`) now requires that **every approved trade from a provider uses the operator-configured channel lot size, not any lot value embedded in the Telegram message**. Provider-sent lot/risk hints are captured for review only — see spec §"Provider Strategy Configuration" line 270, §"Signal Lifecycle and Multi-TP Design" line 319, and Success Criteria lines 555-556.

The UI must surface this policy in five specific places so operators can see, configure, and understand it without reading the spec.

| # | Surface | Treatment |
|---|---|---|
| 1 | **Provider Config Modal** | First field, above Message Template. Labelled `Channel lot size`, monospace numeric input (step 0.01), default 0.01 / placeholder "e.g. 0.20". Below the input: a derived preview that updates live — `Allocation 25/25/25/25 → 0.05 / 0.05 / 0.05 / 0.05 per TP leg`. If the configured TP allocation produces a per-leg volume below the broker minimum (reported by EA), highlight the offending leg in `--warn`. |
| 2 | **Providers performance table** | New `LOTS` column between `RISK` and `TP#`. Right-aligned, monospace, two-decimal (`0.20`). Sortable. Hover tooltip: "Per-trade execution volume for this channel". |
| 3 | **History tab / Trade lifecycle card** | Each TP-leg row shows `vol: 0.05` (derived from channel lot ÷ allocation), not from parsed signal text. The trade card header shows `Channel lot 0.20` next to the symbol so the per-leg math is auditable at a glance. |
| 4 | **Parser Lab row** | When a raw signal contains a lot or risk hint (e.g., `risk 1%`, `0.5 lots`), display it under a small `CAPTURED · NOT EXECUTED` tag so operators see what the provider sent and immediately understand it's ignored for queueing. The hint stays visible for fixture authoring; it just never reaches the EA. |
| 5 | **Account header strip** | No change. Channel lot is provider-scoped, not account-scoped. Account-level KPIs (initial balance, total profit, deltas) continue to live in the strip; lot-size belongs in the Providers tab. |

Number formatting note: lot-size inputs and displays must use a **dot decimal separator** regardless of browser locale. Use `Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })` or a manual `value.toFixed(2)` for display, and a controlled `<input>` with `step="0.01"` + custom parse to avoid `0.1` ↔ `0,1` locale slippage on EU systems.

---

## Implementation sketch (when we choose to build it)

### Pass 1 — Visual language swap (~1 day, CSS-mostly)

Replace `apps/web/src/styles.css` wholesale. Keep the JSX structure largely intact in this pass.

- **Palette:** `--bg: #0c0f12`, `--panel: #12161b`, `--panel-2: #161b21`, `--line: #232a32`, `--line-strong: #2f3942`, `--ink: #e7ecf2`, `--ink-dim: #8b96a3`, `--accent: #54b8ff` (single cyan/blue interactive accent — matches TSC's blue family), `--up: #37d399`, `--down: #ff5d6c`, `--warn: #f0b85a`. Strip every drop-shadow. 1 px borders only.
- **Type:** Two-stack — `--font-ui: "Inter", "Inter Tight", system-ui` for labels & UI chrome; `--font-mono: "JetBrains Mono", "IBM Plex Mono", ui-monospace` for all numeric data, codes, IDs, prices, retcodes. `font-variant-numeric: tabular-nums` on the mono stack so numbers align without forcing a true monospace.
- **Geometry:** `border-radius: 4px` max (light softening, not full Bloomberg flat), 1 px borders, 12 px panel padding, 10 px grid gap. Replace pill statuses with inline tokens (`<Tag tone="up">ON</Tag>` → `ON` in green text on a 1 px green-tinted border, no fill).
- **Header:** swap the marketing eyebrow + 34 px H1 for a 28 px slim status bar — `TG-TC · Operations    DB ●ok  TG ●mock  Queue 7  ·  12:04:11 UTC` — and put a real `onClick` refresh + a "live" pulse dot on the right.
- **Grid rail:** keep a slim ~200 px sidebar (not the full 260 px) but invest in usability — every nav item has a hotkey hint shown on `Alt`, hover states are crisp, the rail stays sticky on scroll. Don't shrink to a 56 px icon rail; that hurts navigability.

### Pass 2 — Information architecture & feature parity (~2-3 days)

Layout (top → bottom):

1. **Status bar (28 px)** — brand · health chips · queue count · last-poll clock · refresh button (wired) · live dot.
2. **Account header strip (72 px)** — TSC-style: `Connected Platform (MT4/MT5 + broker + DEMO/LIVE) · Initial Balance · Total Profit Δ% · This Month Δ% · This Week Δ% · Today Δ%` + an `EA WORKING` heartbeat badge tied to MT5 adapter status. Quick actions dropdown on the right.
3. **Tab strip** — `Performance · Providers · History · Equity Guardian · Symbol Settings · Signal Strategy Rules · Logs`. Sidebar collapses to a top-level nav (Home / Linked Accounts / Live / Telegram Setup); within "Live" the tabs do the per-section work. Wires `activeView` properly for the first time.
4. **Performance tab (default)** — split:
   - Left ~70 % — **Growth/Drawdown line+area chart** over trade count with Growth/Drawdown toggle.
   - Right ~30 % — **Monthly Return / Top Providers bar chart** with toggle.
   - Below — small per-account latency strip (median queue→fill, parse latency, last error).
5. **Providers tab** — full-width sortable **performance table** with the columns from the TSC screen plus our channel-lot column: `NAME · RISK · LOTS · TP# · SL · OTHERS · PIPS · W/L% · AVG. DRAWDOWN · P/L · PROFIT · GAIN`. Filter chips (Name/Date/Status), Provider Report button, Add Provider button (opens DialogPicker), per-row gear opens **Provider Config Modal** (channel lot size, template, TP1/2/3 strategy, pip manipulation, settings history). Replaces today's stacked card list.
6. **History tab** — chronological trade list, each row expandable to lifecycle events (`12:04:11 OPEN · 12:04:13 SL@1.0820 · 12:08:47 TP1 hit 25%`) and a P&L sparkline. Today this is buried in the "Trade Lifecycle" panel.
7. **Equity Guardian tab** — per-account: current drawdown %, threshold input, pause-on-breach toggle, breach event log, max-dd metric.
8. **Symbol Settings tab** — what's currently in the Symbol Mapping panel, but as proper tables (global aliases / per-account overrides) with inline edit instead of a wall of inputs.
9. **Signal Strategy Rules tab** — per-provider per-pair rule editor, scaffolded UI even if backend doesn't yet support per-pair (forward-compatible).
10. **Logs tab** — combined Parser Lab review queue + execution logs as one timestamped feed with type filters; replaces two separate panels.
11. **Tables not cards everywhere** — fixed-column rows, 26 px row height, right-aligned numerics with `tabular-nums`, sortable headers, sticky table headers on scroll.
12. **Settings drawer** (`Cmd/Ctrl+,`) for global Telegram credentials + add-provider flow that doesn't fit a tab.

Navigation:

- Sidebar = top-level nav only; tabs scope sub-views.
- Hotkeys: `g 1..7` for tabs, `?` for help, `r` refresh, `/` filter the active table, `Cmd/Ctrl+K` command palette (refresh, pause provider, jump to tab, open settings).
- Footer strip: last-poll timestamp + coloured live-poll dot (green ok / red on last fetch reject).

### Pass 3 — Functional fixes (folded into Passes 1–2)

- `App.tsx:455` — wire `onClick={() => void refreshDashboard()}` on the runtime-strip refresh button.
- `App.tsx:413` — implement an `activeView` switch (or `<section hidden={activeView !== "providers"}>`) so the sidebar actually filters; otherwise drop the nav.
- `App.tsx:142` — replace the `mappingForm` initializer with `useEffect(() => { if (!mappingForm.accountId && snapshot.mt5Accounts[0]) setMappingForm(f => ({ ...f, accountId: snapshot.mt5Accounts[0].id })); }, [snapshot.mt5Accounts])`.
- `App.tsx:614` — read from `redactedFixtureText[result.rawMessageId]` directly; drop the `parentElement?.querySelector("textarea")` hack.
- `App.tsx:303-399` — converge on controlled state for all forms; remove the parallel `FormData` reads.
- Surface fetch failures — wrap the polling `load()` in a try/catch and set a `lastPollError` flag; render a red dot in the footer when set.
- Add timestamp column to `executionLogs` rows (currently absent on screen).

### Files that would change

| Path | Change |
|---|---|
| `apps/web/src/styles.css` | Full rewrite — dark tokens, two-stack type (Inter + JetBrains Mono), flat 1 px geometry, table styles, ticker tape, status bar. |
| `apps/web/src/App.tsx` | JSX restructure: status-bar header, account strip, tab strip, table-based panels, P&L sparkline + event log, equity guardian strip, settings drawer (`Cmd/Ctrl+,`), command palette (`Cmd/Ctrl+K`), keyboard nav. Fix refresh handler, `activeView` wiring, `mappingForm` init, drop the DOM-querySelector hack, surface poll errors. |
| `apps/web/src/App.test.tsx` | Update text assertions where copy moves (eyebrow → status bar). Behavior tests (toggle, save, fixture) keep working. Add tests for: refresh button now triggers `/api/dashboard`; `activeView` filters panels; failed poll renders the error dot. |
| `apps/web/index.html` | Add `<meta name="color-scheme" content="dark">`, set `<title>` to `TG-TC · Operations`, preconnect to font CDN if used. |
| `apps/web/src/components/` (new) | Extract `StatusBar`, `AccountHeader`, `Tabs`, `DataTable`, `Tag`, `SettingsDrawer`, `CommandPalette`, `GrowthChart`, `MonthlyBars`, `Sparkline`, `EventLog`, `EquityGuardian`, `ProviderConfigModal`, `SetupFlow`, `DialogPicker`, `Panel`. |
| `apps/web/src/charts/` (new) | Lightweight chart primitives. Recommend `uplot` (~40 KB) over Recharts (~500 KB) — faster, fits a "terminal" feel, easy to style with CSS variables. |
| `apps/web/src/api/client.ts` (new) | Centralised typed `fetch` helpers per resource (`providers.toggle`, `mappings.saveAlias`, `telegram.start`, …), single error path that flips the footer error dot. |
| `apps/web/src/hooks/useHotkeys.ts` (new) | Key-binding hook for tab jumps (`g 1..7`), `?`, `r`, `/`, `Cmd-K`, `Cmd-,`. |
| `apps/api` (additive endpoints) | `GET /api/account/performance`, `GET /api/providers/performance`, `GET /api/equity-curve?accountId=…`, `GET /api/trades/:id/events`, `GET /api/equity-guardian` + `PATCH /api/equity-guardian`, `GET /api/providers/:id/config` + `PATCH /api/providers/:id/config`. Stub with deterministic data first if real attribution is not ready; defer accurate calc to a follow-up. |

---

## Spec edits required to `docs/superpowers/specs/2026-05-09-telegram-copy-app-design.md`

The TSC-parity UI work introduces product features that aren't currently scoped in the design doc. These would need to be added (or moved out of "Deferred") before the frontend rewrite goes in, so backend/EA/data-model alignment is explicit.

**A. Add a new top-level section: "Analytics & Performance"** (between "Position State and TP Management" and "MT5 Expert Advisor Design")

- Per-provider attribution: pips, W/L %, average drawdown, P/L, profit, gain — calculated from the join of LogicalTrade ↔ ExecutionReport ↔ Provider.
- Account-level KPIs: initial balance, total profit, Δ today / week / month, EA status badge tied to heartbeat freshness.
- Equity curve series: account growth vs trade-count, plus drawdown series. Stored as either a derived view or pre-aggregated daily snapshots.
- Monthly returns series.
- Filtering: by provider name, by date range, by enabled/disabled status.
- Export: "Provider Report" CSV/PDF for a selected window.

**B. Add a new top-level section: "Equity Guardian"** (between "Symbol Mapping Design" and "Signal Lifecycle and Multi-TP Design")

- Per-account threshold (e.g. max drawdown %) with current dd %.
- Pause-on-breach: when current dd ≥ threshold, the queue must reject new OPEN_TRADE commands for that account; lifecycle commands on already-open trades still pass.
- Breach event log (when, what dd, what action taken).
- Manual unpause action (audited).
- This is a backend rule, not just a UI display — the queue/EA paths must consult it.

**C. Add a new top-level section: "Provider Strategy Configuration"** (between "Symbol Mapping Design" and the new Equity Guardian section)

- Per-provider editable: Message Template (Automatic / Named template / Manual override), with a Test Message preview using a recent raw message.
- Per-TP strategy: When TP1 hits → set SL to ENTRY+offset OR multiply SL pips by factor.
- TP manipulation: change TP1 to N pips OR change to 1:R risk-reward; conditional "only if signal lacks TPx".
- Pip add/randomize/spread on individual TP levels.
- Per-provider Settings History (audit log of who/when/what changed).
- Spec must say: the deterministic parser remains the source of truth for raw fields; strategy config layers over parser output before the signal enters the queue.

**D. Expand "Frontend Screens" section** (line 382-394) — replace the flat 10-screen list with the new IA:

- Top-level nav: Home · Linked Accounts · Account Management · Live (default) · Telegram Setup.
- Within "Live": tabs for `Performance · Providers · History · Equity Guardian · Symbol Settings · Signal Strategy Rules · Logs`.
- Each screen described with: data on screen, primary actions, empty/error states.
- Add: "Per-trade lifecycle event log" sub-feature on History/Trade Lifecycle (timestamped OPEN / SL set / TP hit / partial close events).
- Add: "P&L sparkline per logical trade" on the trade card.

**E. Expand "Backend Responsibilities"** (line 99-146) with new endpoint groups:

- Analytics: `GET /api/account/performance`, `GET /api/providers/performance`, `GET /api/equity-curve`, `GET /api/monthly-returns`, `GET /api/providers/:id/report`.
- Equity Guardian: `GET/PATCH /api/equity-guardian/:accountId`, `GET /api/equity-guardian/:accountId/breaches`.
- Provider Strategy: `GET/PATCH /api/providers/:id/config` (template, TP rules, manipulation), `GET /api/providers/:id/config/history`, `POST /api/providers/:id/config/test` (apply template+rules to a sample raw message and return the would-be parsed signal).
- Per-trade events: `GET /api/trades/:id/events` for the lifecycle event log.

**F. Expand "Data Model"** (line 360-378) with new entities:

- `EquityGuardian`: per-MT5Account thresholds, current dd, paused state, breach history.
- `ProviderConfig`: per-Provider template choice, TP strategy rules, pip-manipulation settings, version + author + timestamp for history.
- `ProviderConfigHistory`: append-only changelog rows for `ProviderConfig`.
- `EquitySnapshot`: periodic per-account balance/equity capture for the equity curve.
- `LogicalTradeEvent`: timestamped events (OPEN, SL_MOVED, TP_HIT, PARTIAL_CLOSE, MODIFY, CANCEL, CLOSED) joined to LogicalTrade — already partly implied by "command history" but needs to be an explicit append-only log for the UI feed.

**G. Update "Product Scope"** (line 14-44) to reflect:

- Move "Strategy builder" from Deferred → into v1 *as Provider Strategy Configuration (TP rules + templates)*; the TSC-style strategy builder is differentiating and the UI is being designed for it now.
- Keep AI assistant, image parsing, 100 TPs, multi-platform, payment, cloud broker APIs in Deferred.
- Add to v1 Included: Analytics & Performance (per-provider attribution, account KPIs, equity curve, monthly returns), Equity Guardian, Provider Strategy Configuration, per-trade lifecycle event log.

**H. Update "Success Criteria"** (line 432-448) with new acceptance lines:

- Per-provider performance metrics visible and match a hand-computed value on a fixture-driven test account.
- Equity Guardian threshold breach pauses new OPEN_TRADE commands while passing lifecycle commands.
- Provider Strategy Configuration changes round-trip through the queue and the EA receives the modified TP/SL.
- Per-trade lifecycle event log is populated for every state transition.

**I. Update "Visual direction"** sentence at line 395 — "clean dashboard style similar to Rantoniaina's app" → describe the actual target: "modern dark terminal: dense, monospace numerics, sharp 1 px borders, single cyan accent on near-black, status bar header + ticker tape + tabbed working surface, restrained colour reserved for direction (green/red) and warnings (amber); inspired by Bloomberg-style operations terminals while keeping the navigability of TSCopier." Remove the Rantoniaina reference — its aesthetic pulls in the opposite direction from the stated goal.

---

## Verification approach (when implemented)

1. `bun install && bun run --cwd apps/web dev` — open `http://127.0.0.1:5173`, eyeball at 1440 × 900 and 1920 × 1080.
2. `bun test apps/web` — existing tests should pass after copy updates; add tests for: refresh button now triggers `/api/dashboard`; `activeView` filters panels; failed poll renders the error dot; provider performance table sorts; Equity Guardian threshold breach disables OPEN_TRADE in the queue.
3. Manual: open with the **MT5 demo terminal verification** flow (`docs/mt5-demo-terminal-verification.md`) running, confirm queue → trade lifecycle → exec log row updates flash on change; confirm growth chart re-renders.
4. Lighthouse a11y pass ≥ 95 (keyboard nav, contrast, labels).
5. Compare side-by-side with `telegram-signals-copier.com` — the tool should look like the **back office** that runs *behind* a site like that, not like another front-of-house clone.
