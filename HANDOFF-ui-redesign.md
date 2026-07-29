# Handoff — UI redesign, 2026-07-29

## State

`main` is at `568c6a6c`, **v1.64.0, deployed and live** on 192.168.0.100. Verified: asset hash
matches the local build, both accounts online, Telegram connected.

Shipped in that release: the canonical token layer, four new components in
`apps/web/src/components/FormControls.tsx` (Switch, NumberField, ThresholdBar, SaveBar), and
Settings rebuilt against them.

`SPEC-ui-fidelity-2026-07-29.md` is the authority for the design. Read it before continuing.
`REVIEW-ui-fidelity.md` describes the OLD target and is historical — do not work from it.

## In flight

A Codex run (gpt-5.6-sol, high) is redesigning the remaining seven routes on branch
`feat/ui-redesign-routes-2026-07-29`: `/` `/logs` `/providers` `/symbols` `/telegram` `/history`
`/performance` `/equity-guardian`. Those routes currently inherit the new tokens and shell but their
interiors are unchanged.

## The verification gap — this is the important part

**Codex cannot run a browser in its sandbox.** It cannot bind ports, reach an existing Vite server,
or launch Chrome. It reports this honestly rather than claiming success, but it means **no visual or
layout verification happens on its side**. Someone with a browser has to do it.

That gap already caught one real regression: at 560px `/logs` scrolled the whole document, 1554px
against a 560px viewport, in both themes, because a grid item defaults to `min-width: auto` and
would not shrink below the held-signals table's `min-width: 1050px`. Fixed with
`.wide-panel { min-width: 0 }`.

### How to verify

```
DATABASE_PATH=/private/tmp/claude-501/-Users-kamogelo-Code-telegram-tc/44c4a40d-4a25-459e-8e48-36090b77dd29/scratchpad/audit.db \
  TELEGRAM_ADAPTER=mock PORT=8787 bun apps/api/src/server.ts
bun run dev:web
```

Always override `TELEGRAM_ADAPTER=mock`; the repo `.env` sets gramjs. If the DB copy is gone, take a
fresh one: `ssh kamo@192.168.0.100 'docker cp telegram-tc-app-1:/app/data/telegram-tc.db /tmp/a.db'`
then scp it down.

The app is a React Router SPA. Synthetic `history.pushState` does NOT drive it — click the real
sidebar buttons and `.workspace-tab` buttons.

For each route, in **both themes** at **1600px and 560px**, assert: every content child of a
`.panel` shares left and right edges, none overruns its parent, and
`document.scrollWidth <= innerWidth`. Measure **both states** of anything collapsible — an audit that
only measured the collapsed state missed a bug on 2026-07-28.

Then screenshot each route in both themes and hand the set to Codex sol for a design review against
the spec.

## Hazards that have each produced a real bug

1. **`base.css` duplicated top-level blocks, later one silently wins.** ~8,600 lines. Grep every
   occurrence of a selector before editing. Five bugs so far. `bun run lint` has a duplicate guard.
2. **Panel inset depends on a DIRECT-CHILD relationship** — `.panel > *:not(header)` and the
   `margin-inline` group at `signal-desk.css:630`. A wrapper inside a panel silently strips inset and
   padding from everything below it.
3. **Grid items default to `min-width: auto`** and will not shrink below a wide child. See the
   `/logs` regression above.

## Gate

`bun run typecheck`, `bun run lint` (zero warnings — baseline has none), `bun test`, `bun run build`.
648 tests at `568c6a6c`.

`AccountHeader > shows honest stale state and exposes account actions` is a **pre-existing flake**:
times out under full-suite load roughly 1 run in 5, passes in isolation. Verified against a clean
baseline. Do not chase it, and do not let it mask a real failure.

## Working discipline that has paid off repeatedly this session

- **Measure rendered boxes, do not judge screenshots.** Three bugs shipped from eyeballing.
- **Mutation-check every test**: revert the mechanism, the test must fail. Two fixes this session
  were found to have no covering test at all despite a green suite.
- **Corpus tallies pin `commandType`, NOT symbols.** A parser change can shift symbol extraction
  across all 1,945 messages while the tallies stay byte-identical. Diff symbols separately.
- **Review the Codex diff yourself.** Every pass this session needed correction.
