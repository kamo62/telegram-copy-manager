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
