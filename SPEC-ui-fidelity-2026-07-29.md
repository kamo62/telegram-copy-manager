# SPEC — bring every route to the console-artifact fidelity

Owner target, 2026-07-29: every route should match the design target at the fidelity of the
Settings screenshot the owner supplied. This is a polish and correction pass, not a rebuild:
the structure, the light theme and the blue accent already exist.

## Target aesthetic

From the canonical "console" artifact, restated so you do not need to fetch it:

- Dark default plus a toggleable light theme. Accent is **blue** (`--accent`, roughly hsl 212–218).
- Cards: 12px radius, 1px `--line` border. Attention is `inset 3px 0 0 var(--warn)`, an amber left edge.
- Status chips: neutral track background for offline, accent background for online.
- **No violet anywhere.** `--unknown` is reserved for the attribution bucket only.
- Equity curve: dithered dot-matrix fill under a stepped line, cyan `--curve`, fading toward the baseline.
- Big figures with de-emphasised decimals (`.fig .fr`).
- Offline and stale read as **neutral plus amber**, never violet.

## Phase 0 — re-verify before changing anything (required)

`REVIEW-ui-fidelity.md` was written on 2026-07-23. The app has shipped v1.55.1 through v1.63.0 since,
including two UI passes and a panel-system change. **Do not assume its findings are still open.**

For each finding below, confirm against current code and a running instance, and record the verdict:

| # | Claim | Cited location |
|---|---|---|
| 1 | Offline/stale rendered violet, not neutral+amber | `signal-desk.css:848`, `:882`, `:961` |
| 2 | Account header says "Live" while blanking Balance/Equity to "—" | `AccountHeader.tsx:161`, `App.tsx:1069`, `:1166-1187` |
| 3 | Equity curve is a solid cyan slab on near-flat series | Account growth, Performance › Overview |
| 6 | Default lot size renders "0,1" with a comma decimal | Settings |
| 7 | Mobile 390px: status cluster truncates and overlaps nav | header |

Finding 2 looks **partly resolved already**: the Operations desk now renders
`Balance as at 09:34 PM - not current` with last-known values. Verify what remains rather than
re-implementing it.

Report which findings are still live before starting Phase 1. If a finding is already fixed, say so
and skip it. Do not manufacture work.

## Phase 1 — the corrections

Work in this order. Each item ships verified.

1. **Violet purge (finding 1)** if still open. Swap `--unknown` for neutral/`--warn` in the
   `.operations-account*` rules. `--unknown` stays for attribution only. Grep for every `--unknown`
   usage and classify each one before editing.
2. **Account header truth (finding 2)** if still open. Title driven by heartbeat state; never claim
   "Live" beside an "EA OFFLINE" chip; keep showing last-known values with the "as at" caption.
3. **Equity curve on sparse data (finding 3)**. Clamp the fill for near-flat series or show an empty
   state. A single flat point must not paint a full-height saturated block.
4. **Settings screenshot parity.** The owner's reference shows `Save execution settings` in the intro
   banner, right-aligned beside the descriptive text. NOTE: this conflicts with the `Panel actions`
   pattern introduced on 2026-07-28, where panel-level controls live in the panel header. **Pick one
   and apply it consistently across all routes.** State which you chose and why. Do not leave both
   patterns in the codebase.
5. **Top-bar status chips.** The reference gives each chip a coloured icon treatment (green for sync
   and Telegram, blue for DB). Current chips are plainer. Bring them to the reference, keeping
   offline/stale neutral+amber.
6. **Remaining route sweep.** Apply the same treatment to Operations, Providers, Symbols, Telegram,
   History, Performance, Equity Guardian and Logs. Report per route what changed.

## Non-negotiable constraints

**`base.css` is the single largest defect source in this repo.** ~8,600 lines with duplicated
top-level blocks where the later one silently wins. It has caused five confirmed bugs, two of them in
the last 24 hours. Before editing any selector, grep for **every** occurrence and edit the one that
actually wins. The lint gate includes a duplicate-block guard; keep it green.

Related trap, also from the last 24 hours: `.panel > *:not(header)` and the `margin-inline` group in
`signal-desk.css:630` depend on a **direct-child** relationship. Introducing a wrapper element inside
a panel silently breaks the inset and padding of everything below it. Do not add wrapper divs inside
panels.

Do not change: any file under `apps/api/`, `packages/core/`, `mt5/`. This is a presentation pass only.
No behaviour, no execution path, no parser.

## Verification protocol (required, this is where the last pass failed)

Judging by screenshot is not acceptable. Two bugs shipped in the last day because rendered boxes were
never measured, and a third because the audit only ever measured one component state.

For every route, in **both themes** and at **1600px and 560px**:

1. Measure the rendered boxes. Every content child of a `.panel` must share left and right edges, and
   none may overrun its parent. Assert `document.scrollWidth <= innerWidth`.
2. Measure **both states** of anything collapsible or toggleable. A panel that only gets measured
   collapsed hides bugs that live in its expanded state.
3. Grep for violet: after Phase 1 item 1, no `--unknown` may appear in any `.operations-account*`,
   status-chip or stale-banner rule.
4. Capture before/after screenshots per route and state what changed.

Report the measurements, not an assurance that it looks right.

## Gate

`bun run typecheck`, `bun run lint` (zero warnings; the baseline has none, do not introduce any),
`bun test`, `bun run build`. Report the exact test count. The suite is 635 tests as of `9efa677a`.

`AccountHeader > shows honest stale state and exposes account actions` is a known pre-existing flake:
it times out under full-suite load roughly 1 run in 5 and passes in isolation. Do not chase it, and do
not let it mask a real failure you introduced.

## Reporting

Per route: what changed, the measured edges in both themes and both widths, and any finding you found
already fixed. Flag anything you could not verify rather than asserting it works.

Do not commit. Leave the work in the tree for review.
