# Work log — m3l-cli build-out, ADR-0042 activation 8b–8g (2026-08-14)

This log covers the full activation of ADR-0042's deferred `packages/m3l-cli`
design — re-assessment, the 8b–8g phased build, and the
`M3LConfigParameter.secret` library prerequisite — run as one continuous
hub-and-spoke session (plan mode → 8 PRs). It records what shipped, what
matched the plan, what diverged, and the durable lessons.

Plan of record:
[`docs/plans/archive/2026-08-14-m3l-cli-build-out.md`](../plans/archive/2026-08-14-m3l-cli-build-out.md)

## Summary

Shipped the complete script-facing CLI as a new zero-dependency workspace
package plus one library semver-minor, across 8 PRs:

- **#406** ADR-0042 activation record (revisit trigger 1 fired via issue
  #333) + the dist-first loader correction + hub-tooling registration of the
  new tracker section — merged.
- **#407** package scaffold + governance (ESLint type-stripping zone,
  import boundary, no-cycle, knip, tsconfig refs, reserved names) + 8b
  `list`/`inspect` — merged.
- **#415** 8c `run` with pass-through argv and verbatim child-exit
  propagation — merged.
- **#416** library `secret?: boolean` + `isSecret()` +
  `M3LConfigHelpFormatter` default-masking (m3l-common 2.2.0 → 2.3.0) —
  merged after a one-finding claude-pr-review FAIL→fix cycle.
- **#417** 8d dynamic per-script subcommands + shared table/cached-load
  dedup refactors — open at log time.
- **#418** 8e `doctor` (stacked) — open.
- **#419** 8f presets + history + secret threading (stacked) — open.
- **8g** wizard + closeout — this change set (final PR of the series).

Final state: 380 m3l-cli tests across 20 files (7,189 workspace-wide), every
src file over the per-file coverage gate; 15 review-spoke dispatches across
the series (code-reviewer ×5, type-design-analyzer ×3, security-reviewer ×3,
silent-failure-hunter ×3, docs-consistency-reviewer ×1) — every Must-fix
fixed and test-locked in the same PR, including two security Must-fixes
proven by execution (env-sourced secret default persisted into the discovery
cache; the same value rendered by `inspect`). The CLI's contract is
`docs/reference/cli.md`; trackers flipped to Done; ADR-0042 carries the
shipped note.

Skills used: starting-work, writing-commits, creating-prs, syncing-docs,
eslint-flat-config, resolving-pr-comments, writing-work-logs.

Spoke incidents: 13 writer-spoke truncations / 0 stalls / 12 SendMessage
resumes + 2 fresh-spoke handoffs (the 8f GREEN and security-fix passes were
finished by narrowly-scoped replacement spokes after their originals
exceeded ~300k tokens).

## What went as planned

- **The pre-build re-assessment paid for itself immediately** — the
  Explore fan-out found the one false assumption in ADR-0042's verified
  zero-dependency table (`json-etl`'s relative `.js` import breaks native
  type-stripping) before any code existed, and the dist-first loader that
  correction forced held unchanged through all six phases.
- **RED failed for the right reason in every phase** — all five RED passes
  produced only `Cannot find module` / missing-member failures; not one
  test-file defect required a GREEN-time rewrite of test logic.
- **The exhaustive `Record<M3LCliErrorCode, M3LCliExitCode>` map worked as
  designed** — all four post-8b code additions were forced to declare their
  exit class at compile time.
- **Adversarial security review with execution probes caught what reading
  missed, twice** — the cached secret-default leak (8f) and the unsound
  `defaultValue` help-rendering carve-out (library PR) were both proven with
  planted fixtures against built `dist/`, not inferred.
- **Stacked PRs kept the phases reviewable** while the claude-pr-review
  gate processed the merged prefix; GitHub retargeting handled the stack
  as it merged.

## What didn't go as planned, and why

### 1. Writer-spoke truncation dominated the run (13 incidents)

Nearly every substantial writer spoke (RED authors, GREEN implementers, fix
passes) stopped mid-turn at least once, ending with a narration fragment
instead of a report; the 8f GREEN pass truncated twice and was finished by a
fresh spoke scoped to the 11 remaining failures. All work survived on disk;
recovery was a `SendMessage` resume (or a fresh handoff when the original
exceeded ~300k tokens) plus a disk-state survey to scope the remainder.

**Why it happened:** the phase briefs bundled implement + full verify loop +
coverage reporting into single dispatches; on a 20-file test surface that
regularly exceeds what one spoke turn can narrate.

**Fix for future:** scope writer dispatches to ≤5 files with the verify loop
as the spoke's last act, demand terse work-then-report (no narration), and
when a resumed spoke passes ~250k tokens, prefer a fresh spoke briefed from a
disk-state survey over a second resume.

### 2. The reserved-name set grew three times and each growth had a drift tail

8b reserved six names; 8f added `presets`/`history`; 8g added `wizard`. Each
addition had to land in three literals (scaffold manifest, doctor's mirror,
and — discovered only by the 8g review — `dynamic.ts`'s suggestion pool,
which had silently missed both prior growths).

**Why it happened:** the three lists live in two module graphs (`bin/` ESM
scripts vs the package) so no shared import exists; the drift-guard test
added in 8e covered only two of the three copies.

**Fix for future:** when a constant must be mirrored across module graphs,
enumerate **every** copy in the drift-guard test the day the second copy is
born — grep for the literal's members, not just its name.

### 3. Parallel test-authors left stale cross-file pins

The 8b foundation/commands split and the 8f wide extension both left a few
pre-existing expected-literal pins stale (descriptor shapes without
`secret`, context shapes without `historyFilePath`, an old 4-member error
union), surfacing as tsc/vitest failures only after GREEN and costing three
micro test-passes.

**Why it happened:** each parallel spoke updated the files named in its
brief; nobody owned "every literal that pins the changed type," and
`expectTypeOf` pins don't fail until the type actually changes.

**Fix for future:** when a phase widens a shared type, the RED brief must
include a repo-wide sweep instruction — grep for the type name and every
`toEqualTypeOf`/`toEqual` literal of its shape — as an explicit numbered
step, not an implication.

### 4. Infrastructure flaked twice at push time

One pre-push failed on a vitest run inside the `check:test-counts` lane that
passed on immediate rerun; another failed when the rebase-triggered
`post-rewrite` regen and the pre-push's own `pnpm install` raced over
`node_modules/.bin/lefthook` (ENOENT on a file that existed seconds later).

**Why it happened:** the pre-push lanes run in parallel with hooks that may
themselves run `pnpm install`; two package managers touching `.bin`
concurrently is a known-shape race.

**Fix for future:** after a rebase that triggers regen hooks, let the
working tree settle (or run `pnpm install` once, foreground) before pushing;
treat a first pre-push failure in an infra lane as retry-once before
diagnosing.

## Lessons learned

- **Re-verify a deferred design's "verified" table before building** — a
  recorded verification is a snapshot; the `json-etl` type-stripping
  counter-example only existed because the fleet grew after the ADR. The
  fan-out re-assessment (repo + web + ADR in parallel) took under an hour
  and reshaped the loader design.
- **Scope writer spokes small; report terse** — see divergence 1. The
  single-phase-single-spoke pattern breaks down past ~5 files; the
  fresh-spoke-from-disk-survey recovery beat repeated resumes both times it
  was used. _(promoted → .claude/agents/code-implementer.md)_
- **Drift guards must enumerate every copy** — a two-of-three mirror test
  is a false comfort; the third copy drifts precisely because the test
  passes. _(promoted → .claude/rules/library-src.md)_
- **Widening a shared type owns its pin sweep** — stale `expectTypeOf`/
  literal pins are silent until GREEN; make the sweep an explicit RED-brief
  step. _(promoted → .claude/agents/test-author.md)_
- **Security claims need execution, not prose** — both proven leaks in this
  series (cache-persisted secret default; help-rendered env default) were
  invisible to reading and trivial to demonstrate with a planted fixture
  against built `dist/`. The mandatory security-reviewer on secret-touching
  phases is earning its cost.
- **Fail closed on optional security flags** — `descriptor?.secret === true`
  persisted a secret when the flag was merely absent; the writer now
  persists only on explicit `secret: false`. Optional booleans that gate a
  security behavior default to the safe side.
- **Content-free error categories beat cause-chain printing at render
  boundaries** — the preset-row diagnosability fix and the leak the naive
  fix would have caused were the same finding from two reviewers; classify
  by code, render categories, keep the cause chained but unprinted.
