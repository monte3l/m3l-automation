# Work log — X10 run-launcher UI MVP (2026-08-30)

This log covers issue #558 (X10 — run-launcher UI MVP), shipped as four
PRs: #749 (X10a, the `core/config` introspection seam), #755 (X10b,
`GET /api/v1/scripts` discovery), #757 (X10c, web shell + hash router +
read views), and #762 (X10d, parameter form + launch + live SSE tail).

Plan of record: `on-issue-545-the-snuggly-avalanche.md` (local plan file; not
committed to the repo).

## Summary

X10's tracker row read as web-only work depending on X4/X9. Checking the row
against repo state before planning found it understated the scope twice.
`docs/reference/console.md` and ADR-0066's 2026-08-29 Update both assigned the
missing `GET /scripts` discovery endpoint to X10, and the introspection
machinery the parameter form needs already existed in `m3l-cli` but was
unreachable — `m3l-cli` has no `exports` map, so `m3l-console-server` could
not import it. X10 was therefore a library + server + web item, not a UI item,
and was sliced into four PRs on that basis.

The slice that mattered most was the smallest: promoting the CLI's descriptor
logic into `core/config` (X10a) is what made both the server's discovery
endpoint and the browser's parameter form possible without duplicating the
secret-masking and operation-normalisation rules in a third place.

## What went as planned

- The four-slice split held. Each slice branched fresh from `origin/main`,
  carried its predecessor's tracker flip, and merged before the next started.
- The hand-rolled hash router stayed dependency-free (ADR-0067's thin-stack
  policy), as did the single plain `styles.css`.
- The `runs/` zone was the right home for discovery in X10b. A dedicated
  `scripts/` zone would have had to import `runs/` anyway, dragging
  `runs -> store, stream` into a fresh layer for no gain.
- `main.ts` stayed byte-identical across X10b by riding the new catalog on the
  existing `M3LRunSubsystem` object rather than adding a subsystem.
- Playwright stayed API-mocked via `page.route()` rather than booting a second
  process. The real two-process end-to-end is X11's stated acceptance.

## What didn't go as planned, and why

### 1. Three of the four reviews found defects the gates could not

Every gate was green — lint, typecheck, 237 tests, build, format, per-file
coverage — before review started. Review then produced two security Must-fix,
two silent-failure CRITICAL, and one type-design Must-fix. None were
detectable by a gate, because each was about a state the code never entered
under test:

- A route change carried stale form state. `App.tsx` had no `key` on
  `ScriptDetail` and its fetch state never reset on a `name` change, so
  `#/scripts/alpha` -> `#/scripts/beta` reused the mounted form. The security
  reviewer drove it end to end and got `beta` launched with a `confirmed: true`
  never granted for `beta`, carrying a secret typed under `alpha`, and — when
  `beta` declared the same parameter non-secret — re-rendered in a plaintext
  control.
- `handleResync` dropped a failed re-fetch with a bare `return` and no
  `.catch()`. It runs precisely when a `stream.gap` has already reported lost
  events, so a failed resync left known-stale status on screen indefinitely.
  The sibling initial-load effect twenty lines above handled both cases
  correctly; this was a second copy of the same fetch that handled neither.
- `useRunStream` never registered an `error` listener, and `phase` was
  computed and consumed nowhere. A dead connection froze the tail
  indistinguishably from a quiet script — and because `phase` was dead state,
  no code path could have reported it even if the listener had existed.

The lesson is not "add more gates". It is that the guard written for the case
you imagined does not cover the case you did not. The in-form confirm
round-trip (off -> confirm -> on -> off) was specified, implemented, and
tested correctly; the identical invariant approached via a route change was
wide open.

### 2. A maintainer decision reversed part of the plan mid-slice

The plan specified `type="password"` for secret parameters. The security
review pointed out the server persists run `parameters` verbatim to SQLite and
echoes them back — `console.md` says outright not to pass secrets as run
parameters — and X10d's own `RunDetail` renders that echo in cleartext. A
password control therefore signalled the opposite of the truth.

This was escalated rather than resolved unilaterally: it contradicted a
maintainer-confirmed plan decision, and all four options had real costs. The
decision was to render a `secret: true` parameter read-only with no control at
all. Latent rather than urgent — no script in the repo declares a secret
parameter today — which is exactly why it was worth deciding deliberately
instead of patching in a hurry.

### 3. `stream.gap` ships two payload shapes; the docs described one

`http/routes/run-stream.ts` emits `{ oldestRetainedId }` for a retention gap;
`http/stream-writer.ts` emits `{ lastEventId }` for a backpressure gap.
`console.md` documented only the first. A client written against the docs
would branch on `oldestRetainedId`, work against one emitter and silently miss
the other — the precise failure the gap frame exists to prevent. The docs now
describe both and say not to branch on either; the hook never reads the
payload, and a test drives both shapes through the same assertion.

### 4. Subagent turn limits dominated the slice

Seven dispatches stopped at the 40-turn limit. Six were near-complete and
needed only a resume with a checklist of what was already verified. One
`code-implementer` consumed all 40 turns and ~131k tokens on exploration and
produced **zero edits** — the post-run gate state was byte-identical to the
RED baseline. Resuming it with an ordered, eight-step edit list and an
explicit "stop reading, start writing" recovered it; it then landed all twelve
fixes across three further resumes.

Verifying state independently before each resume mattered more than the resume
itself. Two agents reported "done" on work that a re-run showed incomplete,
and one reported a `format:check` failure on a file it had never touched —
which turned out to be the hub's own unformatted tracker edit.

### 5. Two tests went obsolete by design, not by defect

After the secret-parameter decision, two tests failed with `Unable to find a
label with the text of: apiKey` — they typed into a control that no longer
exists. The implementation was correct and the implementer correctly refused
to edit them.

The second of those guarded a real security vector (a value typed under one
script surfacing in another). Deleting it because its original carrier became
unreachable would have dropped coverage of a leak that is still live for
non-secret parameters. It was re-pointed at that residual vector instead. The
test-author checked whether it had become a duplicate of the sibling reset
test and explained why not: the sibling never retypes its field after
switching and only inspects the submitted payload, where an empty optional is
omitted entirely — so its assertion would pass vacuously even with the remount
key removed.

## Lessons learned

1. **Re-derive a tracker row's scope before planning from it.** X10's row
   described a UI task; two other documents assigned it a server endpoint.
   Both were authored months apart and neither was wrong when written.

2. **Green gates say nothing about states the tests never enter.** Five of the
   defects here were found by review, none by a gate, and each lived in a
   transition — a route change, a gap-then-failure, a connection death — that
   no test drove.

3. **Dead state is a defect, not a wart.** `phase` was computed and never read.
   That was not untidiness; it was the reason a whole class of failure could
   not be surfaced.

4. **A type that admits an illegal state will have the check re-implemented at
   runtime somewhere.** `M3LRunLaunchRequest`'s two independent booleans had
   `canSubmit = !submitting && (dryRun || confirmed)` as their shadow. Making
   it a discriminated union moved the check to compile time and broke exactly
   one call site, which is the point.

5. **When a review's suggested fix is wrong, say so and fix the real thing.**
   In X10c the bot recommended mirroring `fetchScript`'s `encodeURIComponent`.
   That would not have closed the traversal: `.` is RFC 3986 unreserved, so
   `encodeURIComponent("..")` returns `".."` and the URL parser strips it —
   `fetchScript` was equally vulnerable, not the safe reference.

6. **Ask when a review contradicts a confirmed plan decision.** The secret
   parameter question had four defensible answers with different costs. It was
   the maintainer's call, and it was cheap to ask because the issue was latent.

7. **Resume a stalled subagent with verified state, not with "continue".**
   Every resume here carried an explicit list of what was already confirmed
   green and what remained, which is what kept six near-complete agents from
   re-deriving work that was already done.
