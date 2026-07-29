# SPEC — rebuild the console to the 2026-07-29 design

Supersedes the earlier version of this file, which targeted the older console artifact. The owner
has replaced the target with a new design, supplied as a working HTML mockup of the Settings screen.
That mockup is the ground truth. Where this document and the mockup disagree, the mockup wins.

This is **not** the polish pass the previous spec described. The token vocabulary, the Settings
layout and four components are new.

## Decisions already taken (do not reopen)

1. **The new design replaces the console artifact as the target.** `REVIEW-ui-fidelity.md` and its
   findings describe the old target and are now historical. Do not work from them.
2. **The new tokens are canonical.** Old names become aliases that resolve to the new ones, so
   existing CSS keeps working while the vocabulary converges. Do not run a find-and-replace across
   `base.css`, and do not leave two independent palettes.
3. **The dirty-state save bar is specified for Settings only in this pass.** Build it as a reusable
   component; do not retrofit it to other forms yet.

## Design tokens (authoritative)

Add these as the canonical layer. Keep `--space-*`, `--fs-*`, `--radius-*` and the existing motion
tokens as they are.

```
--font-ui    "Inter", -apple-system, "Segoe UI", Roboto, sans-serif
--font-mono  "JetBrains Mono", "SF Mono", "Cascadia Code", Consolas, monospace
--radius-sm 6px   --radius-md 10px   --radius-lg 14px
--accent #4f7cff   --accent-strong #3b63e8   --accent-soft rgba(79,124,255,0.12)
--ok #2fbf71       --warn #e8a13c            --danger #e5534b
--dur 160ms
```

Dark (`[data-theme="dark"]`):
```
--bg-app #0c0e12   --bg-shell #101318   --bg-panel #14181f
--bg-panel-raised #1a1f28   --bg-input #0e1116
--bg-hover rgba(255,255,255,0.045)
--border rgba(255,255,255,0.08)   --border-strong rgba(255,255,255,0.14)
--text-1 #eef1f6   --text-2 #9aa3b2   --text-3 #626b7a
--ok-soft rgba(47,191,113,0.14)  --warn-soft rgba(232,161,60,0.14)  --danger-soft rgba(229,83,75,0.14)
--shadow-card 0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 24px rgba(0,0,0,0.28)
--topbar-blur rgba(12,14,18,0.82)
```

Light (`[data-theme="light"]`):
```
--bg-app #f4f6f9   --bg-shell #ffffff   --bg-panel #ffffff
--bg-panel-raised #f8fafc   --bg-input #ffffff
--bg-hover rgba(15,23,42,0.045)
--border rgba(15,23,42,0.10)   --border-strong rgba(15,23,42,0.18)
--text-1 #131722   --text-2 #5b6472   --text-3 #8a93a3
--ok-soft rgba(47,191,113,0.14)  --warn-soft rgba(232,161,60,0.16)  --danger-soft rgba(229,83,75,0.13)
--shadow-card 0 1px 2px rgba(15,23,42,0.05), 0 4px 16px rgba(15,23,42,0.05)
--topbar-blur rgba(244,246,249,0.85)
```

Map the existing vocabulary onto these: `--ink`→`--text-1`, `--ink-2`/`--ink-dim`→`--text-2`,
`--ink-3`/`--ink-faint`→`--text-3`, `--line`→`--border`, `--bg`→`--bg-app`,
`--bg-elevated`/`--panel`→`--bg-panel`. Verify each mapping against actual usage before aliasing;
where a name is used for two different purposes, split it rather than forcing one alias.

## Layout

- Shell: `grid-template-columns: 264px 1fr`, full viewport height.
- Content column: `max-width: 880px`, centred, `padding: 36px 32px 120px`. Currently full-width.
- Top bar: 56px, `backdrop-filter: blur(12px)` over `--topbar-blur`.
- Settings sections: `grid-template-columns: 260px 1fr; gap: 32px; padding: 28px 0;` separated by
  `border-top: 1px solid var(--border)`. Left rail carries the section title and description; right
  carries the controls. This replaces the current icon-chip-above-full-width-form arrangement.

## New components

Build each as a reusable component with tests, not as one-off markup.

1. **Switch** — 38x22 track, 16px knob, `--accent` when on, `translateX(16px)`. Replaces the
   Colour accents checkbox. Needs `role="switch"` and `aria-checked`.
2. **NumberField** — bordered wrapper, mono input, unit suffix ("lots", "%", "pips"), and a stacked
   stepper pair on the right. `:focus-within` gets `border-color: var(--accent)` and a 3px
   `--accent-soft` ring. Steppers honour per-field `step` and `min` and preserve decimal places.
   Replaces native number inputs on Settings.
3. **ThresholdBar** — 10px gradient track (ok → warn → danger) whose stops are driven by the warn and
   danger values, pins at each threshold, and a 0–25% labelled scale. Tags above show the live values.
   It must react as the inputs change.
4. **SaveBar** — fixed to the bottom of the content area, `left: 264px`, hidden until the form is
   dirty, sliding up on `translateY(80px) → 0` over 240ms. Carries a pulsing amber dot, "Unsaved
   execution changes", a Discard and a Save. Save also fires the existing toast.

Dirty tracking compares current values against the values loaded from the server, and Discard
restores them. The page-head Save button is disabled until dirty.

## Segmented control

Light/Dark pair with icons, `--bg-input` track, active pill on `--bg-panel-raised` with a 1px border
and a subtle shadow. The existing theme toggle in the top bar stays and must stay in sync with it.

## Scope

**Every route, to full fidelity.** Not the shell and palette with old interiors underneath.

Settings first, because it is the screen the mockup specifies and it exercises every new component.
Then `/` `/logs` `/providers` `/symbols` `/telegram` `/history` `/performance` `/equity-guardian`,
each brought to the same standard: the new token layer, the 880px centred content column, hairline
`--border` separation, `--radius-lg` cards on `--bg-panel` with `--shadow-card`, mono figures with
`font-feature-settings: "tnum"`, `--text-1/2/3` hierarchy, and the new controls wherever their
equivalents appear.

Apply the new components by kind, not by page. Anywhere a route has a numeric input, it becomes
NumberField. Anywhere it has a boolean, it becomes Switch. Anywhere it has an editable form with a
save action, it gets dirty tracking and the SaveBar. Anywhere it has a two-or-three-way choice, it
becomes the segmented control. Tables, ledgers and charts keep their structure but adopt the token
layer, the card treatment and the type hierarchy.

Where a route has no direct analogue in the mockup, derive the treatment from the tokens and the
patterns above rather than inventing a new idiom, and say in your report what you derived and why.

This is a large pass. Work route by route, verify each before moving on, and report per route. Do not
batch all eight and verify at the end.

Presentation only. Do **not** change anything under `apps/api/`, `packages/core/` or `mt5/`.

## Hazards that have each produced a bug in this repo

1. **`base.css` has duplicated top-level blocks and the later one silently wins.** ~8,600 lines.
   Grep every occurrence of a selector before editing and change the one that actually applies. The
   lint gate has a duplicate-block guard; keep it green.
2. **Panel inset and padding depend on a DIRECT-CHILD relationship** — `.panel > *:not(header)` in
   `base.css` and the `margin-inline` group at `signal-desk.css:630`. Adding a wrapper element inside
   a panel silently strips inset and padding from everything below it. A wrapper added on 2026-07-28
   did exactly this.
3. **Measure, do not eyeball.** Two bugs shipped because rendered boxes were never measured, and a
   third because an audit only measured a collapsible panel while collapsed, where no body renders.

## Verification (required)

Run the app locally against a copy of the live DB so pages are populated:

- DB copy: `/private/tmp/claude-501/-Users-kamogelo-Code-telegram-tc/44c4a40d-4a25-459e-8e48-36090b77dd29/scratchpad/audit.db`
- API: `DATABASE_PATH=<path> TELEGRAM_ADAPTER=mock PORT=8787 bun apps/api/src/server.ts`
- Web: `bun run dev:web` (5173, proxies to 8787). **Always** override `TELEGRAM_ADAPTER=mock`.
- The app is a React Router SPA; synthetic `pushState` does not drive it. Click the real sidebar and
  `.workspace-tab` buttons.

For every route, in **both themes** at **1600px and 560px**:

1. Every content child of a `.panel` shares left and right edges; none overruns its parent;
   `document.scrollWidth <= innerWidth`.
2. Measure **both states** of anything collapsible or toggleable.
3. Report the measured numbers, not an assurance that it looks right.

For Settings specifically, demonstrate: dirty tracking raises the save bar, Discard restores the
loaded values, the threshold bar tracks the inputs, and both themes render correctly.

## Gate

`bun run typecheck`, `bun run lint` (zero warnings; the baseline has none), `bun test` (635 at
`892e8a14`, report the exact count), `bun run build`.

`AccountHeader > shows honest stale state and exposes account actions` is a known pre-existing flake:
times out under full-suite load about 1 run in 5, passes in isolation. Do not chase it, and do not let
it mask a real failure you introduced.

## Reporting

State the token mapping you chose and any name you had to split. Per route: what changed and the
measured edges in both themes and both widths. Flag anything you could not verify rather than
asserting it works. Do not commit.
