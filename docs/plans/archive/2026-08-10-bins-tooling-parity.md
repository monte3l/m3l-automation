# `bins/` tooling-parity audit — license gate, reporter migration, coverage/dup extension, scaffolder hardening

**Status: shipped.** Branch `feat/bins-tooling-parity`, commits
`c0d4b38`..`499c322`.

## Context

An `/auditing` pass compared this repo's `bin/` fleet against a technical
review of a different repo's `bins/` directory (a deployment-flavored
monorepo: Docker/Lambda/multi-region tooling this repo has no target for).
Roughly half the reference doc — packaging/deployment tooling, a
deterministic submodule scaffolder, a diff-aware new-export test guard — was
considered and rejected outright: no target under ADR-0020, or too large a
new generator for the value. What survived: the dependency-license gap the
predecessor audit (`2026-08-10-codebase-map-audit-improvements.md`)
explicitly deferred, half-adopted reporting infrastructure, `bin/`'s own
exemption from the duplication/coverage gates it enforces on everything else,
and a handful of concrete scaffolder/tsconfig correctness gaps.

## Approach / Decisions

1. **Dependency license policy (ADR-0036).** Two layers, same allow-list
   (MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, CC0-1.0, Unlicense):
   `dependency-review.yml`'s `allow-licenses` at PR-diff time, and a new
   `bin/check-licenses.mjs` (`bin/lib/licenses.mjs`'s recursive-descent SPDX
   expression parser) gating the resolved tree on every push. Zero new
   dependencies — `pnpm licenses list --json` is already bundled with the
   pinned pnpm. Prod scope (m3l-common's runtime deps + optional peers)
   errors; dev-only tooling warns. Verified against the live tree before
   writing the ADR: prod is clean today; dev has real non-blocking outliers
   (`eslint-plugin-sonarjs` LGPL-3.0-only, `lightningcss` MPL-2.0, and
   others). A real bug surfaced during implementation: the first pass deduped
   `pnpm licenses list`'s output by package name, silently dropping
   `argparse`'s second, differently-licensed resolved version
   (`2.0.1`/Python-2.0 alongside `1.0.10`/MIT) — fixed to classify every
   resolved (name, license) pair independently.
2. **Reporter adoption.** 10 of 23 `check-*.mjs` scripts used
   `bin/lib/report.mjs`; the other 13 printed raw `console.error`/stdout,
   so `--json` (the ADR-0030 agent-facing contract) worked for under half
   the fleet. Migrated all 13, added `repoRoot()` (the
   `dirname(dirname(fileURLToPath(...)))` one-liner nearly every script
   duplicated), and gave `error()`/`warn()` an optional `{file, line}` that
   emits a `::error::`/`::warning::` GitHub Actions annotation under
   `GITHUB_ACTIONS=true` — attaching a failure to its file/line in the PR
   "Files changed" view, which nothing in `bin/` did before. Threaded
   locations through five checks that already used the reporter.
3. **`bin/` under its own gates.** `.jscpd.json` widened to a full-fragment
   brace-expansion pattern covering `bin/**/*.mjs`; residual duplication
   (mostly pre-existing similarity between sibling scripts) lands at 1.58%,
   under the 4% threshold with no changes needed. Coverage took real
   investigation: Vitest's per-glob `coverage.thresholds` entries are
   **additive**, not overrides (confirmed against `vitest`'s own source,
   `coverage.*.js`'s `resolveThresholds` — the global threshold applies to
   every included file regardless of glob-keyed entries), so
   `packages/*/src`'s 80% `perFile` floor and a realistic `bin/` floor
   cannot coexist in one `vitest.config.ts` coverage block. `bin/` got its
   own `vitest.bin.config.ts` instead — a separate process, chained into
   `pnpm test:coverage` — with an **aggregate** (not `perFile`) threshold,
   since roughly 20 of ~48 `bin/**/*.mjs` files sit at a structural 0%
   per-file (their real logic lives behind an `argv[1] === ...` main guard
   that only executes via direct invocation, verified that way by every
   pre-push/CI `check:*` step rather than by Vitest).
4. **Scaffolder hardening.** `substituteTokens()` now throws on any
   surviving `__TOKEN__`-shaped span after substitution (a typo'd token
   previously shipped silently into generated source); verified by
   injecting a bad token and confirming the existing atomic rollback fires.
   `--dry-run` (renders every file, writes nothing) and `--force`
   (overwrites an existing `scripts/<name>/`, scoped to the manifest's known
   files only, no blanket directory delete, no rollback under `--force`
   since a blanket `rm` could destroy content the run never wrote) — both
   wired into the `scaffold_script` MCP tool. Reordered the generator's
   printed next-steps to fill in docs before running
   `pnpm check:script-scaffold` (it previously told users to run the check
   before the README placeholder was filled in, which the check itself
   rejects).
5. **Structural rule coverage.** `packages/*` gets the same root-tsconfig
   reference forward/reverse coverage `check-script-scaffold.mjs` already
   had for `scripts/*` — `packages/m3l-common` had none before this. New
   `tsconfigShapeErrors()` validates a scaffolded tsconfig's `extends`/
   `references` against the real templates (read live, not hand-duplicated).
   Tightening `packageManifestErrors`' `scripts.{build,typecheck,start}`
   check from presence-only to exact value surfaced the actual stale test
   fixture the predecessor audit had flagged by a different name:
   `bin/tests/script-scaffold.test.ts`'s `conformantManifest()` hardcoded
   `"tsc -b"`/`"node dist/main.js"` instead of the template's real
   `"tsc -p tsconfig.json"`/`"node --env-file-if-exists=.env dist/main.js"`
   — verified against all 13 live `scripts/*/package.json` first (all
   already matched the template) before fixing the fixture.
6. **Deliberately deferred:** TS-Compiler-API structural checks
   (`config.ts` declared-symbol assertions, README-parameter-completeness) —
   recorded in `docs/ROADMAP.md`'s Priority 2 table as Blocked, since
   introducing AST parsing into `bin/` is its own architectural step, not a
   bundle-in for this change. Also out of scope: a deterministic submodule
   scaffolder and packaging/deployment tooling (no target under ADR-0020).

## Outcome

- `pnpm verify`: 35/35 runnable steps pass (gitleaks and a frozen-lockfile
  reinstall skip by design).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` all pass.
- `pnpm test:coverage`: main config unchanged in shape from before the branch
  (175 files / 6201 tests / 97.92%/94.92%/99.58%/98.55%
  stmt/branch/func/line); the new `vitest.bin.config.ts` pass measures
  `bin/**/*.mjs` at 41.51%/41.29%/54.32%/41.44%, gated at a
  35%/35%/45%/35% aggregate floor with margin.
- `/syncing-docs`: 14/14 steps clean, zero diff both before and after
  committing.
- Four commits, one per theme (license gate; reporter migration; jscpd/
  coverage widening; scaffolder + structural rules combined, since both
  touch `bin/lib/script-scaffold.mjs` and its two consumers).
