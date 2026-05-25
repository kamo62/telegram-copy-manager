# Per-account Providers: account-scoped stats, config, and copy workflow

> Implementation plan. Validated against `main` @ `bce0eb6` after consolidating the repo to a
> single worktree (the old `telegram-tc-pr2` worktree and merged/stale branches were removed).

## Problem

The Providers tab shows the **same** stats and the **same** "Copied by" chip matrix no matter
which MT5 account is selected in the sidebar. Two accounts copying one provider (KAL VIP)
appear to share a single stat set, and accounts are attached to a provider from the provider
row — an inverted workflow — made worse because accounts have different balances yet share one
global lot/risk config.

Root causes (`main`):
1. **Providers tab is global.** `App.tsx` (~1309-1330) renders `ProvidersPage` with all
   providers / all accounts / all links and never reads `selectedAccountId`; it merges the
   **aggregate** `snapshot.providerPerformance` into every row.
2. **Snapshot perf is aggregate.** Dashboard snapshot calls `this.providerPerformance()` with
   no account (`app.ts:5007`).
3. **Chip matrix inverts the flow.** `ProvidersTable.tsx:185-217` edits the global
   `account_provider_links` join table from each provider row.
4. **Config is global.** Lot/risk/TP live on the `providers` row (`provider_config_json`),
   shared by every copying account (`providerConfig` `app.ts:1086`, used once at `app.ts:1716`).

## Already in place on `main` (reduces scope)

- `providerPerformance(accountId?)` (`app.ts:3724`) **already filters logical trades by
  account** and computes per-account `gain`, `gainPct`, `winRate`, `averageDrawdown`,
  `copiedDrawdown` (via `averageCurveDrawdown`/`maxCurveDrawdown("provider", accountId, id)`).
- `providerPerformanceCsv(accountId?)` + export endpoint already exist.
- `ensureColumn(table, column, definition)` migration helper (`app.ts:6062`) → use for the new
  link column instead of hand-writing `ALTER TABLE`.
- Execution already fans a signal out to one logical trade per linked account; logical trades
  carry `accountId`+`providerId`; `broker_orders` carry `account_id`; queue items carry per-item
  `volume`/`riskPercent` → **EA needs no change**.
- API serves `index.html` for any path (`app.ts` `app.get("*")`) → clean client-side routes
  survive reload with no server change.

## Decisions (confirmed)

- Provider config (lot/risk/TP) becomes **per-account**, inheriting a provider default.
- Providers tab becomes **account-scoped**, driven by **`react-router-dom`** URL routes.
- **Overview (no account):** aggregated stats across enabled accounts + **read-only** "Copied
  by" chips (no Configure/Pause/Remove/toggle).
- Deliver **all in one pass**.

## Plan

### Part A — Per-account provider config (data model + API + execution)

- **Schema:** `this.ensureColumn("account_provider_links", "config_json", "TEXT")` (the table is
  defined at `app.ts:5295`; add the call where other `ensureColumn` migrations run). `NULL` =
  inherit the provider default.
- **Resolver:** `providerConfig(providerId)` → `providerConfig(providerId, accountId?)`
  (`app.ts:1086`). With `accountId`, if the link row has `config_json`, parse + return it;
  else fall back to the provider-level config (current behaviour). Keep provider-level as the
  inheritance default.
- **Persistence:** `saveProviderConfig(providerId, config)` →
  `saveProviderConfig(providerId, config, accountId?)` (`app.ts:1138`): with `accountId`, write
  the link `config_json`; else keep writing `providers.provider_config_json` (+ history).
  Extend `PUT /api/account-provider-links/:accountId/:providerId` (`app.ts:497`) to accept an
  optional `config` body (or add a `/config` sub-route).
- **Execution path** (`app.ts` ~1708-1850): resolve config **per target account**. Replace the
  single `const providerConfig = this.providerConfig(providerId)` (`1716`) usage inside the
  per-target `applyProviderExecutionConfig` calls (`1750`, `1761`, `1842`) and the
  `volume`/`riskPercent` blocks with `this.providerConfig(providerId, target.accountId)`.
- **Config GET** (`app.ts:257`): accept optional `?accountId` to return the resolved per-account
  config for the modal.

### Part B — Surface per-account performance to the UI (mostly done server-side)

- Dashboard snapshot (`app.ts:5007`): keep aggregate `providerPerformance()` (overview) and add
  `providerPerformanceByAccount: Record<accountId, rows[]>` computed per linked account.
- Expose `providerPerformanceByAccount` in the web `DashboardSnapshot` type (`apps/web/src/App.tsx`
  snapshot interface ~line 76 / `apps/web/src/lib/api.ts`).

### Part C — Routing (`react-router-dom`, all surfaces)

- Add `react-router-dom`; wrap `<App/>` in `<BrowserRouter>` in `main.tsx` (no router today).
- URL scheme:
  - `/` → overview (no account) = aggregated Providers + read-only chips.
  - `/accounts/:accountId/{performance|providers|history|symbols|guardian|logs}` → per-account tabs.
  - `/telegram`, `/linked-accounts`, `/settings` → global views.
- In `App.tsx`, replace `activeView`/`activeTab`/`selectedAccountId` `useState` (~345-370) with
  `useParams`/`useLocation`/`useNavigate`. `focusedAccount` (~465), the `dashTab()`/`show*`
  helpers (~1133-1152), and the `document.title` effect (~636) derive from the route. Convert
  the ~24 `setActiveView`/`setActiveTab`/`setSelected*` call sites to `navigate(...)`.
- `Sidebar.tsx`: `onNavigate`/`onSelectAccount`/`onSelectSlot` → route links; active highlight
  from `useLocation`. `WorkspaceTabs`, the 1-9 hotkeys (~629), and command-palette "Go to X"
  (~594) all call `navigate`.
- **Guards:** unknown/deleted `:accountId` → redirect to `/`; bare `/accounts/:id` → default
  tab (`performance`).

### Part D — Providers UI (overview vs per-account) + relocate global lifecycle

- `ProvidersTable`/`ProvidersPage` gain a `mode`:
  - **overview** (no `accountId`): **aggregated** stats; "Copied by" chips render **read-only**;
    **no** Configure/Pause/Remove/toggle; keep Export.
  - **account** (`accountId` present): rows show that account's stats (from
    `providerPerformanceByAccount[accountId]`); the chip matrix (`ProvidersTable.tsx:185-217`)
    is replaced by a single **Copy on/off** toggle (link/unlink this account); a **Configure**
    action opens the per-account config modal.
- **Relocate global provider lifecycle + default config** (overview is read-only): provider
  enable/pause (`toggleProvider`), remove (`deleteProvider`), **and global default Configure**
  move to **Telegram Setup** (the provider-setup home). A "Provider monitoring" list there
  exposes Configure / Enable-Pause / Remove per provider. This also fills a gap: the global
  default config (which per-account overrides inherit from) needs an editable home now that the
  Providers tab is account-scoped/read-only. The same `ProviderConfigModal` is reused — opened
  with no `accountId` it saves the global default (PATCH `/api/providers/:id`); opened from an
  account's Providers tab it saves a per-account override (PUT link `config`).
- `ProviderConfigModal.tsx`: accept an optional `accountId`; load via config GET `?accountId`;
  save via the per-account link config endpoint; show inheriting-default vs override.

### Part E — Tests + checks

- `apps/api/src/api.test.ts`: per-account config resolution + inheritance fallback; `PUT`
  link-config endpoint; execution sizing picks the right per-account volume/risk;
  `providerPerformanceByAccount` snapshot shape. (Per-account `providerPerformance(accountId)`
  isolation may already be covered — extend if not.)
- `apps/web/src/App.test.tsx`: adapt to embedded `BrowserRouter` (happy-dom provides
  `window.history`); update nav/tab/account-visibility assertions to drive via routes. Add a
  `ProvidersTable` overview-vs-account-mode test.
- Run `bun run typecheck`, `bun run lint`, `bun test`.

## Critical files

- `apps/api/src/app.ts` — link `config_json` migration (via `ensureColumn`), `providerConfig`,
  `saveProviderConfig`, approve/execution loops, snapshot, config + link endpoints.
- `apps/web/src/main.tsx`, `apps/web/src/App.tsx` — router + route-driven state.
- `apps/web/src/components/Sidebar.tsx`, `WorkspaceTabs.tsx`, `ProvidersTable.tsx`,
  `ProviderConfigModal.tsx`; `apps/web/src/pages/ProvidersPage.tsx`, `TelegramSetupPage.tsx`.
- `apps/web/src/lib/api.ts` — `DashboardSnapshot` type.
- Tests: `apps/api/src/api.test.ts`, `apps/web/src/App.test.tsx`.

## Verification

1. `bun run typecheck && bun run lint && bun test`.
2. `bun run dev:api` + `bun run dev:web`; with two accounts both copying KAL VIP:
   - `/` overview shows aggregated stats + read-only chips, no actions.
   - `/accounts/54870107/providers` shows **that** account's stats + a single Copy toggle;
     `/accounts/63442826/providers` shows **different** stats.
   - Set a different lot for KAL VIP per account; approve a signal; confirm each account's
     queued order uses its own volume/risk.
   - Reload a deep link (`/accounts/63442826/history`) — restores via SPA fallback.
   - Toggle copy off for one account → it stops being a target.
3. Confirm global enable/pause + remove still work from Telegram Setup.
