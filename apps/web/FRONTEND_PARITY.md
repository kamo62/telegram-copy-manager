# Frontend parity contract

The replacement console is allowed to reorganise a workflow, but it must not remove a capability.
This checklist is the release gate for future frontend changes.

**Stale as of 2026-08-01.** This predates the v1.64.4/v1.64.5/v1.65.0 route restructuring: `/providers`,
`/symbols`, and `/logs` are now standalone top-level views, and the account workspace tab strip no
longer shows `summary` or `symbols` as tabs (see `README.md`'s Application Surfaces section for the
current structure). The capability list below stays useful as a checklist of things a redesign must
not drop; the route and tab structure it describes is out of date.

## Global routes

- `/`: all-account operations overview, account selection, exposure, activity and onboarding.
- `/telegram`: Telegram authentication, OTP/2FA continuation, dialog refresh, provider selection,
  and provider addition. Provider monitoring, resync, enable/disable, configuration, and removal
  live on the Providers page.
- `/linked-accounts`: link-slot creation/deletion, link code, connected-account health, provider
  assignment summary, account removal and external broker activity.
- `/settings`: appearance, execution defaults, order types, polling/dedup, stale-signal expiry,
  reporting currency, risk display thresholds, alerting, AI extraction and database backup.

## Account workspace

- `summary`: live account posture, performance strip, exposure and recent activity.
- `performance`: growth/equity chart, range statistics, provider attribution and sampled history.
- `providers`: aggregate or account-scoped results, copy toggle, execution configuration, TP/runner
  validation, configuration dry run, recent-message parse and CSV export.
- `history`: open EA/external positions, pending orders, grouped closed trades, partial-close legs,
  trade-journal export and out-of-sync resolution.
- `equity-guardian`: explicitly opt-in protection, threshold, paused state and safe unpause/requeue.
- `symbols`: global/provider aliases, account rules, direct broker mappings and deletion.
- `logs`: recent parses, fixture classification/redaction, AI review, approve/ignore/correct-and-push,
  held-signal requeue/dismiss, queue visibility and execution-report detail.

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
