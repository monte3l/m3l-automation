# 0104. Mutation testing and property-based testing are adopted; the SAST-platform bar is not reopened

- **Status:** Accepted
- **Date:** 2026-09-15
- **Review by:** 2026-12-15
- **Deciders:** Enrico Lionello

## Context and problem statement

An audit asked how this repo's testing techniques compare to current
TypeScript-ecosystem practice — chaos engineering, fuzzing, SAST, DAST,
property-based testing (PBT), mutation testing — and which are worth refining
or adopting. The answer is an asymmetry, and naming it is the whole point of
this ADR.

**The static and supply-chain half is saturated and deliberately governed.**
CodeQL, Dependabot, Scorecard, SHA-pinned Actions, `pnpm audit`,
`check:licenses`, `sonarjs/cognitive-complexity` and `jscpd` are all in place
under [ADR-0015](./0015-code-scanning-tooling-evaluation.md) and
[ADR-0034](./0034-sonar-act-podman-reassessment.md). Adding a SAST platform
here would re-litigate a standing decision, not close a gap.

**The test-generation half has one real hole, and it is the important one.**
`.claude/rules/tests.md` _mandates_ mutation testing and encodes its theory
correctly — equivalent mutants, mutations that never applied, guards that go
vacuous later (`.claude/rules/tests.md:20-36`) — while automating, recording,
and enforcing none of it. A test can ship with zero mutation evidence and pass
every gate.

That hole matters because **vacuous guards are this repo's most-repeated
recorded defect class.** Measured against `docs/logs/` on 2026-09-15 (220 work
logs): 26 mention `mutation-test`, 29 mention `vacuous`, and 17 mention a guard
that "stayed green". The maintainer's own recurring-insight index corroborates
the same class independently across roughly ten distinct incidents.

**The decisive argument is a harness one, not a test-quality one.** Manual
mutation testing edits real source files. Spokes run in worktrees off a shared
git stack, the hub dispatches them concurrently, and `tests.md:27-29` already
concedes that scripted mutation is unreliable — "verify a scripted mutation
actually changed the file (e.g. after a Prettier reflow) before trusting a
'survivor'". A spoke truncating mid-mutation leaves the guard deleted or, worse,
**inverted** under a correct-sounding comment. Stryker mutates a sandbox copy,
so that entire failure class disappears.

### Two claimed gaps were refuted before this ADR was written

Both were fan-out findings; both are false, and recording them here is what
stops them being re-filed.

| Claimed gap                                   | Verified reality (2026-09-15)                                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "No CodeQL analysis"                          | **False.** CodeQL default setup reports `state: configured` for `actions`, `javascript`, `javascript-typescript` and `typescript`, on the `default` query suite. No `codeql.yml` exists because default setup needs no workflow file — ADR-0034 says exactly this. |
| "No push protection / native secret scanning" | **False.** Live repository settings report `secret_scanning: enabled` and `secret_scanning_push_protection: enabled`.                                                                                                                                              |

Three further "gaps" are standing decisions rather than oversights: Semgrep /
Sonar / Snyk / Codacy / Codecov were rejected as redundant in ADR-0015 and
re-assessed in ADR-0034, which filled the two named residual gaps with OSS
rules instead; SBOM and npm provenance are moot per ADR-0015's 2026-07-06
Update (no publish path to attest,
[ADR-0020](./0020-drop-release-automation.md)); and Trivy is adopted
**scheduled-only** in `.github/workflows/security-audit.yml`, a deliberate
per-PR cost decision.

## Decision drivers

- **ADR-0015's standing bar holds:** each new gate must cover something not
  already covered (`docs/adr/0015-code-scanning-tooling-evaluation.md`,
  Decision drivers). This ADR clears that bar rather than weakening it.
- **That bar has only ever been applied to SAST _platforms_.** There is zero
  prior mention of `stryker`, `fast-check`, `property-based`, `jazzer` or
  `quickcheck` anywhere in `docs/`, `.claude/` or `REVIEW.md` (verified
  2026-09-15). This is a clean slate, not a reopened decision.
- **No new non-Node prerequisite.** ADR-0034 declined Act/Podman partly to keep
  contributor prerequisites minimal; a separate Go or JVM binary is refused on
  the same ground.
- **A blocking gate must be reproducible.** This repo cannot accept a gate that
  fails a PR on an input unrelated to its diff.
- **Never run a heavy analysis concurrently with other gates.**
  [ADR-0080](./0080-host-resource-budgeting.md) and the documented 5-second
  starvation canary make host contention a first-class constraint.
- Minimal dev dependencies; findings should be able to block a merge rather
  than be merely advisory (both inherited from ADR-0015).

## Considered options

1. Adopt nothing; keep mandating manual mutation testing in prose.
2. Adopt a SAST platform (Semgrep/Sonar/Snyk) as the "missing" coverage.
3. Adopt mutation testing (Stryker) and property-based testing (fast-check) as
   test-generation techniques, leave the SAST-platform decision untouched, and
   mechanize the subset of `tests.md` that can be mechanized.
4. Adopt option 3 plus a coverage-guided fuzzer (jazzer.js) and a network fault
   injector (Toxiproxy) for chaos coverage.

## Decision

We chose **option 3**. Option 1 leaves the repo's most-repeated defect class
unautomated and keeps a documented-unreliable manual procedure on the critical
path. Option 2 re-litigates ADR-0015/0034 and covers nothing new. Option 4 adds
prerequisites ADR-0034 already declined on principle.

Concretely, ten decisions:

1. **Stryker** runs as a **scheduled full run over `packages/m3l-common`**,
   which is the **score of record**, plus an **advisory `--since` delta** on
   PRs. Never at `pre-push`.
2. **The mutation gate is measured before it is set.** Report-only first, then
   `thresholds.break` set just under the measured floor. This is exactly the
   precedent `vitest.config.ts:58-76` records for the coverage thresholds
   ("Each threshold below is set just under its measured floor so today's suite
   still passes").
3. **fast-check seeding is split.** A fixed seed on the blocking path; a varying
   seed on a scheduled discovery job only; every counterexample pinned
   permanently via `examples: [[…]]`. The library's own recommendation of a
   varying seed is deliberately **not** followed on a blocking path.
4. **Four PBT surfaces**, all adopted: importers/exporters round-trip,
   `core/security` DangerousKeys, `core/polling` backoff invariants, and
   `core/storage` seal + digest.
5. **The hub authors the invariant set and the arbitraries; `test-author`
   implements them.** This preserves that spoke's charter as "well-scoped from
   the documented contract" (`docs/contributing/model-selection.md`, matrix row
   4), so no `MODEL-MATRIX` change is required.
6. **HTTP-level negative testing is hand-rolled** — malformed-input and
   authz-rejection tests in the existing real-socket
   `packages/m3l-console-server/tests/integration/` suite. Schemathesis and
   every other schema-driven DAST tool is **not applicable**: no OpenAPI schema
   exists in the repo (verified 2026-09-15), and authoring one purely to feed a
   fuzzer was declined.
7. **Existing techniques get a full hardening sweep**: tag every
   `.claude/rules/tests.md` rule bullet `[enforced]` or `[advisory]`, adopt the
   Vitest determinism keys, and mechanize the high-value subset.
8. **CodeQL stays on the `default` query suite.** Precision over volume, and no
   new triage load. Default setup cannot take custom queries at all; adopting
   them would mean migrating to advanced setup, which is not worth it here.
9. **Declined: jazzer.js and Toxiproxy.** jazzer.js has no Vitest runner and
   forbids direct TypeScript execution; Toxiproxy is a separate Go binary — a
   new prerequisite refused on ADR-0034's own Podman ground. **Substitute:**
   `fc.scheduler()` + `waitAll()` for reproducible async interleavings, whose
   documented limit is controlled promises only — not real timers, not real I/O.
10. **No new spoke; `test-author` is extended.** **Promotion trigger:** if
    survivor review ever becomes blocking rather than advisory, promote it to
    its own spoke at that point — a new agent costs a `MODEL-MATRIX` row, a
    mandatory `disallowedTools: Agent`, a writer-spoke "Journal as you go"
    section, and `maxTurns <= 40` under `pnpm check:agents`.

### Why the sandbox is the property being bought

`--inPlace` is a **hard prohibition**, not a preference. It reintroduces
precisely the mid-mutation-truncation hazard that motivates adopting Stryker
over the hand procedure, and it would let a spoke's crash destroy a concurrent
spoke's work across the shared worktree stack.

### Countermeasures are config keys, not guidelines

Every pitfall carried by either tool is answered with a config key, a flag, or
a gate — enumerated in this wave's plan document
(`docs/plans/2026-09-15-testing-technique-adoption.md`) rather than duplicated
here, because they are implementation detail that will move. Four are
load-bearing enough to state as decisions:

- `plugins:` is **explicitly listed**, never auto-detected: pnpm's linking
  breaks Stryker's plugin discovery, and a silently absent
  `typescript-checker` counts every tsc-invalid mutant as a survivor, poisoning
  the score.
- `ignoreStatic: true` **requires** `coverageAnalysis: "perTest"`, and `perTest`
  can be _wrong_ rather than merely faster when tests share mutable state —
  which is why decision 7's `clearMocks` work lands **before** Stryker.
- A `--since` score is **never** a gate. It is incomparable to a full baseline;
  gating happens only through the survivor-diff script.
- `thresholds.break` is the only Stryker threshold that fails the process;
  `high` and `low` are cosmetic.

### The revisit trigger

`thresholds.break` is deliberately unset by this ADR — the number does not
exist until the first full run measures it. That is the one revisit trigger
stated here: the threshold is recorded by the Update that lands the
survivor-diff gate. The `Review by:` date above exists so the trigger is not
forgotten if the wave stalls.

## Consequences

- **Positive:** the repo's most-repeated recorded defect class gets an
  automated, sandboxed, diffable signal for the first time. The
  mid-mutation-truncation failure mode disappears by construction.
  `.claude/rules/tests.md` becomes readable as discipline-versus-enforcement
  rather than an undifferentiated 38-bullet list. The hand-mutation bullet at
  `tests.md:27-29` becomes obsolete — it exists only because hand mutation was
  unreliable.
- **Negative / trade-offs:** four new dev dependencies and a new scheduled
  workflow to maintain. Mutation scores are slow and must be scheduled, so the
  score of record always lags `main` slightly. A fixed PBT seed buys
  reproducibility at the cost of discovery, which is why the varying-seed job
  exists at all. Adopting the Vitest determinism keys will surface latent
  mock-leak and order-dependence failures across the existing suite; that
  fallout is the point, but it is real work. Property-test coverage is
  diagnostic only and must not drive the per-file thresholds.
- **Semver impact:** none — test infrastructure and repo tooling; no public API
  surface and no `exports` map change.

## Links

- Related: ADR-0015 (the standing redundancy bar, re-affirmed here for a domain
  it never covered); ADR-0034 (the OSS-rules-over-platform precedent and the
  new-prerequisite refusal reused for Toxiproxy); ADR-0020 (why SBOM and
  provenance are moot); ADR-0080 (host budgeting, why nothing heavy runs
  concurrently); ADR-0072 (the reviewable-slice discipline this wave lands
  under); ADR-0100 (the test-I/O sandbox policy the integration suite is exempt
  from).
- Plan of record: `docs/plans/2026-09-15-testing-technique-adoption.md`.
- Evidence: `.claude/rules/tests.md:20-36` (mutation theory, unautomated);
  `vitest.config.ts:58-76` (the measure-then-set-just-under threshold
  precedent); `vitest.config.ts:72-74` (`coverage.all` is deliberately left at
  its `false` default).
