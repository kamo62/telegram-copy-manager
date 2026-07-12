# Plan: Colour-mode toggle + top-bar cleanup

Iterative polish on the monochrome white redesign (branch `feat/white-ui-redesign`, at 1.20.0)
from operator feedback on the running demo. Instead of hardcoding "colour vs monochrome", add a
Settings toggle so the operator chooses. Also clean up the top bar.

## Core idea: a colour-mode preference
One boolean UI preference, "Colour accents" (default ON), toggled from the Settings page:
- ON  → colour appears ONLY where it carries meaning: signed financial deltas (already), DATA
  VISUALIZATION (charts), and SEVERITY/STATUS (notifications, status dots).
- OFF → the current fully-monochrome look (colour limited to signed deltas only).
Chrome (surfaces, nav, cards, typography, spacing) stays monochrome in BOTH modes — the toggle
only affects charts, notifications, and status dots. It never restyles layout.

## Mechanism (flash-free, reactive)
- Persist the preference in `localStorage` (key e.g. `ttc:colorAccents`, default `true`).
- In `apps/web/src/main.tsx`, read it SYNCHRONOUSLY before first render and set a root attribute
  `document.documentElement.dataset.colorAccents = "on" | "off"` so CSS-driven parts (notifications,
  status dots) never flash.
- Provide a small React context/hook (`useColorAccents()`) holding the boolean + a setter that
  writes localStorage AND updates the root attribute. Charts (JS-driven colour) read the hook so
  they re-render with the right palette when toggled — no page reload.
- Settings page renders the toggle; flipping it updates context → attribute → charts live.
- Keep it CLIENT-SIDE (display preference, per-browser). Do NOT add it to server `app_settings`.

## Delegation
- Implement: Codex CLI `gpt-5.6-terra` effort `high`.
- Review: Codex CLI `gpt-5.6-sol` effort `medium`.
- Gate: `bun run typecheck && bun run lint && bun test && bun run build` (all green).
- Visual-only; optional minimal changelog line under 1.20.0 or a 1.20.1 patch entry.

## A. Charts (gated on colour-mode)
- Define the chart palette ONCE (a shared TS constant / CSS vars): a small, muted, cohesive
  categorical set (3-5 hues) plus a growth colour and the drawdown red. One source of truth used
  by growth, source/attribution bars, donut, sparkline — no per-component literals.
- `GrowthChart.tsx` (~90-116): when colour ON, growth series uses a calm data colour (teal/green
  or blue that reads on white); when OFF, `grey`. Drawdown stays `red` in both. Keep
  `variant="gradient"` + restrained bloom.
- P/L-by-source / attribution bars (`PerformancePage.tsx`) and account donut
  (`AccountsOverview.tsx`/`Donut.tsx`): colour ON → the categorical palette; OFF → current
  monochrome dither/pattern. Legends/labels stay in both modes so series remain distinguishable
  even in monochrome.

## B. Notifications + status dots (gated on colour-mode, CSS-driven)
- Toasts (`base.css` ~7418 `.toast`, ~7446/7452 `::before`; `ToastContext.tsx`), alert banners
  (`AlertsBanner.tsx`), activity rows (`base.css` ~7558-7571): when colour ON, restrained severity
  colour — success=green, error=red, warn=amber, info=blue — as colcoured icon + coloured left
  accent border + subtle tint (NOT loud full fills). When OFF, keep the current neutral ink border
  + glyph. Gate with `:root[data-color-accents="on"] .toast-error { … }` style selectors so both
  modes coexist. Reuse `--up/--down/--warn`; add `--info` if missing.
- Top-bar status dots (DB/TG): colour ON → green/amber/red per state; OFF → neutral. (Status is
  meaningful, so it follows the same toggle.)

## C. Top-bar cleanup (`StatusBar.tsx` + `.status-bar` styles) — applies in BOTH modes
- Demote the `Version` tag out of the always-on strip (tooltip on brand, or tiny muted far-right,
  or Settings). Not operator-critical.
- Resolve the redundant DUAL time: keep "Last sync" prominent (data freshness); drop / strongly
  de-emphasize the ticking UTC clock.
- Tighten into three zones: brand (left) · compact status cluster · actions (far right); one
  consistent chip style, consistent muted labels; single clean row.
- Status dots pick up colour per the toggle (part B). Preserve ALL affordances (refresh, command
  palette, live/poll-error signaling) and a11y labels/roles/aria-live.

## Scope guardrails
Visual-only. No IA/routing/data/behavior changes. Chrome monochrome in both modes. Keep tests
green; update assertions only where markup necessarily changes. Add a test for the toggle
(default on; flipping sets the root attribute / persists) and that charts/notifications read it.

## Approval criteria
- Settings has a working "Colour accents" toggle (default ON), persisted, flash-free on reload.
- ON: growth/source/donut charts show restrained cohesive colour, notifications + status dots
  show severity colour; drawdown red both ways. OFF: fully monochrome as today.
- Toggling live updates charts (no reload) and notifications/status (via root attribute).
- Top bar reads cleaner: version demoted, single time reference, tight three-zone grouping;
  all actions + a11y intact.
- `typecheck && lint && test && build` all green.
