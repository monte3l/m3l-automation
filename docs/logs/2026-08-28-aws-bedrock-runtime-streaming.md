# Work log — `aws/bedrock-runtime` submodule, slice 2 (2026-08-28)

This log covers issue #541 (V4, ADR-0059) slice 2 — `invokeStream()`, the
streaming extension of the `aws/bedrock-runtime` typed wrapper, landed as a
follow-on to slice 1 (single-shot `invoke()`, PR #725, merged earlier the
same day). It records what shipped, what matched the plan, what diverged, and
durable lessons for the next `aws/*` streaming submodule.

Plan of record: the "Landing plan" section of `docs/reference/aws/bedrock-runtime.md`
(no fresh `~/.claude/plans/` file for this slice — no plan-mode session was
entered; the hub went straight from `starting-work` into a contract-settling
spoke dispatch per the user's "Start slice 2" instruction).

## Summary

Shipped `M3LBedrockRuntimeOperations.invokeStream()` — an `async function*`
over Bedrock's `ConverseStream` API — yielding `M3LBedrockStreamEvent`
(`message-start` / `text-delta` / `message-stop`, the last fusing the SDK's
`messageStop`+`metadata` events into one terminal event). New
`M3LBedrockRuntimeStreamError` (carrying a type-visible `retrySafe: boolean`)
and `ERR_BEDROCK_RUNTIME_STREAM` (`origin: external`, `retryable:
situational`). Two-phase fault handling: pre-first-yield reuses `invoke()`'s
retry/fallback state machine verbatim; post-first-yield most transport faults
collapse to `M3LBedrockRuntimeStreamError`, while `ModelStreamErrorException`/
`ValidationException` keep their pre-boundary error types (both were already
no-retry/no-fallback). Corrected a false claim slice 1's own reference page
had recorded — stream-lifecycle exceptions are **thrown** from iteration, not
yielded as in-band data — verified by reading `@smithy/core`'s
`EventStreamSerde` deserializer directly, not just the SDK's `.d.ts` shapes.
43 new tests in `tests/bedrock-runtime-streaming.test.ts` (100% coverage);
slice 1's 40 tests (`tests/bedrock-runtime.test.ts`) untouched and still
green. `client.ts` was split into `client.ts`/`stream.ts`/`shared.ts` (all
internal, non-barrel-exported) to clear the ADR-0072 25,000-byte file-budget
ceiling — the file layout the original slice-1 plan had already scoped for
this slice. Full-workspace `pnpm verify` (48/48 applicable steps),
`/syncing-docs` (13/13), and `pnpm build`/`test`/`typecheck`/`lint` all
green. PR #728 opened against `main`, mergeable, CI running.

A security-review finding — `M3LError.toJSON()` serializes `cause` verbatim
and the shipped AWS SDK builds exception instances with an enumerable
`message`, so `JSON.stringify(err.toJSON())` leaks chained-exception text
(potentially prompt content or secrets) into structured/JSON log sinks, not
just text renderers, contradicting this doc page's prior claim — is
library-wide and pre-existing, not introduced by this PR. Per the user's
explicit decision (correct the doc now, file the root-cause fix separately),
it was filed as F31 / GitHub issue #727 (priority Now) via `pnpm sync:hub
--apply`, rather than fixed inline.

Review verdicts: first round (5-spoke: code-reviewer, spec-conformance-reviewer,
type-design-analyzer, silent-failure-hunter, security-reviewer) found 1
Must-fix (a doc/code fault-table mismatch — the doc overstated an
"unconditional" post-yield collapse that the code, correctly, did not
implement) and converged on 3 Should-fix items (`retrySafe` field,
exhaustive SDK-exception-key check, `@throws` TSDoc wording) plus the
security doc-claim Must-fix. A bounded confirmation re-review (3 of the 5
original reviewers) closed all four clean, including an unusually rigorous
verification that the new exhaustiveness check's compile-time guarantee
genuinely holds (traced against the SDK's actual codegen pattern, not just
inferred). A second, focused pre-push review round (3 fresh reviewers)
specifically re-verified the `client.ts` → `client.ts`/`stream.ts`/`shared.ts`
split that happened after the confirmation pass — all three came back clean,
zero new findings.

Skills used: starting-work, creating-prs, writing-work-logs.

Spoke incidents: 2 truncations / 0 stalls / 2 resumes (the `code-implementer`
GREEN dispatch hit its 40-turn limit twice, both times immediately before
running its own final build-gate command — once on the initial
implementation, once again on the `retrySafe` fix-round pass; both resumed
cleanly via `SendMessage` with a scoped continuation prompt, no re-dispatch
needed).

## What went as planned

- **The contract-settling pass earned its cost again, this time overturning
  a claim from an already-shipped, already-reviewed doc page.** Slice 1's
  reference page stated stream-lifecycle exceptions "arrive in-band… not
  thrown from iteration" — this had passed a full review round in the prior
  session. Reading `@smithy/core`'s actual deserializer code (not just the
  SDK's `.d.ts` union shape) proved the opposite: they're thrown, same as
  the non-streaming path. Nothing short of reading the real runtime code
  would have caught this.
- **RED failed for the right reason on the first attempt** — no defect
  rounds needed this time, unlike slice 1's two rounds of test-file fixes.
- **GREEN passed all 83 tests on the implementer's first pass**, before any
  review-driven fix round — a notably clean first implementation, including
  the deliberately tricky two-phase fault-handling asymmetry.
- **The 5-spoke review found only one doc-level Must-fix, zero code-logic
  Must-fix** — every fault-handling rule, abort-ordering rule, and event-shape
  rule in the settled contract was implemented exactly as documented on the
  first pass; the one Must-fix was the doc overstating behavior the code had
  correctly _not_ implemented.
- **The confirmation pass and the post-split pre-push review round both
  closed with zero new findings** — two independent signals that the fix
  round and the later file-split refactor were both genuinely clean, not
  just clean-by-luck.
- **The push succeeded on the first attempt** — no repeat of slice 1's
  `console-server` contention-flake retries.

## What didn't go as planned, and why

### 1. The prior slice's "in-band exception delivery" claim was actively wrong, not just unverified

Slice 1's reference page recorded, as settled fact, that stream-lifecycle
exceptions arrive in-band as yielded `ConverseStreamOutput` data rather than
being thrown from iteration. This premise had already been through a full
review round in the prior session and shipped in a merged PR. The slice-2
contract-settling pass re-verified it against the installed SDK's shipped
runtime (not just its type declarations) and found the opposite: `@smithy/core`'s
`EventStreamSerde` throws the deserialized exception from iteration, exactly
like the non-streaming path. The claim also undercounted the exception set
by one (missing `ValidationException`) and over-counted which names could
ever be thrown from `send()` for the streaming command specifically.

**Why it happened:** the prior claim was built from reading the SDK's
TypeScript union shape (`ConverseStreamOutput`'s declared members) and
inferring runtime behavior from the type shape alone, rather than reading the
deserializer function that actually produces those values at runtime. A
type declaring a union member says nothing about whether that member is ever
actually _returned_ as data versus _thrown_.

**Fix for future:** this reinforces, rather than adds, the existing
`aws/*` contract-settling discipline ("check the installed
`node_modules/.pnpm/…/dist-types/**`" — already in `implementing-submodules`
§5) — but the discipline needs to extend past `dist-types` into the actual
`dist-es`/`dist-cjs` runtime code for any claim about _how_ a value is
delivered (thrown vs. returned vs. yielded), not just _what shape_ it has.
Type declarations describe possible shapes; only the runtime code describes
delivery mechanism.

### 2. `pnpm check:file-budget` wasn't in the GREEN dispatch's own gate list, so the ceiling was discovered late

The GREEN dispatch asked for `test`/`typecheck`/`eslint`/`prettier`/`build` —
all standard, all passed cleanly, twice (once on the initial implementation,
once after the fix round). The 25,000-byte file-budget ceiling
(`pnpm check:file-budget`, an ADR-0072 gate) wasn't in that list, so
`client.ts` (45,497 bytes by the time both `invoke()` and `invokeStream()`
plus every fix-round addition lived in one file) only got flagged during the
hub's own full `pnpm verify` sweep — after review had already signed off on
the pre-split code shape. This forced a whole extra dispatch-and-verify round
(the file split into `client.ts`/`stream.ts`/`shared.ts`) plus a second,
narrower pre-push review round to confirm the split hadn't regressed
anything the first review had already cleared.

**Why it happened:** the original slice-1 plan had explicitly scoped a
separate `stream.ts` file for slice 2 ("the `AsyncGenerator` event surface"),
but that scoping lived in an old, condensed plan-archive narrative from a
prior session — it wasn't restated in this session's GREEN dispatch prompt,
so the implementer had no signal to split proactively, and the hub's own
gate list for that dispatch didn't include the one check that would have
caught the omission immediately.

**Fix for future:** include `pnpm check:file-budget` in every GREEN
dispatch's gate list, not just as part of a later full-`pnpm verify` sweep —
and if an earlier plan already scoped a multi-file layout, restate that
explicitly in the dispatch prompt rather than relying on the implementer to
rediscover it via a failing gate. _(promoted →
`.claude/skills/implementing-submodules/SKILL.md`)_

### 3. A security finding implicated a file outside this module's scope, requiring a scope decision mid-review

The security-review round proved, by execution against the built library,
that `M3LError.toJSON()` (a `core/errors` file, not `aws/bedrock-runtime`)
leaks chained-exception `.message` text into structured/JSON log output —
directly contradicting a safety claim this module's own reference page had
made. Fixing the root cause meant touching a file affecting every `M3LError`
subclass in the library, well outside this PR's natural scope.

**Why it happened:** this is not really a "went wrong" — it's the review
process working as intended (a security spoke executing a proof-of-concept
against the real error hierarchy, not just reading the code) surfacing a
genuine cross-cutting defect that happened to be discoverable from this
module's own doc claim. The friction was procedural: deciding how much of
this PR's scope should absorb a fix for a defect neither introduced nor
contained by this module.

**Fix for future:** when a review finding implicates a file outside the
current module/PR's boundary, don't silently choose to fix it inline or
silently choose to defer it — surface the scope decision to the user
explicitly (a single `AskUserQuestion`, here: "fix the doc claim now and file
the root cause separately" vs. "fix the core file in this same PR"), then
follow through on filing a _real_ tracker row (not just a log mention) for
whichever path defers the fix. A follow-up that lives only in a review
finding or a work log does not exist — filed here as F31 / #727 via
`pnpm sync:hub --apply` in the same session, not left for a future session
to rediscover.

## Lessons learned

- **Contract-settling must read runtime code, not just `.d.ts` shapes, for
  any claim about delivery mechanism.** A TypeScript union member's
  declared shape says nothing about whether the SDK actually returns it as
  data or throws it — this distinction cost slice 1 a wrong, already-shipped
  doc claim that slice 2 had to correct. Extend the existing "read
  `dist-types` directly" discipline to "read the actual deserializer/handler
  code for delivery-mechanism claims specifically."
- **Include the file-budget gate in the GREEN dispatch's own checklist, not
  just the later full-verify sweep.** A clean `test`/`typecheck`/`lint`/`build`
  pass says nothing about ADR-0072 file-size compliance; catching it only
  during `pnpm verify` costs a full extra split-and-re-review round.
  _(promoted → `.claude/skills/implementing-submodules/SKILL.md`)_
- **A security finding outside the current module's boundary is a scope
  decision, not a fix-or-ignore binary.** Ask once, up front, which path the
  user wants (inline fix vs. filed follow-up) — then actually file the
  follow-up as a tracker row in the same session, since an unfiled follow-up
  effectively doesn't exist.
- **A second, narrowly-scoped review round earns its cost even for a "just
  mechanical" refactor.** Converting `#`-private class methods into
  explicit-parameter free functions across a file split is exactly the kind
  of change that _looks_ behavior-preserving and usually is — but "the tests
  still pass" and "a fresh reviewer traced every state-threading path and
  found nothing" are different strengths of evidence. Here they agreed, but
  the second pass materially raised confidence for a repo-wide gate (ADR-0072)
  the first review round had no way to anticipate.
- **Two truncations clustering at the same point (right before a spoke's own
  final gate command) across two separate dispatches on the same task is
  worth watching for a pattern.** Both `code-implementer` truncations this
  session happened immediately before running `pnpm build` as the last item
  in its own verification checklist, not mid-implementation — if this
  recurs on a third module, it may be worth flagging to
  `docs/contributing/subagent-context-management.md` as a specific
  "verification-tail" truncation shape distinct from mid-implementation
  truncation.
