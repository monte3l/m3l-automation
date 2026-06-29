# Plan: coverage fix + work log + PR for `feat/core-errors`

> Follow-up to [`errors-submodule-implementation.md`](./errors-submodule-implementation.md)
> (the implementation plan for the `core/errors` submodule). That plan is complete
> and committed; this one ships the cleanup and the PR.

## Context

The `core/errors` submodule is implemented, reviewed, and committed (`1cdb305`) on
branch `feat/core-errors`. During that build the hub found a coverage-tooling gap:
`M3LErrorUtils.ts` never appears in the v8 coverage table despite being re-exported
through the barrel and exercised by ~37 passing runtime tests — so utils-style files
are not actually guarded by the 80% threshold, and every future submodule uses the
same barrel pattern. This task (1) closes that gap, (2) records a durable work log
of the errors build, and (3) ships the branch as a PR to `main`.

## Part 1 — Coverage fix (`vitest.config.ts`)

Add `all: true` to the `coverage` block so every file matching
`include: ["packages/*/src/**/*.ts"]` is forced into the report regardless of the
test import graph — making the threshold trustworthy. Update the adjacent comment
to explain why (re-exported files such as `M3LErrorUtils.ts` were silently absent).

**Safety:** the only non-`index.ts` source files today are the three `errors` files
(already covered), so the aggregate stays ~98%. Going forward `all: true` correctly
counts a newly-scaffolded-but-untested module at 0% — desirable for the TDD gate.

**Verify:** `pnpm test:coverage` shows an `M3LErrorUtils.ts` row and ≥80% on all
four metrics. If it instead surfaces at ~0% (execution not attributed by v8), stop
and reassess rather than commit a misleading green.

Commit: `test: force vitest coverage.all so re-exported src files are gated`.

## Part 2 — Work log (`docs/logs/2026-06-29-core-errors.md`)

A markdown record of the errors build. `docs/logs/**` is not excluded from
`lint:md`, so it must pass `rumdl`. Sections: Summary, What went as planned, What
didn't go as planned & why, Lessons learned (actionable).

Commit: `docs: add work log for core/errors implementation`.

## Part 3 — Push & open PR to `main`

Use the `create-pr` skill (verifies gates, pushes the branch, opens the PR with a
Conventional-Commit title and a templated body). Title:
`feat: implement core/errors submodule` (minor; `exports` map unchanged → no break).
Body follows `.github/pull_request_template.md`. The PR triggers `ci.yml` and the
mandatory blocking `claude-pr-review.yml` gate; merge requires its PASS verdict.

## Execution order

1. Edit `vitest.config.ts` (add `all: true` + comment).
2. `pnpm test:coverage` → confirm the `M3LErrorUtils.ts` row and ≥80% all metrics.
3. Commit the `test:` change.
4. Write `docs/logs/2026-06-29-core-errors.md`.
5. `pnpm lint:md`, then the full gate
   (`typecheck && lint && test && build && check:api`) → all green.
6. Commit the `docs:` change.
7. Run the `create-pr` skill (push `-u` + open PR to `main`); report the PR URL.

## Critical files

- **Edit:** `vitest.config.ts`.
- **Create:** `docs/logs/2026-06-29-core-errors.md`.
- **Do NOT touch:** `docs/plans/errors-submodule-implementation.md`;
  `packages/m3l-common/package.json` `exports`/`version`; `dist/`.

## Verification

- `pnpm test:coverage`: `M3LErrorUtils.ts` appears; aggregate ≥80% on all metrics.
- `pnpm lint:md`: the new work log passes `rumdl`.
- Full gate green; `check:api` confirms the `exports` snapshot is unchanged.
- PR opened against `main`; CI + `claude-pr-review` triggered; report the URL.
