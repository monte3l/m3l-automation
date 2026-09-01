---
name: resolving-pr-comments
description: >
  This skill resolves automated PR review bot failures end-to-end. When a review bot
  (especially claude-pr-review) has posted a FAIL verdict with Must-fix findings —
  TypeScript errors, missing .js extensions, TSDoc gaps, coverage holes — and the user
  wants them fixed, committed, and replied to: invoke this skill. It owns the full loop:
  fetch bot comment → parse Must-fix findings (showing Should-fix / Nits for context but
  not touching them) → fix each Must-fix violation → run quality gates → reconcile docs
  (/syncing-docs) → commit → push → reply to bot.

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
- If a finding requires a structural change you cannot make as a targeted line fix
  (e.g., redesigning an entire type hierarchy, splitting a test suite), describe what is
  needed and ask the user to handle it before continuing.
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

Fetch the most recent bot review comment on the PR's issue thread. The
`claude-pr-review.yml` workflow authenticates via `CLAUDE_CODE_OAUTH_TOKEN` (OAuth app),
so the action always posts as `claude[bot]`:

```
mcp__github__pull_request_read({
  method: "get_comments", owner, repo, pullNumber, perPage: 100
})
```

`get_comments` is paginated (`page`/`perPage`) the same way `gh api --paginate` was —
keep paging (increment `page`) until a page returns fewer than `perPage` results, so a
thread with more than 100 comments isn't silently truncated. Across all pages, filter to
comments where the author is `claude[bot]` and take the most recent one (highest
`created_at` / last in creation order).

- If no `claude[bot]` comment is found, tell the user "No bot review comment found" and stop.
- Check whether the bot's **Verdict** section says PASS by anchoring the grep to the
  heading so a passing sub-check mentioned elsewhere in the comment body cannot trigger
  a false early-exit:
  ```bash
  echo "$body" | grep -A2 '^### Verdict' | grep -qiw 'PASS'
  ```
  If the Verdict is PASS, tell the user "The bot review already shows PASS — nothing
  to fix." and stop.
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
## Must-fix (will be fixed)
1. `src/core/foo.ts:12` — bare throw (Error handling)
…

## Should-fix (not touched — non-blocking)
1. `src/core/foo.ts:45` — missing @example (TypeScript)
…

## Nits (not touched — advisory)
1. …
```

After printing the preview, check for the "FAIL with no Must-fix items" anomaly:

- If the verdict is FAIL **and** the Must-fix list is empty, tell the user:
  "The bot verdict is FAIL but no Must-fix items were found. See Should-fix / Nits
  above. Investigate whether the bot miscategorised a finding or if a non-blocking
  item was intended to block." Then **stop**.
- If the verdict is PASS (confirmed by the check in Step 2), you never reach this point.

### 4 — Implement fixes

Work through **Must-fix findings only**, in this category order. Error handling and
Security are adjacent because both gate on `pnpm lint` — running them together avoids a
duplicate gate pass:

1. TypeScript
2. ESM imports
3. Error handling
4. Security
5. Testing
6. Exports map

For each Must-fix finding whose rule matches the current category, locate the affected
file and apply the **minimum correct fix**. Skip any category that has no Must-fix
findings. Should-fix and Nits are not touched.

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

If you are unsure what the correct fix is for a finding, describe the issue and ask the
user rather than guessing.

### 5 — Verify after each category

After all fixes in a category are applied, run the gate for that category before moving on:

| Category                  | Gate command         |
| ------------------------- | -------------------- |
| TypeScript / ESM imports  | `pnpm typecheck`     |
| Error handling / Security | `pnpm lint`          |
| Testing                   | `pnpm test:coverage` |
| Exports map               | `pnpm check:api`     |

If a gate fails, stop and show the user the exact error output. Do not continue to the
next category until they resolve it or instruct you to skip.

### 6 — Final full-gate check

Once all categories are done, run the full suite (matches the Definition of Done in
CLAUDE.md — all four gates):

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build
```

If this fails, do not commit or push. Show the failure and stop.

### 7 — Reconcile docs

With the gates green, reconcile doc metadata **before** committing. Invoke the
`/syncing-docs` skill — it re-stamps provenance sidecars to the current HEAD,
regenerates `docs/reference/catalog.json`, and reconciles the "N of 22" counts.
It only mutates working-tree files; it never commits.

`/syncing-docs` runs `pnpm lint:md`, which can fail — surface a `lint:md`
failure like any other gate (stop and report) rather than committing past it.

If it produced working-tree changes, stage them so the Step 8 commit captures
them (the reconciled sidecars + `catalog.json` are easy to miss with a narrow
`git add`):

```bash
git add -A
```

If it produced no changes, continue.

### 8 — Commit and push

Commit using the `writing-commits` skill conventions. Choose the Conventional Commit type
based on the findings resolved:

| Must-fix findings resolved                                    | Commit type |
| ------------------------------------------------------------- | ----------- |
| Actual defects (`any`, missing `.js`, bare throws, bad types) | `fix:`      |
| TSDoc / `@example` additions only                             | `docs:`     |
| Test coverage gaps only                                       | `test:`     |
| Mix of defect + documentation fixes                           | `fix:`      |

- **Subject:** `{type}: resolve claude-pr-review must-fix findings` (≤70 chars)
- **Body:** one bullet per **Must-fix** finding resolved (do not list Should-fix or Nits):
  ```
  - replace `any` with `unknown` in src/core/config/index.ts
  - add `.js` extension to relative import in src/aws/index.ts
  - add TSDoc + @example to `loadConfig`
  ```

Then sync and push. The `claude-pr-review` bot can push to the branch (e.g. an
auto-fix commit), so the local branch may be behind its own remote — rebase onto
it first to avoid a rejected non-fast-forward push (lesson from
`docs/logs/2026-06-30-core-utils.md`). Never use `--force`:

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

### 9 — Post a follow-up comment

Post a new top-level comment on the PR thread summarising what was fixed. GitHub's
issue-comments API has no `in_reply_to` concept (unlike pull-request review comments),
so this creates a sibling comment rather than a nested reply:

The body should itemize every Must-fix finding that was resolved, and list any
Should-fix / Nits that remain open so the re-reviewer knows what to expect. Omit
the "Not addressed" section if Should-fix and Nits are both empty.

```
mcp__github__add_issue_comment({
  owner, repo, issue_number: pr_number,
  body: `Fixed in {commit_sha}:

**Must-fix items resolved:**
- \`path/to/file.ts:line\` — <one-line description of what was changed>
- …

**Not addressed (non-blocking):**
- Should-fix: \`path/to/file.ts:line\` — <violation>
- Nits: \`path/to/file.ts:line\` — <violation>`
})
```

Print a confirmation to the user: "Done — posted a follow-up comment with commit
`{sha}`. The PR will re-trigger CI shortly."
