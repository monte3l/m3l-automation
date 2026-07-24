# Work log — `core/script` log-level chain, ADR-0035 phase 4b (2026-07-23)

This log covers ADR-0035 phase 4b (A4b): resolving `M3LScript`'s default-logger
severity floor from the ambient CLI/env, the last P1 item of the ADR-0035
rollout. It ran the full hub-and-spoke pipeline (`starting-work` → RED → GREEN →
three-spoke review → two fix rounds → confirmation re-review →
`security-reviewer` at the PR gate → `syncing-docs` → `writing-commits` →
`creating-prs` → this log) and records what shipped, what matched the plan, what
diverged, and the durable lessons.

Plan of record: an in-session plan file (not tracked in the repo). Shipped as
[ADR-0035](../adr/0035-failure-reporting-and-diagnostics.md) phase 4b via PR
[#218](https://github.com/monte3l/m3l-automation/pull/218) (commit `fe25b69`).

## Summary

`M3LScript` now resolves its default logger's `minLevel` from the ambient
environment when the caller does not supply `options.logger`: precedence
**CLI > env > default** — `--log-level=<floor>`/`--debug` >
`M3L_LOG_LEVEL`/`M3L_DEBUG=1` > no floor — resolved once in the constructor so
`--debug`/`M3L_DEBUG=1` light up all nine stages including the pre-config ones. A
caller-supplied `options.logger` opts out entirely. New internal
`resolveLogLevelFloor` (`internal/logging/resolveLogLevelFloor.ts`) plus
`parseLogLevelFloor` + `LOG_LEVEL_FLOORS` in `internal/logging/levels.ts`;
constructor wiring via a private `buildDefaultLogger()`.

- **Config-file tier dropped, not deferred** (user decision, recorded as an
  ADR §2.5 carve-out): it can't affect config-load-time logs, and reaching the
  already-built default logger would need a public `M3LLogger` mutator or a
  rebuild that breaks `script.logger` identity. CLI + env cover the need.
- **Zero new exported symbols** — everything is `internal/`; `check:api`,
  `check:doc-exports`, `gen:index`, and provenance `sources[]` were all
  non-events, sidestepping the A3/A4a "new symbol missing from the sidecar" trap.
- **Tests:** `logging.test.ts` 220 (+ the resolver matrix + parser),
  `script.test.ts` 220 (+ constructor integration); full suite green.
- **Coverage:** exit 0, per-file ≥80% — `resolveLogLevelFloor.ts` 100% branches,
  `levels.ts` 90%, `M3LScript.ts` 97.2%.
- **Gates:** typecheck, lint, format, build, `check:api` (no exports-map change),
  `check:exports`, `knip`, `sync:docs` (14/14), `check:test-counts`, `lint:md`
  all green.
- **Review verdicts:** `code-reviewer` FAIL→CONFIRMED-clean, `spec-conformance`
  conformant, `silent-failure-hunter` CRITICAL→CONFIRMED-clean,
  `security-reviewer` (PR gate) clean.
- **End-to-end:** 12 built-`dist/` child-process probes all pass — floor honored
  per env/CLI; invalid/valueless/tied-spelling values exit `1` with
  `ERR_INVALID_ARGUMENT`; a custom logger + invalid env exits `0` (opts out).
- **Semver:** `feat(script):` minor, additive.

Skills used: starting-work, syncing-docs, writing-commits, creating-prs,
writing-work-logs.

Spoke incidents: 1 truncation / 0 stalls / 2 resumes. The `code-implementer`'s
GREEN report was cut mid-sentence ("Now check format and coverage."); disk state
was verified directly rather than trusted. Both fix rounds ran as `SendMessage`
resumes of the still-warm implementer and test-author (not fresh dispatches).

## What went as planned

- **RED failed for the right reason** — `Cannot find module
'…/resolveLogLevelFloor.js'` at import time, plus behavioral mismatches on the
  unwired constructor; never a bug in the test logic.
- **`check:api` was a non-event throughout**, exactly as the plan predicted:
  three new symbols, all `internal/`, so the three-entry `exports` map and its
  snapshot never moved. The whole "new export must reach the sidecar `sources[]`"
  hazard was designed out by keeping the resolver private.
- **The design fork was settled up front.** Asking the config-file-tier and
  invalid-value questions before planning (drop the tier + fail loud) collapsed
  A4b from "needs new `M3LLogger` API" to a constructor-local wiring change —
  the single biggest lever on the whole phase's size.
- **The two CLI/env config providers already exposed what was needed** —
  `parseArgv` for argv and a direct `process.env` read for the two reserved
  names — so no config schema and no new seam were required.
- **The confirmation re-review paid for itself** (as it did in A4a): both fix
  rounds were re-reviewed on the changed files only and came back
  CONFIRMED-clean with no new defect introduced.

## What didn't go as planned, and why

### 1. My RED dispatch told the implementer to swallow a valueless `--log-level`

The RED hand-off said that a bare `--log-level` (no value) should "fall through"
as if unset. `parseArgv` stores boolean `true` for a valueless flag, so the
resolver's `typeof === "string"` guard skipped it and dropped to the `--debug`/
env tier silently. `silent-failure-hunter` flagged this as a **CRITICAL**: an
operator who mistypes `--log-level` (missing `=value`, or a templating bug drops
it) intends to _change_ verbosity, and instead the run proceeds at the wrong
floor with no signal — the exact "must fail loud, must not be silently ignored"
contract, violated by my own instruction. Fixed so a present-but-non-string
`log-level` key throws `ERR_INVALID_ARGUMENT`.

**Why it happened:** I reasoned about `--log-level` as "explicit value present"
vs "absent" and missed the third state `parseArgv` actually produces — "present
but valueless" — then wrote the fall-through into the dispatch as an explicit
instruction, so the implementer built exactly the swallow.

**Fix for future:** a present-but-valueless explicit flag is _malformed input_,
not "unset" — fail loud. When a hand-off says "fall through on X," check whether
X is genuinely absent or just malformed; the parser's value domain (here a
`string | boolean` union) is the tell.

### 2. Floor resolution ran eagerly, before the `options.logger` check

The first GREEN put `resolveLogLevelFloor()` as a bare statement at the top of
the constructor, before `this.logger = options.logger ?? …`. All three reviewers
flagged it: a caller who brings their own logger still ate a construction-time
throw from a stray/invalid `M3L_LOG_LEVEL` whose resolved value was then
discarded. Fixed by moving resolution into a private `buildDefaultLogger()`
reached only on the `??` default branch, so a supplied logger opts out of the
machinery entirely (no read, no throw). A covering test (custom logger + invalid
env → constructs cleanly) was added.

**Why it happened:** "resolve the floor, then build the logger with it" read as
two sequential steps, so it landed as two sequential statements — but the resolve
step is _only_ meaningful for the default logger, and eager evaluation coupled it
to every construction.

**Fix for future:** side-effecting resolution that only feeds an
optional-default resource belongs _inside_ the default branch, not above the
`??`. If a value is discarded when the caller opts out, its computation
(including any throw) must be discarded too.

### 3. `LOG_LEVEL_FLOORS` derived through an unchecked type predicate

The first GREEN derived the six-member floor list by filtering `CATEGORY_RANK`
keys against a hand-maintained `TIED_RANK_ONE_ALIASES` set with a
`category is M3LLogLevelFloor` predicate — an _unchecked_ assertion. Adding a
category to `M3LLogLevelFloor`'s `Exclude` clause without updating the alias set
would silently accept an out-of-type value, with no compile error. Fixed to
derive from a `Record<M3LLogLevelFloor, true>` object literal (mirroring the
existing `CATEGORY_RANK: Record<M3LLogEventCategory, number>`), which the
compiler forces to stay exhaustive.

**Why it happened:** a filter + type-predicate _looks_ derived but launders a
runtime `Set` through an assertion; only a `Record<Key, …>` literal gives the
compiler both missing-key and excess-key enforcement.

**Fix for future:** to make a runtime list track a string-literal union without
drift, key it off a `Record<TheUnion, true>` and `Object.keys` it — never a
hand-set plus an `is`-predicate filter.

### 4. `sync:docs` step 1 tripped on staleness its own step 2 clears (recurring)

`pnpm sync:docs` failed at step 1 (`check:doc-provenance`) on
`script.provenance.json` staleness warnings — the same known sequencing quirk
where the composite's own step 2 (`--update`) exists to clear them. Worked around
by running `node bin/check-doc-provenance.mjs --update` manually first, then
re-running the composite (14/14 green). This is already in session memory
(`prettier-scans-gitignored-settings` sibling note) but bit again.

**Why it happened:** the composite runs the pre-flight verifier fail-fast before
the re-stamp step, so any source edit since the last stamp aborts it.

**Fix for future:** when a change touched a documented source file, run
`check-doc-provenance.mjs --update` _before_ `pnpm sync:docs`, not after it
fails. (Candidate: have `sync:docs` re-stamp-then-verify instead of
verify-then-re-stamp — filed below.)

## Lessons learned

- **Present-but-valueless ≠ absent.** A flag parsed to a boolean `true` because
  it carried no value is malformed explicit input — fail loud, never fall
  through to a lower tier. Check the parser's value domain (a `string | boolean`
  union is the tell) before writing "fall through on X" into a hand-off.
  _(promoted → .claude/rules/library-src.md)_
- **Discard the computation when the caller opts out.** Resolution that only
  feeds an optional-default resource must live _inside_ the `?? default` branch,
  not eagerly above it — otherwise a caller who supplied their own value still
  pays its cost (and its throw) for a result that's discarded.
  _(promoted → .claude/rules/library-src.md)_
- **Track a literal union at runtime with `Record<Union, true>`, not an
  `is`-predicate filter.** A `filter(x): x is T` launders a runtime set through
  an unchecked assertion and drifts silently; a `Record<Union, true>` literal +
  `Object.keys` gives compile-time exhaustiveness both ways.
  _(promoted → .claude/rules/library-src.md)_
- **Design the export surface to dodge the doc-metadata traps.** Keeping the
  resolver/parser `internal/` made `check:api`, `check:doc-exports`, `gen:index`,
  and the provenance `sources[]` all non-events — the cheapest way to avoid the
  A3/A4a "new symbol missing from the sidecar" failure is to add no new public
  symbol when the capability doesn't require one.
- **Settle the design fork before planning, not during GREEN.** Two upfront
  decisions (drop the config-file tier; fail loud on bad values) turned a
  "needs new `M3LLogger` API" phase into a constructor-local change. The
  question that most shrinks the work is the one about what _not_ to build.
- **Executed probes still beat read-throughs for the exit-facing contract.**
  The 12 `dist/` child-process probes proved the operator-visible behavior a
  reviewer reading code can't: that an invalid value exits `1` with the code on
  stderr and a custom logger exits `0`. Consistent with every ADR-0035 phase.

## Follow-ups filed

- **Candidate (unfiled):** invert `sync:docs`'s pre-flight ordering to
  re-stamp-then-verify (or make step 1 non-fatal on staleness that step 2 will
  clear), so a change touching a documented source file doesn't require the
  manual `check-doc-provenance.mjs --update` workaround. Recurring across A3, A4a,
  and A4b — flagging here for the next hooks/tooling pass rather than filing a
  tracker item.
- **A5** (ADR-0035, P2, pending) — template + consumer-script refresh: the
  scaffold composition root adopts `runScript()`, and the archival-vs-report
  `data/output/` directory split gets reconciled. Now unblocked (A4a/A4b both
  shipped); already tracked in `IMPLEMENTATION.md`/`ROADMAP.md`.
