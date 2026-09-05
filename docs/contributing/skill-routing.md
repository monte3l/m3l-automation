# Skill routing guide

You know roughly what you want to do — "add a new AWS wrapper", "the CI run
is red", "I need to fix a review comment" — and want to know which Claude
Code skill in this repo handles it, and how to invoke it. This page answers
that. It is written for **you**, the maintainer, not for Claude — every other
harness document (`CLAUDE.md`, `.claude/rules/*.md`,
`docs/contributing/agent-operating-model.md`) is instructions Claude reads
about itself; this one is a lookup table you read about the harness.

For the in-session equivalent — ask Claude the same question without leaving
the terminal — run `/harness-guide <what you're trying to do>`. It reads this
page and answers directly. See [Ask instead of look
up](#ask-instead-of-look-up) below.

## Slash command or plain English — does it matter?

Both work, but they are not the same mechanism underneath, and the
difference matters for a skill you use rarely.

- **`/skill-name`** is a deterministic dispatch. The harness parses it before
  the model ever reasons about your request, so it always reaches the named
  skill regardless of how it's phrased or how many other skills exist.
- **Plain English** ("open a PR for this") depends on Claude matching your
  request against every skill's `description`, which is injected into the
  model's context inside a fixed **skill-listing budget** — about 1% of the
  active context window. This repo currently uses 7,739 of that budget's
  ~8,000 characters at a 200,000-token context window (enforced by
  `pnpm check:context-budget`, which fails the push if the listing grows past
  it). If the listing ever did overflow that budget, Claude Code drops
  descriptions starting with the **least-invoked** skills — so a skill you
  reach for once a month is exactly the one at risk of silently stopping to
  trigger on prose.

**Use `/skill-name` when you know which skill you want** — it's faster to
type and never depends on phrasing or budget headroom. Prose is fine for
common skills (`starting-work`, `creating-prs`) where the description is
well within budget and triggers reliably either way. If a skill of yours ever
stops firing on a phrase that used to work, that's the listing-budget
degradation above — check `pnpm check:context-budget`'s skill-listing line,
or just start typing `/` and pick it from the menu.

## Routing table

Each skill's row gives the exact `/slug`, the plain-English phrasing that
also reaches it (subject to the budget note above), and what it hands off to
next when it's a link in a chain.

### Planning and research

| I want to...                                                                         | Skill                             | Also triggers on                                               |
| ------------------------------------------------------------------------------------ | --------------------------------- | -------------------------------------------------------------- |
| Investigate a topic and get a plan, without writing code yet                         | `/auditing`                       | "audit the codebase", "audit \[topic]", "investigate and plan" |
| Check a specific decision or approach against Anthropic's own docs before committing | `/researching-anthropic-guidance` | "what does Anthropic recommend for X"                          |
| Sweep the whole harness (agents/skills/hooks/rules/CLAUDE.md) for staleness          | `/refreshing-anthropic-guidance`  | "is our harness up to date with Anthropic"                     |

### Starting a change

| I want to...                                                | Skill            | Also triggers on                                             |
| ----------------------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| Figure out branch/worktree/PR plan before touching any code | `/starting-work` | "implement X", "fix Y", "build Z" — anything with real scope |

`starting-work` is the mandatory first step for anything touching
`packages/*/src/**`, `scripts/*/src/**`, or `**/tests/**` — a pre-push hook
blocks those writes on `main`. It hands off into one of the four build chains
below.

### Building library code (`packages/m3l-common`)

| I want to...                                                                | Skill                      | Then                                   |
| --------------------------------------------------------------------------- | -------------------------- | -------------------------------------- |
| Add a brand-new Core/AWS module with no spec page yet                       | `/scaffolding-submodules`  | hands off to `implementing-submodules` |
| Flesh out a module that already has a `docs/reference/{core,aws}/*.md` page | `/implementing-submodules` | → `/creating-prs`                      |

### Building a consumer script (`scripts/<name>`)

| I want to...                                             | Skill                   | Then                                |
| -------------------------------------------------------- | ----------------------- | ----------------------------------- |
| Add a brand-new script package with no directory yet     | `/scaffolding-scripts`  | hands off to `implementing-scripts` |
| Implement the real logic of an already-scaffolded script | `/implementing-scripts` | → `/creating-prs`                   |

### Shipping and closing out

| I want to...                                                        | Skill             | Also triggers on                                        |
| ------------------------------------------------------------------- | ----------------- | ------------------------------------------------------- |
| Verify gates, push, open the PR, decide its merge path              | `/creating-prs`   | "open a PR", "ship this for review", "get this merged"  |
| Clean up after a PR merged (branch, worktree, refs, tracker prompt) | `/finishing-work` | "clean up after this PR", "the PR merged, wrap this up" |
| Reconcile doc metadata (provenance, counts, reference index)        | `/syncing-docs`   | "sync docs", "reconcile docs", "stamp provenance"       |

`creating-prs` always calls `/syncing-docs` itself as one of its steps — you
rarely need to invoke it standalone except mid-task or before a PR exists.

### Git and review hygiene

| I want to...                                            | Skill                        | Also triggers on                                           |
| ------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| Write a commit message for what's staged                | `/writing-commits`           | "commit this", "write a commit"                            |
| Finish a rebase/merge that's showing real conflicts     | `/resolving-merge-conflicts` | "git says CONFLICT", "help me finish this rebase"          |
| Address `claude-pr-review`'s automated findings on a PR | `/resolving-pr-comments`     | "fix what the bot flagged", "claude-pr-review posted FAIL" |

### CI, security, and dependency triage

| I want to...                                         | Skill                       | Also triggers on                                 |
| ---------------------------------------------------- | --------------------------- | ------------------------------------------------ |
| Understand why a CI run went red                     | `/triaging-ci`              | "why did CI fail", "CI is failing", a run ID/URL |
| Check open CodeQL/Scorecard alerts on a PR or branch | `/triaging-scan-alerts`     | "check the CodeQL alerts"                        |
| Review and merge/hold/reject open Dependabot PRs     | `/reviewing-dependabot-prs` | "review the dependabot PRs"                      |

### Config-specific how-to

| I'm touching...                                                | Skill                          |
| -------------------------------------------------------------- | ------------------------------ |
| `eslint.config.js`, an ESLint rule, an override block          | `/eslint-flat-config`          |
| `tsconfig*.json`, a project reference, TS5110/TS2834/2835      | `/tsconfig-strict-esm`         |
| `vitest.config.ts`, a coverage threshold, `vi.mock`/type tests | `/vitest-coverage-types-mocks` |

### The knowledge loop

| I want to...                                                           | Skill                         | Also triggers on                          |
| ---------------------------------------------------------------------- | ----------------------------- | ----------------------------------------- |
| Record what happened after a unit of work ([scope](../logs/README.md)) | `/writing-work-logs`          | "document this task", "log what happened" |
| Find lessons recurring across logs and promote them into rules         | `/promoting-work-log-lessons` | "promote work-log lessons"                |

## Successor chains

Several skills are one link in a fixed sequence, not a standalone
destination:

```text
scaffolding-submodules → implementing-submodules → creating-prs → finishing-work
scaffolding-scripts    → implementing-scripts    → creating-prs → finishing-work
```

`starting-work` precedes every chain above; `syncing-docs` is a sub-step
inside `creating-prs`, not a separate stage.

## When nothing in the table matches

Say so rather than guessing at the nearest-sounding skill name. Either ask
directly, or run `/auditing` — it's the general-purpose "investigate and
plan" entry point and doesn't require knowing which narrower skill applies
first.

## Ask instead of look up

`/harness-guide <what you're trying to do>` reads this page and answers
directly, without you scanning the table by hand. It's reachable only by
that literal command — it's deliberately excluded from the model's
automatic skill-listing (`disable-model-invocation: true` in its
frontmatter), so it adds nothing to the listing-budget accounting above and
can never compete with another skill for prose-matching.

## Keeping this page current

A new skill needs a row here in the same PR that adds it — nothing enforces
that automatically today (unlike `docs/contributing/skills-catalog.md`'s
per-skill catalog row, which `check:skill-frontmatter` does enforce). Add the
row under whichever section fits, or a new section if none does.
