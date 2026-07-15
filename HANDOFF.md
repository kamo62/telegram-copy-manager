# Handoff

Updated: 2026-07-15

## Current state

- Branch `release/ops-redesign-1.21.1` carries v1.26.0: geometry-inference parsing for single-symbol providers plus parameter-level open-signal dedup.
- Driving incident: KAL VIP message 17020 (2026-07-15 03:47 SAST) with entry zone, SL, and TPs but no direction word or symbol was binned as noise. It now parses as XAUUSD BUY LIMIT 4023-4022, SL 4017, TP 4028/4035/4041, held for operator review because it also references "stops for 60" (4060).
- Design reviewed at high effort before implementation (approve with amendments; plural-keyword and quoted-body blockers fixed). Implemented by Codex, verified independently: core 43/43, API 232/232, lint/typecheck/build/docker green.
- Geometry inference activates only for providers with an explicitly configured locked symbol. The title-contains-"kal" default-symbol heuristic does not authorize it.

## Remaining tasks

1. Deploy v1.26.0 to prod (`bun run deploy` from repo root; backs up live DB, rsyncs, swaps container).
2. Set Locked symbol = XAUUSD on KAL VIP (`provider_1gfxfwd`) in the provider config modal, or via the provider config API. Without this the new inference stays inactive.
3. Watch the next directionless KAL VIP signal in ParseLab: expect auto-queue for clean geometry, review-hold when short-level stops are referenced.
4. Known trade-safety backlog (2026-07-14 audit) still has open items: double-close on lost report, percent-risk ignored, naked orders, guardian timing.

## Next commands

- Deploy: `bun run deploy`
- Live provider check: `curl -s http://192.168.0.100:18787/api/providers`
- Recent KAL VIP messages: `curl -s "http://192.168.0.100:18787/api/providers/provider_1gfxfwd/messages?limit=10"`
- Test suites: `bun test packages/core && bun test apps/api`
