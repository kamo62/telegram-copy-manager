# Frontend parity contract

The replacement console is allowed to reorganise a workflow, but it must not remove a capability.
This checklist is the release gate for future frontend changes.

**Route and tab structure corrected 2026-08-01** to match the v1.64.4/v1.64.5/v1.65.0 restructuring,
verified directly against `apps/web/src/App.tsx`'s route parsing and tab-strip rendering (see
`README.md`'s Application Surfaces section for the narrative version). The capability list stays the
release-gate checklist: a redesign may relocate a capability but must not drop it.

## Global routes

- `/`: all-account operations overview, account selection, exposure, activity and onboarding.
- `/logs`: standalone Review queue, with recent-message parsing, AI review, approve/ignore,
  fixture classification/redaction, saved fixtures, signal queue and EA execution reports. No
  account workspace tab strip.
- `/providers`: standalone global provider hub, with aggregate provider overview, account-scoped copy
  chips, provider config, parser template and symbol lock, lot/risk sizing, TP allocation, runner
  config, dry-run tests, parse-recent and CSV export. No account workspace tab strip.
- `/symbols`: standalone Symbol Mapping, with global and provider aliases, plus per-account broker
  symbol mappings. No account workspace tab strip.
- `/telegram`: Telegram authentication, OTP/2FA continuation, dialog refresh, provider selection,
  and provider addition. Provider monitoring, resync, enable/disable, configuration, and removal
  live on the Providers page.
- `/linked-accounts`: link-slot creation/deletion, link code, connected-account health, provider
  assignment summary, account removal and external broker activity.
- `/settings`: appearance, execution defaults, order types, polling/dedup, stale-signal expiry,
  reporting currency, risk display thresholds, alerting, AI extraction and database backup.

## Account workspace

`/accounts/:accountId/:tab` renders the account-scoped tab strip: `performance`, `providers`,
`history`, `equity-guardian`, `logs` (five tab-strip buttons, confirmed against `WorkspaceTabs.tsx`).
`summary` is not a distinct tab in this scope; it resolves to `performance`. `symbols` is reachable at
the same URL scheme, for example from an unmapped-symbol alert, but has no tab-strip button of its
own; routine alias and mapping work happens on the top-level `/symbols` page above.

- `performance`: growth/equity chart, range statistics, provider attribution and sampled history.
- `providers`: aggregate or account-scoped results, copy toggle, execution configuration, TP/runner
  validation, configuration dry run, recent-message parse and CSV export.
- `history`: open EA/external positions, pending orders, grouped closed trades, partial-close legs,
  trade-journal export and out-of-sync resolution.
- `equity-guardian`: explicitly opt-in protection, threshold, paused state and safe unpause/requeue.
- `logs`: recent parses, fixture classification/redaction, AI review, approve/ignore/correct-and-push,
  held-signal requeue/dismiss, queue visibility and execution-report detail.
- `symbols` (no tab-strip button, direct-link only): global/provider aliases, account rules, direct
  broker mappings and deletion.

## Persistent controls

- URL-backed navigation and reload-safe account/tab selection.
- Live SSE status with polling fallback and manual refresh.
- Light and dark themes persisted per browser.
- Colour-accent preference, locale-aware display, command palette, keyboard shortcuts, toasts,
  confirmation dialogs, focus trapping, live-region announcements and skip navigation.

## Release gates

- Every item above has an automated test or an executed browser-flow check.
- Route changes render immediately and do not wait for a dashboard request.
- Empty, loading, stale, held, offline, unknown and error states remain visually distinct.
- `bun run typecheck`, `bun run lint`, `bun test`, `bun run build` and the Docker rebuild pass.
- Light/dark screenshots are reviewed at desktop and phone widths before deployment.
