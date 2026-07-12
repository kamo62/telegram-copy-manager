# Plan: Clean white UI redesign + dither-kit charts

Visual-only re-skin of apps/web toward a clean, minimal, monochrome white dashboard
(reference: a light SEO-analytics dashboard the owner shared), plus replacing the uPlot
charts with dither-kit ordered-dither charts. No IA, copy, routing, or behaviour changes.

## Decisions (from the owner)
- Accent: NEUTRAL / MONOCHROME. Near-black (ink) is the only "accent" — primary buttons,
  active nav, selected states. No colored brand accent (no blue, no orange). Keep green up
  / red down for deltas only.
- Charts: ADOPT dither-kit NOW. Replace the main growth chart with dither-kit's ordered-
  dither area fill; use it for sparkline/donut too where clean.

## Delegation
- Implement: Codex CLI, model `gpt-5.6-terra`, reasoning effort `high`.
- Review the changes: Codex CLI, model `gpt-5.6-sol`, reasoning effort `medium`.
- Gate after implementation: `bun run typecheck && bun run lint && bun test && bun run build`.
- Branch: new branch `feat/white-ui-redesign` off current HEAD. Do not push. Do not bump
  the app version for a visual-only change unless a dependency addition (dither-kit)
  warrants a minor bump — if so, bump to the next minor and add a changelog entry.

## Target aesthetic (what "clean white" means here)
- Page background: cool light gray (~#F6F7F9), not the current warm off-white.
- Cards/panels: pure white, 1px hairline gray border, ~12px radius, little or no shadow
  (borders carry separation, not drop shadows). Generous internal padding.
- Typography: near-black headings, muted gray secondary text; small UPPERCASE, letter-
  spaced, muted section labels (the reference's "ANALYTICS", "EDIT", "MANAGE" style).
  Keep Geist. High readability, clear hierarchy.
- Active nav: light gray fill + near-black icon/text (no colored tint).
- Segmented/range control: black selected pill with white text; unselected plain muted text.
- Stat cards: small icon + UPPERCASE label, large bold number, green up-delta with arrow.
- Deltas: green up, red down. Everything else neutral.
- Dark theme is a NON-GOAL for this pass. The luna audit confirmed there is NO dark theme
  today: tokens.css is `color-scheme: light` only with no `@media (prefers-color-scheme:
  dark)` / `[data-theme="dark"]` override anywhere. The reference and target are light/white,
  so we ship light-only. Do not add dark-mode work now; a dark override can be a later pass.

## Workstream 0 — Theming-consistency fixes (from luna audit)
Verdict: the codebase is mostly token/base.css-driven (no Tailwind utility drift in TSX),
but it is NOT consistently token-driven — ~193 raw-color lines in base.css plus several
components with hardcoded colors or classes that have no CSS rule at all. These must be
tokenized during the re-skin or they simply will not respond to the token remap. Fix, in
priority order:
1. `components/CommandPalette.tsx:72-114` — 9 classes with NO matching CSS rule
   (`.command-palette-overlay/.command-palette/.command-palette-input/.kbd-hint/.command-
   list/.command-empty/.command-label/.command-shortcut` + unscoped `active`). Style via
   `.modal-overlay`/`.modal` + new tokenized base.css rules. (Currently effectively unstyled.)
2. `components/ConfirmDialog.tsx:62-76` — `.modal-confirm/.modal-body/.confirm-dialog-
   description/.confirm-dialog-type-to-confirm/.input` have no rules; add a tokenized
   `.modal-body` and reuse `.settings-input` for the confirm field.
3. Shared modal CSS not token-safe: base.css:5262 `rgba(15,23,42,0.35)`, :5275
   `rgba(15,23,42,0.18)`, :6338, :6354 — replace with an overlay token + `var(--panel)` +
   `var(--shadow-3)`.
4. `components/GrowthChart.tsx:66-99` — 8 raw uPlot colors (#9ca3af, #5046e5, #ef4444, …).
   Moot if replaced by dither-kit (WS3); if any uPlot chart survives, drive it from token-
   backed CSS vars (`--ink-3`, `--line`, `--up`, `--down`).
5. `components/AccountHeader.tsx:54-56` + `AccountsOverview.tsx:24-25` hardcode cobalt
   `hsl(218 85% 42%)` and violet `hsl(265 70% 50%)` — decorative, not semantic; collapse to
   neutral tokens under monochrome. `Donut.tsx:106` inline `backgroundColor` → token var.
6. One-off unstyled classes → reuse existing: `.attribution-trades-table`
   (PerformancePage:350), `.account-thresholds-table` (SettingsPage:483), `.providers-table`
   (ProvidersTable:100), `.symbol-mappings-table` (SymbolMappingsTable:25) → `.data-table`;
   `.sr-only` (AccountsOverview:101) → existing `.visually-hidden` (base.css:2626);
   `.empty-state-glyph`, `.provider-health-*`, `.skeleton-row` → define tokenized rules or remove.
7. Raw semantic-color groups in base.css to convert to `var(--up*/--down*/--warn*)` and
   neutral tokens for non-semantic blue/violet/amber: lines ~1732-1785, 2020-2070, 2381-2436,
   2515-2610, 3320-3453, 3562-3713, 6462-6547, 6633-6702, 6768-6987, 7009-7243, 7587-7730;
   plus scattered raw white/shadow/blue at 77, 522, 1852, 2289, 5102-5103, 5413, 5614,
   5946-5951, 6227, 6360-6370. IMPORTANT accent-meaning risk: provider attribution
   (PerformancePage) and EA-origin (HistoryPage) are BLUE-coded for meaning — under
   monochrome, re-encode that meaning without relying on blue (label/weight/icon, or a
   single neutral-dark emphasis), do not just silently drop it.
8. `App.tsx:1268` uses native `window.confirm` — replace with the shared `ConfirmDialog` so
   it is themed (also fixes an inconsistency).
Standardize methodology: CSS custom properties + semantic base.css classes for every surface
and dialog; no raw colors, no inline color/background; Tailwind (if used later) limited to
mapped tokens.

## Workstream 1 — Design tokens (apps/web/src/styles/tokens.css)
This is the core lever; the app is token-driven so most of the re-skin lands here.
- Surfaces: `--bg` → cool light gray (e.g. `hsl(220 16% 97%)`); `--bg-elevated`/`--panel`
  → `hsl(0 0% 100%)`; `--panel-2` → `hsl(220 16% 96%)`; `--panel-hover` → `hsl(220 14% 94%)`.
- Lines: `--line` → `hsl(220 15% 90%)`; `--line-strong` → `hsl(220 13% 84%)`;
  `--line-subtle` → `hsl(220 16% 94%)` (crisp cool hairlines, not warm).
- Accent → monochrome: `--accent`/`--accent-9`/`--accent-10`/`--accent-dim` → near-black
  ink (`hsl(220 25% 12%)`); `--accent-soft` → `hsl(220 14% 92%)` (light gray fill for
  active/hover); `--accent-ring` → `hsl(220 20% 40% / 0.25)` for focus rings on white.
- Keep `--up`/`--down`/`--warn` families; only cool the neutrals.
- Shadows: flatten `--shadow-1/2/3` toward near-zero (keep only a whisper on true overlays
  like modals/toasts/command palette so they lift off the page). Borders do the rest.
- Verify all downstream `var(--accent*)` usages now read as monochrome and nothing depends
  on the accent being blue for meaning (e.g. don't let a blue-coded status vanish).

## Workstream 2 — Component polish (apps/web/src/styles/base.css)
base.css is 7,800 lines and CASCADE-ORDER-SENSITIVE: duplicated rule blocks mean later
selectors win (known repo gotcha). Edit rules in place at their existing location; do NOT
append a second competing block for a class that already has one. Touch these classes:
- Sidebar: `.sidebar`, `.sidebar-group`, `.sidebar-child` — grouped UPPERCASE section
  labels; active child = light gray fill + near-black icon/text; remove colored active tint.
- Stat cards: `.kpi`, `.kpi-head`, `.kpi-label`, `.kpi-amount`, `.kpi-delta`,
  `.kpi-delta-up/-down`, `.kpi-badge*` — flat white, thin border, uppercase label + icon,
  large number, green up-delta. Neutralize the colored kpi-badge variants toward subtle
  gray chips (keep semantic up/down/warn where it carries meaning).
- Segmented/range: `.segmented-control`, `.kpi-window-toggle`, `.chart-toggle`,
  `.panel-tabs`/`.panel-tab` — black selected pill, plain unselected.
- Surfaces: `.panel`, `.chart-card`, `.statistics-card`, `.card*` — white, 1px border,
  flat, ~12px radius.
- Tables: `.data-table` — clean header row, hairline row borders, comfortable row height,
  right-aligned numerics stay mono.
- Buttons: `.btn-primary` near-black solid + white text; `.btn-ghost` white with 1px
  border; `.btn-small`, `.btn-danger`, `.btn-destructive-subtle` stay semantic but flat.
- Focus: ensure `:focus-visible` rings are visible on white surfaces everywhere (uses
  `--accent-ring`).
- Do not restructure DOM; only restyle. Keep all class names so component TSX is untouched
  except where a chart swap forces it.

## Workstream 2b — Typography & sharpness (crispness)
The app already has good typographic hygiene — KEEP it: `-webkit-font-smoothing: antialiased`
+ `text-rendering: optimizeLegibility` (base.css:13-15), Geist stylistic sets ss01/cv11/cv05,
`tabular-nums slashed-zero` on numerics, letter-spacing tracking (~86 rules), weights
400/500/600/700. This workstream is tuning + crispness, not a rebuild.

Sharpness (dominant lever is flat borders, NOT text):
- Replace card/panel drop shadows with crisp 1px SOLID hairline borders (`var(--line)`);
  reserve shadow for true overlays only (modals, toasts, command palette). This is the main
  reason the reference reads "sharp" vs the current soft-shadow cards. (Same change as the
  WS1 shadow flatten — called out here as the sharpness driver so it is not treated as
  merely cosmetic.)
- Use solid (non-alpha) hairline borders so edges land on a crisp device pixel instead of a
  blurred semi-transparent line; verify 1px holds at common DPRs.
- Raise text contrast on the new white surfaces: headings `--ink`, primary body `--ink-2`,
  meta `--ink-3`; set a readability floor (no meaningful text lighter than `--ink-3`). The
  monochrome direction increases perceived sharpness because text runs darker/higher-contrast.
- Crisp `:focus-visible` rings and consistent radii; snap dividers/borders to hairlines.
- Evaluate deliberately (display-dependent, do NOT flip globally without a side-by-side):
  whether keeping `antialiased` (thins text) or allowing default smoothing gives the
  reference's slightly heavier, sharper text on white. Default: keep antialiased.

Typography tuning to match the reference:
- One consistent section-label treatment across `.sidebar-group`, `.kpi-label`, card
  section titles: small, UPPERCASE, muted (`--ink-3`), tracked (~0.04-0.06em).
- Stat numbers (`.kpi-amount`): heavier weight (700), tight tracking, tabular-nums so
  columns align crisply.
- Clear hierarchy: heading (`--ink`, 600) / body (`--ink-2`, 400-500) / meta (`--ink-3`);
  keep tabular-nums + slashed-zero on all financial numerics and tables; keep mono for
  numeric/code contexts.

## Workstream 2c — Concrete text/cleanliness spec + monochrome meaning (from sol review)
Exact targets (sol review is file:line-anchored; apply it directly):
- THREE-TIER TYPE SYSTEM. Micro-labels (`.sidebar-group > button`, `.kpi-label`,
  `.statistics-card dt`, `.data-table thead th`, section eyebrows): `--fs-1` (11px), 600,
  UPPERCASE, `letter-spacing:0.06em`, `--ink-3` — one treatment, kill the 10-11px/0.03-0.06em
  drift. Card/chart titles: `--fs-6` (19px), 600, sentence-case, `--ink`; page titles
  `--fs-7` (24px)/600. Body/subtitles: 14px/400, `--lh-normal`, `--ink-2`; meta 12px/`--ink-3`.
- TWO REAL BUGS TO FIX: (a) `.panel > header h2` (base.css ~1018-1036) is a real card title
  currently forced to 11px uppercase muted — restore it to 16-19px/600 sentence-case `--ink`,
  keep uppercase only for actual eyebrows/field labels (Panel.tsx:19-21). (b)
  `.kpi-label-currency` (base.css:5884) references nonexistent `--ink-muted` (invalid) → use
  `--ink-3`.
- READABILITY FLOOR: no meaningful text lighter than `--ink-3` (46% L); raise all content
  currently on `--ink-faint` (62% L) to `--ink-3` — `.chart-card-meta`, `.statistics-card dt`,
  `.data-table thead th`, `.data-table-subtle`, `.modal-section-help`, `.summary-panel-hint`,
  attribution labels. Target WCAG AA 4.5:1 for normal text.
- BIG NUMBERS: `.kpi-amount` 18px/600 → 24px (`--fs-7`)/700/`-0.02em`; `.kpi-primary
  .kpi-amount` 22px → 32px (`--fs-8`); same hierarchy for `.attribution-kpi-value` (20→) and
  `.accounts-overview-stats strong` (16→); keep mono + `tabular-nums slashed-zero`.
- CLEANLINESS. Flatten primary surfaces to `background:var(--panel); border:1px solid
  var(--line); border-radius:var(--radius-3); box-shadow:none`. The shadows live in LATE
  cascade blocks that win — EDIT THOSE IN PLACE (cascade gotcha), not a new override:
  `.panel`/`.metric-card` ~6194-6199, `.account-header` (gets `--shadow-2`) ~6225-6242; also
  `.statistics-card`, `.chart-card`, `.data-table-wrap`, `.attribution-*`, `.summary-panel`.
  Keep shadow ONLY on true overlays: `.modal`, `.toast`, `.resolve-menu-popover`. Remove the
  `.data-table thead` fake `box-shadow:0 1px 0` (winning block ~6280), rely on its border.
- NORMALIZE: card radius → 12px (`--radius-3`) everywhere (kill 8px/10px mixes); primary card
  padding → 24px (`--space-5`), 20px only where 4-col KPI can't fit; loosen `.workspace`
  gap/padding 12→24px, `.content-grid`/`.account-kpis` 10-12→16px; table rows 10px 12px →
  12px 16px; right-align `.exposure-table` numeric cols 2-4 with tabular treatment.
- SEGMENTED/TABS: `.active` for `.panel-tab`, `.chart-toggle button`, `.segmented-control
  button`, `.performance-mode-tabs button`, `.kpi-window-toggle button` →
  `background:var(--ink); color:var(--panel); box-shadow:none`; pill radius on track+selected;
  unselected `--ink-dim`.
- BUTTONS: `.btn-primary` flat near-black, no resting/hover shadow; `.btn-ghost` white + 1px
  `--line` border; radius 8px (`--radius-2`).
- SIDEBAR: remove the extra active indicator bar (base.css ~912-923); active = `--panel-2`
  fill + `--ink` (parent + child); `.sidebar-child` padding 5→7px, text 11→12px/`--ink-2`.
  Remove decorative gradients (`.account-platform-card*`) and status-bar glass/blur/shadow.
- PRESERVE MEANING UNDER MONOCHROME (critical — do NOT just drop color that carries meaning):
  sidebar status dots (online/pending) → neutral filled/hollow/pulsing SHAPES, not green/amber;
  donut account slices → monochrome dither/pattern variants + explicit legend labels;
  attribution categories → neutral chrome, identity via existing text labels; buy/sell,
  source/origin, held rows, provider-health → neutral + existing text/icon; operational alert
  banners → severity via border weight + icon shape, not colored fills; keep `--up`/`--down`
  ONLY for actual signed financial deltas. Map cobalt `--accent*` AND Telegram-blue tokens to
  neutral ink (no blue sign-in chrome); neutralize KPI badge blue/violet/emerald/amber/rose.
- SOL PUNCH-LIST ORDER: (1) tokens first, (2) three-tier type system + raise faint text +
  enlarge KPI numerics, (3) flatten/unify surfaces, (4) segmented/tab black pills + sidebar
  active, (5) spacing/radius + table rows + exposure align, (6) remove all non-delta color.

## Workstream 3 — Charts: adopt dither-kit
Current charts use uPlot: `apps/web/src/components/GrowthChart.tsx`,
`Sparkline.tsx`, `Donut.tsx` (confirm exact set). dither-kit is a no-dependency ordered-
dither charting lib (area/bar/pie/radar, recharts-style children-as-config API, installed
via `npx shadcn@latest` which vendors component source into the repo).
- Install dither-kit the way its docs specify; INSPECT the actual installed API (the docs
  site is a client-rendered SPA, so read the vendored source / package README after
  install). Report the exact install path used (shadcn-vendored vs npm) and where files land.
- Confirm compatibility with this stack: Bun + Vite 7 + React 19 + Tailwind 4 + TS strict
  (`noUncheckedIndexedAccess`). If shadcn needs a `components.json`, add a minimal one
  scoped so it does not fight the existing Tailwind 4 setup.
- Replace GrowthChart (the primary equity/time area chart) with a dither-kit area chart:
  ordered-dither gradient fill, entrance animation and scrub tooltip if cheap, mapping the
  existing series (equity, drawdown) and x-axis buckets. Match the new monochrome chrome;
  the dither fill may keep a restrained green/teal like the reference or a neutral ink ramp
  — pick what reads cleanly in BOTH light and dark.
- Sparkline → dither-kit area/line and Donut → dither-kit pie ONLY if the swap is clean and
  keeps the existing props/behaviour; otherwise leave them on uPlot and just restyle to the
  new palette. State which you swapped.
- Test env: tests run under happy-dom with no real canvas. Guard chart rendering so tests
  don't crash (mirror how uPlot is currently guarded/mocked in the test setup); add a mock
  if needed. Do not let the chart swap break existing component/page tests.
- Only remove the `uplot` dependency if it is fully unused after the swap; otherwise keep it.

## Scope guardrails
- Visual + chart-engine only. No routing, IA, copy, data, or business-logic changes.
- Keep every route, component, and test working. Update DOM/snapshot assertions only where
  the chart swap necessarily changes markup.
- Accessibility: monochrome text must meet WCAG AA contrast on the new surfaces; focus rings
  visible on white; do not rely on color alone for up/down (arrows already present).

## Approval criteria
- The dashboard reads as the reference: cool-gray page, flat white hairline-bordered cards,
  UPPERCASE muted section labels, black selected segmented pill, green deltas, near-black
  primary actions, no blue/orange brand accent.
- dither-kit area chart renders the ordered-dither fill and is legible in light AND dark.
- `bun run typecheck && bun run lint && bun test && bun run build` all green; no console
  errors; keyboard focus visible on white.

## Verification
1. Run the full gate.
2. Drive the dev app (`bun run dev:web` + `bun run dev:api`): confirm sidebar grouping +
   active state, a stat-card row, the range segmented control, the growth chart's dither
   fill, one data table, and one modal against the target aesthetic in both light and dark.
