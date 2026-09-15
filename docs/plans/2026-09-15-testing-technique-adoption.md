# Testing-technique adoption: mutation testing, PBT, and determinism hardening

**Decision of record:** [ADR-0104](../adr/0104-testing-technique-adoption.md).
That ADR holds the ten decisions, the declines and their rationale, the two
refuted "gaps", and the ADR-0015/0034 boundary. This document holds the
sequence and the countermeasure detail — the parts expected to move as the wave
lands.

## Why this wave exists

`.claude/rules/tests.md:20-36` mandates mutation testing and encodes its theory
correctly while automating, recording and enforcing none of it: a test can ship
with zero mutation evidence and pass every gate. Vacuous guards are this repo's
most-repeated recorded defect class (26 of 219 work logs mention
`mutation-test`, 29 mention `vacuous`, 17 mention a guard that "stayed green",
measured 2026-09-15).

The decisive argument is a harness one. Manual mutation testing edits real
source files, spokes run concurrently off a shared git stack, and
`tests.md:27-29` already concedes scripted mutation is unreliable. A spoke
truncating mid-mutation leaves the guard deleted or **inverted** under a
correct-sounding comment. Stryker mutates a sandbox copy, which is why
`--inPlace` is a hard prohibition rather than a preference.

## Landing plan

ADR-0072's durable slice record for this non-submodule multi-PR wave — the
same `## Landing plan` heading and `| Slice | Branch | Scope | Status |` table
a submodule's reference page carries, gated by `pnpm check:landing-plans`.

Slices land as **separate sequential PRs**, one open at a time: a squash-merged
parent turns a stacked child into duplicate history. Run
`pnpm check:review-size` before opening each.

| Slice | Branch                             | Scope                                                                                                                                                                                                                                                                                                                                                                       | Status            |
| ----- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| T1    | `feat/testing-technique-adoption`  | ADR-0104 recording all ten decisions, the declines, the refuted gaps and the platform-versus-test-generation boundary; this plan doc; the `re-affirmed-by: 0104` relations on ADR-0015 and ADR-0034; ADR-0034's stale `corepack` decision-driver swept via an in-file Update                                                                                                | Landed (PR #1270) |
| T2    | `feat/vitest-determinism-keys`     | All four Vitest configs gain `clearMocks`, an explicit `fakeTimers.toFake` plus `toNotFake: ["nextTick","queueMicrotask"]`, `sequence.seed`, and `typecheck.enabled`. Expect real fallout across the suite — that fallout **is** latent mock-leak and order-dependence surfacing. Settle the shuffle-seed-logging question here by observation                              | To Do             |
| T3    | `feat/tests-rules-tagging`         | Tag every `.claude/rules/tests.md` rule bullet `[enforced]`/`[advisory]`, each **verified against its gate source**; demote already-enforced bullets to one-line pointers; add `no-restricted-syntax` selectors (existing mechanism, no new plugin) for `setImmediate` retry-count waits, `not.toHaveProperty` on prototype-reachable keys, and `Date.now()` in time guards | To Do             |
| T4    | `feat/stryker-report-only`         | Stryker deps, `stryker.config.mjs` carrying every countermeasure in table A below, `pnpm mutate`, the scheduled workflow job, and `.stryker-tmp/` registered in every ignore surface. Report-only — no threshold yet. Record the measured score in ADR-0104 via an Update                                                                                                   | To Do             |
| T5    | `feat/mutation-survivor-gate`      | `bin/check-mutation-survivors.mjs` (new survivor versus stored baseline fails; pre-existing is ignored) with `bin/tests/` coverage, plus `thresholds.break` set just under the measured floor                                                                                                                                                                               | To Do             |
| T6    | `feat/pbt-infrastructure`          | `fast-check` + `@fast-check/vitest`, a setup file implementing the split seeding, the first surface (importers/exporters round-trip), and the scheduled varying-seed discovery job that files an issue and never blocks                                                                                                                                                     | To Do             |
| T7    | `feat/pbt-security-dangerous-keys` | `core/security` DangerousKeys properties — fast-check's by-design `__proto__` and null-prototype key generation is the point here, so `noNullPrototype` stays off for this surface alone                                                                                                                                                                                    | To Do             |
| T8    | `feat/pbt-polling-backoff`         | `core/polling` backoff invariants, replacing the `Math.random` pinning in `M3LBackoff`                                                                                                                                                                                                                                                                                      | To Do             |
| T9    | `feat/pbt-storage-seal-digest`     | `core/storage` seal + digest round-trip and single-byte-flip rejection                                                                                                                                                                                                                                                                                                      | To Do             |
| T10   | `feat/console-http-negative-tests` | `http-malformed-input.integration.test.ts` and `http-authz-rejection.integration.test.ts` reusing the existing real-socket harness (exempt from the no-network and `mkdtemp` rules per ADR-0100)                                                                                                                                                                            | To Do             |
| T11   | `feat/testing-harness-refinements` | `test-author.md` (RED-evidence journaling, PBT implementation guidance, hand-mutation to `pnpm mutate`), `code-implementer.md` (survivors are discovery input, not implementation failure), the Phase-4 mutation step in both implementing skills, and `vitest-testing/SKILL.md` with its `evals/evals.json`                                                                | To Do             |

### Ordering constraints that are not negotiable

- **T2 before T4.** `ignoreStatic: true` requires `coverageAnalysis: "perTest"`,
  and `perTest` produces a _corrupted_ score — not merely a faster one — when
  tests share mutable state. T2's `clearMocks` is what makes `perTest` sound.
- **T4 before T5.** `thresholds.break` cannot be set before a full run measures
  the floor. Setting it blind is the failure mode ADR-0104 decision 2 exists to
  prevent.
- **T6 before T7-T9.** The shared `fc.configureGlobal` setup file and the
  seeding split land once.

## Countermeasures

Countermeasures are config keys, flags, or gates — not guidelines. Where only a
guideline is available, it says so.

### Table A — Stryker (mutation testing)

| Pitfall                                         | Manifests                                                                                                                                                                | Deterministic countermeasure                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm breaks plugin auto-detection               | `typescript-checker` silently never loads; tsc-invalid mutants counted as survivors, poisoning the score                                                                 | `plugins: ["@stryker-mutator/vitest-runner", "@stryker-mutator/typescript-checker"]` — explicit, mandatory under pnpm                                                                                     |
| Strict-TS mutants that cannot compile           | Inflated survivor count, unexplained on a strict repo                                                                                                                    | `checkers: ["typescript"]` with `tsconfigFile` pinned                                                                                                                                                     |
| Timeout false-kills under contention            | Slow-but-finite mutants time out, are falsely reported **killed**, and **inflate** the score. The default `timeoutMS: 5000` collides with the 5-second starvation canary | Never run concurrently with other gates (own scheduled job, own runner); raise `timeoutFactor` to about 2.0 and raise `timeoutMS`; pin `concurrency` explicitly rather than defaulting to cores minus one |
| Sandbox versus real tree                        | —                                                                                                                                                                        | **Never pass `--inPlace`.** The default sandbox is the safety property being bought                                                                                                                       |
| Sandbox breaks path-dependent tests             | Tests asserting absolute paths, or creating their own temp dirs, fail only under Stryker                                                                                 | Keep `symlinkNodeModules: true`; relative paths and `import.meta.url`; `ignorePatterns` for heavy directories                                                                                             |
| Incremental staleness                           | Silently stale score after a dep bump, config change or env change — the cache only watches source and test edits                                                        | Incremental only for the advisory PR delta; the scheduled full run is the score of record; `--force` on any config or dep change                                                                          |
| `--since` scores are incomparable to a baseline | A PR "passes" at 75% on changed code while `main` sits at 90%                                                                                                            | Never gate on a `--since` score; gate only via the survivor-diff script                                                                                                                                   |
| Only `thresholds.break` fails the process       | `high` and `low` are cosmetic; a plan setting only those gates nothing                                                                                                   | Set `break` explicitly once measured (T5)                                                                                                                                                                 |
| Equivalent and immortal mutants                 | Score plateaus; survivors no test can kill                                                                                                                               | `// Stryker disable next-line <mutator>: <reason>` inline, or `mutator.excludedMutations`. Maps one-to-one onto `tests.md`'s existing equivalent-mutant rule                                              |
| Static mutants                                  | Load-time code mutants distort the score, at large perf cost                                                                                                             | `ignoreStatic: true` — **requires** `coverageAnalysis: "perTest"`                                                                                                                                         |
| `perTest` can be _wrong_, not just faster       | Tests sharing mutable state produce a corrupted score                                                                                                                    | Why T2's `clearMocks` lands before T4                                                                                                                                                                     |
| No survivor-set diffing                         | Cannot tell a new survivor from a pre-existing one                                                                                                                       | `bin/check-mutation-survivors.mjs` over the JSON report — this repo's own gate idiom                                                                                                                      |

### Table B — fast-check (property-based testing)

| Pitfall                                        | Manifests                                                                                      | Deterministic countermeasure                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-reproducible failures — the core objection | A PR fails on a counterexample unrelated to its diff                                           | `fc.configureGlobal({ seed: <fixed>, numRuns })` on the blocking path; varying seed only on the scheduled discovery job; pin every counterexample into `examples: [[…]]` forever. The library recommends a varying seed; a blocking path here cannot accept one |
| Unbounded wall-clock                           | A property run starves a contended host                                                        | `interruptAfterTimeLimit` with `markInterruptAsFailure: false`                                                                                                                                                                                                  |
| Filter exhaustion                              | "too many pre-condition failures"; nondeterministic timeouts                                   | _Construct_ inputs via `.map`/`.chain` instead of `.filter`; `maxSkipsPerRun` as the bound                                                                                                                                                                      |
| Prototype-polluting keys generated by default  | `fc.object()` and `fc.anything()` emit `__proto__` and null-prototype keys **by design** in v4 | A _feature_ for `core/security` (T7); elsewhere set `noNullPrototype: true`                                                                                                                                                                                     |
| Float and NaN surprises                        | `-0`, `NaN`, `±Infinity` counterexamples that are not real defects                             | `fc.double({ noNaN: true, noDefaultInfinity: true })`                                                                                                                                                                                                           |
| Bias hiding bugs                               | `fc.nat()` biases small                                                                        | `fc.noBias(...)` where uniformity matters                                                                                                                                                                                                                       |
| Cross-run state leakage                        | Passes alone, fails in a full run                                                              | `.beforeEach()` / `.afterEach()` on the property itself, not just the suite                                                                                                                                                                                     |
| Mutating the generated input                   | Shrinking misreports the counterexample                                                        | Clone before mutating — **owner-guideline only**, no config key exists                                                                                                                                                                                          |
| Coverage distortion                            | Repeated runs inflate apparent branch coverage                                                 | Treat property-test coverage as diagnostic; keep per-file thresholds driven by the unit suite                                                                                                                                                                   |
| Async races                                    | Interleaving bugs appearing once in 500 runs                                                   | `fc.scheduler()` + `waitAll()`, reproducible under a seed. Documented limit: controlled promises only — **not** real timers, **not** real I/O                                                                                                                   |

### Table C — existing techniques, refinements

| Pitfall                                            | Manifests                                                                                                                      | Deterministic countermeasure                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mock state bleeds across tests                     | Intermittent failures only in full runs; `restoreAllMocks()` does **not** clear a `vi.fn()` created inside a `vi.mock` factory | `clearMocks: true` (or `mockReset`) repo-wide in all four configs — replaces per-file `afterEach` discipline                                                                                  |
| `nextTick` faking unsupported with `pool: "forks"` | Promise-chained fake-timer code deadlocks; all four configs use `forks`                                                        | `fakeTimers: { toFake: [...explicit], toNotFake: ["nextTick", "queueMicrotask"] }`; `vi.advanceTimersByTimeAsync` / `runAllTimersAsync`                                                       |
| Test-order dependence never exercised              | An order-dependent suite stays green forever                                                                                   | `sequence.shuffle` **with** `sequence.seed` — shuffle without a seed is unreproducible. Whether Vitest auto-logs the seed is **unsettled**: settle it in T2 by running it once, do not assume |
| `expectTypeOf` not gated by the runner             | Vitest transforms without typechecking, so type tests can rot                                                                  | `test.typecheck.enabled` — **in addition to**, never instead of, `pnpm typecheck`                                                                                                             |
| Zero-test files invisible to the coverage gate     | `coverage.all: false` (the v8 default) means a shipped, wholly-untested file trips nothing                                     | `all: true` would also make _unimplemented_ modules fail — `false` is deliberate per `vitest.config.ts:72-74`. Prefer a scoped `bin/check-untested-files.mjs` over flipping the flag          |
| Playwright retries mask real bugs                  | Green-on-retry hides a genuine defect                                                                                          | Web-first retrying assertions and `expect.poll()` over test-level `retries`; `trace: "on-first-retry"`; `--workers` sized to host memory                                                      |
| CodeQL default setup cannot take custom queries    | A custom query silently does nothing                                                                                           | Accepted: staying on `default` (ADR-0104 decision 8). Custom queries would require migrating to advanced setup                                                                                |

## Harness, rules and practice refinements

`.claude/rules/tests.md` carries **38 rule bullets and zero
`[enforced]`/`[advisory]` tags**, while `docs/contributing/style-guide.md` uses
that tagging **71 times** (both measured 2026-09-15). A reader cannot tell
discipline from enforcement — and the rules left advisory are exactly the ones
the recurring defects come from.

The denominator is worth stating precisely, because T3 has to tag every one of
them: the file has **39 top-level bullets**, of which the first
(`.claude/rules/tests.md:13-15`) is a cross-reference pointer to
`style-guide.md` Part 2 rather than a rule — leaving **38 rules to tag**. A
naive `grep -cE '^[[:space:]]*- '` returns 41 because it also counts the two
YAML frontmatter `paths:` entries at `tests.md:3-4`; that miscount was made and
corrected during this slice's own review, which is a fair warning about how the
count behaves.

> **Do not inherit the proposed classification.** An earlier pass proposed a
> 9-enforced/8-mechanizable-now/7-mechanized-by-this-plan/14-advisory split over
> those 38 bullets. The denominator is right, but the split is still not
> trustworthy, because spot-checking found a substantive error in it: the
> "justify intentional `eslint-disable`" bullet was reported as already-enforced
> by `reportUnusedDisableDirectives`, but that flags _unused_ directives, and
> `guard-eslint-disable-red.mjs` blocks RED-phase-noise disables while merely
> _parsing_ `-- reason`. **Nothing requires a rationale** — that bullet is
> advisory, not enforced. One confirmed misclassification in a spot-check of a
> 38-way split means the whole split needs re-deriving, not patching. Tagging a
> rule `[enforced]` when nothing enforces it is worse than no tag. Verify each
> bullet against its gate source, per the repo's own standing rule that a gate
> is defined by its `bin/*.mjs` source, not nearby prose.

Refinements, all in T11 unless noted:

1. **`test-author` records RED evidence.** It is told to confirm the expected
   red but never told to record the failure output, so the hub receives an
   unverifiable verbal claim — and truncation can hide a failure entirely.
   Require the RED failure text in the dispatch journal
   (`guard-writer-dispatch-journal.mjs` already warns when a journal path is
   missing).
2. **`test-author` gains PBT implementation guidance** — `test.prop`, the
   fixed-seed convention, `examples: [[…]]` pinning. The hub supplies the
   invariants (ADR-0104 decision 5), so the spoke's charter and tier are
   unchanged.
3. **The hand-mutation instruction becomes `pnpm mutate`.** The bullet at
   `tests.md:27-29` about verifying a scripted mutation actually changed the
   file becomes **obsolete** — it exists only because hand mutation was
   unreliable.
4. **Mutation verification gets a phase.** Both `implementing-submodules` and
   `implementing-scripts` run Contract, RED, GREEN, Review, with mutation
   verification currently unassigned. Insert it as the first step of Phase 4.
5. **`vitest-testing/SKILL.md`** documents the new config keys, the seed policy,
   `test.prop` and `pnpm mutate`, and corrects advice premised on mocks _not_
   being auto-cleared. Editing a `SKILL.md` requires its `evals/evals.json`
   updated in the same PR (at least 3 cases, at least 3 checklist entries each).
   Phrase eval criteria as asserted _text_, never as an action or as ordering
   versus a return.
6. **No new hooks.** Dispatch-side coverage (journal reminder plus truncation
   detection) is already solid, and a "test written without mutation evidence"
   hook cannot distinguish "no mutation run yet" from "mutation run pending" on
   a `FileChanged` signal. Test-side gaps belong in ESLint (T3).
7. **No new spoke.** Extend `test-author`. The promotion trigger is recorded in
   ADR-0104 decision 10.

## Verification

Per-slice gates are named in the table above. Wave-level:

- `pnpm verify --continue` green — **without `--continue`, one early failure
  silently skips every later step.**
- `pnpm test:coverage` **plus** the bin, web and integration configs run
  explicitly: `pnpm verify` omits the bin and integration runs, so a green
  verify can still fail the push.
- `pnpm lint` (both lanes), `pnpm typecheck`, `pnpm build`.
- `pnpm knip`, `check:deps`, `check:licenses`, `check:dup`.
- `check:cadence`, `check:verify-parity`, `check:command-catalog`,
  `check:workflows`, `check:workflows-doc`.
- `check:test-counts`, `check:test-fs-isolation`, `check:file-budget`,
  `check:review-size`.
- `check:agents`, `check:skill-frontmatter`, `check:skill-evals`, `check:hooks`.
- ADR gates: `check:adr-index`, `check:adr-claims`, `check:adr-provenance`,
  `check:adr-worthiness`.
- `pnpm mutate` completes, and the survivor-diff gate fails on a seeded new
  survivor.
- `check:host-resources` before any concurrent run; never `--no-verify`.
- Provenance order respected: format, then stamp, then `gen:index`.

**The `review` check ignores markdown-only PRs**, so T1's diff needs the
reviewer spokes run against it by hand rather than trusting a green check.
