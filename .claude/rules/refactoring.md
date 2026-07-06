---
paths:
  - "packages/m3l-common/src/**"
  - "**/tests/**"
  - "**/*.test.ts"
---

# Refactoring rules (source & tests)

> Canonical rationale: [`docs/contributing/style-guide.md` § Refactoring existing
> code & tests](../../docs/contributing/style-guide.md#part-3--refactoring-existing-code--tests).
> This file is the terse checklist that auto-loads when you change existing code.

Refactoring changes internal structure **without changing observable behavior**.
It is not feature, performance, or behavior work — those are separate commits.

- **Test safety net first.** A passing suite must exist before you refactor; if the
  area lacks tests, **add characterization tests** capturing current behavior first.
- **State the goal.** Name the problem you are removing (duplication, complexity,
  naming, weak types). No identified problem → no refactor.
- **Small isolated steps**, each one focused operation, **committed individually**
  with a `refactor:` commit. Rerun the full suite after each
  step; a failure is a regression — revert before continuing.
- **Opportunistic / Boy-Scout:** leave touched code better than you found it, and
  do a preparatory refactor first when it makes the change you came to do simpler —
  but **keep it bounded** (don't chase one cleanup into a rewrite) and in its own
  commit, separate from the feature/fix.
- **A refactor MUST NOT** add features, change observable behavior, add a
  dependency, or change a public interface unless that is the explicit purpose.
- **Semver hazard:** changing an exported signature or the `exports` map is a
  breaking change, not a free refactor — keep the public surface stable or plan the
  major bump. New capability surfaces through the namespace barrel, never a new
  subpath. (Guarded by `guard-exports-semver.mjs` + `publint`/`attw`.)
- **Tests are production code:** rename a test when its behavior is renamed, delete
  tests that no longer assert a contract, refactor a shared fixture once (not every
  caller), and update a mock target the moment the impl's I/O primitive changes (a
  stale mock silently intercepts nothing).
