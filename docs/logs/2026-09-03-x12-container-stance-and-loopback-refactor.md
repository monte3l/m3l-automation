# Work log — x12-container-stance-and-loopback-refactor (2026-09-03)

This log covers the first two of three planned PRs for issue #560 (X12,
the console's containerization item): the docs-first stance PR (#929) and
the `src/` refactor + feature PR (#936). It records what shipped, what
went as planned, two real divergences worth remembering, and durable
lessons — the third PR (Dockerfiles, compose, Trivy scheduling) is still
ahead and will get its own log once it lands.

## Summary

**PR #929 — `docs: fire the ADR-0015/0071 container stance for X12`** (merged,
squash). Docs-only, two commits: the initial stance plus a follow-up fixing a
review finding. Fired the two obligations ADR-0071 deferred to X12:

- `docs/adr/0015-code-scanning-tooling-evaluation.md` — dated Update
  reassessing the Trivy container-scanning rejection (premise changed:
  the repo now builds two images, so "ships no images" is stale); Trivy
  adopted in the scheduled `security-audit.yml` workflow, not per-PR.
- `docs/adr/0071-console-containerization-deployment.md` — dated Update
  recording X12's compose topology _ahead of writing it_: a shared
  network-namespace choice (`network_mode: "service:server"`, so the
  server keeps binding `127.0.0.1` literally with zero security-relevant
  code change), the `nginx-unprivileged` web image choice and its
  minimal-dependency-stance reconciliation, and which of the remaining
  two PRs each deferred item lands in.
- `docs/contributing/ci-cd.md` — new `## Containers` section, placed after
  the existing sections so `check:workflows-doc`'s table-only parse stayed
  unaffected (verified: still "10 workflow file(s)" matched).

**PR #936 — `feat: add the console server's readiness grace period`** (merged,
fast-forward-mergeable). One squashed commit, `@m3l-automation/m3l-console-server`
only, two parts:

1. Behavior-preserving refactor: `net/loopback.ts`'s single `isLoopbackHost`
   predicate — called at three sites asking three different questions under
   one name — split into `isPermittedBindHost` (`config/env.ts`),
   `isVerifiedBoundAddress` (`lifecycle/http-server.ts`), and
   `isAcceptedRequestHostname` (`http/origin-guard.ts`), all delegating to
   the unchanged, still-exported `isLoopbackHost`. Relocated the measured
   Node v26.7.0 bind-resolution table and the DNS-rebinding port-comparison
   rationale to the predicate each actually documents.
2. New feature: `M3L_CONSOLE_READINESS_GRACE_MS` (default `0`, non-negative
   integer bounded by `MAX_TIMER_DELAY_MS`) delays `server.close()` behind a
   grace window when set, so `/ready`'s 503 becomes observable to a
   healthcheck during a drain — closing the gap ADR-0071 recorded as
   deferred to X12. `0` preserves today's exact synchronous close-alongside-
   drain ordering (an existing regression test pins this).

Final state: 2630 package tests passing (up from a 2587 first-GREEN pass;
+43 from a post-review follow-up round), 0 typecheck errors, 0 eslint
findings, `main.ts` measured at 23,266/25,000 `check:file-budget` chars (no
extraction needed). Both PRs' `pnpm verify`-equivalent gates and `pnpm
sync:docs` (13 steps) passed clean; no open error-severity CodeQL alerts
touched either diff.

**Skills used:** starting-work, creating-prs (×2), syncing-docs (×2),
finishing-work, writing-commits, writing-work-logs.

**Spoke incidents:** 1 truncation (code-implementer hit its 40-turn limit
mid-task on PR #936's GREEN phase, with `main.ts`'s wiring and final
verification still outstanding) / 0 stalls / 1 resume (`SendMessage` to the
same agent, which picked up cleanly from its own journal and finished
correctly — see below). `tmp/session-incidents.jsonl` does not exist for
this session; this count is from recollection.

**Compaction events:** none observed this session.

## What went as planned

- **The dependency check held.** X12's issue prerequisites (X2/#550, X9/#557)
  were both confirmed `closed` via `mcp__github__issue_read` before any
  planning began — no surprise blocker.
- **Plan mode surfaced a real design tension before any code existed.** The
  loopback-predicate "one function, three questions" smell and the
  container/origin-guard bind conflict were found and resolved entirely
  during exploration/plan-mode reads, before writing a single line — the
  eventual implementation matched the plan almost exactly.
- **`git worktree add <path> <existing-branch>` (no `-b`) + `pnpm
worktree:setup`, run manually, correctly recovers an existing local branch
  into a worktree** — used to migrate PR #929's already-made commit out of
  the shared checkout without losing it (see divergence #1 below). The
  commit, branch, and signature all survived the move intact.
- **The TDD hub-and-spoke loop worked as designed for PR #936**:
  `test-author` wrote genuinely failing RED tests (confirmed via `tsc
--noEmit` diagnostics all naming the missing field, not an unrelated
  failure); `code-implementer` made them green without touching any test
  file; two independent review spokes (`code-reviewer`,
  `silent-failure-hunter`) each found real, non-overlapping issues on the
  first pass and confirmed clean on the second.
- **The turn-limit → `SendMessage` resume mechanism, already documented in
  `code-implementer.md`/`subagent-dispatch.md`, worked exactly as
  specified.** The spoke's own journal made resuming lossless — no context
  had to be re-explained, and the finishing steps (main.ts wiring, budget
  check, full verification) completed correctly on the very next turn.
- **`pnpm sync:docs`'s 13-step composite ran clean both times** with zero
  working-tree drift from either PR — the many `check:test-counts` warnings
  it printed (untracked sibling script test files) are pre-existing noise,
  not something either PR introduced.
- **Squash-merge non-ancestry was expected, not alarming.** PR #929's local
  branch survived `pnpm worktree:remove`'s `git branch -d` check because a
  squash merge isn't a fast-forward ancestor of the local tip — exactly the
  case `finishing-work`'s own notes call out as expected. Independent
  verification via `gh pr view` plus the `[gone]`-upstream marker on the
  local branch confirmed the merge before asking the user to force-delete.

## What didn't go as planned, and why

### 1. PR #929's initial work happened in the shared checkout, then had to be migrated to a worktree mid-task

`starting-work`'s documented default is the shared checkout, with a linked
worktree reserved for signalled concurrent work (ADR-0013). Following that
default, PR #929's ADR/docs edits and first commit were made directly in the
shared checkout on `docs/console-container-stance`. The user then gave an
explicit, durable instruction: never work in the shared checkout, only in
linked worktrees — discovered because the shared checkout had, in the
meantime, been switched back to `main` externally (the user's own working
copy), which the harness surfaced as a "changed on disk" notice on the very
files just edited. The existing commit was intact on the local branch
(`git branch -vv` confirmed it), so recovery was a `git worktree add
<path> docs/console-container-stance` (no `-b`, the branch already existed)
plus a manual `pnpm worktree:setup` run — not a redo.

**Why it happened:** `starting-work`'s Step 3 default (shared checkout) is a
documented, deliberate repo policy, but this particular maintainer keeps the
shared checkout as their own personal working copy and expects an agent to
never touch it for branch work — a preference the skill's generic default
doesn't encode.

**Fix for future:** saved as a durable feedback memory
(`always-use-worktrees-not-shared-checkout.md`) so `starting-work`'s Step 3
recommendation for this repo/user is "new linked worktree" by default,
overriding the skill's own stated default — checked before the first write,
not discovered after one.

### 2. A pre-push docs-consistency review caught a real tense-overclaim in PR #929

The first draft of ADR-0071's 2026-09-03 Update and `ci-cd.md`'s new
Containers section described the not-yet-written PR #2/#3 work (the
loopback-predicate refactor, the readiness grace period, the images/Trivy
wiring) in past/present tense — "the readiness grace period landed as
planned," "`security-audit.yml` builds both images" — as if it had already
shipped, when only the docs/stance PR existed at that point.
`docs-consistency-reviewer`, dispatched per `creating-prs` Step 7's
docs-only review path, flagged this as one Must-fix and one Should-fix. Both
were fixed in a follow-up commit switching every such claim to future/planned
tense and adding an explicit "this Update records decisions made ahead of the
code that will implement them" framing sentence.

**Why it happened:** writing an ADR Update that records a multi-PR plan's
full design _before_ any of the later PRs exist is a genuinely unusual
tense to sustain consistently across a long prose passage — it's easy to
slip into describing the plan as the eventual finished state rather than as
a recorded decision.

**Fix for future:** when an ADR Update records design decisions for PRs that
haven't landed yet, write (and then re-read) it once specifically checking
verb tense against "has this specific PR actually merged yet" — not against
whether the reasoning itself is sound, which is a different check the first
pass already does well.

## Lessons learned

- **The repo-wide worktree/shared-checkout default is not this user's
  default.** Confirm the location preference for a specific
  repo/maintainer before the first write in a new session, rather than
  trusting a skill's documented default silently — the two can diverge
  and the divergence surfaces only when it's already inconvenient to fix.
  _(saved as a personal feedback memory, not promoted into the repo skill
  itself — that would be a repo-policy change the user hasn't asked for)_
- **A multi-PR ADR Update needs an explicit tense discipline, checked as its
  own pass.** Write it, then re-read it once purely for "does any sentence
  describe unshipped work as already shipped" — this is a distinct failure
  mode from whether the design reasoning itself is correct, and a
  same-pass review is likely to miss it because it's reading for content,
  not tense.
- **`worktree:new` only mints `feat/`/`fix/`-prefixed branches from
  `origin/main`.** A `docs/`, `refactor/`, or other conventionally-prefixed
  branch name needs `pnpm worktree:new <slug> [--fix]` followed by a plain
  `git branch -m <old> <new>` rename inside the fresh worktree — there is no
  flag for an arbitrary prefix.
- **`git worktree add <path> <existing-branch>` (deliberately omitting
  `-b`) is the correct recovery when a branch needs to move from an
  unwanted location into a worktree without losing its commits** — confirmed
  working end-to-end (branch, commits, and GPG signature all survived) and
  worth remembering as the specific incantation, since `worktree:new` alone
  cannot check out an existing branch.
- **Inside a linked worktree, `git log main...HEAD` and `git diff
main...HEAD` can silently include commits that are already on
  `origin/main` but not on that worktree's local `main` ref**, if local
  `main` was never fetched/updated in that worktree. `creating-prs`'s own
  Step 2 correctly rebases onto `origin/main`, but its Steps 7 and 10 use
  bare `main` for the post-rebase diff/log — harmless when working in the
  primary checkout (where `main` tracks itself), but a real footgun in a
  worktree-first workflow, since every new worktree's local `main` is
  frozen at whatever commit `origin/main` pointed to when the worktree was
  created. Worth a follow-up fix to `creating-prs/SKILL.md` (Steps 7 and
  10, `main...HEAD` → `origin/main...HEAD`) — flagged to the user rather
  than bundled into this log's PR, since it changes a governance skill's
  documented commands and deserves its own review.
- **Two independent review spokes on the same diff, in two rounds, is worth
  the cost even for a "small" refactor.** The loopback-predicate split
  looked like pure renaming, but review still surfaced a genuine
  test-coverage gap (three new exported predicates had zero direct tests,
  only indirect coverage through their call sites) that would have shipped
  unnoticed otherwise.
