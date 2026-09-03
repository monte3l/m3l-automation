# Work log — dependabot-commit-subject-gate (2026-09-03)

This log covers a `/reviewing-dependabot-prs` sweep that found all 8 open
Dependabot PRs blocked by the same repo-side gate (not a dependency issue),
the fix shipped as PR #975, and the post-merge follow-through that unblocked
the backlog. It records what shipped, what matched the plan, one divergence
during verification, and the durable lesson it surfaced.

## Summary

- Ran `/reviewing-dependabot-prs` against all 8 open Dependabot PRs
  (#960–#968). Every one was failing the required `verify` check at
  `Governance gates` → `bin/lint-commit.mjs`, on subject case, not on any
  dependency defect: Dependabot started capitalizing the verb after the
  `chore(...):` prefix (`Bump foo from 1 to 2`), and every merged bump in
  this repo's history used lowercase `bump`. #961/#960 additionally
  proposed `node:24-slim` → `node:26-slim` while `.node-version` pins 24.
- Posted a HOLD comment (with a `dependabot-review-verdict` idempotency
  marker) on all 8 PRs explaining the failure and naming the incoming fix —
  zero merges, zero rejects in the sweep itself.
- Shipped the fix as PR #975 (`fix/dependabot-commit-subject-gate`, merged
  2026-09-03T16:40:25Z):
  - `bin/lint-commit.mjs` gained `isDependabotAuthor(email)` and
    `subjectsFromLog(log)` (exported pure functions). Range mode now parses
    `git log --format=%s%x00%ae` and drops Dependabot-authored commits
    before linting subjects — identity-based, not shape-based, so a
    human-authored bump still must write lowercase `bump`.
  - `.github/dependabot.yml` gained a version-anchored `ignore: node >=25`
    on both `docker` ecosystem entries, mirroring the existing
    `@types/node`/`typescript` holds (comment corrected mid-review to not
    overclaim a literal `MAJOR_HOLDS` mirror, since that map is npm-only).
  - `bin/tests/lint-commit.test.ts` gained 13 new tests (35/35 total):
    `isDependabotAuthor` identity matching/non-broadening, `subjectsFromLog`
    parsing, and a negative-control case proving `lintMessages` still
    rejects a human-authored capitalized subject.
- Post-merge: commented `@dependabot rebase` on the 6 non-docker PRs
  (#962, #964, #965, #966, #967, #968); confirmed #961 and #960 auto-closed
  once the new `ignore` rule took effect — no manual close needed.
- Cleanup: `pnpm worktree:remove dependabot-commit-subject-gate` (worktree
  removed, merged branch deleted), `git fetch --prune` (4 stale refs
  cleared: the two closed docker branches, the merged fix branch, and one
  unrelated already-merged branch from another session).

Skills used: reviewing-dependabot-prs, starting-work, writing-commits,
creating-prs, syncing-docs, finishing-work, writing-work-logs.

Spoke incidents: none (no `tmp/session-incidents.jsonl` present; by
recollection, 0 truncations / 0 stalls / 0 resumes — both `test-author`
dispatches completed as fresh runs, no `SendMessage` resume needed).

Compaction events: none.

## What went as planned

- **Root-cause diagnosis was fast and unambiguous.** Fetching one PR's CI
  job log immediately showed the exact `lint-commit.mjs` failure line and
  the capitalized-subject pattern; confirming it was identical on a second,
  differently-shaped PR (#961) took one more job-log fetch.
- **The identity-based fix design held up against the historical precedent.**
  PR #790 (a hand-rebuilt `aws-sdk` bump after a bad REJECT) was the exact
  case an identity-based exemption needed to keep working — checked before
  writing any code, not after.
- **`pnpm sync:docs` and `pnpm verify` were both clean on the first full
  run** (58 steps passed, 10 skipped push-only/e2e) — no gate needed a
  second pass because of the implementation itself.
- **The `.node-version`/`MAJOR_HOLDS` cross-reference for the docker
  `ignore` rule was verified against actual `bin/check-deps.mjs` content
  before writing the dependabot.yml comment**, which caught a near-miss
  overclaim during review (see below) rather than shipping it.
- **`docs-consistency-reviewer`'s two findings were genuinely useful and
  cheap to fix** — both were real comment-accuracy issues (a stale file
  header, an overclaimed "mirrors MAJOR_HOLDS" statement), fixed as a
  second small commit before push.

## What didn't go as planned, and why

### 1. A negative-control `git reset --hard` discarded three uncommitted files

While proving the fix, after the real-range check against the live
`zod-4.5.4` PR branch passed, I ran a negative control: create an empty
human-authored commit with a capitalized subject, confirm `lint-commit.mjs`
still rejects it, then `git reset --hard "$BASE"` to discard the throwaway
commit. `$BASE` had been captured with `git rev-parse HEAD` _before_ the
three real edits (`bin/lint-commit.mjs`, `bin/tests/lint-commit.test.ts`,
`.github/dependabot.yml`) were committed — they were still uncommitted
working-tree changes at that moment, sitting on top of `$BASE`. The reset
moved `HEAD` back to `$BASE` and, because it is `--hard`, also blew away the
working tree and index, silently discarding all three files along with the
throwaway commit.

The Artifact/session tooling flagged the file-content mismatch as soon as
the next `Edit` call ran against `.github/dependabot.yml`, and `git status`
confirmed a clean tree with the fix commit missing entirely from
`git log`. No work was actually lost: every line of the three files had
already been fully specified earlier in the same conversation, so recovery
was a matter of reapplying identical `Edit` calls (and redispatching the
test file to `test-author`, since `bin/tests/**` is a guarded path the hub
cannot write directly). The second `test-author` run reproduced the exact
same 35/35-passing result.

**Why it happened:** the standing instruction is to run `git status` and
stash/commit before any command that could discard uncommitted work, but in
the moment the mental model was "I'm just undoing a throwaway test commit,"
not "I'm about to run `--hard` with unrelated uncommitted changes sitting on
top of it." `git reset --hard` resets three things at once (HEAD, index,
working tree), and the working-tree wipe is easy to forget when the intent
is narrowly about undoing a commit.

**Fix for future:** before any `git reset --hard` (even one aimed at a
throwaway commit made purely for a test), run `git status --porcelain`
immediately beforehand in the same tool call sequence and treat any
non-empty output as a hard stop — commit or stash it first, unconditionally,
regardless of how confident the reset's target commit looks. There is no
partial-hard-reset escape hatch, so the real fix is sequencing: commit real
work before touching git for a disposable test artifact, never interleave
the two.

## Lessons learned

- **`git reset --hard` wipes the working tree, not just HEAD — commit real
  work before any disposable git experiment, never interleave them.**
  A `--hard` reset aimed at undoing one throwaway commit will just as
  silently discard unrelated uncommitted edits sitting on top of it. Run
  `git status --porcelain` immediately before any `reset --hard` and treat
  non-empty output as a hard stop, independent of how narrow the reset's
  intended scope feels.

- **When a Dependabot PR fails a required check, check whether the failure
  is dependency-specific before triaging PR-by-PR.** All 8 open PRs here
  failed at the identical step for the identical repo-side reason — one
  root-cause read (one CI job log) diagnosed the whole backlog at once,
  instead of eight independent HOLD/MERGE/REJECT judgment calls.

- **An identity-based exemption (author email) survives a "what if a human
  has to redo this" edge case that a shape-based one (regex on the
  capitalized subject) would not.** Checking the repo's own historical
  precedent (PR #790, a hand-rebuilt Dependabot bump after a bad REJECT)
  before choosing the fix's shape caught this before it became a design
  flaw discovered in review.

- **A `dependabot.yml` comment claiming to "mirror" another file's logic is
  a specific, checkable claim — verify it against that file's actual
  content, not just its rationale.** The first draft of the `ignore: node
  > =25`comment said it mirrored`bin/check-deps.mjs`'s `MAJOR_HOLDS`; that
map is npm-package-only and has no docker-image concept, so the claim was
literally false even though the underlying reasoning (pin to the same
Node floor) was correct. `docs-consistency-reviewer` caught it, but
  > checking cross-references against the referenced file's actual content
  > before writing the comment would have caught it for free.
