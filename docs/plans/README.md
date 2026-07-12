# Plans

Planning documents for m3l-automation, split into **living trackers** and
**archived point-in-time plans**.

## Living trackers (start here)

- [`../ROADMAP.md`](../ROADMAP.md) — the coarse, prioritized view of pending
  program work (unblock-first).
- [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) — the detailed per-item backlog
  (friction F-series, fleet W2–W5, gated D4/D5).
- [`../implementation-status.md`](../implementation-status.md) — the _done_
  library ledger (22/22 submodules, count-enforced).

These are **fixed and living** (no date in the name), updated as work lands.

## Archive

[`archive/`](./archive/) holds completed and superseded dated plans, kept as
history. They are frozen — do **not** edit them; the accurate current state
lives in the trackers above. `archive/**` is excluded from `lint:md`.

| Group                              | Files                                                                                                 | State                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Library bootstrap plan             | `m3l-common-implementation.md`                                                                        | **done** — the 2026-06-28 all-22-submodule build schedule; superseded by `implementation-status.md`               |
| Per-submodule implementation plans | `*-submodule-implementation.md` (22) + `utils-submodule-closure.md`, `core-events-coverage-log-pr.md` | **done** — library reached 22/22 (see `implementation-status.md`)                                                 |
| Pre-1.0.0 release audit            | `2026-07-05-pre-1.0.0-release-audit.md`                                                               | **done** — findings shipped / dropped                                                                             |
| Deepen-first (post-1.0)            | `2026-07-06-post-1.0-deepen-first-roadmap.md`, `2026-07-06-deepen-first-implementation-plan.md`       | **done** — WS-A…WS-G shipped at v1.1.0 (PRs #74–83)                                                               |
| Consumer-fleet (Phase 5)           | `2026-07-06-consumer-fleet-roadmap.md`, `2026-07-06-consumer-fleet-implementation-plan.md`            | **done/superseded** — F0/F1 shipped (PR #85–91); F2–F4 superseded by the trackers                                 |
| Script pipeline                    | `2026-07-09-consumer-script-pipeline.md`                                                              | **done** — generator + gates (PRs #90/#91)                                                                        |
| Consumer-scripts (W0–W5)           | `2026-07-09-consumer-scripts-roadmap.md`, `2026-07-09-consumer-scripts-implementation-plan.md`        | **superseded** by `ROADMAP.md` + `IMPLEMENTATION.md`; W0 shipped (#96/#97/#98), W1 done (#99), W2–W5 tracked live |
| json-etl F-series adoption         | `2026-07-12-json-etl-adopt-seams.md`                                                                  | **done** — F8-adopt landed (`--preset` wiring); F6-adopt kept its event counter, gap filed as F6b                 |

## Adding a plan

Author a dated one-off plan under `docs/plans/` when a large unit needs a
committed record; when it ships, `git mv` it into `archive/` and update the
trackers. The routine per-submodule/per-script work is now tracked directly in
the living trackers rather than a new file each time.
