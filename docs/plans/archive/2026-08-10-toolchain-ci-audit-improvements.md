# Toolchain & CI comparison audit — lint/tsconfig/CI hardening

**Status: shipped.** Branch `fix/toolchain-hardening`, commits
`4827404`..`acff84f`.

## Context

An `/auditing` pass compared `m3l-automation` against a purely-technical
description of a different repository's toolchain (ESLint flat config with a
custom inline plugin, dependency-cruiser, Renovate, `type-coverage`, and a
reusable-workflow CI). Most of the reference's distinctive machinery was
already covered here by an equivalent mechanism or explicitly rejected on the
record (dependency-cruiser vs. `import-x/no-restricted-paths` — ADR-0009;
Renovate vs. Dependabot grouping) — the comparison confirmed this repo is
ahead on supply chain (gitleaks, Scorecard, dependency-review) and drift gates
(~25 `check:*` scripts, `check:verify-parity`, `check:zones`) that the
reference has no analogue for. What genuinely transferred: three
`import-x/no-restricted-paths` boundary gaps, two absent compiler-strictness
flags, two lint rules mechanizing already-documented-but-reviewer-only
conventions, and three targeted CI additions.

One planned item — extending the coverage gate to `scripts/*/src` — was
dropped mid-implementation: `.claude/rules/scripts.md` and ADR-0022 §8
explicitly exempt scripts from the 80% gate as ratified policy, not an
accidental gap, so adding one would have contradicted the ADR. The
measurement taken before discovering this (87.7%/83.3%/94.6%/88.5%
stmt/branch/func/line) confirmed the fleet is healthy without a mandate.

## Approach / Decisions

1. **Three `import-x/no-restricted-paths` boundary gaps closed**, all via the
   existing zone mechanism (no dependency-cruiser escalation — ADR-0009's
   documented trigger did not fire): a script-cross-import zone generated
   per `scripts/` directory entry (the existing `no-restricted-imports` rule
   only catches bare specifiers, not a relative reach into a sibling
   script's `src`), two prod-not-to-test zones (library + scripts), and
   `import-x/no-cycle` widened from library-only to also cover
   `scripts/*/src`. All three registered in `bin/check-eslint-zones.mjs` so
   a deleted zone fails CI instead of silently passing lint.
2. **Two compiler-strictness flags**: `noImplicitReturns` and
   `allowUnreachableCode: false`. The latter caught one real finding — a
   `return;` after `process.exit()` in `signalHandlers.ts`, dead code under
   Node's `never`-typed `process.exit()` — fixed in the same commit that
   enabled the flag so the tree stays green at every commit.
   `isolatedDeclarations` stays build-config-only (the tooling projects set
   `declaration: false` and include tests, which it doesn't tolerate);
   `noUnusedLocals`/`noUnusedParameters` deliberately skipped —
   `@typescript-eslint/no-unused-vars` already covers both with the `^_`
   escape hatch the codebase relies on, which tsc's flags don't honor.
3. **Two lint rules mechanizing existing convention**: `no-restricted-syntax`
   - `max-lines(200)` on `scripts/*/src/main.ts` enforce ADR-0022's
     "composition root only" rule, previously reviewer-checked only per
     `.claude/rules/scripts.md`'s own admission; `no-console: error` on
     `packages/m3l-common/src/**` mechanizes the "library does not log by
     default" security promise. One real finding on the latter —
     `M3LHttpClient`'s opt-in `debug: true` diagnostic line — got a narrowly
     scoped, justified suppression rather than an exception to the rule.
4. **Three targeted CI additions**, deliberately not a `verify`-job split
   (would need a rewritten `check-verify-parity` parser, an aggregate gate
   job, and a branch-protection change together): a weekly
   `security-audit.yml` re-running `pnpm audit`/`check:licenses` on a
   schedule so an advisory published against an unchanged lockfile doesn't
   sit uncaught between pushes; `timeout-minutes` added to three previously
   uncapped jobs (`claude-assistant.yml` mattered most — it carries the
   broadest write token in the repo, triggered by any `@claude` mention);
   and `bin/check-licenses.mjs` now parses `dependency-review.yml`'s
   `allow-licenses:` line and fails on drift from `ALLOWED_LICENSES` — the
   two lists were "keep them textually identical by hand" (ADR-0036) with
   nothing enforcing it. This closes the "dependency-license allow-list"
   item the codebase-map audit (`2026-08-10-codebase-map-audit-improvements.md`)
   deferred.
5. **Minor tooling fixes bundled in**: `.prettierrc.json` pins
   `endOfLine: "lf"` (previously unset — a known `format:check` flake
   source); `knip.json`'s project glob extended to `bin/**/*.mjs` so the
   ~48 tooling scripts' unused exports are checked like everything else
   (clean today).

## Outcome

- `pnpm verify` (35/35 runnable steps; gitleaks and a frozen-lockfile
  reinstall skip by design) passes end-to-end against the final commit.
- `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, and `pnpm build` all
  pass on the rebased branch immediately before push.
- `/syncing-docs` reconciled the one provenance sidecar staleness
  (`docs/reference/core/network.provenance.json`, from the `M3LHttpClient.ts`
  suppression comment) mid-session; a second pass immediately before push
  found nothing left to reconcile.
- Three commits, each independently buildable/lintable (verified by
  ordering: lint-config changes first, then the tsconfig flags + their one
  required source fix together, then CI/docs last) — no `git add -p`
  hunk-splitting needed since no file was touched by more than one commit.
