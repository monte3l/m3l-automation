# 0001. Development toolchain choices

- **Status:** Accepted
- **Date:** 2026-06-27
- **Deciders:** Enrico Lionello

> Note: the `scripts/` example-automation workspace this ADR references was later
> removed — see [ADR-0019](./0019-remove-scripts-workspace.md), which supersedes
> the scripts/-workspace aspect of this decision. The toolchain choices themselves
> stand.

## Context and problem statement

The monorepo needs a dev/CI toolchain that upholds the project's
non-negotiables — ESM-only output, faithful `.d.ts`, minimal runtime
dependencies, strict semver via the `exports` map — while staying on
actively-maintained tools. This ADR records the choices made when the toolchain
was modernized, and the options deliberately rejected, so they are not
relitigated.

## Decision drivers

- Minimal runtime/dev dependencies; prefer platform-native features.
- Actively-maintained tooling (recency checked against the npm registry).
- Correctness of the published package (exports map, ESM, types resolution).
- The `exports` map is the public contract; ESM `.js` extensions are mandatory.

## Decisions

1. **Build with `tsc`, no bundler.** tsc emits accurate `.d.ts` for a
   types-first ESM library. Bundlers (tsup/tsdown/unbuild) were rejected as they
   add risk to declaration fidelity and contradict the "no bundler" constraint.
   `@typescript/native-preview` (tsgo) is fast but preview-quality for
   declaration emit — revisit later.
2. **Git hooks: Lefthook**, replacing husky + lint-staged. Husky 9.1.7 has been
   static since Jan 2025; Lefthook is actively maintained and its native staged-
   file globbing + `stage_fixed` absorbs lint-staged, cutting two deps to one.
3. **Task orchestration: Turborepo** for `build` + `typecheck` (task-graph
   ordering + local caching). `pnpm -r` was sufficient for two packages but does
   not scale as `scripts/` grows; Nx was heavier than needed.
4. **Runtime/pkg-manager pinning:** `.node-version` (Node 24) + Corepack +
   the existing `packageManager` field. No new tool (mise/Volta rejected as
   heavier all-in-ones).
5. **Publish correctness gates:** `publint` + `@arethetypeswrong/cli`
   (`--profile esm-only`) validate the exports map / ESM / types resolution
   before publish. The `esm-only` profile ignores the `node10` and CJS
   resolutions, which an ESM-only package intentionally does not support.
6. **Dead-code gate:** `knip` (unused files/exports/deps/devDeps), monorepo-
   aware. ts-prune was rejected (unmaintained since 2022).
7. **Environment management:** Node's native `--env-file` for `scripts/`. No
   dotenv library; dotenvx would only add value for encrypted secrets, which are
   not in scope.

## Consequences

- **Positive:** fewer, more-active dependencies; publish correctness is enforced
  in CI; cached builds; dead code is caught early.
- **Negative / trade-offs:** Turbo adds little for the current two-package repo
  (accepted as a forward investment). Migrating off Husky requires a one-time
  local `git config --unset core.hooksPath` for machines that had Husky; fresh
  clones are unaffected.
- **Semver impact:** none (tooling only; no change to the public API).

## Links

- Related: `CLAUDE.md` (Tech Stack, Commands, Git Workflow), `lefthook.yml`,
  `turbo.json`, `knip.json`, `.github/workflows/ci.yml`.
