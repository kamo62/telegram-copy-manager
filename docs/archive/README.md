# Archived documents

Two permanent records. Everything else from the May-to-July 2026 planning and review cycle was
deleted on 2026-07-30 after its durable content was lifted into `HANDOFF.md`.

The live docs are `README.md` (what the system is), `HANDOFF.md` (current state, standing invariants,
open backlog), and `changelog.md` (what shipped when).

## Kept

`INCIDENT-2026-07-20-vipgold.md` — VIP Gold missed-close postmortem, -R397, plus six follow-on
defects. Root causes shipped in v1.57.0 to v1.60.0. Postmortems for events that lost real money are
kept permanently.

`AUDIT-2026-07-20-codebase.md` — 21-finding no-ship audit of the v1.40 tree. The messaging and
classification findings were fixed in v1.57 to v1.60. Five structural findings were still open when
this was archived and are summarised in HANDOFF under "Open trade-safety risks carried forward". The
full reasoning for each lives here, which is why the file is kept rather than deleted.

## Deleted, recoverable from git history at `e63717e7`

Implementation briefs, all shipped: `IMPL-symbol-picker-and-alerts-2026-07-24` (v1.56.0),
`IMPL-duplicate-open-prevention-2026-07-24` (v1.57.0), `IMPL-close-semantics-2026-07-25` (v1.58.0),
`IMPL-structure-first-classification-2026-07-26` (v1.59.0), `IMPL-ui-fixes-2026-07-23` (v1.55.1).

Completed plans: `PLAN-evidence-gated-execution` (v1.60.0, with a deviation now recorded in HANDOFF),
`plan-11-07-26` (v1.19.0), `plan-signal-correlation-17-07-26` (v1.27.0 to v1.32.0),
`account-routing`, `improvements-21-5` (phases 3 and 4 shipped; 2.1 and 2.2 never implemented and now
in HANDOFF's backlog).

Review chain on v1.50, all defects resolved: `REVIEW-2026-07-20-v150`,
`REVIEW-2026-07-20-v150-verify`, `REVIEW-item7-verify`. Plus `REVIEW.md`, the rolling review scratch
pad, whose unshipped items are now in HANDOFF.

UI design targets, superseded four times in three weeks: `plan-white-ui-redesign`,
`plan-ui-refine-12-07`, `plan-ui-refine-2` (all 07-12), `REVIEW-ui-fidelity` (07-23),
`SPEC-ui-fidelity-2026-07-29` (07-29). None described the current UI. The design base in effect is
SF Pro on a 12/13/14/24px scale with a 1180px canvas, specified at the top of `HANDOFF.md`.
