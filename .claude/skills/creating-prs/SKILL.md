---
name: creating-prs
description: >-
  Verify quality gates, push the branch, and open a PR with a Conventional
  Commit title and body from commit history. Use for /creating-prs, "open a PR",
  "create a pull request", "ship this for review", or after finishing a fix.
  Requires gh CLI auth. GitHub stance: gh CLI (ADR-0030).
---

# creating-prs

This skill enforces quality gates before touching the remote (so you never push
a broken branch to CI), then uses the commit history to generate a PR title and
body that match this repo's conventions: Conventional Commit format, scoped
summary bullets, a concrete test-plan checklist, and a semver note.

## Steps

### 1 — Preflight checks

```bash
gh auth status
```

If the command fails (not authenticated), stop and tell the user:
`gh CLI is not authenticated. Run "gh auth login" and try again.`

```bash
git branch --show-current
```

If the branch is `main`, stop:
`You are on main. Branch off main first (e.g. feat/<slug> or fix/<slug>).`

### 2 — Resync with `origin/main`

Rebase the branch onto the latest `main` **before** the quality gates, so the
gates run against the state that will actually be reviewed and merged. This is
what keeps a stale branch from opening a PR that CI or a required check would
reject.

Detect staleness first:

```bash
git fetch origin main
git rev-list --count HEAD..origin/main
```

If the count is `0`, the branch is already up to date — print
`branch is up to date with main` and skip to Step 3.

Otherwise rebase onto the fetched `main`:

```bash
git rebase origin/main
```

- **On conflict:** capture the conflicted files, abort, and **hand back** —
  never auto-resolve:

  ```bash
  git diff --name-only --diff-filter=U   # capture the conflicted paths first
  git rebase --abort
  ```

  Tell the user which files conflict and hand off to the
  `/resolving-merge-conflicts` skill (its remit narrowed by the merge-driver
  layer below to real `src/`/test logic, same-module provenance, and same-row
  tracker collisions), then re-run this skill. If they prefer to resolve by
  hand: `git rebase origin/main`, fix, `git rebase --continue`. Stop here.

  **Most derived-artifact conflicts auto-resolve during the rebase itself
  (ADR-0024).** `docs/reference/catalog.json`, `docs/reference/symbol-map.json`,
  and `pnpm-lock.yaml` are tagged `merge=m3l-generated` in `.gitattributes`; the
  registered git merge driver (`bin/merge-driver-generated.mjs`, installed via
  `prepare`/`worktree:setup`) keeps the current side and exits 0 on any
  conflict there — no stop, no `git diff --diff-filter=U` entry for them at
  all. The `post-rewrite` lefthook hook (`bin/post-integrate-regen.mjs`) then
  regenerates `catalog.json`/`symbol-map.json` automatically once the rebase
  finishes; for `pnpm-lock.yaml` it runs `pnpm install` against the merged
  `package.json` (only when the lockfile is actually dirty), reporting dirty
  files rather than committing. Land that reconciliation as a `docs:
reconcile doc metadata` commit (this repo's standard pattern) before
  pushing. The `package.json` `dependencies` block and the "N of 22" count
  prose are **not** driver-covered (the source blocks, not their generated
  outputs) — a conflict there still needs the union/regenerate treatment
  `/resolving-merge-conflicts` Step 3 describes. Still hand back on any
  conflict in real `src/`/test logic, or a same-row/same-module collision.

- **Signing:** pushes are signature-gated, so rebased commits must stay signed.
  If the user's `commit.gpgsign` is unset, use the same recovery pattern
  `verify-signed-range` documents:

  ```bash
  git rebase --exec 'git commit --amend --no-edit -S' origin/main
  ```

### 3 — Reviewable-size check (ADR-0072)

Cheap, so it runs before the multi-minute quality gates. If
`bin/check-review-size.mjs` exists on this branch, run it:

```bash
pnpm check:review-size
```

- **Under the soft target (75,000 reviewable chars):** passes quietly,
  continue.
- **Over the soft target, under the hard ceiling (300,000):** it warns and
  names the top contributing files plus a suggested split axis. Split the PR
  along one of ADR-0072's axes (docs-vs-code first — a markdown-only slice
  measures ~0 reviewable chars — then path cluster, then commit boundary,
  then public-surface subset for library work) **or** record in the PR body
  why not splitting is the right call. Either way, continue.
- **Over the hard ceiling:** splitting is not optional — the CI gate will
  reject the PR outright with no review attempted (`claude-pr-review.yml`).
  Stop, split the branch, and re-run this skill on each slice.

If the script does not yet exist on this branch (bootstrap case — ADR-0072
landed the gate in a follow-up PR to this repo), skip this step; the
`claude-pr-review.yml` ceiling check still applies at push time regardless.

### 4 — Quality gates

Run the full verification pipeline. Fail fast: stop on the first failure and
tell the user which gate failed. Do **not** push a branch that fails any gate.

**Build the CLI before running tests, not after** — several scaffold-checker
tests (e.g. `bin/tests/script-scaffold.test.ts`) read
`packages/m3l-cli/dist/scaffold/manifest.js` directly, so `test:coverage`
fails on a fresh worktree/clone if `pnpm build` hasn't produced that file
yet. `pnpm verify` (`bin/lib/verify-steps.mjs`'s `build-cli-for-gates` step)
already orders this correctly; mirror it here rather than composing `lint`,
`typecheck`, `test:coverage`, and `build` in a plausible-looking but
dependency-violating sequence:

```bash
pnpm lint && pnpm typecheck && pnpm turbo run build --filter=@m3l-automation/m3l-cli && pnpm test:coverage && pnpm build && pnpm knip
```

**`pnpm knip` is not part of `pre-push`** (cost reasons — see
`.claude/rules/tests.md`), but it IS a required CI gate
(`Governance gates` / `check:unused`), so a push that never runs it locally
can pass every `pre-push` lane and still fail CI on an unused export the
same change just introduced — logged twice now
(`docs/logs/2026-09-03-x11b-console-session-views.md`). Run it here, not
only when CI catches it.

### 5 — Reconcile docs

Bring doc metadata in line with the commits before they go up for review.
Invoke the `/syncing-docs` skill — it re-stamps provenance sidecars to the
current HEAD, regenerates `docs/reference/catalog.json`, and reconciles the
"N of 22" counts. It only mutates working-tree files; it never commits.

`/syncing-docs` runs `pnpm lint:md`, which can fail — surface a `lint:md`
failure like any other gate (fail fast, hand back) rather than pushing past it.

If `/syncing-docs` produced working-tree changes, commit them as a standalone
reconciliation commit **before** the push, so the change is in the commit
history the PR is generated from (Steps 10–12) — this skill otherwise never
creates commits:

```bash
git add -A
git commit -S -m "docs: reconcile doc metadata"
```

If it produced no changes, there is nothing to commit — continue.

### 6 — Archive the originating plan (if applicable)

If this session entered plan mode for this unit of work (a file exists under
`~/.claude/plans/` for this task), decide whether it clears the archival bar
from `docs/plans/README.md`: does it ratify or reference an ADR, span more than
one PR, add or change a `.claude/skills|hooks|agents` file, or make a
cross-cutting governance/infra change? If yes:

- Write a condensed narrative (not a raw transcript dump) to
  `docs/plans/archive/<merge-date>-<slug>.md` — dated by today (the landing
  date), following the existing archived-plan voice: a title, a
  `**Status: shipped**` line with the PR/commit reference, `## Context`,
  `## Approach / Decisions`, and `## Outcome` cross-linking any related work log
  or ADR.
- Add a row to `docs/plans/README.md`'s Archive table.
- Fold both into the doc-reconciliation commit from Step 5 (or make a
  standalone `docs: archive <slug> plan` commit if Step 5 produced no changes).

If the unit is a routine submodule/script implementation (already covered by
the mandatory work log) or a trivial one-off fix, skip this step.

### 7 — Pre-push review

Check which files changed since main:

```bash
git diff main...HEAD --name-only
```

**Inside a linked worktree, `main` here means local `main` — verify it isn't
stale first** (`git rev-parse main origin/main`). A linked worktree branches
from `origin/main` directly at creation time (ADR-0013/0014) and never
fast-forwards the shared local `main` ref afterward; if other PRs landed on
`origin/main` during this session, the diff picks up every file from those
unrelated commits too. Diff against `origin/main` (after `git fetch origin
main`) instead when the two ref values differ.

If the diff is empty, skip this step.

If the diff contains **any `src/**` changes** (files under `packages/*/src/` or
`scripts/*/src/`), fan out in **one message** the following review spokes in
parallel — this mirrors the Phase 4 fan-out in `implementing-submodules` so the
two pipelines stay consistent:

- **Always:** `code-reviewer` + `spec-conformance-reviewer` (conformance mode)
- **If public types changed** (`src/core/index.ts` or `src/aws/index.ts` in
  the diff): also `type-design-analyzer`
- **If error-handling or async paths changed:** also `silent-failure-hunter`
- **If `aws/`, secrets, credentials, or logging paths changed:** also
  `security-reviewer`

Hand each dispatched reviewer an explicit scratchpad path (e.g.
`<scratchpad>/<agent-name>-<target>.md`) alongside its file list — every
review spoke's bounded-output contract only spills full findings and returns
a capped digest when it has a path to write to; leaving it to each spoke's
own fallback default makes the digest pattern accidental rather than
deliberate.

If the diff contains **only docs/automation changes** (no `src/**` files),
dispatch `docs-consistency-reviewer` instead.

After collecting spoke results: if any spoke reports a **Must-fix** finding,
fix it and loop back through Steps 4, 5, and 7 before pushing. Do not push with
outstanding Must-fix findings.

When the PR will carry GitHub auto-merge, this step is the only review whose
findings you can still act on cheaply. Auto-merge fires the moment the required
checks pass, so `claude-pr-review.yml`'s verdict typically arrives on an
already-merged PR and every finding becomes a follow-up PR — U10 had three land
that way, twice while a spoke was still fixing that same PR
(`docs/logs/2026-09-02-u10-orchestration-engine.md`). Drafting buys no window
either: the review job is gated on
`github.event.pull_request.draft == false`, so a draft gets no review at all
(`docs/contributing/branch-protection.md`). Nor do the mechanical gates
substitute — that wave shipped eight real defects past typecheck, lint, `knip`,
`check:dup`, `check:file-budget` and ~1,450 tests; every one was caught by a
reviewer reasoning about behaviour.

### 8 — Pre-existing code-scanning check

CodeQL runs via GitHub "default setup" and its `Analyze (...)` check-runs are
required to merge (see `docs/contributing/branch-protection.md`). Before
pushing, surface any **open error-severity CodeQL alert that already touches a
file this branch changes** — so you learn about a blocker now, not after the PR
is open.

`--paginate` is required — without it, alerts past the first page (>30) are
silently missed:

```bash
gh api --method GET repos/{owner}/{repo}/code-scanning/alerts --paginate \
  -f state=open -f tool_name=CodeQL \
  --jq '.[] | select(.rule.severity=="error")
        | "\(.rule.id) \(.most_recent_instance.location.path)"'
```

Cross-reference the paths against the changed set from Step 7
(`git diff main...HEAD --name-only`). If any alert path matches, list the
matches and tell the user to triage them with the `triaging-scan-alerts` skill
before merge. This is informational — alerts for **newly pushed** code only
appear after the post-push scan, so `triaging-scan-alerts` is the follow-up once
the PR is open.

### 9 — Push the branch

```bash
git push -u origin HEAD
```

**Budget for the pre-push hook — it runs a multi-minute verify.** This push
triggers the `pre-push` lefthook, which runs `format:check` + `lint` +
`typecheck` + `test:coverage` + `build`/`check:exports` + signature check +
`check:agents` + `check:test-counts` **in parallel**; wall-clock is roughly
the slowest lane (usually `test:coverage` or `lint`), often 2–4 min. A fixed foreground tool-timeout will kill the `git push`
mid-hook — the ref never transmits, and a later retry just pays the cost again.
So **run the push in the background or raise the command timeout**; do not lower
your guard by reaching for `--no-verify` to dodge the wall-clock — the hook is the
local safety net and CI re-runs everything regardless. (Warming turbo with
`pnpm build` first only speeds `build`/`typecheck`, not the `test:coverage`/`lint`
dominators, so it won't save the push.)

**`git push`'s generic `error: failed to push some refs` gives no clue whether
a local pre-push hook failed or the remote rejected it — read the lane summary
lefthook prints immediately above that line before assuming either.** A `--no-verify`
retry "to isolate the variable" bypasses exactly the hook that may be the real,
correct blocker: a push that twice failed this way turned out to be
`format:check` legitimately failing on a `.mjs` file lefthook's pre-commit
`format` glob (`**/*.{ts,json,md,yml,yaml}`) never auto-formats, and the
`--no-verify` retry pushed the unformatted file straight to CI
(`docs/logs/2026-09-02-session-naming-convention.md`). Retry the plain,
verified push first; if a lane's own `✗` is genuinely there, fix that gate,
never bypass it to "see what happens."

**A push can also fail _before_ `pre-push` runs, in which case nothing was
gated at all.** Git resolves the remote and discovers refs first, so a DNS or
auth failure (`Could not resolve hostname github.com`, exit 128) means the hook
never executed and the commit is still completely ungated. "It got as far as
ssh" is not evidence the gates passed — the missing lefthook lane summary is
the tell. Re-push once the transport recovers and confirm the hook actually
ran; it prints its step list and takes minutes
(`docs/logs/2026-09-03-x8-open-items.md`).

**A session-level process restart drops harness-tracked background jobs and
can wipe the scratchpad their logs were written into**, leaving a
`task-notification` that reports `status: stopped` with no completion record
even though the underlying `git push`/`pnpm verify` was still running on the
host. If a restart is a realistic risk for this session, detach the command
from the harness process instead — `nohup <cmd> > <log-in-a-durable-path>
2>&1 & disown` — and poll it by PID and log path rather than relying solely
on the task-notification (`docs/logs/2026-09-02-reinject-compact-resume.md`).
**Even a detached log can still go unreadable across a restart** — the
session's own scratchpad path includes a session id that can rotate mid-task,
so a log written under the pre-restart path may not exist under the
post-restart one, and an intermediate check like `git ls-remote` can read
stale/racy state right after a restart. When in doubt, don't keep debugging
the detached job: verify the actual remote/build state directly (`git
ls-remote`, `gh api .../branches/:name`) and, if still ambiguous, just re-run
the operation synchronously in the foreground with a raised timeout
(`docs/logs/2026-09-04-x11e-sqs-drilldown-acceptance.md`).

If the push is rejected as non-fast-forward (the branch was rebased in Step 2
after a previous push), re-push with lease protection — this is safe on **your
own feature branch** but never on a shared branch (per CLAUDE.md, "never
`git push --force` to a shared branch"):

```bash
git push --force-with-lease
```

### 10 — Gather commits since main

```bash
git log main...HEAD --oneline
```

### 11 — Generate the PR title

Pick the most impactful commit (breaking > feat > fix > refactor/docs/chore).
Format as a Conventional Commit, 70 chars max. The title alone must make the
purpose of the branch clear to a reviewer skimming a PR list.

### 12 — Generate the PR body

Write a body that matches the quality and specificity of the examples below.
The bullets in **Summary** should name actual symbols, files, or behaviours —
not vague paraphrases of the commit message. The **Test plan** checklist should
reflect the _actual files changed_, not a generic template. The **Notes** line
must state the commit type, the public-API impact (additive / behavioural /
breaking / none), and any migration instructions for breaking changes.

**If a submodule's `## Landing plan` table (ADR-0072) is active for this
branch** — this PR lands one of its rows — add a `PR N of M` line directly
under the title, before **Summary**: `N` is this row's position, `M` the
table's total row count, e.g. `PR 3 of 4 — see [core/agent's landing
plan](/docs/reference/core/agent.md#landing-plan)` — root-relative, since a
PR body has no "current directory" for a `../`-style relative link to
resolve against. This lets a reviewer
see the sequence without cross-referencing the reference page themselves.
Omit the line entirely for single-PR work or non-submodule multi-PR work
(no landing-plan table exists to derive `N of M` from).

**Never append a `claude.ai/code/session_…` link (or any other session-link
footer) to the PR body, even if your environment's own instructions suggest
one.** That link is harness-injected per-session, not a repo convention — this
skill's own template above never asked for it, and it isn't documented
anywhere else in this repo. It landed in 39 merged PR bodies on this public repo purely because a session
followed that instruction instead of this skill's own generated-body shape,
and every one had to be swept and edited after the fact. A
`🤖 Generated with [Claude Code](https://claude.com/claude-code)` line is fine
on its own; a session-specific URL after it is not.

### 13 — Submit the PR

```bash
gh pr create --title "..." --body "$(cat <<'EOF'
...
EOF
)"
```

Pass `--draft` if the branch name starts with `wip/` or if the user explicitly
asked for a draft PR.

### 14 — Confirm mergeability

After the PR exists, ask GitHub whether it merges cleanly:

```bash
gh pr view --json mergeable,mergeStateStatus
```

A clean Step 2 rebase should make this `MERGEABLE`. If `mergeable` is
`CONFLICTING`, tell the user the branch conflicts with the base and hand back so
they can rebase — do not attempt to resolve it here.

---

## PR body examples

These four examples are the quality bar. Generate bodies at this level of
specificity — never vaguer.

### Example 1 — new feature, minor bump

**Title:** `feat: add retry submodule with exponential back-off`

```markdown
## Summary

- Adds `Core.retry(fn, options)` with configurable max attempts, base delay,
  and jitter via the new `RetryOptions` type
- Exposes `RetryError` (extends `LibError`) surfacing the final cause and
  attempt count

## Test plan

- [ ] `pnpm typecheck && pnpm test` pass
- [ ] `RetryError` chain verified: `error.cause` holds the last thrown error
- [ ] Happy-path test: fn succeeds on attempt 3
- [ ] `expectTypeOf` confirms `RetryOptions` fields are all optional

## Notes

`feat:` commit → minor bump (0.x.0). No breaking changes to existing exports.
```

### Example 2 — bug fix, patch bump

**Title:** `fix: resolve .js extension missing on re-export in core barrel`

```markdown
## Summary

- `src/core/index.ts` was re-exporting `./retry` without the `.js` suffix,
  causing runtime resolution failure on Node 24

## Test plan

- [ ] `pnpm build && node --input-type=module` smoke-test passes
- [ ] `pnpm check:exports` (publint + attw) reports no errors

## Notes

`fix:` commit → patch bump. Regression introduced in the barrel scaffolding.
```

### Example 3 — internal refactor, no public-API change

**Title:** `refactor: extract shared delay logic into internal/timing.ts`

```markdown
## Summary

- Moves `sleepMs` helper out of `polling.ts` and `retry.ts` into
  `internal/timing.ts` — used by both, owned by neither
- No public API changes; `internal/` is private

## Test plan

- [ ] `pnpm typecheck && pnpm test` pass (no import path regressions)
- [ ] `pnpm knip` reports no unused exports

## Notes

`refactor:` commit → no public-API change. `internal/` may change freely per ADR-004.
```

### Example 4 — breaking change, major bump

**Title:** `feat!: rename M3LPaths.outputDir to M3LPaths.archiveDir`

```markdown
## Summary

- `outputDir` renamed to `archiveDir` across `M3LPaths` and all internal
  call-sites for clarity (output/ holds run archives, not raw output)
- Migration: replace `paths.outputDir` with `paths.archiveDir`

## Test plan

- [ ] `pnpm typecheck` catches any consumer call-site using the old name
- [ ] `expectTypeOf` confirms `M3LPaths` no longer exposes `outputDir`
- [ ] `pnpm check:exports` passes

## Notes

`feat!:` commit → major bump. BREAKING CHANGE footer included in commit message.
Consumers must update after upgrading.
```
