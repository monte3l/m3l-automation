# Work log — U13 slice P3: release workflow + publish-version gate (2026-09-12)

This log covers PR #1217, slice P3 of the U13 private-registry-publishing wave
(issue #537): the release workflow that publishes `@monte3l/m3l-common` to
GitHub Packages, the `check:publish-version` registry-immutability gate, and
the associated `publishConfig`/docs updates. It records what shipped, two
review rounds (one finding fixed directly, one CodeQL finding fixed
separately), and a should-fix-ack gate nuance worth remembering for future
PRs.

Plan of record: [`docs/plans/2026-09-12-u13-registry-publish.md`](../plans/2026-09-12-u13-registry-publish.md)

## Summary

Shipped in PR #1217 (squash-merged as `d7310ed0`):

- `.github/workflows/release.yml` — new `workflow_dispatch`-only workflow;
  `permissions: { contents: read, packages: write }`; a first step that fails
  loudly (`::error::` + exit 1) on any non-`main` ref rather than silently
  skipping the job; auth via the workflow's own ephemeral `GITHUB_TOKEN`, no
  durable secret stored in the repo.
- `bin/check-publish-version.mjs` (`check:publish-version`) — queries the
  registry for `packages/m3l-common/package.json`'s `{name, version}` and
  refuses to let the release proceed if that version is already published
  (GitHub Packages versions are immutable). `bin/tests/check-publish-version.test.ts`,
  15 tests, dispatched to `test-author`.
- `packages/m3l-common/package.json`: `publishConfig.registry` added.
- Docs: consumer install instructions, `CLAUDE.md` § Security and
  `docs/contributing/ci-cd.md` updated to state CI holds no _durable_ publish
  credential (the ephemeral one is the ADR-0103 exception), `docs/README.md`'s
  stale "not published to npm" claim corrected.

CI: all required checks passed on the final push — `Build & typecheck`,
`Test` (full coverage suite), `Lint (library)`, `Lint (workspace)`,
`Governance gates`, `CodeQL`, `should-fix-ack`, `review`, `verify`, `Run skill
evals`. `gh pr view` confirmed `mergeStateStatus: CLEAN` before merge.

Skills used: `starting-work` (carried over from P1/P2's confirmed decisions),
`finishing-work`.

Spoke incidents: 1 truncation (recorded in `tmp/session-incidents.jsonl` for
agent `ad97a6ad6ed27edff`, from earlier in this session's P1/P2 work — a
fresh `Agent` call was used instead of `SendMessage` to resume it; the
resulting independent review was still valid and was kept) / 0 stalls / 0
resumes for this slice's own two `test-author` dispatches (each completed
cleanly on the first call).

Compaction events: 1 compaction / 1 recovered via handoff — the session
compacted mid-slice (after the round-2 review fixes were drafted but not yet
committed) and the `PreCompact`/`SessionStart` handoff correctly preserved the
branch, PR number, the exact edit in progress, and the pending next step, so
no state was lost.

## What went as planned

- **`pnpm verify` was clean on every round** — no gate failures after either
  the round-2 fix commit or the CodeQL fix commit; each needed exactly one
  `pnpm verify` pass before pushing.
- **The `test-author` dispatches were both single-shot** — the one-word
  header-comment fix and the `registryPathSegment` test update each completed
  correctly on the first call, with prettier and the scoped vitest config
  (`vitest.bin.config.ts`) passing immediately.
- **The pnpm workspace-alias mechanism (from P2) held up under P3's changes**
  — no import-specifier churn was needed to add `publishConfig` or the
  release workflow.
- **`finishing-work`'s documented recovery path for a post-compaction
  `ExitWorktree` worked exactly as written** — `ExitWorktree({action:
"remove"})` refused with "not the owner" (expected after the mid-slice
  compaction), `ExitWorktree({action: "keep"})` returned cleanly to the shared
  checkout, and `pnpm worktree:prune` + `git branch -D` finished the cleanup
  with no ambiguity.

## What didn't go as planned, and why

### 1. `should-fix-ack` required an acknowledgment footer even for a directly-fixed finding

Round 2's review posted one Should-fix finding (the job-level `if:` silent-skip
issue). It was fixed directly in commit `3cb0f8b6` — no deferral, no dispute.
The `should-fix-ack` required check still failed afterward, reporting the
finding as unacknowledged in the `ca3d55cd..3cb0f8b6` range. Reading
`bin/check-should-fix-ack.mjs`'s own header comment confirmed this is
intentional: "Whatever you decide for each round — fix it, defer it, or
dispute it as wrong — add an `Acknowledged-Should-Fix:` footer to a commit
pushed AFTER that round's reviewed commit." An `--allow-empty` commit
(`4efd51d5`) carrying the footer and naming the fix commit cleared it.

**Why it happened:** the gate enforces that every Should-fix finding has a
_recorded decision_, separate from whether the code was actually changed —
"fixed" is one of three valid dispositions (fix/defer/dispute), not an
exemption from the footer requirement. This is documented in ADR-0097 and in
at least one prior log (`docs/logs/2026-09-07-lefthook-shim-fail-open.md`),
but it is easy to assume a direct fix needs no separate acknowledgment.

**Fix for future:** treat every posted Should-fix finding as needing an
`Acknowledged-Should-Fix:` footer on some commit after that round's reviewed
SHA, regardless of whether the finding was fixed, deferred, or disputed. If
the fix commit's own message doesn't carry the footer, an `--allow-empty`
follow-up commit is the established recovery, not a workaround.

### 2. CodeQL flagged a real defect in `registryPathSegment` that neither review round nor the test suite caught

`bin/check-publish-version.mjs`'s `registryPathSegment` used
`name.replace("/", "%2F")` — `String.replace` with a string pattern replaces
only the first occurrence. For every real scoped package name (exactly one
`/`) this is harmless, and the existing test suite had a test that
_deliberately pinned this exact behavior_ as documented. CodeQL's required
`CodeQL` check failed the PR with a high-severity "Incomplete string escaping
or encoding" alert on this line. Fixed by switching to `.replaceAll("/",
"%2F")`, which required `test-author` to rewrite the pinning test to assert
the corrected (fully-encoded) output instead.

**Why it happened:** the original implementation and its test were written
together with the same (incorrect) assumption baked into both — a test that
pins current behavior rather than correct behavior can't catch this class of
bug, since the author's blind spot is shared between the code and the test
asserting it.

**Fix for future:** when a string-transform test's own docstring is explaining
_why_ it only handles one occurrence "by design," that's a signal to
re-verify the design against `replaceAll`/global-regex semantics before
trusting the pinned behavior — CodeQL (or a security-reviewer dispatch) is a
cheap independent check specifically for this class of "did the encoding
apply to the whole string" defect.

## Insights

- **`should-fix-ack` needs a footer even for a fixed finding** — the gate
  enforces a recorded decision (fix/defer/dispute), not code correctness by
  itself; an `--allow-empty` commit carrying `Acknowledged-Should-Fix:` is
  the correct recovery when a fix commit's own message omits it.

- **A test that pins "current" string-transform behavior instead of "correct"
  behavior shares its author's blind spot with the code it's testing.** When
  a test's comment explains why only the first occurrence is handled "by
  design," treat that as a prompt to double check against
  `replaceAll`/global-regex semantics, not as settled reasoning — CodeQL
  caught exactly this gap after both the implementation and its test agreed
  on the wrong contract.

- **`finishing-work`'s post-compaction `ExitWorktree` fallback (try `remove`,
  fall back to `keep`, then manual `worktree:prune` + `branch:cleanup`)
  worked exactly as documented on the first attempt** — no new insight
  needed here, but it's worth confirming the documented path holds under a
  real mid-slice compaction rather than only in the abstract.
