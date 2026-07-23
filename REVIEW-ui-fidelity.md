# UI redesign fidelity assessment — 2026-07-23

Live app (dark, dev) driven in Chrome (chrome-devtools MCP) against a copy of `data/telegram-tc.db`
(mock Telegram adapter, 2 USD accounts, 1 provider). Target = the "Telegram TC — console" and
"— desk & account operations" artifacts (2026-07-20). Findings below, most visible first.

## Setup notes
- API: `DATABASE_PATH=<copy> TELEGRAM_ADAPTER=mock PORT=8787 bun apps/api/src/server.ts`
- Web: `bun run dev:web` (5173, proxies /api → 8787). No live Telegram/MT5 touched.
- Both mock accounts report `heartbeatStatus` stale → they render in the OFFLINE/stale state,
  which is why the desk is dominated by the offline styling.

## Target aesthetic (from the console artifact)
- Dark default + toggleable light. Accent = **blue** (`--accent` ~hsl(212–218 …)).
- Cards: 12px radius, 1px `--line` border, foldable. Attention = `inset 3px 0 0 var(--warn)` (amber left edge).
- Status chips: neutral track bg for offline, accent bg for online. **No violet anywhere.**
- Equity curve = dithered dot-matrix fill under a stepped line (cyan `--curve`).
- Big figures with de-emphasised decimals (`.fig .fr`).

---

## Findings

### 1. Offline/stale account state is rendered in VIOLET, not the artifact's neutral+amber (high)
- `signal-desk.css:848` `.operations-account.offline { border-color: var(--unknown) }` → violet ring.
- `:882` `.operations-state` badge and `:961` `.operations-account-issue` stale banner both use
  `var(--unknown)` / `var(--unknown-soft)` (violet `hsl(269 72% 73%)`).
- Both demo accounts are stale, so the entire desk reads purple. The console artifact encodes
  offline as a **neutral chip** and stale/attention as **amber `--warn`** with an inset left edge —
  never violet. This is the single biggest reason the desk "doesn't look like the artifacts".
- Fix direction: offline border → `--line` (or `--warn` inset for attention); status badge offline →
  neutral chip; stale banner → `--warn-soft`/`--warn`. Reserve `--unknown` for attribution only.

### 2. Account header contradicts itself: says "Live" but blanks Balance/Equity to "—" when stale (high)
- Account Performance header title is **hardcoded** `"Live"` (`AccountHeader.tsx:161`) regardless of
  heartbeat state — shows "Live" even while the same card shows an "EA OFFLINE" chip.
- `App.tsx:1069` `performanceIsLive = heartbeatStatus === "online"`. When false (both demo accounts
  are stale), `App.tsx:1166-1187` forces `balance`/`equity`/`tradingPnl` to `null`, so the KPIs render
  em-dashes ("—") even though the **last-known values exist and display fine on the Operations desk**
  ($10,000.00). Net effect: the header claims "Live" and simultaneously shows no numbers.
- The artifact handles stale by showing the last-known value under a "Balance as at HH:MM — not current"
  label. Fix direction: drive the title from heartbeat state; show last-known balance/equity (muted or
  with an "as at" caption) instead of blanking to "—".

### 3. Equity curve fills the whole panel as a solid cyan slab with sparse data (medium)
- With 1-2 equity points and no movement, the dithered area fill spans the entire $0→$10,000 height as
  a near-solid cyan block (Account growth, Performance › Overview). The artifact's fade-mask keeps the
  fill light and fading toward the baseline; here it reads as one saturated rectangle.
- Partly a demo-data artifact, but the fade gradient/mask isn't taming a flat single-value series, and
  the x-axis degenerates to "0 … 1 · NUMBER OF TRADES". Fix direction: floor the visible range / clamp
  the fill height for near-flat series, or show an empty-state instead of a full-height fill.

### 4. Favicon 404 (low)
- `GET /favicon.ico` 404s (only console error on load). Add a favicon or inline data-URI in index.html.

### 5. `/review` is an unhandled route that silently falls back to the Operations desk (low/medium)
- Typing `/review` renders the full Operations desk (title "Operations", Signals tab, Operations nav
  still active) with no redirect. The sidebar "Review queue" item actually navigates to `/logs`
  (all-accounts "Signals & logs"), which is correct. So `/review` is a dead URL that should redirect
  to `/logs` (or 404) rather than impersonate Operations.

### 6. DEFAULT LOT SIZE renders as "0,1" (comma decimal) in Settings (low, verify)
- Settings › Execution defaults shows `0,1` for a value the API returns as `0.1`. Looks like locale
  number formatting leaking into a text/number input. Risk: round-trips or edits could misparse the
  decimal. Confirm the input parses/saves `0.1` correctly under a comma-decimal locale.

### 7. Mobile (390px): header status cluster truncates and overlaps the nav; account list drops out (low)
- The rail reflows to a top nav row (good), but the top-right status chips (DB/TG/Queue/version) and
  the theme/refresh icons collide with the wrapped nav, and the ACCOUNTS group isn't in the collapsed
  nav (accounts still reachable via their cards). Desktop is unaffected.

## Matches the target well (dark + light)
- Grouped left rail (Desk / Accounts / Setup), brand block, "Local execution" footer.
- Dithered cyan equity curve, Growth/Drawdown black-pill segmented control, Today/Week/Month toggle.
- P/L attribution cards, Overview/Statistics sub-tabs, signal ledger with PARSE→FILL stage bars
  (blue done / amber hold), working-orders empty state, provider strip.
- Light mode = clean cool-gray page, white hairline cards, black active-nav pill, green/red deltas.
- Blue accent token is correct (`--accent` blue in both themes); the purple is only the misused
  `--unknown` offline styling (finding #1).
- Command palette is now fully styled (white modal, search field + ↵ hint, numbered command list,
  highlighted selection) — the old `plan-white-ui-redesign.md` "CommandPalette unstyled" item is resolved.
- Settings, Equity Guardian (correctly scoped to the focused account), Trade ledger Open/Closed toggle,
  and the Parser Lab / signal-queue / execution-logs on the Logs page are all clean and on-brand.

## Part 2 — route/IA map + owner's follow-up items (2026-07-23)

### The actual routes (parsed in `App.tsx:parseRoute`, catch-all router in `main.tsx`)
- `/` and `/<tab>` → all-accounts dashboard. Tabs: performance, providers, history (Trade ledger),
  equity-guardian, symbols, logs. `summary` redirects to performance.
- `/accounts/<id>/<tab>` → same dashboard scoped to one account.
- `/telegram` → Telegram setup. **Provider add / enable / pause / remove lives here** (bottom section).
- `/linked-accounts` (view "mt5") → link slots + connected accounts + **Remove account**. Only reachable
  via the sidebar **"Add account"** button; there is no standing nav item for it.
- `/settings` → global settings.
- `/providers` → the all-accounts dashboard **Providers tab** (aggregated performance + health), i.e. the
  same content as the dashboard providers tab, not a distinct page.
- `/symbols`, `/logs` (Review queue).

Sidebar (`Sidebar.tsx`): Desk = Operations, Review queue. Accounts = account list + Add account. Setup =
Providers, Symbols, Telegram, Settings. No "Linked accounts"/"Accounts" management item.

### Provider controls are split across three places (root of the confusion)
1. `/providers` nav → aggregated provider **performance/health** (`ProvidersPage`, all-accounts).
2. `/telegram` bottom → provider **monitoring**: enable/pause/remove + default lot/risk/TP (`TelegramSetupPage`).
3. account **Providers tab** → per-account **copy config** (start/stop copy, per-account lot/risk/TP).

### Owner follow-up items and their root cause
- **F8. Remove the Signal ledger from the Operations desk** — `OperationsPage.tsx:171`
  `<section className="operations-ledger">`. Duplicates the Review queue. Delete the section (and its
  stage-bar helpers if unused elsewhere).
- **F9. Tracked providers should be at the TOP of the Telegram page** — `TelegramSetupPage.tsx` renders the
  dialog list first and the `PROVIDER MONITORING` (tracked KAL VIP / VIP Signals) section last. Move the
  monitoring section above the dialog list.
- **F10. Providers nav overlaps Telegram monitoring** — see split above. Needs an IA decision (dedicated
  Providers page vs remove from nav). DECISION NEEDED.
- **F11. No discoverable way to edit/delete an account** — Remove exists (`LinkedAccountsPage.tsx:151`,
  `DELETE /api/mt5/accounts/:id` at `App.tsx:1608`) but only reachable via "Add account". No rename/edit.
  Needs an IA decision on where account management lives. DECISION NEEDED.
- **F12. Untracked/external trade can't be removed** — by design: external broker positions are read-only
  (`LinkedAccountsPage.tsx:202-208` "The app does not manage these"), and Archive/resolve is gated to
  `status === "OUT_OF_SYNC"` only (`HistoryPage.tsx:49,162`). No dismiss/remove for a non-out-of-sync or
  external trade. Needs a decision on what "remove" should do. DECISION NEEDED.
- **F13. Settings appearance toggle is inconsistent** — `.settings-theme-picker` (`SettingsPage.tsx:121`)
  has **no CSS rule anywhere**, so the Light/Dark control renders as a plain bordered box instead of the
  black-pill segmented control used for Growth/Drawdown, Today/Week/Month, Open/Closed. Style it to match.
- **F14. Equity curve solid slab confirmed with real data** (Image #3) — even a multi-point $0–$15k series
  fills the whole plot as a uniform cyan dither with no fade toward baseline and no visible top line.
  `GrowthChart.tsx` + `dither-kit/area.tsx`/`dither-paint.ts`. Fade mask / density ramp isn't applied.
- **F15. Default lot size shows "0,04" (comma decimal)** — `SettingsPage.tsx:165` `type="number"`
  `defaultValue={settings.defaultLotSize}`; browser renders the decimal per locale (comma). Confirm it
  round-trips to a dot on save; consider a text input with explicit dot parsing.

## Net read
The redesign structurally matches the console artifact and the light mode is faithful. The two things
that make it "not look like the artifacts" are cosmetic-but-loud: (1) the violet offline/stale treatment
dominating the desk, and (2) the account header saying "Live" while blanking Balance/Equity to "—".
Both are small, well-localised fixes (finding #1 = swap `--unknown` for neutral/`--warn` in three
`.operations-account*` rules; finding #2 = drive the title from heartbeat and stop nulling last-known
balance when offline). Everything else is polish.
