# Implementation brief — UI fidelity + IA fixes (2026-07-23)

Branch: `feat/ui-fidelity-and-ia-2026-07-23`. Frontend-first change set with one small additive
backend endpoint. Companion analysis with root causes and file:line refs is in `REVIEW-ui-fidelity.md`
(read it first). Target design = the "Telegram TC — console" / "— desk & account operations" artifacts.

## Locked product decisions (from the owner)
1. **Providers** becomes a dedicated page: aggregated performance + health PLUS provider monitoring
   (enable/pause/remove + default lot/risk/TP). The Telegram page keeps only "dialog list → Add provider".
2. **Account management** lives on the account page via an overflow (▾) menu next to the account header:
   Rename, Remove account, Manage link.
3. **Untracked/external trade** gets "Dismiss from app view" — a client-side soft-hide persisted in
   localStorage (reuse the v1.53.2 dismissed-signals/alerts pattern). It MUST NOT touch the broker.

## Hard constraints
- Work only on the branch above. Do NOT push, open a PR, or deploy.
- Keep `apps/web/FRONTEND_PARITY.md` intact: reorganising is fine, removing a capability is not. Every
  capability that moves must still be reachable and tested.
- Token-driven only: no raw hex/hsl in components; use `tokens.css` semantic vars. Reserve `--unknown`
  (violet) for attribution buckets only — never for offline/stale account state.
- Update `apps/web/src/App.test.tsx` and any page tests whose DOM assertions change (removing the signal
  ledger and moving provider controls WILL break tests — fix them, don't delete coverage).
- Bump the app version (minor) in root `package.json` and `mt5/TelegramTC_EA.mq5` version metadata to
  match, and add a `changelog.md` entry. EA payload contract is unchanged (no recompile).
- Gate before handoff: `bun run typecheck && bun run lint && bun test && bun run build` all green.
- No em dashes in code comments/UI copy; plain direct English.

## Lane A — Operations desk + Telegram page
- **A1.** Remove the Signal ledger from the Operations desk: delete the `<section className="operations-ledger">`
  block (`apps/web/src/pages/OperationsPage.tsx:171`) and any now-unused stage-bar helpers
  (`stageState`, stage-label markup) if they are not used elsewhere. Keep Working orders + account grid +
  provider strip. Update OperationsPage/App tests that assert the ledger.
- **A2.** Telegram page (`apps/web/src/pages/TelegramSetupPage.tsx`): remove the `PROVIDER MONITORING`
  section (tracked providers with Configure/Pause/Remove) from the bottom. The page keeps auth + dialog
  list + per-row "Add provider" only. Those monitoring controls move to Lane B.

## Lane B — Dedicated Providers page
- `apps/web/src/pages/ProvidersPage.tsx` (rendered at `/providers`, all-accounts mode) becomes the single
  provider hub. Add, above/around the existing `ProvidersTable` + `provider-health-strip`, the monitoring
  controls currently on the Telegram page: per-provider **Configure**, **Pause/Resume (enabled toggle)**,
  **Remove**, and default lot/risk/TP (these already exist in `App.tsx`: `toggleProvider` ~1577,
  `removeProvider` ~1590 `DELETE /api/providers/:id`, `configureProvider`/`test-config`). Re-parent the
  handlers via props; do not duplicate logic.
- Keep the per-account Providers tab as-is (per-account copy config). Update the ProvidersPage intro copy
  so the three surfaces read coherently (global hub = performance+health+monitoring; account tab = copy).
- Ensure `/providers` still resolves (it maps through `TAB_IDS` in `App.tsx:parseRoute`); the nav item
  already points here.

## Lane C — Account management on the account page (+ small backend add for Rename)
- **C1 (backend, additive).** Add an account nickname:
  - Migration: add a nullable `nickname` (or `label`) column to the mt5 accounts table.
  - `PATCH /api/mt5/accounts/:accountId` accepting `{ nickname }`; store method `updateAccountNickname`.
  - Surface `nickname` on the account DTO used by the dashboard/sidebar; display it (fall back to account
    number) in the sidebar list, account header, and account cards.
- **C2 (frontend).** Add an overflow (▾) menu by the account header (`AccountHeader.tsx`) with:
  **Rename** (inline field → PATCH), **Remove account** (existing `removeAccount` → `DELETE
  /api/mt5/accounts/:id` at `App.tsx:1608`, behind the shared `ConfirmDialog`), **Manage link** (navigate
  to `/linked-accounts` / open link-slot management). Use the tokenised menu/popover styling (mirror
  `.resolve-menu`/`.resolve-menu-popover`). This makes account delete/rename discoverable without the
  `/linked-accounts` page being the only entry.

## Lane D — Dismiss untracked trade
- On external/untracked rows in the Trade ledger Open view (`OpenPositionsTable`, and the external block in
  `LinkedAccountsPage`), add a per-row "Dismiss from app view" action (overflow or small ghost button).
- Persist dismissed ticket ids in localStorage using the SAME pattern/util as the v1.53.2 dismissed
  signals/alerts; filter dismissed rows out of the external/untracked lists on render. Provide an
  "undo"/"show dismissed" affordance (toast with undo is enough). Never call any broker/close endpoint.

## Lane E — Visual fidelity fixes
- **E1.** Offline/stale account styling → neutral + amber, not violet. In `signal-desk.css`:
  `.operations-account.offline` border `var(--unknown)` → `var(--line)` (attention = `inset 3px 0 0
  var(--warn)`); `.operations-state` badge (offline) → neutral chip (track bg / `--ink-2`), online stays
  `--up`; `.operations-account-issue` stale banner → `--warn`/`--warn-soft`. Keep `--unknown` for the
  attribution `Unknown / EA` bucket only.
- **E2.** Account header contradiction: drive the title from heartbeat instead of the hardcoded "Live"
  (`AccountHeader.tsx:161`); when stale, label "Balance as at HH:MM — not current" (per artifact) and
  SHOW the last-known balance/equity rather than blanking to "—". Stop forcing balance/equity to `null`
  when `performanceIsLive` is false (`App.tsx:1166-1187`) — show last-known (muted is fine), matching the
  Operations desk which already shows them.
- **E3.** Equity curve solid slab: in the dither area chart (`GrowthChart.tsx` + `dither-kit/area.tsx` /
  `dither-paint.ts`), restore the fade-toward-baseline (density/opacity ramp mask like the artifact) and
  ensure the stepped top line stroke renders. For near-flat/short series, floor the visible y-range or clamp
  fill height so it does not paint the whole panel; degenerate x-axis ("0 … 1") should show a clean state.
- **E4.** Settings appearance toggle: `.settings-theme-picker` (`SettingsPage.tsx:121`) has NO CSS rule.
  Style it as the standard black-pill segmented control (selected = `background: var(--ink); color:
  var(--panel)`), matching Growth/Drawdown, Today/Week/Month, Open/Closed.
- **E5.** Default lot size "0,04": `SettingsPage.tsx:165` `type="number"` renders the locale decimal.
  Ensure it round-trips to a dot on save (verify `valueAsNumber`); if fragile, switch to a text input with
  explicit dot parsing/validation so display and stored value agree.
- **E6.** `/review` should redirect to `/logs` (Review queue) instead of silently rendering Operations;
  add a favicon (inline data-URI in `apps/web/index.html`) to kill the 404.

## Acceptance
- All five lanes complete; parity contract still satisfied and tested.
- Full gate green; no console errors in the dev app; keyboard focus visible.
- Verified in both light and dark against the artifacts: no violet on offline state, account header honest
  about stale, equity curve reads like the artifact, Providers is one coherent hub, Telegram is just
  dialogs + add, account ▾ menu works, untracked dismiss hides only in-app.
- Version bumped, changelog entry added, `HANDOFF.md` updated with what shipped and any follow-ups.
