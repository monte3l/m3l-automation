# Work log — `aws/bedrock-runtime` tool-use loop (2026-08-30)

Covers V5 slice 4 — conversation state and the bounded, cancellable tool-use
loop — implemented through the `implementing-submodules` hub-and-spoke
pipeline and shipped as PR #744. Records what shipped, what matched the plan,
where execution diverged, and the durable lessons.

Plan of record: [`docs/plans/archive/2026-08-29-v5-tool-use-loop-primitives.md`](../plans/archive/2026-08-29-v5-tool-use-loop-primitives.md)

## Summary

Ships ADR-0059's `invoke → tool_use → execute → tool_result` state machine
plus the immutable conversation value it drives. **15 new symbols** through
the existing AWS namespace barrel — no new `exports` subpath, AWS stays at 20
documented submodules. Reference index 761 → **777 symbols**.

Value exports: `createBedrockConversation`, `appendBedrockMessage`,
`appendBedrockUserText`, `runBedrockToolLoop`, `M3LBedrockToolLoopError`.
Type-only: `M3LBedrockConversation`, `M3LBedrockToolContext`,
`M3LBedrockToolHandler`, `M3LBedrockToolRegistration`,
`M3LBedrockToolRegistry`, `M3LBedrockModelRate`, `M3LBedrockToolLoopOptions`,
`M3LBedrockToolExecution`, `M3LBedrockToolLoopIteration`,
`M3LBedrockToolLoopOutcome`, `M3LBedrockToolLoopInvoker`.

Four source files (`conversation.ts` 5,247 B, `loop.ts` 19,434 B,
`tool-dispatch.ts` 12,003 B, `tool-ledger.ts` 7,768 B) — a three-way split of
what the contract projected as one ~10–14 KB file, forced by ADR-0072's
25,000-byte ceiling.

**Tests: 97** — `bedrock-runtime-conversation.test.ts` (13),
`bedrock-runtime-loop.test.ts` (67), `bedrock-runtime-loop-wire.test.ts` (17,
wire-level against a real `BedrockRuntimeClient`). Full workspace suite 6,695
passing across 93 files. `pnpm verify`: **50 steps passed, 10 skipped**.
Review size 159,186 chars (over the 75,000 soft target, under the 300,000
ceiling; rationale recorded in the PR body).

Review verdicts: `code-reviewer` approve-pending-format (1 Must-fix, the
`format:check` gate I had omitted); `spec-conformance-reviewer` conformant,
64/68 items Met, 1 Must-fix; `type-design-analyzer` ship-blocked on 1 EOPT
hole, 3 Should-fix; `silent-failure-hunter` **not clean** — 1 CRITICAL,
1 HIGH; `security-reviewer` **2 Must-fix**, both proven end-to-end with
executable probes.

Skills used: implementing-submodules, syncing-docs, writing-work-logs,
triaging-ci (earlier in the same session, for slice 3's CI failure).

Spoke incidents: 6 truncations / 0 stalls / 8 resumes.

## What went as planned

- **RED failed for the right reason, twice over.** 80 tests across two files,
  all 77 runtime failures `TypeError: <symbol> is not a function`, `tsc`
  reporting only `TS2305`/`TS2724` unresolved-symbol diagnostics, and all 259
  ESLint findings in the acceptable `no-unsafe-*` class. No assertion-logic
  failures masquerading as RED.
- **The contract spoke settled the deferred type-level question with an actual
  compile probe**, as the plan required, rather than reasoning about it. It
  also overturned the framing: the plan assumed byte budget would decide
  method-vs-free-function, and the probe measured the method form at 1,276
  bytes — affordable. The real argument was that `M3LBedrockRuntimeOperations`
  declares `#` fields and is nominally typed, so a method rejects structural
  fakes with TS2345.
- **The three-file split held up under review.** `code-reviewer` was asked
  specifically whether the seams were structurally honest or merely
  size-driven, and verified one-way acyclic dependencies, no shared mutable
  state crossing a file boundary, and each file's stated responsibility
  matching its contents.
- **Every ceiling, allowlist and registry hardening survived adversarial
  refutation.** A secret planted in three places leaked through none of
  `toJSON()`, `util.inspect`, `formatErrorChain`, or `serializeErrorChain`;
  every prototype-chain tool name resolved to `undefined` with zero handler
  calls; `Infinity`/`NaN`/negative ceilings all rejected.
- **`gen:index` produced a non-vacuous diff** — checked explicitly rather than
  trusting the exit code, per the trap recorded in slice 3.

## What didn't go as planned, and why

### 1. Six writer-spoke truncations across one slice

`code-implementer` hit its 40-turn limit four times and the wire-test
`test-author` twice — one of those having written **zero files across 41 tool
calls**. Each cost a verify-state-then-resume cycle. Every resume recovered
cleanly because the journal files and on-disk state were checked directly
rather than trusting the truncated report.

**Why it happened:** my dispatches were too large. The fix-round brief bundled
a security fix, five refactors, and a seven-step gate loop into one turn;
`.claude/rules/subagent-dispatch.md` says to pre-split by group and I
under-applied it. The wire-test spoke had no explicit "write the file first"
instruction, so it explored until its budget ran out.

**Fix for future:** cap a writer dispatch at roughly one Must-fix plus its
gate, and state an explicit first artifact ("create the file, then report")
so the spoke cannot spend its whole turn reading. When resuming, hand back the
facts already gathered rather than letting it re-derive them.

### 2. I told a spoke twice that M1 was unimplemented when it was

I grepped for `assertDocumentGrammar|validateToolUseBatch|DANGEROUS|MAX_DOCUMENT`,
none of which match the shipped `validateToolUseInputShape` or its
`copyDocument` call, and concluded the fix had not started. The implementer
checked before acting and corrected me.

**Why it happened:** I chose grep patterns from the names I expected the fix to
use, not from the behavior it had to exhibit. An absence of matches for
_guessed_ identifiers is not evidence of absence.

**Fix for future:** verify a fix landed by running the test that guards it, or
by grepping the _call site_ being protected, never by grepping for an
identifier you predicted.

### 3. The `format:check` gate was missing from my GREEN gate list

`code-reviewer` found three new files failing `pnpm format:check`, having
noticed that `lint` being green says nothing about format state — ESLint has
no Prettier integration in this repo, `format:check` is a separate script.

**Why it happened:** I assembled the gate list from the Definition of Done plus
the gates the plan named, and `format:check` appears in neither, only in
`lefthook.yml`'s pre-push stage.

**Fix for future:** derive a dispatch's gate list from `lefthook.yml` and
`package.json`, not from prose. This is the same lesson as the CI-only
path-anchored gates finding — a gate's authority is its script, not its
mention.

### 4. A reviewer's proposed fix would have introduced the opposite defect

`silent-failure-hunter` correctly identified the over-broad
`isAborted(signal) || cause instanceof M3LOperationAbortedError` catch, then
proposed dropping the signal clause entirely. That would have made a handler
honouring the signal via `fetch(url, {signal})` — which throws a `DOMException`
`AbortError`, not our class — become a `status: "error"` toolResult, so the
loop would continue past a cancellation.

**Why it happened:** the reviewer reasoned from the contract's literal wording
("a handler that _itself throws_") rather than from the full space of
abort-shaped errors a real handler can produce.

**Fix for future:** treat a review spoke's _diagnosis_ and its _prescription_
as separately trustworthy. Verify the prescription against the precedent the
codebase already sets — here V4's `isAborted(signal) && isAbortError(error)`,
which was correct and three files away.

### 5. My own dispatch rule blocked the correct fix

I had told the implementer "never call `isAbortError` from the loop", copying
the plan's constraint. That rule's actual rationale is avoiding
double-classification of `invoke()`'s SDK failures — and a handler rejection
never passes through `invoke()`. I had over-applied it, and it would have
forced a worse fix had I not re-read the rationale.

**Why it happened:** I transcribed a constraint from the plan without its
reasoning attached, then applied it to a case the reasoning does not cover.

**Fix for future:** when copying a constraint into a dispatch, copy its _why_
too. A rule without its rationale cannot be correctly scoped by the spoke
receiving it, or by the person who wrote it down.

### 6. The M2 fix silently damaged an unrelated error path

Giving `sanitizeForMessage` an optional `maxLength` parameter turned an
existing `options.attemptedModels.map(sanitizeForMessage)` into a bug: `.map()`
passes the array index as the second argument, so every entry was truncated to
0–1 characters. The implementer found and fixed it, then grepped the tree for
other bare higher-order references.

**Why it happened:** adding an optional parameter to a function used
point-free is a source-compatible change that is not behavior-compatible.
Nothing in the type system flags it.

**Fix for future:** when adding a parameter to an existing exported helper,
grep for bare higher-order uses (`.map(fn)`, `.filter(fn)`, `.forEach(fn)`)
before considering the change done.

### 7. Slice 3 shipped without its work log

The plan's step 5 called for `…-tools.md` and `…-loop.md`. PR #741 merged with
neither. Written retroactively alongside this one, at lower fidelity.

**Why it happened:** slice 3 ended with a CI failure and a rebase; once CI went
green the session treated the slice as finished and moved on.

**Fix for future:** the work log belongs to the slice, not to the session — a
slice is not done when CI passes but when its log exists.

## Lessons learned

- **Verify a fix by its guard, not by its name.** Grepping for identifiers you
  predicted the implementation would use produces confident false negatives;
  run the test that guards the behavior instead.
- **A reviewer's diagnosis and its prescription deserve separate trust.** Two
  spokes this round diagnosed correctly and prescribed a fix that would have
  introduced a new defect. Check the prescription against existing precedent
  in the codebase before dispatching it.
- **Copy a constraint's rationale, not just the constraint.** An unexplained
  rule cannot be scoped correctly by whoever receives it — mine nearly forced
  a worse abort fix than the one V4 already demonstrated.
- **Derive gate lists from `lefthook.yml` and `package.json`, never prose.**
  `format:check` is invisible to `lint` and absent from the Definition of Done,
  and it failed on three new files.
- **Mutation-test the guard before believing the test.** Disabling
  `validateToolUseInputShape` failed exactly the five tests claiming to guard
  it — which is the only evidence that those tests are not passing vacuously.
- **Adding an optional parameter breaks point-free call sites silently.**
  `.map(fn)` feeds the index in as the new argument, and neither `tsc` nor
  ESLint objects.
- **Wire-level coverage is the standard for this submodule for a reason.**
  Both Must-fix security defects were invisible to a structural `{ invoke }`
  fake and surfaced only against a real client with captured bytes.
- **Composing two safe slices can create an unsafe one.** Response-side mapping
  validated nothing and request-side `copyDocument` validated everything;
  neither was wrong alone, and the vulnerability existed only once the loop
  fed one into the other. Re-audit the seam when a new slice connects two
  existing ones.
- **Cap writer dispatches at one Must-fix plus its gate**, and name the first
  artifact explicitly, or expect turn-limit truncation.
