# Work log — flow-preflight-required-params (2026-09-10)

Resolves issue #883: `m3l flow`'s validator never checked that a step's
target script would actually receive its required parameters at run time.
This log covers the full pipeline — exploration that disproved the issue's
own proposed fix, a TDD hub-and-spoke build, two pre-push review rounds and a
post-push bot review round that each found real defects, and the merge.

Plan of record: [`docs/plans/archive/2026-09-10-flow-preflight-required-params.md`](../plans/archive/2026-09-10-flow-preflight-required-params.md)

## Summary

Shipped `packages/m3l-cli/src/flow/preflight.ts` + `preflight-supply.ts` — a
pre-flight parameter-resolution check `m3l flow run` performs once, before
step 1 executes, deliberately **fail-open** on uncertainty (the inverse of
the sibling `flow/validate.ts`'s fail-closed posture). Wired into
`commands/flow.ts`'s `runNamedFlow`, after resume-record validation and
before any step runs. New `ERR_CLI_FLOW_PREFLIGHT_FAILED` at exit `2`. New
ADR-0101, amending ADR-0056. `docs/reference/cli.md` gained a pre-flight
paragraph, an author-facing note in § Flows, and an exit-code table row.

- **Tests**: `flow-preflight.test.ts` 60 → 67 (new module + 2 review-round
  fixes), `flow-command.test.ts` 56 pre-existing → 63 (wiring + the
  unloadable-script fix), `flow-sqs-roundtrip.test.ts` 2 → 5 (acceptance:
  both shipped flows verified against the check with `env: {}` and no
  readable `.env` file for any script), `errors.test.ts` +1 row. Full
  `packages/m3l-cli` suite: 1706/1706 passing.
- **Gates**: `pnpm verify`'s full pipeline (lint, typecheck, build,
  coverage-gated tests, knip, every `check:*` governance gate) run clean
  three times across the session (initial landing, after the pre-push
  should-fix round, and via the pushed branch's own `pre-push` hook). CI's
  full required-check set (verify, review, CodeQL, Governance gates, Test,
  Lint × 2, Build & typecheck, Dependency Review, Secret scan,
  `should-fix-ack`) all green on the final commit.
- **Review verdicts**: pre-push fan-out (code-reviewer, silent-failure-hunter,
  spec-conformance-reviewer) — PASS with 1 HIGH finding from
  silent-failure-hunter; a second pre-push round after wiring
  (silent-failure-hunter again, dispatched solo) — 1 HIGH finding; post-push
  `claude-pr-review` bot — PASS with 3 Should-fix, 2 fixed + 1 acknowledged;
  a fresh bot pass on the should-fix commit — PASS, 1 non-blocking
  observation suppressed on re-review convergence.
- **PR**: [#1164](https://github.com/monte3l/m3l-automation/pull/1164),
  squash-merged as `b9a6b61e`.
- **Skills used**: `starting-work`, `writing-commits` (×3), `creating-prs`,
  `syncing-docs` (×2, invoked from within `creating-prs` and
  `resolving-pr-comments`), `resolving-pr-comments`, `finishing-work`,
  `writing-work-logs`.
- **Spoke incidents**: 2 truncations / 0 stalls / 2 resumes (both
  40-turn-limit truncations — the initial `flow/preflight.ts` implementer and
  the unloadable-script-fix implementer — both continued cleanly via
  `SendMessage` to the same agent id). One additional, distinct failure mode
  not covered by that taxonomy: a bounded re-review spoke was terminated
  mid-task by a session-wide rate limit (HTTP 429); rather than retry it, the
  hub completed the one remaining verification point itself directly with
  `Read`. `tmp/session-incidents.jsonl` did not exist for this session — all
  counts are from recollection, not the mechanical hook log.
- **Compaction events**: none observed.

## What went as planned

- **The exploration phase caught a wrong premise before any code was
  written.** The issue's own proposed fix — a load-time validator rule
  rejecting a step whose `parameters` omits a `required: true` descriptor —
  was disproved by three parallel Explore agents tracing the real provider
  chain (`M3LScriptConfigLoader`), `M3LEnvironmentConfigProvider`'s
  `AWS_PROFILE`-style derivation, and the shipped `dlq-reconcile.yaml`'s own
  header. This was surfaced to the user directly, with the redirect
  (pre-flight check instead) confirmed via `AskUserQuestion` before any
  implementation work began.
- **The TDD hub-and-spoke loop delivered clean GREEN passes.** Every RED
  spoke failed for the right reason (module not found, not a syntax or logic
  error in the test file itself), and every GREEN spoke's first
  implementation attempt passed its target test file in full — no
  re-dispatch needed for a wrong implementation, only for byte-budget trims
  and turn-limit continuations.
- **The acceptance test was decisive and passed on the first real run.**
  Both shipped flow definitions passed the check under the strictest
  possible context (`env: {}`, empty `envFileReachByScript`) with zero
  `missing` and zero `unverified` findings — confirming the design's core
  claim (real flows don't need the ambient-environment escape hatch to be
  forbidden, they just need it to exist) without any flow-file changes.
- **Host-resource contention was recoverable without losing work.** Two
  `pnpm verify` runs and one `git push` were killed mid-run by `earlyoom`
  competing with a peer session's own heavy `vitest --coverage` run — all
  three recovered cleanly by re-running detached (`nohup … & disown`) and
  polling by PID rather than relying on the harness's own background-job
  tracking, which is itself a target of the same OOM kill.

## What didn't go as planned, and why

### 1. Three independent review rounds found three instances of the same bug class

The pre-push fan-out found a HIGH-severity gap: `checkFlowPreflight`'s
`.has()` guard (added specifically to route an unknown script to the
`unverified` warning tier) was defeated by `context.parametersByScript.get(...)
?? []` — an unknown script and a script legitimately declaring zero
parameters were indistinguishable, so the former silently passed as
"nothing required." Fixed by checking `.has()` before falling back. A second
pre-push round, run after wiring `commands/flow.ts`, found a _third_
instance of the identical class: `buildParametersByScript`'s own
degraded-load fallback (`parametersByScript.set(name, [])` on a config-load
failure, needed so `flow/validate.ts` still accepts the script name) fed the
same `[]` sentinel into the pre-flight context, defeating the just-fixed
`.has()` guard all over again — a script whose config genuinely couldn't be
read was, once more, silently treated as "declares nothing."

**Why it happened:** the sentinel value (`[]`) doing double duty for two
semantically different states — "verified to declare nothing" and "unknown,
could not verify" — kept re-appearing at each layer that touched the map,
because nothing in the type system distinguished the two. Fixing it once at
the check's own boundary (`.has()`) did not stop a caller one layer up from
reintroducing the exact same ambiguity by construction.

**Fix for future:** when a sentinel value must represent both "verified
absent" and "unknown," don't reuse one value for both — thread a second,
explicit signal (here, a `Set` of unloadable names) through every layer that
constructs the ambiguous map, not just the layer that first consumes it. A
`.has()`/`.get() ?? default` guard only protects the exact map it's checking
against; it does nothing for a caller that builds a _different_ map with the
same ambiguous fallback.

### 2. A documentation claim was asserted from a design conversation rather than re-verified against the actual source it cited

The first `docs/reference/cli.md` draft claimed "the shipped `dlq-reconcile`
flow's own header documents [an ambient-`AWS_PROFILE` step] as legitimate."
This was backwards: `dlq-reconcile.yaml`'s header documents that its own
_stricter, consumer-side verifier forbids_ omitting `aws.profile` — the
engine-level point (the CLI itself must not impose that rule) is correct,
but the cited example asserted the opposite of what the source actually
says. Caught by a `spec-conformance-reviewer` pass explicitly told to verify
every claim against the actual file, not the PR's own stated intent.

**Why it happened:** the design-phase exploration (several turns and
subagent reports earlier) correctly established that the _engine_ permits
ambient-environment resolution, and that fact got restated in the docs
without a fresh read of the specific file being cited as an example —
carrying forward a conclusion from memory rather than re-deriving the
citation at the point of writing it.

**Fix for future:** when writing documentation prose that cites a specific
file as evidence for a claim ("X's own header says Y"), re-read that exact
file at the point of writing the sentence, even when the underlying design
point was already established and confirmed earlier in the same session —
the citation and the point it supports are separate claims, and only one of
them had actually been re-verified.

## Insights

- **A sentinel doing double duty is a bug that reappears at every caller,
  not just the first one found.** Fixing "unknown vs. legitimately empty"
  ambiguity at one consumer of a map does not fix it for a different
  consumer building the same map with the same fallback — grep for every
  construction site of the ambiguous value, not just its first flagged use.
- **Fail-open and fail-closed are not a spectrum a reviewer will default to
  understanding correctly.** Three separate review passes converged
  independently on flagging the SAME exhaustiveness-guard code-reuse issue
  as suspicious, even though it was a deliberately-unreachable defensive
  branch — state the fail-open/fail-closed asymmetry in the module header,
  the ADR, _and_ the docs, because a reviewer calibrated to a sibling
  module's opposite posture will read the asymmetry as a bug by default.
- **A citation is a separate claim from the point it supports, and needs its
  own re-verification.** Confirming "the engine permits X" earlier in a
  session does not confirm "file Y documents X as legitimate" — re-read the
  specific source at the point of citing it, even when the broader point was
  already settled.
- **A subagent's mid-task rate-limit failure is not the same as a
  truncation, and doesn't need a retry to recover from.** When a bounded
  re-review agent was cut off by a session-wide 429, the one remaining
  verification point (confirming a rewritten test genuinely discriminates a
  regression) was cheap enough to complete directly with `Read` rather than
  waiting out the rate limit or re-dispatching — worth checking whether a
  stalled/failed subagent's remaining scope is hub-doable before spending a
  retry on it. (Not promoted into `subagent-dispatch.md` this pass — that
  file was already within 29 bytes of `check:context-budget`'s ceiling; a
  future edit to that file should fold this in rather than trim around it.)
- **`nohup … & disown` plus PID-based polling survives an OOM kill that
  takes out the harness's own background-job tracking.** Two `pnpm verify`
  runs and one `git push` were killed by `earlyoom` targeting node/vitest
  processes under memory pressure from a concurrent peer session; detaching
  the command from the harness process (rather than using the tool's native
  `run_in_background`) and polling via `kill -0 $PID` plus a log tail
  recovered cleanly each time, matching this repo's own documented
  `docs/contributing/branch-protection.md` guidance for exactly this
  scenario.
