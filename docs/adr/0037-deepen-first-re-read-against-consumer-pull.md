# 0037. Re-read deepen-first against real consumer pull; priority order for the capability-deepening wave

- **Status:** Accepted
- **Date:** 2026-08-10
- **Deciders:** Enrico Lionello (maintainer); Claude (audit synthesis)

## Context and problem statement

An internal capability audit of `@m3l-automation/m3l-common`'s Core and AWS
surface found the library already covers the large majority of what a mature
automation-tooling library needs — a Rust-style Result type, a layered
config subsystem with per-key source tracking and a Lambda-event provider,
multi-handler structured logging, pluggable retry classifiers, an SSO
auto-re-login credentials manager, and a full-text extractor registry with
ZIP-bomb guarding. The audit's remaining findings are a short, concrete
list: config `--help`/typo-suggestion ergonomics, a few zero-dependency
primitives, a half-built AWS services tier plus several missing AWS
capabilities, and toolchain hygiene.

Two of ADR-0021's decision drivers no longer hold as written:

- **"No usage evidence yet."** ADR-0021 (2026-07-06) explicitly reasoned
  from "nothing has exercised the library end-to-end" — at that time the
  `scripts/` workspace had just been removed (ADR-0019) and had not yet been
  re-introduced (ADR-0022, 2026-07-08). Today `scripts/` holds 13 real,
  implemented consumer packages, every one of which exports
  `configParameters: readonly Core.M3LConfigParameter[]` from its
  `config.ts` — a live, uniform seam the "no evidence" driver said did not
  exist.
- **The AWS services-tier inconsistency.** The audit found
  `AWSClientProvider` already exposes four ad-hoc convenience-wrapper getters
  (`sqsOperations`, `eventBridgeOperations`, `requestSigner`,
  `dynamoDBDocument`) sitting alongside eleven caller-constructed wrappers —
  a half-built tier that contradicts ADR-0026's own stated "expose the
  underlying SDK clients directly" posture. That contradiction needs
  resolving before more AWS wrapper work lands on top of it.

This ADR is the maintainer re-read ADR-0021 itself calls for
("consumer feedback... arrives one iteration later than the consumer-first
ordering would have delivered it" — that iteration has now happened). It does
not reopen the four-option interview; it re-grounds the still-valid parts of
option 2 ("deepen first") in the now-available usage evidence and sets the
priority order for the current capability-deepening wave.

## Decision drivers

- **Usage evidence now exists** — 13 consumer scripts, all sharing the
  `configParameters` seam, are the concrete "observed pain" ADR-0021 said was
  unavailable at authoring time.
- **Minimal runtime dependencies** and the frozen three-entry `exports` map
  remain non-negotiable (unchanged from ADR-0021) — the zero-dependency
  primitives (canonical JSON, single-flight, file downloader) are additive
  through the `core` barrel with no new package.
- **Additive-by-default semver appetite** carries forward from ADR-0021: a
  major bump is acceptable only if the wave's own findings earn it, decided
  per-item below rather than assumed.
- **No premature ADR-0009 Zone A widening** — a lint-config change should be
  justified by a genuinely acyclic edge a specific PR needs, not adopted
  speculatively ahead of the code that needs it (the same standard ADR-0026
  already applied).

## Considered options

1. **Leave ADR-0021 as the standing rationale and just implement the audit
   findings.** Cheapest, but leaves a stale "no usage evidence" driver in a
   still-cited, `Accepted` decision record, and gives the nine-PR wave below
   no recorded priority order or place to put the two semver questions this
   wave surfaces.
2. **Re-open the full four-option interview from ADR-0021.** Overkill: none
   of the four original options (consumer-first / deepen-first / dual-track /
   platform-first) is actually in dispute — the consumer fleet already
   exists, deepening is already underway, and platform extraction is still
   correctly gated on a second repo. There is nothing to re-decide at that
   level.
3. **Supersede ADR-0021 with a narrower re-read**: keep its still-true
   drivers (internal-only, solo consumer, minimal deps, additive-by-default),
   replace the "no usage evidence" driver with the now-available evidence,
   and use the fresh grounding to set this wave's priority order plus the two
   semver decisions the audit could not resolve without knowing the wave's
   full additive surface.

## Decision

We chose **option 3**.

### Priority order for the capability-deepening wave

Sequenced small PRs, each independently gate-passing, in this order:

1. **Decision wave** (this ADR + the ADR-0026 amendment + the LLM/Bedrock
   stance ADR) — ships first because two later PRs are blocked on decisions
   made here.
2. **Toolchain and hygiene** — smallest risk, includes a same-day cooldown
   expiry (`pnpm-workspace.yaml`'s `read-excel-file@9.3.9`
   `minimumReleaseAgeExclude`, due ~2026-08-10T21:49 UTC).
3. **Zero-dependency primitives** (canonical JSON, single-flight, file
   downloader) — no new dependency, no semver ambiguity, unblocks nothing
   else so it can land any time after hygiene.
4. **Config help + typo suggestions** — directly improves all 13 existing
   consumers' `configParameters` seam; the one place this wave's own usage
   evidence most directly applies.
5. **AWS surface**, smallest-to-largest: `s3://` URI parser → CloudWatch
   Alarms/Metrics (already a runtime dependency, zero new deps) → Secrets
   Manager (the one new runtime dependency in this wave) → SQS DLQ redrive +
   Athena SQL templating (blocked on the ADR-0026 amendment) → the
   `.services` tier (blocked on the same amendment; lands last so it wires
   every wrapper the earlier AWS PRs add).

### Semver decision: `M3LUnknownParameterDetector.detect()`

**Add a new method; leave `detect()` untouched.** `detect()` keeps its
current `readonly string[]` return — every existing call site across the
library and all 13 consumer scripts stays source-compatible. Typo
suggestions surface through a new method (name settled at implementation
time, e.g. `detectWithSuggestions()`) returning the richer
name-plus-candidates shape. This keeps the whole wave additive-minor: nothing
else in scope (config help, the zero-dep primitives, the AWS additions) forces
a breaking change on its own, so there is no independent reason to spend a
major bump here. Revisit only if a future, unrelated breaking change is
already earning a major and this can ride along.

### Catalog question: decline `catalog:` for now

**Do not adopt the pnpm `catalog:` protocol.** Investigated per the
maintainer's request: the AWS SDK pins the audit called "duplicated across
packages" are **not actually duplicated** — `grep -rl "@aws-sdk"
--include=package.json .` (excluding `node_modules`) returns exactly one
file, `packages/m3l-common/package.json`. Per ADR-0029, consumer scripts
depend only on `@m3l-automation/m3l-common` and never declare an AWS SDK
package themselves, so there is no second manifest for a catalog to
de-duplicate against. Dependabot's existing `aws-sdk` group
(`.github/dependabot.yml`) already collapses the ~19 pins into one grouped
weekly PR, which was the actual pain point the audit's "bumped individually"
phrasing was gesturing at — that is already solved without `catalog:`.
Revisit if a second in-repo package ever needs the same AWS SDK version set
directly (not merely through `workspace:*`), at which point genuine
duplication would exist.

### ADR-0021 superseded, not overturned

ADR-0021's still-valid drivers — internal-only (ADR-0020), solo consumer,
minimal runtime dependencies, the frozen `exports` map, additive-by-default
semver, focused-phase cadence — all carry forward unchanged into this ADR.
Only the "no usage evidence yet" driver and its consequence (features
prioritized "without usage evidence... some of the five may see little use")
are retired: usage evidence now exists and this ADR uses it.

## Consequences

- **Positive:** the nine-PR wave has a recorded priority order instead of an
  implicit one; the two semver questions the audit deferred are answered
  once, up front, rather than re-litigated per-PR; the stale "no usage
  evidence" driver no longer sits uncorrected in an `Accepted` ADR that later
  work keeps citing; the catalog investigation is closed with a factual
  finding instead of left open.
- **Negative / trade-offs:** this ADR itself carries no code — it is pure
  process overhead ahead of PR 2. Declining `catalog:` means the (currently
  nonexistent) duplication risk is deferred rather than pre-empted; if a
  second package ever needs the AWS SDK directly, this decision will need
  revisiting.
- **Semver impact:** none. This ADR is a process/planning decision record; no
  exported signature or `exports`-map entry changes.

## Links

- Supersedes: [ADR-0021 (post-1.0 deepen-first strategy)](./0021-post-1.0-deepen-first-strategy.md)
  — its status is updated to `Superseded by ADR-0037`.
- Related: [ADR-0019 (remove scripts workspace)](./0019-remove-scripts-workspace.md),
  [ADR-0020 (drop release automation, internal-only)](./0020-drop-release-automation.md),
  [ADR-0022 (re-introduce scripts workspace)](./0022-reintroduce-scripts-workspace.md),
  [ADR-0026 (SQS operations wrapper — amended alongside this ADR)](./0026-sqs-operations-wrapper.md),
  [ADR-0029 (script dependency boundary — the fact this ADR's catalog finding
  relies on)](./0029-script-dependency-boundary.md), `.github/dependabot.yml`
  (`aws-sdk` group), `docs/plans/archive/2026-07-06-post-1.0-deepen-first-roadmap.md`
  (superseded roadmap).
