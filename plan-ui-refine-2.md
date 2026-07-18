# Plan: Dither the Summary sparklines + sidebar clarity

Iterative polish on branch `feat/white-ui-redesign` (currently 1.21.1). Visual-only. Follows the
colour-accents principle: monochrome chrome; colour in data-viz / notifications / status, gated by
the `useColorAccents()` toggle (default on). Delegation: implement Codex `gpt-5.6-terra` high;
review Codex `gpt-5.6-sol` medium. Gate: `bun run typecheck && bun run lint && bun test && bun run
build` all green. Optional 1.21.2 patch changelog line.

## Part 1 — Dither the Summary trend + sparklines
Today the Summary "Recent trend" and KPI/provider mini-charts use the pure-SVG `Sparkline`
component (looks "old" vs the dither-kit growth chart). dither-kit's own `sparkline.tsx` was
deleted as unused, so DON'T rely on it — render a compact dither-kit `AreaChart` instead.
- Add a small reusable `DitherSparkline` wrapper around `@/components/dither-kit/area-chart`'s
  `AreaChart` in a decorative mode: `interactive={false}`, no `XAxis`/`YAxis`/`Grid`/`Tooltip`,
  tight `margins`, small fixed height, a single `<Area variant="gradient">`. Colour via the shared
  `chartPalette` gated by `useColorAccents()` (palette colour when ON, neutral ink when OFF).
- Replace the Summary "Recent trend" in `SummaryPanel.tsx` (currently `<Sparkline>`) with
  `DitherSparkline` — this is the prominent, wide chart the operator pointed at; it MUST get the
  dithered fill so the app reads as one chart language.
- KPI card sparklines (`AccountHeader.tsx`) and the provider-health sparkline
  (`ProviderHealthCard.tsx`): switch to `DitherSparkline` too IF multiple simultaneous instances
  stay smooth (dither-kit uses canvas + motion + d3 per instance). If several tiny instances cause
  jank, KEEP the fast SVG `Sparkline` for those small strips and just keep their colour consistent
  with the palette/toggle. State which you dithered vs kept SVG and why.
- Keep the SVG `Sparkline` component in the tree as the lightweight / OFF-mode fallback.
- Guard the happy-dom test env as the growth chart already is (ResizeObserver + canvas fallback);
  don't let new dither instances crash tests.

## Part 2 — Sidebar: bigger + clear active/inactive status
- WIDEN: `app-shell` grid `grid-template-columns: 200px minmax(0,1fr)` (base.css:56) → ~232px (and
  reconcile the responsive override near base.css:2172). This reduces account-label truncation
  ("XM-…", "MT5…") and lets the pane breathe. Keep it a single column; don't break the layout.
- STATUS CLARITY (the core ask). Account/slot status is rendered as `.sidebar-child-dot.ok/.off/
  .pending` (Sidebar.tsx:111,134) but these are NOT wired to the colour toggle, so they stay
  monochrome even when colour is ON — fix that AND make the states obvious:
  - Colour when colour-accents ON via `:root[data-color-accents="on"] .sidebar-child-dot.ok {…}`:
    online = green (`--up`), offline = red (`--down`), pending slot = amber (`--warn`). This alone
    fixes the operator's "monochrome even with colour on" complaint (default is ON).
  - Make the states unambiguous in BOTH modes with distinct SHAPES/ICONS (colour-blind safe):
    online = filled dot, offline = hollow ring (or muted), pending slot = a distinct icon (e.g.
    lucide `Link`/`Hourglass`) rather than a plain square. Slightly larger dots + a touch more row
    padding for legibility (`.sidebar-child` ~7px already).
  - Decision: status is operational health → colour whenever colour-accents is ON (default), clear
    shapes when OFF. (If the owner later wants colour forced even in monochrome mode, it's a
    one-line change — note it, don't do it now.)
- Keep all nav behavior, selection, held-count badge, a11y (aria-current, titles) intact.

## Approval criteria
- Summary "Recent trend" renders a dithered gradient fill matching the Performance growth chart;
  colour follows the toggle; monochrome mode is neutral (no leak).
- Sidebar is visibly wider with less label truncation; account/slot status is obvious at a glance —
  coloured green/amber/red when colour ON, distinct shapes when OFF.
- No perf jank from dither instances; tests green (`typecheck && lint && test && build`).
