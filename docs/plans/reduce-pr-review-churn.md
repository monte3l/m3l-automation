# Plan: Cut PR-review churn by intercepting findings before the PR

## Context

Recent PRs needed far more `claude-pr-review` bot rounds than they should have:

| PR  | Branch / type                          | Rounds | Dominant finding class                                |
| --- | -------------------------------------- | ------ | ----------------------------------------------------- |
| #25 | core/environment (feat)                | 10+    | real-fs in unit tests; untested documented branches   |
| #23 | deterministic-lint-automations (chore) | 8 PASS | hook-script nits re-flagged every round               |
| #20 | encode-security-lessons (chore)        | 5      | regex false-negatives in a hook; doc/semver drift     |
| #22 | resolve-pr-comments skill (feat)       | 5      | SKILL.md shell bugs (gate bypass, heading mismatch)   |
| #21 | sync-docs-coverage (chore)             | 5 PASS | hook path-normalization bug; missing `process` import |
| #24 | write-work-log skill (chore)           | 5 PASS | one new doc/eval-metadata issue surfaced per round    |
| #16 | optimize-session-interactions (feat)   | 4      | silent error-swallowing in `bin/check-deps.mjs`       |
| #26 | core/utils (feat)                      | 2      | orphaned TSDoc block                                  |

An audit of every bot comment on these PRs shows the churn has **four structural
root causes** plus **one behavioral multiplier**:

1. **The automation layer is unlinted, untested, and unaudited.** `bin/*.mjs`
   (6 validators) and `.claude/hooks/*.mjs` are excluded from ESLint
   (`eslint.config.js` ignores `bin/**` and `.claude/**`) and have **no unit
   tests** (vitest includes only `*.test.ts`; coverage only
   `packages/*/src/**`). This produced nearly all chore-PR findings: silent
   error-swallowing (`check-deps.mjs`, #16), regex false-negatives discovered
   across two rounds (`guard-eslint-disable-red.mjs`, #20), variable shadowing
   (#20), missing `process` import + no-op `path.join` + path-normalization bug
   (#21), missing `cause` chaining (#16). ESLint would have caught most; unit
   tests on the parse/regex logic the rest.
2. **Library tests escape two checks no gate enforces:** real filesystem I/O in
   "unit" tests (6 instances on #25 — green locally only because the real walk-up
   coincidentally finds `pnpm-workspace.yaml` in CI) and coverage of _documented
   branches_ (`CI=1`, `JENKINS_URL`, 5 `credentialSource` arms — the 80% gate is
   met while specific arms stay unverified).
3. **Type/design + spec findings reach PR** because the review spokes
   (`type-design-analyzer`, `security-reviewer`, `spec-conformance-reviewer`,
   `silent-failure-hunter`) run only inside `implement-submodule`, **never on the
   final integrated branch** `create-pr` actually pushes (post-rebase/merge).
4. **Doc-sync drift recurs and is fixed by hand every time:** CLAUDE.md commands
   table vs `package.json` scripts (#16); CLAUDE.md hook enumeration vs
   `.claude/hooks/` on disk (#20, #21); stale in-file counts (#23).
5. **Behavioral multiplier (code-type-independent):** the bot surfaces a _new_
   finding/instance **each round** instead of sweeping a class in one pass, and
   **re-raises identical non-blocking nits every round with no state**
   (#23 = 8 all-PASS rounds). `use_sticky_comment: true` is also not collapsing —
   #25 has 14 separate comments (each `created_at == updated_at`).

Direction (confirmed with the user): **prevention-first.** Drive the round count
toward 1–2 by catching each class locally before the PR opens, fixing the bot's
round-multiplying behavior, and layering low-risk config wins. The review **model
stays Sonnet** — this is a blocking release gate; quality must not regress.

---

## 1 — Bring the automation layer under ESLint + targeted tests (root cause #1)

The single largest fix for chore/automation PRs.

**1a. ESLint scope.** In `eslint.config.js`, stop ignoring `bin/**` and the
`.claude/hooks/**` scripts (keep ignoring the rest of `.claude/**` — evals,
skills, agents). Add a dedicated flat-config block for these Node `.mjs` scripts
(no TS project service; Node globals) enabling the rules that would have caught the
real findings:

- `no-empty` / `@typescript-eslint/no-unused-vars` — empty/again-swallowed catches.
- `@typescript-eslint/no-floating-promises` (or core `no-floating-promises`
  equivalent) — unchecked async.
- `no-shadow` — the #20 `raw` parameter shadowing.
- `prefer-promise-reject-errors` / a `cause`-chaining lint or review note — the
  #16 missing-`cause` case.
- Keep the ESM/`no-restricted-globals` rules these scripts already should obey.

**Where:** `eslint.config.js` (the `ignores` block at lines 11–17, and a new
`files: ["bin/**/*.mjs", ".claude/hooks/**/*.mjs"]` block). **Verify:** `pnpm lint`
now lints those files; fix the existing findings the bot already enumerated
(missing `process` import, `no-shadow`, no-op `path.join`, etc.) so the scope
change lands green.

**1b. Targeted unit tests for the parse/regex logic** — the classes ESLint can't
catch. Cover, table-driven:

- `guard-eslint-disable-red.mjs` — all four disable forms × single/multi-line ×
  variant suffixes (`-next-line`, `-line`), the exact #20 blind spots.
- `bin/check-deps.mjs` — JSON parse on warning-prefixed pnpm output (the #16 false
  "clean"), and non-zero `pnpm install` exit handling.
- `guard-doc-counts.mjs` — relative vs absolute path normalization (the #21 bug).

**Where:** a new `bin/tests/` (or `tests/tooling/`) with `*.test.ts` importing the
scripts' pure functions — which may require a small refactor to export the
parsing/regex helpers from each script (entry stays a thin `main()`). **Verify:**
`pnpm test` runs them; each test reproduces the historical bot finding as a failing
case, then passes against the fixed code.

---

## 2 — Static test-isolation rule for library tests (root cause #2, part A)

Add an ESLint rule flagging real, _mutating_ filesystem (and network/process) calls
in test files — the #25 smell where pure unit tests called `fs.mkdtempSync` /
`mkdirSync` / `writeFileSync` / `rmSync` against live `/tmp`. Read-only methods that
tests legitimately `vi.spyOn` (`existsSync`, `readdirSync`, `accessSync`) are **not**
banned; target the create-temp-dir-and-write pattern that is never valid in an
isolated unit test.

**Where:** `eslint.config.js`, extend the existing test-file override
(lines 146–152, `files: ["**/tests/**/*.ts", "**/*.test.ts"]`) with a
`no-restricted-syntax` entry matching `CallExpression` on a denylist of mutating
`fs`/`fs/promises` methods + `child_process` spawn/exec + bare global `fetch(`. The
message points to `vi.spyOn(fs, ...)` / `vi.mock`. **Why this mechanism:**
deterministic, runs automatically in `post-edit-verify.mjs` (per-edit), `pre-push`,
and CI — the author sees it the moment the test is written. **Verify:** a temp test
calling `fs.mkdtempSync` fails `pnpm lint`; rewritten with `vi.spyOn` it passes;
**zero false positives** across the 5 existing submodule suites (hardened on #25).

Add a one-line note to `.claude/agents/test-author.md` that temp-dir/real-fs is
banned and `vi.spyOn(fs, ...)` is the only sanctioned approach, so the rule has a
rationale the writer spoke already states.

---

## 3 — Pre-PR review gate in create-pr (root causes #2 part B, and #3)

Catch branch-coverage gaps and type/design/spec defects on the **integrated diff**
before the PR opens, mirroring what the CI bot checks.

**Where:** `.claude/skills/create-pr/SKILL.md`.

- **Tighten Step 2:** switch `pnpm test` → `pnpm test:coverage` so the 80% gate and
  branch holes are caught locally (matches `resolve-pr-comments` Step 6 + CI).
- **New step between Step 2 and push:** on any `src/**` change in
  `git diff main...HEAD`, fan out in one message: `code-reviewer` +
  `spec-conformance-reviewer`, plus `type-design-analyzer` (public types change),
  `silent-failure-hunter` (error/async paths), `security-reviewer` (aws/secrets/
  logging) — the exact fan-out rule already encoded in
  `implement-submodule` Phase 4 (lift it verbatim so the two stay consistent). For
  docs/automation-only diffs, dispatch `docs-consistency-reviewer` instead. Loop any
  Must-fix back before pushing.

**Reuse:** the spoke agents already exist under `.claude/agents/`. **Verify:** on a
branch with a deliberately impure test or an `any`, the skill surfaces it and
refuses to push until fixed.

---

## 4 — Doc-sync enforcement (root cause #4)

Extend the existing `bin/check-doc-counts.mjs` / `check-scaffold.mjs` pattern with
two new sync checks, wired into CI (and `pre-push` if cheap):

- **Commands table ↔ scripts:** every `package.json` `scripts` entry intended to be
  user-facing appears in CLAUDE.md's Commands table, and vice-versa (the #16 miss).
- **Hooks enumeration ↔ filesystem:** every `.claude/hooks/*.mjs` registered in
  `.claude/settings.json` is listed in CLAUDE.md's hooks section, and vice-versa
  (the #20/#21 misses).

**Where:** a new `bin/check-doc-sync.mjs` (or extend `check-doc-counts.mjs`), a
`check:doc-sync` script in `package.json`, and a CI step alongside
`check:doc-counts`. **Verify:** deleting a Commands-table row or adding an
unlisted hook makes the check fail with a precise diff.

---

## 5 — Stop the bot from multiplying rounds (root cause #5)

File: `.github/workflows/claude-pr-review.yml`. All user-approved.

1. **Exhaustive-sweep instruction** (add after the Testing section, ~line 58): when
   a finding is an instance of a class (real-fs in a test, an untested documented
   branch, a regex blind spot, a doc-sync drift), **grep/enumerate every instance
   in the diff and list them all in one comment** — never one-per-round. Biggest
   round-count lever after prevention.
2. **Suppress repeated non-blocking nits:** on re-review, do **not** re-raise a
   non-blocking nit already reported in a prior PASS comment; re-check only Must-fix
   items and newly changed lines. (Directly targets #23's 8 all-PASS rounds and
   #24's drip-feed.)
3. **`use_sticky_comment` fix:** investigate why #25 produced 14 distinct comments
   instead of one updated comment (check the `anthropics/claude-code-action@v1`
   sticky marker vs the verdict-file flow); adjust so each round updates a single
   comment. Diagnosis task — exact fix depends on findings.

**Verify:** a code PR with two same-class issues → both listed in one comment; a
second push that fixes one nit and leaves an old nit → the old nit is not re-raised;
only one sticky comment exists per PR.

---

## 6 — Low-risk workflow efficiency (claude-pr-review.yml)

1. **`fetch-depth: 0` → `1`** (line 24) — no blame/history analysis is done; aligns
   with `claude-assistant.yml`.
2. **`--max-turns 25` → ~12** (line 29) — #25's invocations finished in 1–3 turns.
3. **Add a `paths` filter** to the trigger (lines 4–6) so doc-only / CI-config-only
   pushes don't spend a full Sonnet review — mirror the `lint:md` exclusion set in
   `package.json`. Confirm a mixed code+doc PR still triggers (paths-ignore skips
   only when _every_ changed file matches).

`concurrency: cancel-in-progress` is already present (lines 13–15) — keep it.

---

## Verification checklist

- [ ] `pnpm lint` now covers `bin/**/*.mjs` and `.claude/hooks/**/*.mjs`; pre-existing
      bot-flagged findings there are fixed and the scope change is green.
- [ ] New tooling unit tests reproduce the #20 regex / #16 parse / #21 path-norm
      findings as failing-then-passing cases; `pnpm test` runs them.
- [ ] `pnpm lint` fails on a mutating-fs call in a `*.test.ts`, passes once rewritten
      with `vi.spyOn`; **zero false positives** across the 5 existing submodule suites.
- [ ] `create-pr` runs `pnpm test:coverage` and dispatches the right review spokes on
      the integrated diff; refuses to push on a Must-fix; skips spokes for
      doc/automation-only diffs (uses docs-consistency-reviewer there).
- [ ] `check:doc-sync` fails when the Commands table or hooks enumeration drifts from
      `package.json` / the filesystem; wired into CI.
- [ ] Bot lists all same-class findings in one comment; does not re-raise prior
      non-blocking nits on re-review; only one sticky comment per PR.
- [ ] Docs-only PR does not trigger `claude-pr-review.yml`; mixed code+doc PR does.
- [ ] `pnpm typecheck && pnpm lint && pnpm test:coverage && pnpm build` all green.
- [ ] No change to the review **model** (Sonnet) or the blocking verdict mechanism.

## Out of scope / explicitly not doing

- Downgrading the review model to Haiku (quality risk on a blocking release gate).
- Adding knip / gitleaks / `pnpm audit` to `pre-push` (CI-only by design; not a
  driver of the observed churn).
- A global vitest fs-guard setup file (user chose the ESLint-rule mechanism, which
  covers the observed smell without a runtime shim).
- Full 80%-gated coverage of every validator/hook (the chosen scope is lint +
  targeted tests for the parse/regex logic that actually caused findings).
- Promoting `tsdoc/syntax` to `error` or adding a "missing-TSDoc" rule — noted as the
  residual gap behind #26's orphaned-doc and #25's `@example` findings, but the
  tsdoc plugin only checks syntax; deferred until the API stabilizes.
- Commit-prefix-vs-PR-intent semver checks (#20/#21 `fix:` in chore PRs) — left as
  reviewer guidance, not a new gate.
