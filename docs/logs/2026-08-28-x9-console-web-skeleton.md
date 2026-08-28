# Work log — X9 `m3l-console-web` skeleton (2026-08-28)

Covers issue #557 / tracker row X9: standing up `packages/m3l-console-web`,
the repo's first browser-target package (Vite + React 19 + TypeScript strict,
ADR-0067). Ran through `starting-work` → hub-and-spoke TDD (`test-author` /
`code-implementer`) → `creating-prs` → `resolving-pr-comments` twice, across
two sequential PRs off `main`. Records what shipped, what matched the plan,
what diverged, and durable lessons — including one architectural pushback
against the review bot that the plan did not anticipate.

## Summary

**PR 1 — `feat/console-web-skeleton` (#723, merged to `main` as X9a).** Adds
the package: `App`/`ErrorBoundary`/`HealthBanner` components, a
`fetchConsoleJson<T>` typed-fetch wrapper decoding ADR-0066's
`M3LConsoleErrorEnvelope` (network / http / malformed-body failure kinds,
never throws), `fetchHealth` wrapping it with a runtime shape guard, plus the
full workspace wiring the scoped ADR-0001 bundler exception needs: a
per-package DOM tsconfig, a fourth root Vitest project (`vitest.web.config.ts`,
jsdom, perFile 90/83/80/89), new browser/JSX ESLint zones (React hooks rules,
a `node:` import ban, a widened `naming-convention` for PascalCase function
components), and the no-cycle guard's fifth conjunct (mutation-tested). Landed
in three commits after two independent-review rounds: a `silent-failure-hunter`
pass caught a missing `.catch()` on `HealthBanner`'s effect chain and an
unvalidated `/health` response shape (both fixed with regression tests before
push); the `claude-pr-review` bot's second pass then blocked on
`M3LConsoleWebError extends Error` instead of `Core.M3LError` — resolved with
a local error class, a filed follow-up (issue #724), and an explicit override
of the `review` required check with documented reasoning (see divergence #3).
Final state: 6 `src/` files (all but `main.tsx` individually ≥90/83/80/89%
coverage), 24 tests, `pnpm verify` 48/48 local steps passed (6 push-only
skipped).

**PR 2 — `feat/console-web-playwright` (X9b, staged, not yet pushed).** Adds
`playwright.config.ts` (Chromium only, `webServer` builds + `vite preview`s
the production bundle), one backend-free smoke spec, a dedicated
`tsconfig.e2e.json` (Playwright runs under Node, not the browser — needs
`process.env`, the opposite of the rest of the package), a new `console`
change-path category in `bin/lib/changed-paths.mjs` (path-scoped, not the
broad `ts` one — the whole point of scoping the Playwright job), the `e2e`
job in `ci.yml` (path-scoped + `e2e`-label-gated + push-to-main, feeding
`verify`'s aggregate), three new `skipReason` entries in
`bin/lib/verify-steps.mjs` so a routine `pnpm verify` doesn't pay for a full
Chromium install, and a dated ADR-0067 Update recording the CI-cost decision
and the two alternatives rejected. Tracker rows flip to Done in this PR
(`IMPLEMENTATION.md`, `ROADMAP.md`), plus a one-token stale-anchor fix
(`ROADMAP.md` pointed the X-series at `#cli-evolution-wave-u-series`).
`pnpm verify`: 48 passed, 9 skipped (6 push-only + gitleaks + the 3 new
`skipReason` e2e entries).

Skills used: starting-work, creating-prs (×2), syncing-docs (×2),
resolving-pr-comments, writing-work-logs.

Spoke incidents: none (0 truncations / 0 stalls / 0 `SendMessage` resumes
across 8 `test-author`/`code-implementer` dispatches).

## What went as planned

- **The RED/GREEN loop was clean on every dispatch.** Every `test-author` RED
  suite failed for the right reason (missing module import, never a syntax or
  logic error in the test itself — verified by the spoke before handing back
  each time); every `code-implementer` GREEN pass hit lint-clean,
  typecheck-clean, coverage-clean on the first attempt except one coverage gap
  (two defensive branches genuinely unexercised — closed with one more
  `test-author` round, not a code change).
- **The `.js`-extension-on-`.tsx`-imports question resolved cleanly.** The
  plan flagged this as a real open risk (`guard-js-extension.mjs` is
  unscoped, and it was unverified whether Vite's bundler resolution actually
  maps `./App.js` to `./App.tsx` on disk). A real `vite build` — not just
  `tsc` — confirmed it does; no hook-scoping fallback was needed.
- **The no-cycle guard's mutation test caught what it was built to catch.**
  Temporarily dropping the new `packages/m3l-console-web/src/**/*.{ts,tsx}`
  globs from the conjunction made `pnpm check:zones` fail exactly as
  expected, then passed clean on restore — the guard is load-bearing, not
  decorative.
- **`pnpm sync:docs` was a no-op both times.** Neither PR touched a
  `packages/m3l-common` public export, so provenance/counts/reference-index
  regeneration produced byte-identical output — confirms the doc-metadata
  surface correctly treats a new non-library package as out of scope.

## What didn't go as planned, and why

### 1. GitHub's Dependency Review hard-failed on a license `pnpm check:licenses` only warned about

`caniuse-lite` (pulled in transitively by `@vitejs/plugin-react`'s Babel
toolchain via `browserslist`) is licensed `CC-BY-4.0` — not on the shared
allow-list. `pnpm check:licenses` treats a dev-only-scope violation as a
non-blocking warning, but GitHub's `dependency-review-action` has no
concept of that scope split and failed the PR outright. Fixed by adding
`CC-BY-4.0` to both allow-lists (`.github/workflows/dependency-review.yml`
and `bin/lib/licenses.mjs`'s `ALLOWED_LICENSES`, which ADR-0036 requires to
stay textually identical) plus a dated amendment to ADR-0036 itself,
following the exact precedent the `MIT-0` addition (2026-08-17) already set.

**Why it happened:** ADR-0067 named "the repo's first browser dependency
tree... grows the update/audit surface" as an accepted cost in its own
Consequences section, but that was written in the abstract — nobody had
actually run a real `pnpm install` against a Vite/Babel toolchain yet to see
which _specific_ license would be the first to surface.

**Fix for future:** any package adding its first Vite/Babel/PostCSS-based
toolchain dependency should expect a `CC-BY-4.0` (browserslist data) hit on
the first PR and can go straight to the ADR-0036 allow-list addition rather
than treating it as a novel investigation.

### 2. The full quality-gate chain failed on the first run in a fresh worktree — not a real regression

`pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build` failed with
`bin/tests/script-scaffold.test.ts` reporting `packages/m3l-cli is not
built`. `dist/` is gitignored, and a freshly created `worktree:new` checkout
has none — the chain runs `test:coverage` _before_ `build`, so nothing had
populated it yet. Running `pnpm build` once first, then re-running the chain,
resolved it cleanly.

**Why it happened:** the four-gate command sequence in CLAUDE.md's Definition
of Done reads left-to-right as `lint && typecheck && test:coverage && build`,
but `bin/tests/*.test.ts` (specifically the scaffold checkers) has a runtime
dependency on `packages/m3l-cli/dist/` that only `build` satisfies — that
ordering assumption silently held in PR 1's worktree only because an earlier
`pnpm build` had already run there for unrelated reasons.

**Fix for future:** run `pnpm build` once immediately after `worktree:new`,
before the first `pnpm test:coverage` — do not assume the gate chain's
stated left-to-right order is safe to run cold in a brand-new worktree.

### 3. A `claude-pr-review` Must-fix was investigated and overridden, not blindly applied

The bot's second review pass on PR 1 required `M3LConsoleWebError` to extend
`Core.M3LError`, correctly observing that `packages/m3l-common/src/core/
errors/M3LError.ts` itself has zero `node:` imports. But the only reachable
path to that class is through the full `Core` namespace barrel (`exports`
has exactly three entries — `.`, `./core`, `./aws` — no per-submodule
subpath). Verified empirically rather than trusting the bot's implication:
temporarily added `@m3l-automation/m3l-common` as a dependency, imported
`Core.M3LError` from `main.tsx`, ran `vite build`. Result: 20 transformed
modules became 4,823 — the entire library, AWS SDK credential providers
included, with dozens of `node:fs`/`node:crypto`/`node:child_process`
"externalized for browser compatibility" warnings. The production build
technically succeeds (tree-shaking + the package's `sideEffects: false`),
but this is fragile in dev mode and directly contradicts ADR-0067's stated
"deliberately thin dependency policy" for this specific package.

Filed issue #724 (a lightweight `./core/errors`-style exports subpath — the
real fix, but a semver-relevant `exports`-map change needing its own plan)
and replied to the bot with the build evidence. `review` is a required
branch-protection status check with no code-only way to flip it to PASS
without either complying or a human admin override — the user (repo admin)
merged PR 1 themselves after reviewing that reasoning, rather than an
autonomous admin-bypass merge.

**Why it happened:** the bot's finding was locally correct (the leaf class
really has no `node:` imports) but did not — could not, without running a
real build — account for the fact that TypeScript module resolution and the
package's `exports` map make the leaf unreachable without its entire
transitive barrel.

**Fix for future:** when a review finding recommends importing across a
package boundary this repo hasn't crossed before, verify the actual bundle
impact with a real build before either complying or pushing back — "the
target file has no bad imports" is not the same claim as "importing it is
cheap," and only the build proves which one is true.

## Lessons learned

- **Verify a reviewer's claim about a file's imports against the actual
  reachable module graph, not the file in isolation.** A leaf module with
  clean imports can still be unreachable-except-through-a-heavy-barrel; the
  only way to know is a real build, not a `grep` of the target file
  (divergence #3).
- **A new toolchain's first transitive dependency license is predictable,
  not novel.** Vite/Babel-based frontends pull in `browserslist` →
  `caniuse-lite` (`CC-BY-4.0`) essentially every time; the next browser-target
  package in this repo should expect the same hit and go straight to the
  ADR-0036 allow-list amendment (divergence #1).
- **`dist/` being gitignored means a fresh worktree needs one `pnpm build`
  before the first `pnpm test:coverage`.** The four-gate command chain's
  stated order isn't self-sufficient in a cold checkout (divergence #2).
- **The existing "suite failure under fan-out may be contention" rule
  (`.claude/rules/tests.md`) held again.**
  `packages/m3l-console-server/tests/handler.test.ts`'s abort-signal
  assertion failed once mid-session (2 concurrent Claude sessions, per
  `check:host-resources`'s standing warning throughout this task) and passed
  clean on an immediate re-run in isolation — no new promotion needed, this
  confirms the existing lesson rather than adding one.
- **Mutation-testing a hardcoded-conjunction guard (like the no-cycle zone's
  four-then-five-glob check) is cheap and catches real regressions.** Drop
  the new predicate, confirm the checker fails, restore — takes seconds and
  proves the guard isn't decorative before it ships.
