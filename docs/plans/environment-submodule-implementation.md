# Plan: Add the `environment` submodule + fix the implementation-status count drift

## Context

An audit of submodule implementation status found that `@m3l-automation/m3l-common`
has **3** submodules done (`errors`, `events`, `security`), but the prose count in
both `docs/implementation-status.md` and `CLAUDE.md` still says "**2 of 22**" — drift
introduced when `security` shipped. The audit's primary goal is to add the next
foundational module, **`environment`** (`M3LExecutionEnvironment`), which is already
fully specified at `docs/reference/core/environment.md` but has no source, tests,
barrel export, or provenance sidecar. `environment` is tier-1 (no runtime deps) and
unblocks `utils`/`M3LPaths` and `script`, which both depend on its deployment-mode
detection.

Because a spec page already exists, this is an **`implement-submodule`** job (TDD
hub-and-spoke), **not** `new-subpath`. Per the clarifying answers: exact accessor
shapes and boundary-error behavior are pinned during the TDD contract phase (not by
pre-editing the spec), and the count drift is fixed as part of this work.

## 1 — Fix the implementation-status count drift (small docs cleanup)

Do this first; it is independent and quick.

- `docs/implementation-status.md:5` — change "2 of 22 submodules" to "3 of 22
  submodules" and add `security` alongside `errors`/`events` in that sentence.
- `CLAUDE.md` — update the two places that say "2 of 22" / "2 of 22 submodules are
  implemented (`errors`, `events`)" in the _Agent Operating Model → Current state_
  line to "3 of 22 … (`errors`, `events`, `security`)".
- Verify with `pnpm check:doc-counts` (`bin/check-doc-counts.mjs` asserts prose
  counts against the filesystem) and `pnpm lint:md`.

## 2 — Implement `environment` via the `implement-submodule` pipeline

Drive the existing skill (`.claude/skills/implement-submodule/SKILL.md`) end-to-end.
The hub dispatches spokes; the hub does not write src/test code itself.

**Contract (spec-conformance-reviewer as contract producer).** Enumerate the exact
symbols and behavioral contracts from `docs/reference/core/environment.md`:

- Class `M3LExecutionEnvironment` with static `detect()` (cached, process-global
  singleton) and `detectFresh()` (force re-detect).
- `M3LEnv` (the convenience accessor / alias documented in the spec).
- Enums/unions: `M3LExecutionEnvironmentType` (7 values: `LOCAL_INTERACTIVE`, `CI`,
  `AWS_LAMBDA`, `AWS_ECS`, `AWS_EC2`, `AWS_CODEBUILD`, `UNKNOWN`),
  `M3LDeploymentMode` (`MONOREPO` / `STANDALONE`), `M3LCredentialSource` (7 values:
  `SSO_PROFILE`, `ENVIRONMENT`, `CONTAINER`, `INSTANCE_METADATA`, `WEB_IDENTITY`,
  `DEFAULT_CHAIN`, `NONE`).
- `M3LExecutionEnvironmentInfo` — capability flags (`isInteractive`, `isAWSManaged`,
  `canPromptUser`, `canOpenBrowser`, `requiresAwsProfile`), `environmentType`,
  `deploymentMode`, discovered monorepo root path, and `detectionDetails`.
- `M3LEnvironmentDetectionDetails` — raw signals (TTY flags, CI env vars, AWS
  metadata-endpoint presence, the workspace-marker file found during walk-up).
- This phase pins the loose points the spec leaves open (line 84): capability flags
  as `readonly` properties on the info object; and boundary behavior for the
  monorepo walk-up (symlink-loop / depth guard, unreadable dir) — throw a typed
  `M3LError` subclass, never swallow. Follow `rules/01` + `.claude/rules/library-src.md`.

**RED (test-author).** Author `packages/m3l-common/tests/environment.test.ts`:
happy-path detection for representative env types, monorepo-vs-standalone walk-up
(use a temp dir tree; mock `cwd`/env rather than real network/metadata), caching
(`detect()` returns the same singleton; `detectFresh()` re-runs), an
`expectTypeOf` type-level test for the enums/info shape, and a failure path for the
boundary case. Confirm tests fail for the right reason (no impl yet). Heed the
`guard-eslint-disable-red` hook — no import-resolution `eslint-disable` in RED tests.

**GREEN (submodule-implementer).** Create `src/core/environment/` (barrel
`index.ts` + impl files), named exports only, `.js` on every relative import, no
`any`/`!`, TSDoc + `@example` on each exported symbol. Make the suite pass; refactor
while green. Detection reads `process.env`, `process.stdout.isTTY`, and the
filesystem walk-up only — environment-agnostic, no top-level side effects.

**Barrel.** Add `export * from "./environment/index.js";` to
`packages/m3l-common/src/core/index.ts` (it currently exports only errors/events/
security). The `exports` map stays at three entries — no semver change.

**Review.** Run `code-reviewer` + `spec-conformance-reviewer` (and
`silent-failure-hunter` for the walk-up error paths; `type-design-analyzer` for the
new enums/info type). Apply must-fixes.

## 3 — Reconcile docs & status after GREEN+review

- Update `docs/implementation-status.md` row 33: `environment` → `✅`, Tests `✅`,
  Reviewed `✅`, with a note (test count + coverage), mirroring the errors/events/
  security rows. Bump the prose count from step 1 to "**4 of 22**".
- Generate `docs/reference/core/environment.provenance.json` (same schema as
  `errors.provenance.json` — heading → source symbol/lines/commit). Run via the
  `sync-docs` skill so the sidecar is stamped to HEAD.
- Add a work log under `docs/logs/` (per the errors/events/security precedent).

## Verification checklist

- [ ] `pnpm check:doc-counts` passes after step 1 (and again after step 3).
- [ ] `environment.test.ts` failed for the right reason in RED, passes in GREEN.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all green.
- [ ] `pnpm test:coverage` keeps the 80% gate (target ~100% like peers).
- [ ] `pnpm check:scaffold` passes (barrel ↔ `src/core/environment/` in sync).
- [ ] `pnpm check:provenance` passes (new sidecar valid, stamped to HEAD).
- [ ] `pnpm check:api` shows no unexpected `exports`-map change (still 3 entries).
- [ ] `pnpm knip` reports no unused files/exports.
- [ ] Conventional Commit `feat:` (new public surface → minor) for the env module;
      the count-drift fix is `docs:`.
