---
name: resolving-pr-comments
description: >
  This skill resolves automated PR review bot findings end-to-end, across all three
  severity tiers. When a review bot (especially claude-pr-review) has posted a comment
  with findings — TypeScript errors, missing .js extensions, TSDoc gaps, coverage holes
  — and the user wants them fixed, committed, and replied to: invoke this skill. It owns
  the full loop: fetch bot comment → parse findings across all tiers → fix every
  Must-fix (mandatory), fix each Should-fix that resolves as a targeted line fix
  (best-effort — skipped, not blocked on, if it needs a structural change), fold in
  Nits only where an edit already touches that file/region → run quality gates →
  reconcile docs (/syncing-docs) → commit → push → reply to bot.

  Invoke for: "fix what the bot flagged", "address the bot review", "make the
  auto-review pass", "claude-pr-review posted FAIL", "clear blocking findings from the
  reviewer", "fix the PR review comments", "address the review findings", "resolve the
  bot's review", "fix the claude review", "address PR feedback", "the review failed fix
  it", "fix what the reviewer flagged".

  Also invoke proactively when the user pushes a branch and mentions a FAIL verdict, or
  pastes a snippet of the bot's review comment. Even if they say "fix the issues on this
  PR" — if there is an open PR on the current branch with a bot FAIL comment, this is
  the right skill.

  Skip for: manual code reviews, general CI/build failures without a review bot,
  creating PRs.

  GitHub-integration stance: ADR-0030 (amended 2026-07-27) — this skill runs
  hub-only, in-process, never inside a spoke or headless CI, so it has full
  GitHub MCP coverage and uses `mcp__github__*` tools rather than the gh CLI.
---

# resolving-pr-comments

Automates the loop of reading the `claude-pr-review.yml` bot's findings, fixing each
one, verifying quality gates, and closing the loop with a reply comment — so you spend
zero time on mechanical review-driven edits.

## Boundary rules

- Never push with `--force`.
- If any quality gate fails after your fixes, **stop and report the failure** — do not
  commit or push.
- If a **Must-fix** finding requires a structural change you cannot make as a targeted
  line fix (e.g., redesigning an entire type hierarchy, splitting a test suite),
  describe what is needed and ask the user to handle it before continuing — Must-fix
  blocks merge, so it cannot be silently skipped.
- If a **Should-fix** finding requires the same kind of structural change, skip it
  instead of asking — it does not block merge, so stopping the whole run over an
  optional item is worse than leaving it for a human. Note it as not addressed in the
  Step 3 preview and the Step 10 follow-up comment.
- The skill runs in-process as a single agent — no hub-and-spoke needed. This is
  precisely what makes the GitHub MCP tools below usable here: MCP is hub-only
  (no spoke holds an `mcp__*` grant) and unavailable in headless CI, but this
  skill is invoked directly by the hub, never delegated (see ADR-0030's
  2026-07-27 amendment).

---

## Steps

### 1 — Detect the PR

Resolve `{owner}/{repo}` from the local remote (no API call needed — MCP tools
take `owner`/`repo` as parameters):

```bash
git remote get-url origin
```

Parse the owner/repo out of that URL, then find the open PR for the current branch:

```
mcp__github__list_pull_requests({ owner, repo, state: "open", head: "{owner}:{branch}" })
```

where `{branch}` is `git rev-parse --abbrev-ref HEAD`. If the result is empty, tell the
user: "No open PR found for the current branch" and stop.

Store the PR number for use in the subsequent calls.

### 2 — Fetch the bot comment

Fetch every comment on the PR's issue thread — not just `claude[bot]`'s. The
`claude-pr-review.yml` workflow authenticates via `CLAUDE_CODE_OAUTH_TOKEN`
(OAuth app), so a normal review always posts as `claude[bot]`, but the
oversize-rejection path below uses `github.token` instead and posts as
`github-actions[bot]`:

```
mcp__github__pull_request_read({
  method: "get_comments", owner, repo, pullNumber, perPage: 100
})
```

`get_comments` is paginated (`page`/`perPage`) the same way `gh api --paginate` was —
keep paging (increment `page`) until a page returns fewer than `perPage` results, so a
thread with more than 100 comments isn't silently truncated.

Across all pages, find the single most recent comment (highest `created_at`)
that is either:

- a `claude[bot]` comment, or
- a comment from any author whose body starts with `## Claude PR Review — not
run` (the oversize-rejection path — `claude-pr-review.yml` posts this with
  `github.token` when the reviewable diff exceeds `MAX_REVIEWABLE_BYTES`,
  specifically so its `github-actions[bot]` identity can never be mistaken
  for a real review).

- If neither kind of comment is found, tell the user "No bot review comment found"
  and stop.
- If the most recent qualifying comment is the oversize-rejection kind, tell the
  user: "This PR's reviewable diff was too large for a single-pass review — no
  review ran. Split the PR into smaller pieces (see
  `docs/contributing/branch-protection.md`) rather than fixing findings, since
  none were produced." Then **stop** — do not attempt to parse Must-fix
  findings from a review that never ran.
- Otherwise the most recent qualifying comment is a `claude[bot]` review.
  Check whether its **Verdict** section says PASS by anchoring the match to
  the bullet form directly under the heading, not a bare word-search over the
  following lines — a FAIL comment whose reason text happens to contain the
  word "pass" (e.g. "does not pass the export check") must not be misread as
  PASS, the same false-positive class `bin/lib/pr-review-gate.mjs` guards
  against for the workflow's own gate:
  ```bash
  echo "$body" | grep -A2 '^### Verdict' | grep -qE '^\s*-\s*PASS\b'
  ```
  If the Verdict is PASS, do **not** stop here — proceed to Step 3 to parse and show
  any Should-fix/Nits for context (a PASS still routes through the preview; only the
  fix/gate/commit steps are skipped). Stopping here unconditionally was the previous
  behavior and silently dropped Should-fix/Nit visibility on every PASS review — this
  skill's own description promises "showing Should-fix / Nits for context", and a PASS
  verdict is the majority case (most reviewed PRs never raise a Must-fix), so the old
  early-exit broke that promise for most invocations, not an edge case.
- Otherwise, proceed with the full comment body.

### 3 — Parse findings

The bot groups violations under three severity headings: `### Must-fix`,
`### Should-fix`, and `### Nits`. Each bullet has this form (trailing period
included — REVIEW.md's Output format section is the canonical source for
this exact template, restated verbatim in `claude-pr-review.yml`'s prompt):

```
- **`path/to/file.ts:line`** — <violation> (<which rule>).
```

The rule in parentheses maps to a fix category (TypeScript, ESM imports, Error handling,
Security, Testing, Exports map). Parse each section separately and tag every bullet with
its severity tier and its rule/category.

**Split every finding into its claim, its concern, and its prescription, and
trust the three separately.** Verify the claim against the raw artifact — a
wrong claim routinely wraps a correct concern. Check the prescription against
existing precedent before dispatching it: two spokes on `aws/bedrock-runtime`
diagnosed correctly and prescribed a fix that would have introduced a new
defect, a reviewer on `sqs-etl` suggested reusing a shared primitive whose
generic bound made the flagged duplication load-bearing, and a reviewer on
`x9-console-web` called a file's imports clean when only a real build showed
what the module graph actually reached.

Print a three-section preview to the user before starting any edits. Omit a section if
it has no findings:

```
## Must-fix (will be fixed — mandatory)
1. `src/core/foo.ts:12` — bare throw (Error handling)
…

## Should-fix (will be examined — fixed if it resolves as a targeted line fix, left otherwise)
1. `src/core/foo.ts:45` — missing @example (TypeScript)
…

## Nits (left as-is unless an edit above already touches the same file/region)
1. …
```

After printing the preview, branch on the verdict from Step 2:

- **PASS**: nothing blocks merge by definition, so there is nothing to fix regardless
  of what the preview shows. Tell the user "The bot review already shows PASS —
  nothing blocking." (add "See Should-fix / Nits above for optional follow-up." only
  if the preview printed a non-empty Should-fix or Nits section) and **stop** — do not
  proceed to Step 4.
- **FAIL with an empty Must-fix list** (the anomaly case): tell the user "The bot
  verdict is FAIL but no Must-fix items were found. See Should-fix / Nits above.
  Investigate whether the bot miscategorised a finding or if a non-blocking item was
  intended to block." Then **stop**.
- **FAIL with a non-empty Must-fix list**: continue to Step 4.

### 4 — Implement fixes

Work through categories in this order. Error handling and Security are adjacent because
both gate on `pnpm lint` — running them together avoids a duplicate gate pass:

1. TypeScript
2. ESM imports
3. Error handling
4. Security
5. Testing
6. Exports map

Within each category, apply fixes in this priority order — **Must-fix is mandatory,
Should-fix is best-effort, Nits are opportunistic only**:

1. **Must-fix (mandatory).** For every Must-fix finding in this category, locate the
   affected file and apply the **minimum correct fix** from the table below. Nothing
   here is optional — if a fix needs more than a targeted line change, follow the
   Boundary rules above (ask the user, don't skip).
2. **Should-fix (best-effort).** For every Should-fix finding in this category, use the
   same table. If it resolves as a targeted line fix, apply it in the same pass as the
   category's Must-fix fixes. If it needs a structural change, or its correct fix is
   ambiguous, **skip it** — prefer skipping over guessing, since an incorrect optional
   fix is worse than leaving it for a human. This tier never blocks the run.
3. **Nits (opportunistic only).** Do not fix a Nit in isolation — never open a file
   solely to address one. Only apply a Nit whose `file:line` falls inside a region a
   Must-fix or Should-fix fix in this same category already touched (the edit is
   already in flight, so folding it in costs nothing extra). Leave every other Nit
   untouched.

Skip any category that has no Must-fix, resolvable Should-fix, or foldable-Nit finding.

| Finding type                               | Correct fix                                                      |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `any` type                                 | Replace with `unknown` and add a narrowing type guard            |
| Non-null `!` assertion in `src/`           | Use an explicit conditional or type guard                        |
| Missing `.js` on relative import           | Append `.js` to the import path                                  |
| `require` / `module.exports` / `__dirname` | Rewrite as ESM `import`/`export`                                 |
| Throwing bare string                       | Throw an `M3LError` subclass with the `cause` option if wrapping |
| Missing TSDoc                              | Add a `/** ... */` block with `@example` on primary entry points |
| Hardcoded secret / credential              | Remove; if needed for tests, use environment variables           |
| Coverage below the per-file threshold      | Add the missing tests (happy-path and failure-path)              |

If you are unsure what the correct fix is for a Must-fix finding, describe the issue
and ask the user rather than guessing — Must-fix cannot be silently skipped. For a
Should-fix finding, skip it instead (see priority order above).

### 5 — Verify after each category

After all fixes in a category are applied, run the gate for that category before moving on:

| Category                  | Gate command         |
| ------------------------- | -------------------- |
| TypeScript / ESM imports  | `pnpm typecheck`     |
| Error handling / Security | `pnpm lint`          |
| Testing                   | `pnpm test:coverage` |
| Exports map               | `pnpm check:api`     |

`pnpm check:api` only catches a change to the `exports` map's subpath set —
it never sees a symbol added to or removed from an existing namespace barrel
(`./core`, `./aws`). A bot-flagged "Exports map" Must-fix about a
barrel-surfaced symbol needs a manual read of the barrel file alongside this
gate; the gate alone is not sufficient proof the finding is resolved.

If a gate fails, stop and show the user the exact error output. Do not continue to the
next category until they resolve it or instruct you to skip.

### 6 — Final full-gate check

Once all categories are done, re-run the fast per-category gates from Step 5
that cover what you touched, then run `pnpm verify` once — the actual
CI-parity / Definition-of-Done check (per CLAUDE.md). It covers the full
`pre-push` cadence (`format:check`, `check:review-size`, `check:exports`,
`verify-signed-range`, and the rest) that the per-category gates alone don't
reach, so a gap surfaces here instead of for the first time at push:

```bash
pnpm verify
```

If this fails, do not commit or push. Show the failure and stop.

### 7 — Bounded re-review

Before reconciling docs, dispatch a targeted re-review of what you actually
changed — not a fresh full fan-out. Per `.claude/rules/subagent-dispatch.md`'s
re-review guidance, scope this to the reviewer(s) whose category the fixes
touched, and to only the files edited in Step 4:

| Category(ies) fixed              | Re-review with                           |
| -------------------------------- | ---------------------------------------- |
| TypeScript, ESM imports, Testing | `code-reviewer`                          |
| Error handling, Security         | `code-reviewer` + `security-reviewer`    |
| Exports map                      | `code-reviewer` + `type-design-analyzer` |

Give each dispatched reviewer only the files changed in Step 4 (not the whole
PR diff) and a scratchpad path for its bounded-output digest. If a reviewer
reports a new Must-fix, loop back to Step 4 for that finding, then repeat
Steps 5–6 before proceeding. If nothing is flagged, continue to Step 8.

### 8 — Reconcile docs

With the gates green, reconcile doc metadata **before** committing. Invoke the
`/syncing-docs` skill — it re-stamps provenance sidecars to the current HEAD,
regenerates `docs/reference/catalog.json`, and reconciles every "N of M"
count site (Core and AWS counts are tracked and reconciled separately —
computed fresh from the filesystem each run, never hardcoded). It only
mutates working-tree files; it never commits.

`/syncing-docs` runs `pnpm lint:md`, which can fail — surface a `lint:md`
failure like any other gate (stop and report) rather than committing past it.

If it produced working-tree changes, stage them so the Step 9 commit captures
them (the reconciled sidecars + `catalog.json` are easy to miss with a narrow
`git add`):

```bash
git add -A
```

If it produced no changes, continue.

### 9 — Commit and push

Commit using the `writing-commits` skill conventions, including its signing
setup — CLAUDE.md requires every pushed commit to carry a valid signature,
and `pre-push`'s `verify-signed-range` gate rejects an unsigned range the
same as it would for any other change. Choose the Conventional Commit type
based on the findings resolved:

| Must-fix findings resolved                                    | Commit type |
| ------------------------------------------------------------- | ----------- |
| Actual defects (`any`, missing `.js`, bare throws, bad types) | `fix:`      |
| TSDoc / `@example` additions only                             | `docs:`     |
| Test coverage gaps only                                       | `test:`     |
| Mix of defect + documentation fixes                           | `fix:`      |

- **Subject:** `{type}: resolve claude-pr-review findings` (≤70 chars)
- **Body:** one bullet per finding actually resolved this pass, grouped by tier —
  Must-fix first, then any Should-fix fixed, then any Nits folded in. Omit a tier's
  sub-heading entirely when nothing in it was resolved. Do not list a Should-fix or Nit
  that was left unaddressed — those belong only in the Step 3 preview and the Step 10
  follow-up comment, never the commit body:
  ```
  Must-fix:
  - replace `any` with `unknown` in src/core/config/index.ts
  - add `.js` extension to relative import in src/aws/index.ts

  Should-fix:
  - add TSDoc + @example to `loadConfig`

  Nits (folded in):
  - prefer `const` over `let` on the same line
  ```

Then sync and push. The `claude-pr-review.yml` workflow only holds
`contents: read` and its prompt explicitly forbids modifying files, so the
bot itself never pushes to the branch — but the branch can still have moved
since this skill started (a teammate's push, a Dependabot auto-fix commit,
another session working the same branch). Rebase onto the remote first to
avoid a rejected non-fast-forward push. Never use `--force`:

```bash
git pull --rebase origin "$(git rev-parse --abbrev-ref HEAD)"
git push
```

If the `git pull --rebase` stops on conflicts, do not force past it — hand off
to the `/resolving-merge-conflicts` skill (it auto-resolves derived-artifact
conflicts and hands back any real `src/`/test logic), then finish the push.

Capture the resulting commit SHA:

```bash
git rev-parse --short HEAD
```

### 10 — Post a follow-up comment

Post a new top-level comment on the PR thread summarising what was fixed. GitHub's
issue-comments API has no `in_reply_to` concept (unlike pull-request review comments),
so this creates a sibling comment rather than a nested reply:

The body should itemize every finding actually resolved this pass (Must-fix, plus any
Should-fix fixed and any Nits folded in), and separately list any Should-fix / Nits
that remain open so the re-reviewer knows what to expect. Omit a resolved-tier section
when nothing in it was resolved; omit "Not addressed" when Should-fix and Nits are both
fully resolved.

```
mcp__github__add_issue_comment({
  owner, repo, issue_number: pr_number,
  body: `Fixed in {commit_sha}:

**Must-fix items resolved:**
- \`path/to/file.ts:line\` — <one-line description of what was changed>
- …

**Should-fix items resolved:**
- \`path/to/file.ts:line\` — <one-line description>
(omit this section entirely if none were resolved)

**Nits folded in:**
- \`path/to/file.ts:line\` — <one-line description>
(omit this section entirely if none were folded in)

**Not addressed (non-blocking):**
- Should-fix: \`path/to/file.ts:line\` — <violation>
- Nits: \`path/to/file.ts:line\` — <violation>`
})
```

Print a confirmation to the user: "Done — posted a follow-up comment with commit
`{sha}`. The PR will re-trigger CI shortly."
