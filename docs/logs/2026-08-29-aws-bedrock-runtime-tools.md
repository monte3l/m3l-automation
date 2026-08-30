# Work log — `aws/bedrock-runtime` tool vocabulary (2026-08-29)

Covers V5 slice 3 — the tool vocabulary and `invoke()`'s tool path — shipped
as PR #741. **Written retroactively on 2026-08-30**, during the slice-4
session, after noticing the plan's step 5 called for this log and PR #741 had
merged without it. Detail below is drawn from the same continuous session, but
its early portion had been context-compacted, so exact figures are recorded
only where they survived; process narrative is reliable, minor numbers less so.

Plan of record: [`docs/plans/archive/2026-08-29-v5-tool-use-loop-primitives.md`](../plans/archive/2026-08-29-v5-tool-use-loop-primitives.md)

## Summary

Ships the V5 tool vocabulary: `toolUse`/`toolResult` content blocks, the tool
definition/choice/schema types, `M3LBedrockToolInvokeRequest`, and the
request/response mapping for `invoke()`'s tool path. `invokeStream` stays
text-only, guarded and documented. Additive minor — 9 new types through the
existing AWS barrel, AWS unchanged at 20 documented submodules.

`M3LBedrockContentBlock` widened from a single-member union to three members,
which was the seam V4 deliberately left open for exactly this.

New source files: `document.ts` (21,539 B — the untrusted-document copier),
`field-readers.ts` (20,238 B), `request-builder.ts` (8,709 B),
`message-safety.ts` (8,730 B). `shared.ts` shrank 24,884 → 9,534 B via
extraction. A `stream-guard.ts` created mid-review was deleted before merge.

Tests: 222 across four files, including a new `bedrock-runtime-wire.test.ts`
(54 tests) driving a real `BedrockRuntimeClient` through a stub
`requestHandler` and asserting serialized request bytes.

Skills used: implementing-submodules, syncing-docs, triaging-ci.

Spoke incidents: 9 dispatches hit the 40-turn limit; 1 wrote zero files across
43 turns. Exact resume count not recovered from the compacted context.

## What went as planned

- **The V4 seam held.** Widening `M3LBedrockContentBlock` required rewriting
  exactly one type-level test pin and nothing else in the repo — the
  additive-widening claim in the plan was accurate.
- **The field-table invariant delivered a genuine compile-time guarantee.**
  `FIELDS as const satisfies FieldReaders` makes a wire field without a reader
  a TS1360 error, verified by mutation three separate times.
- **Wire-level testing was adopted and immediately paid for itself**, becoming
  the standard this submodule now holds slice 4 to as well.

## What didn't go as planned, and why

### 1. Six adversarial security rounds, five of which found live exploits

Rounds 1–5 each killed a working attack: `__proto__` reaching the wire;
`Symbol.species` hijacking through `.map()`; duck-typed `{length, map()}`
arrays; unvalidated `system`/`inferenceConfig`/`toolChoice` plus a read-twice
TOCTOU; and two regressions inside a module created during round 4. Round 6
failed to refute and the slice shipped.

**Why it happened:** the surface takes caller-supplied documents and hands them
to an SDK that serializes with `for...in` over the prototype chain. Each round
closed a specific hole; the next found the next-cheapest path around it.

**Fix for future:** for a surface that serializes caller-controlled structure,
budget for iterated adversarial rounds from the start rather than treating the
first clean review as done.

### 2. I introduced `stream-guard.ts` mid-review and had to delete it

Asked for in round 4, it created a second request-construction path outside the
field-table invariant I had just had built. Round 5 found two Must-fixes inside
it; round 6 removed it.

**Why it happened:** I responded to a finding by adding a module rather than
extending the invariant that was already supposed to be total.

**Fix for future:** when a review finds a gap in an invariant, close it inside
the invariant. A second path is a second thing to audit.

### 3. I reported a grep-checkable invariant as a strength, and it was refuted

I chose "no `.map`/`.filter`/spread over caller input" partly because it was
mechanically checkable. Round 5 showed it constrains _how_ values are read, not
_which_ values reach the SDK.

**Why it happened:** I optimised the invariant for verifiability rather than
for the property that actually needed to hold.

**Fix for future:** state the security property first, then find a check for
it — never let checkability select the property.

### 4. I told an implementer that path components were safe because they were keys

Wrong: a secret can _be_ a key. Error paths were changed to render
positionally, never interpolating caller key text.

**Why it happened:** I reasoned about the _role_ of the data (a key, not a
value) instead of its _provenance_ (caller-controlled either way).

**Fix for future:** classify data by who controls it, not by where it sits in
a structure.

### 5. CI failed on review size for a reason that had nothing to do with the diff

CI reported 830,949 chars against a real diff of 233,967. Root cause:
`ci.yml` passes the base-branch **tip** while `bin/check-review-size.mjs`
resolves `merge-base` when run bare; the branch was six commits behind, so
main's own work was charged to the PR. Fixed by rebasing.

**Why it happened:** the two invocations agree only while a branch is current.

**Fix for future:** a size failure naming files you never touched means
rebase, never split. This is a latent repo-wide bug in `ci.yml`, still unfixed.

## Lessons learned

- **Close an invariant's gap inside the invariant.** Adding a second code path
  to fix a finding creates a second surface to audit, and round 5 found two
  defects in the module round 4 asked for.
- **Never let checkability choose the security property.** A grep-verifiable
  invariant that constrains the wrong thing is worse than an unverifiable one,
  because it reads as rigour.
- **Classify data by who controls it, not by its structural role.** A key is
  as caller-controlled as a value, and can be a secret.
- **A review-size failure naming untouched files is a stale base**, not an
  oversized PR.
- **Budget for iterated adversarial rounds on a serialization surface.** The
  first clean review is not evidence of safety when each prior round found a
  working exploit.
