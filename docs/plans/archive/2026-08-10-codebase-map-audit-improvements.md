# Codebase-map comparison audit — tooling and build-config hardening

**Status: shipped.** Branch `feat/codebase-map-audit-improvements`, commits
`9b68a09`..`c78a695`.

## Context

An `/auditing` pass compared `m3l-automation` against a codebase map of a
different, larger pnpm monorepo (CLI tools + Lambdas + IaC)
to surface transferable practices and incidental drift. Most of the map's
distinctive features were already rejected on the record here (Renovate →
ADR-0007, dependency-cruiser → ADR-0009, Sonar/Codecov-class type metrics →
ADR-0015) or irrelevant to a library-only repo (`functions/`, `infra/`,
`contracts/`, domain-grouped CLIs). What genuinely transferred: an aggregate
local CI-reproduction gate, three compiler-strictness flags, and four pieces
of dependency/config drift the comparison exposed incidentally.

## Approach / Decisions

1. **`pnpm verify` aggregate gate.** `.github/workflows/ci.yml`'s `verify` job
   ran ~35 ordered steps with no local one-command reproduction.
   `bin/lib/verify-steps.mjs` is the hand-authored, ordered mirror
   (`ciStepName` joined against `ci.yml`'s `name:` field, not the command
   string — command strings drift harmlessly); `bin/verify-all.mjs` runs it
   (`pnpm verify`, fail-fast by default, `--continue`/`--full` to widen);
   `bin/check-verify-parity.mjs` (`pnpm check:verify-parity`, wired as its own
   CI step) asserts the two never drift, mirroring the existing
   `check:cadence` pattern for lefthook.yml/CLAUDE.md.
2. **Three compiler-strictness flags**, sized by measurement before adopting:
   `noUncheckedSideEffectImports` (0 errors, free), `isolatedDeclarations`
   (2 errors total — a missing type annotation each in `core/environment` and
   `codepipeline-ops`; must live in `tsconfig.build.json` per project, not
   `tsconfig.base.json`, since TS5069 rejects it wherever `declaration`/
   `composite` are off), `noPropertyAccessFromIndexSignature` (131 errors
   across `packages/m3l-common` and two `scripts/*` packages found by a
   follow-up repo-wide sweep — all legitimate `Record<string, unknown>` reads
   off `unknown` external input; the largest single-file cluster,
   `run-report.ts`, was checked specifically for a "should be a named-property
   type" smell and cleared as a defensive JSON projector).
3. **Guard coverage.** `bin/check-eslint-zones.mjs` structurally guarded the 3
   ADR-0009 `import-x/no-restricted-paths` zones but not the repo-wide
   `import-x/no-cycle` rule (ADR-0035 A8) — added as a fourth guard. Its
   aws-island assertion was also a `.includes()` subset check that had gone
   silently stale when `eslint.config.js` widened `except` to add `"polling"`;
   tightened to an exact-set comparison.
4. **Dependency-hygiene drift**, all four found incidentally during the
   audit: grouped the 19 lockstep `@aws-sdk/*` Dependabot bumps into an
   `aws-sdk` group; dropped a dead `undici` override in `pnpm-workspace.yaml`
   left over from a resolved merge-deadlock workaround (#292); exact-pinned
   the sole caret devDependency (`globals`) and widened `check:deps` to
   enforce that convention on the root manifest, not just the library's
   ADR-0017-governed one; fixed ADR-0007's stale claim about the Dependabot
   group names.
5. **Deliberately deferred** to follow-up PRs: type-checking the ~45
   CI-gating `bin/*.mjs` scripts (open-ended by design — a large first
   pass belongs in its own change) and a dependency-license allow-list.

## Outcome

- `pnpm verify` (34/34 runnable steps; gitleaks and a frozen-lockfile
  reinstall skip by design) passes end-to-end against the final commit.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`, and
  `pnpm check:api` (zero exports-snapshot drift — every §2 change was
  type-annotation/access-syntax only) all pass.
- `pnpm test:coverage`: 174 test files, 6116 tests, 97.92%/94.92%/99.58%/98.55%
  stmt/branch/func/line coverage — unchanged in shape from before the branch.
- One self-inflicted detour, corrected before push: a `git add -p` slip during
  commit splitting dropped the `globals` package.json hunk from its intended
  commit while its lockfile-specifier counterpart landed, leaving `HEAD`
  briefly `--frozen-lockfile`-inconsistent both ways in turn; caught by
  running `pnpm install --frozen-lockfile` as a deliberate post-commit check
  rather than assuming `git add -p`'s hunk selection matched intent, fixed
  with two small corrective commits (`ff1f782`, `78c6c14`) rather than
  amending. Lesson: after any `git add -p` split, verify with `git diff
--cached` **and** an independent command that exercises the staged state
  (here, `--frozen-lockfile`), not just a re-read of the diff text.
