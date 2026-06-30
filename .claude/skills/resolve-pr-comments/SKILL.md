---
name: resolve-pr-comments
description: >
  This skill resolves automated PR review bot failures end-to-end. When a review bot
  (especially claude-pr-review) has posted a FAIL verdict with Must-fix findings —
  TypeScript errors, missing .js extensions, TSDoc gaps, coverage holes — and the user
  wants them fixed, committed, and replied to: invoke this skill. It owns the full loop:
  fetch bot comment → parse Must-fix findings (showing Should-fix / Nits for context but
  not touching them) → fix each Must-fix violation → run quality gates → commit → push →
  reply to bot.

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
---

# resolve-pr-comments

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
- The skill runs in-process as a single agent — no hub-and-spoke needed.

---

## Steps

### 1 — Detect the PR

Run:

```bash
gh pr view --json number,headRefName,url
```

If the command fails or returns no PR, tell the user: "No open PR found for the current
branch" and stop.

Store the PR number for use in the subsequent API calls.

### 2 — Fetch the bot comment

Determine the GitHub `{owner}/{repo}` from the remote:

```bash
gh repo view --json nameWithOwner --jq '.nameWithOwner'
```

Fetch the most recent bot review comment on the PR's issue thread. The
`claude-pr-review.yml` workflow authenticates via `CLAUDE_CODE_OAUTH_TOKEN` (OAuth app),
so the action always posts as `claude[bot]`. Use `--paginate` so comments beyond the
first page (>30 items) are not silently missed:

```bash
gh api repos/{owner}/{repo}/issues/{pr_number}/comments \
  --paginate \
  --jq '.[] | select(.user.login == "claude[bot]")' \
  | jq -s 'last'
```

`--jq` streams one JSON object per line across all pages; `jq -s 'last'` collects them
into an array and returns the most recent one.

- If the output is empty, tell the user "No bot review comment found" and stop.
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
`### Should-fix`, and `### Nits`. Each bullet has this form:

```
- **`path/to/file.ts:line`** — <violation> (<which rule>)
```

The rule in parentheses maps to a fix category (TypeScript, ESM imports, Error handling,
Security, Testing, Exports map). Parse each section separately and tag every bullet with
its severity tier and its rule/category.

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
| Coverage below 80%                         | Add the missing tests (happy-path and failure-path)              |

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

### 7 — Commit and push

Commit using the `write-commit` skill conventions. Choose the Conventional Commit type
based on the findings resolved — per CLAUDE.md, only `fix:` triggers a patch release:

| Must-fix findings resolved                                    | Commit type | Semver impact |
| ------------------------------------------------------------- | ----------- | ------------- |
| Actual defects (`any`, missing `.js`, bare throws, bad types) | `fix:`      | patch         |
| TSDoc / `@example` additions only                             | `docs:`     | no release    |
| Test coverage gaps only                                       | `test:`     | no release    |
| Mix of defect + documentation fixes                           | `fix:`      | patch         |

- **Subject:** `{type}: resolve claude-pr-review must-fix findings` (≤70 chars)
- **Body:** one bullet per **Must-fix** finding resolved (do not list Should-fix or Nits):
  ```
  - replace `any` with `unknown` in src/core/config/index.ts
  - add `.js` extension to relative import in src/aws/index.ts
  - add TSDoc + @example to `loadConfig`
  ```

Then push:

```bash
git push
```

Capture the resulting commit SHA:

```bash
git rev-parse --short HEAD
```

### 8 — Post a follow-up comment

Post a new top-level comment on the PR thread summarising what was fixed. GitHub's
issue-comments API has no `in_reply_to` concept (unlike pull-request review comments),
so this creates a sibling comment rather than a nested reply:

The body should itemize every Must-fix finding that was resolved, and list any
Should-fix / Nits that remain open so the re-reviewer knows what to expect. Omit
the "Not addressed" section if Should-fix and Nits are both empty.

```bash
gh api repos/{owner}/{repo}/issues/{pr_number}/comments \
  --method POST \
  --field body="$(cat <<'EOF'
Fixed in {commit_sha}:

**Must-fix items resolved:**
- \`path/to/file.ts:line\` — <one-line description of what was changed>
- …

**Not addressed (non-blocking):**
- Should-fix: \`path/to/file.ts:line\` — <violation>
- Nits: \`path/to/file.ts:line\` — <violation>
EOF
)"
```

Print a confirmation to the user: "Done — posted a follow-up comment with commit
`{sha}`. The PR will re-trigger CI shortly."
