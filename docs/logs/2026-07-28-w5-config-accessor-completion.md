# Work log — W5 config-accessor completion pass (2026-07-28)

Closes out the three deferred config-accessor sites the earlier W5 promotion
(PR #260/#261) filed as issues #263/#264/#265 when it stopped at 6 of 13
duplicate sites. Adds five required-variant methods to `Core.M3LConfigAccessor`
and adopts them across all 8 remaining scripts, in a 4-PR chain following the
same shape as the checkpoint-store and record-field-reader promotions before
it. This log records what shipped, a corrected read of what the three source
issues actually needed (two of the three had stated gates that didn't match the
code), a real silent-failure bug the fourth review round caught, and durable
lessons.

Plan of record: `~/.claude/plans/on-docs-roadmap-md-docs-plans-implementa-jazzy-crystal.md` (session-local; not archived — routine W5 promotion, not a cross-cutting/governance change)

## Summary

- **PR 1 (#269, `feat(core)`):** added `optionalNonEmptyString`/
  `requiredString`/`requiredNumber`/`requiredBoolean`/`requiredStringArray` to
  `Core.M3LConfigAccessor` (`packages/m3l-common/src/core/config/M3LConfigAccessor.ts`).
  Each `required*` method composes its `optional*` counterpart with the
  existing `requiredFor`. 44 tests added (31 → 76). No new exported symbol, no
  `exports`-map change — additive `feat:`, minor bump.
- **PR 2 (#270, `feat(scripts)`):** mechanical fleet retrofit onto
  `dynamodb-crud`, `api-gateway-client` (2 steps), `sqs-etl` (6 steps), and
  `s3-objects`/`json-etl`, deleting ~24 local helpers and sweeping the
  already-covered adoptions (`booleanWithDefault`/`oneOf`) the prior retrofit
  skipped in these same files. `pnpm check:dup`: 3.23%/98 → 2.90%/87 clones.
- **PR 3 (#271, `feat(scripts)`):** the behavior-changing retrofit —
  `athena-query`/`cloudwatch-logs-insights` dropped their local
  `AthenaSettingsError`/`LogsInsightsSettingsError` subclasses; `eventbridge-schedules`'s
  shared `config-helpers.ts` dropped 3 of its 4 exports, each of its 6 consumer
  steps now constructing its own accessor directly. `pnpm check:dup`: 2.90%/87
  → 2.95%/88 clones (each newly-touched file independently constructs a small
  accessor snippet — an accepted trade-off, not a regression).
- **PR 4 (this close-out, `docs:`):** tracker rows flipped, issues closed, this
  log.
- Full workspace suite: 5764 (post-#269) → 5783 (post-#270) → 5792 (post-#271)
  tests, all passing throughout. `pnpm typecheck`/`lint`/`build`/
  `check:script-deps`/`lint:md` clean at every step.
- Review fan-out: PR 1 ran `code-reviewer`, `spec-conformance-reviewer`,
  `silent-failure-hunter`, `security-reviewer` (4 spokes, one fix round — a
  DRY duplication in `requiredStringArray` and a missing regression test).
  PR 2 ran `code-reviewer`, `spec-conformance-reviewer`, `silent-failure-hunter`
  (3 spokes, one fix round — a prettier formatting nit, a type-duplication nit,
  two doc-drift items). PR 3 ran all 4 spokes again (behavior-changing scope
  warranted `security-reviewer` a second time) — see divergence #2 below for
  its Must-fix. All spokes returned clean after their fix rounds. CI (`verify`,
  CodeQL, dependency-review, `claude-pr-review`) passed on all three code PRs.
- All three PRs squash-merged to `main` by explicit user confirmation (asked
  separately for each).

Skills used: starting-work (implicit, via the session's own `/starting-work`
decision gate reused across all 4 PRs), writing-commits, creating-prs (partial
— gates run manually inline), syncing-docs, writing-work-logs.

Spoke incidents: none — all 14 review-spoke dispatches (4 on PR 1, 3 on PR 2,
4 on PR 3, plus none needed on this close-out) completed normally; no
truncations, no stalls, no `SendMessage` resumes.

## What went as planned

- **A direct code survey corrected two of the three issues' stated gates
  before any code was written.** #264 claimed the blocker was "a seam for
  narrowing an already-resolved value, not reading one from `M3LConfig`" —
  reading the actual `athena-query`/`cloudwatch-logs-insights` source showed
  9 of 11 `as*` call sites were literally `asString(config.get("x"), "x")`;
  the real blocker was the local error subclasses. #265's "silently drops
  wrong-typed" gate was already settled precedent from #261/#266/#267.
  Surfacing this via `AskUserQuestion` before implementation avoided
  re-deriving the same correction mid-PR.
- **The 4-PR split (library seam / mechanical / behavior-changing / close-out)
  held exactly as planned** — no PR needed to absorb work from another, and
  the mechanical/behavior-changing split correctly predicted which scripts
  would need message-text test updates (only the behavior-changing PR did).
- **`requiredStringArray`'s empty-array-reject composing over `requiredFor`**
  (rather than a second bespoke throw) was accepted on the first design pass
  once code-reviewer's should-fix landed it — no further churn.
- **`s3-objects`'s partial pre-existing accessor adoption composed cleanly**
  with the newly-added `bucket`/`yes` reads — one accessor instance, no
  divergent second construction, confirmed by three separate spokes across
  two PRs.
- **`eventbridge-schedules`'s 6-file `config-helpers.ts` refactor** (deleting
  3 of 4 exports, threading an accessor into `put-rule.ts`'s two internal
  helpers) compiled and passed its full test suite on the first attempt after
  each file's mechanical edit — only the message-text assertions needed a
  second pass, exactly as anticipated.

## What didn't go as planned, and why

### 1. `M3LConfigAccessor.optionalStringArray`'s comma-string tolerance silently widened what `athena-query`'s `executionParameters` accepts

Switching `executionParameters` from the deleted `asOptionalStringArray`
(array-only) to `accessor.optionalStringArray` meant an existing test —
`executionParameters: "not-an-array"` expected to throw — instead passed the
bare string through as a single-element array, since the accessor's
`optionalStringArray` treats any string as comma-separated. The test would
have passed vacuously (asserting a throw on a value that no longer throws)
had `silent-failure-hunter`'s vacuous-test check not caught it during the PR 3
review.

**Why it happened:** `optionalStringArray`'s comma-string tolerance is a
pre-existing library behavior (shipped with the accessor itself, not new in
this PR), and it wasn't surfaced during PR 3's own implementation pass because
the test was mechanically ported forward without re-deriving what the new
method actually accepts.

**Fix for future:** When retrofitting a script onto an existing library method
whose full contract wasn't authored in this same session, re-read that
method's doc comment (not just its name) before porting the site's existing
tests forward — a method named `optionalStringArray` doesn't obviously imply
"and also accepts a raw string." Fixed here by changing the throw-case fixture
from a bare string to a genuinely-invalid value (`42`) and adding an explicit
new test locking the comma-tolerance as intentional.

### 2. A pre-existing silent-failure bug surfaced only because PR 3's review fan-out looked at sibling code, not just the diff

`silent-failure-hunter`'s audit of PR 3's diff noticed that `delete-rule.ts`'s
`force` field — an **unchanged context line**, not part of the diff — still
read `config.get("force") === true` directly, silently defaulting any
wrong-typed value to `false` instead of throwing. The same pattern existed in
`run-eventbridge-schedules.ts`'s `yes` confirm-gate bypass, a file this PR
hadn't touched at all. Both are exactly the failure class this whole
promotion pass exists to eliminate, sitting untouched in files this PR
otherwise fully migrated.

**Why it happened:** The retrofit's own scope was defined by "which functions
does `config-helpers.ts` export," so a boolean read that had always been
inlined at the call site (never routed through the shared helper) was
invisible to a mechanical grep-for-callers pass. It took a reviewer reading
the whole file's logic, not just the changed lines, to notice the sibling gap.

**Fix for future:** When a promotion pass's stated scope is "adopt library
method X at every call site that currently duplicates logic Y," explicitly
grep the touched files for `config.get(` / `.get("...") ===` afterward — not
just for calls to the helper being deleted — to catch a field that bypassed
the shared helper entirely rather than duplicating it. Fixed here: both
`force` and `yes` now route through `accessor.booleanWithDefault`, with
regression tests locking the fix in both files.

## Lessons learned

- **Re-verify an issue's stated blocker against the code before scoping a
  fix.** Two of the three source issues (#264, #265) had blocker descriptions
  that didn't survive a direct read of the actual call sites — #264's
  "narrowing seam" framing described 2 of 11 sites, not the dominant pattern.
  A 10-minute code survey before the `AskUserQuestion` round caught this and
  reshaped the whole plan; skipping it would have designed the wrong seam.
- **A library method's full contract can widen behavior at an adopting site
  in ways the site's existing tests don't anticipate.** `optionalStringArray`'s
  comma-string tolerance is old library behavior, but adopting it at a new
  call site can silently invalidate that site's own throw-case test. Read the
  method's doc comment, not just its name, before porting tests forward.
- **A silent-failure audit should read whole files, not just diff hunks** —
  the `force`/`yes` bug (divergence #2) lived in unchanged context lines and
  in a file outside the PR's original touch-set; catching it required the
  reviewer to reason about the file's logic as a whole, which is exactly what
  `silent-failure-hunter`'s remit already covers but is easy to under-scope
  when briefing it strictly by diff.
- **A promotion pass's "adopt X at every site" scope should include a
  `config.get(` sweep, not just a grep for the deleted helper's name.**
  _(promoted → `.claude/rules/scripts.md`)_
- **The 4-PR chain shape (library / mechanical / behavior-changing / close-out)
  scales cleanly to a 3-issue, 8-script promotion** — confirming the same
  precedent set by the checkpoint-store and record-field-reader promotions
  holds for a wider fleet, not just a narrow 5-script one.
