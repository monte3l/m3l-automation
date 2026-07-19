# Project: m3l-automation

<!--
================================================================
 CLAUDE.md — TypeScript Library Edition
================================================================
 SCOPE
   Project-level instruction file read by Claude Code at the
   start of every session. Lives at ./CLAUDE.md or
   ./.claude/CLAUDE.md (both are valid; ./.claude/CLAUDE.md
   keeps the repo root clean). Shared with the team via source
   control. For personal, gitignored overrides use
   ./CLAUDE.local.md.

 PROJECT SHAPE (drives every section below)
   Internal library (not published to npm) · TypeScript (strict) ·
   ESM only · built with tsc (no bundler) · pnpm · Node.js 24 LTS
   floor · Vitest · ESLint + Prettier · public API exposed via
   package.json subpath exports.

 HOW THIS TEMPLATE WORKS
   Every section is wrapped in an HTML comment that documents:
     - Scope/usage     — what the section is for
     - Status          — Mandatory | Recommended | Optional | Niche
     - Best practices  — how to write it well
     - Model notes     — how Fable 5 / Opus 4.8 / Sonnet 4.6 /
                          Haiku 4.5 consume it
   Block-level HTML comments are STRIPPED before CLAUDE.md is
   injected into the model's context, so this documentation
   costs ZERO context tokens at runtime. It is visible only to
   humans editing the file (and via the Read tool).
   NOTE: comments INSIDE fenced code blocks are NOT stripped —
   keep docs outside code fences if you want them free.

 LENGTH DISCIPLINE
   This file is a SUPERSET menu of every standard, recommended,
   and niche section. A real project should keep the
   runtime-visible content (everything outside HTML comments)
   under ~200 lines: longer files consume more context and
   reduce adherence. Delete sections you don't need; push
   multi-step procedures into skills (.claude/skills/) and
   file-type-specific rules into path-scoped .claude/rules/*.md.

 ENFORCEMENT vs GUIDANCE
   CLAUDE.md is ADVISORY — Claude reads it as context, not
   enforced config. For anything that MUST happen every time
   (lint, tests, blocked paths), use a PreToolUse / PostToolUse
   / Stop hook in .claude/settings.json instead.

 PLACEHOLDERS LEFT TO FILL
   <PROJECT_NAME>, <ONE_LINE_PURPOSE>, <CONSUMERS>, <CONSTRAINT>,
   <pkg-scope>/<pkg-name>, and the Domain Glossary term. These
   are project-identity facts; fill them in, do not guess.
================================================================
-->

<!--
================================================================
 SECTION: Project Identity / Overview
 Scope/usage   : One-paragraph orientation. What this is, who
                 uses it, the stack.
 Status        : Mandatory.
 Best practices: 3-5 sentences max. State the runtime, the
                 domain, and the single most important
                 constraint. No marketing prose.
 Model notes   : Haiku 4.5 leans heavily on this to disambiguate
                 intent — be concrete. Opus 4.8 and Fable 5 infer
                 architecture from terse framing; Sonnet 4.6 sits
                 between. Name the language/version explicitly for
                 every tier.
================================================================
-->

A utilities library designed to support automation scripts with
enterprise-grade abstractions for configuration management, logging,
error handling, data import/export, asynchronous polling/retry mechanisms,
and cross-cutting concern. Package @m3l-automation/m3l-common, written
in **TypeScript 6.x** (`strict: true`), compiled with `tsc`
to **ESM-only** output, managed with `pnpm`, targeting **Node.js 24
LTS+**. Primary consumers: automation scripts. The non-negotiable
constraint is: minimal runtime dependencies, no breaking changes outside
a major release, strict semver, no any in the public API, Node 24+ only

**Owner:** the repo maintainer (single-maintainer project). Review this file
whenever a submodule/script pipeline ships, or every ~6 months, whichever
comes first.

## Tech Stack

<!--
================================================================
 SECTION: Tech Stack
 Scope/usage   : Pin the versions and tools Claude must target,
                 not discover.
 Status        : Recommended.
 Best practices: List only what changes Claude's output
                 (language version, module format, package
                 manager, runtime). Avoid an exhaustive
                 dependency dump — that lives in package.json
                 (import it).
 Model notes   : All tiers; prevents Claude from emitting the
                 wrong module system (e.g. CommonJS `require` in
                 an ESM package) by anchoring to a concrete
                 target.
================================================================
-->

- Language: TypeScript 6.x, `strict: true`, compiled with `tsc`
  (no bundler — tsc emits faithful `.d.ts`)
- Module format: **ESM only** (`"type": "module"`; no bundler)
- Runtime floor: Node.js 24 LTS (pinned in `.node-version`)
- Package manager: `pnpm` (lockfile is authoritative; never edit by hand;
  pinned via `packageManager` + Corepack)
- Task runner: `turbo` (orchestrates/caches `build` + `typecheck`)
- Test: `vitest`
- Lint/format: `eslint` (flat config) + `prettier`
- Git hooks: `lefthook` (`lefthook.yml`; replaces husky + lint-staged)
- Dep/exports hygiene: `knip` (unused files/exports/deps),
  `publint` + `@arethetypeswrong/cli` (exports-map / ESM / types resolution)
- Versioning: manual — `version` in package.json is hand-managed; the package
  is internal and not published to npm (see ADR-0020)

See @package.json for the full dependency set, scripts, and the
`exports` map.

## Repository Layout

<!--
================================================================
 SECTION: Repository Layout
 Scope/usage   : Tells Claude where things live so it edits the
                 right file and places new files correctly.
 Status        : Recommended (Mandatory for monorepos).
 Best practices: Show the top 1-2 levels only, annotate intent.
                 Don't paste a full `tree` dump. For monorepos,
                 prefer nested CLAUDE.md files per package
                 (lazy-loaded) over one giant root layout.
 Model notes   : High value for Haiku 4.5 (reduces
                 wrong-directory edits). Opus 4.8 / Fable 5 will
                 explore if omitted, but stating it saves
                 tokens/time.
================================================================
-->

This is a **pnpm monorepo**. The `pnpm-workspace.yaml` at the root is also
what the library's `M3LExecutionEnvironment` detects to switch into MONOREPO
mode (so `M3LPaths` anchors `data/` at the workspace root).

```text
pnpm-workspace.yaml     # packages/* + scripts/* (also triggers MONOREPO mode)
tsconfig.base.json      # shared strict/ESM/Node24 compiler options
packages/
  m3l-common/           # the published library (@m3l-automation/m3l-common)
    src/
      index.ts          # main entry / public barrel (re-exports Core + AWS)
      core/index.ts     # Core namespace barrel (19 submodules surfaced here)
      aws/index.ts      # AWS namespace barrel (11 submodules surfaced here)
      internal/         # NOT exported; no "exports" entry; may change freely
    dist/               # tsc output (ESM .js + .d.ts) — generated, never edit
    tests/              # *.test.ts (Vitest)
scripts/                # automations consuming the library via workspace:*
  <name>/src/           # main.ts composition root + config.ts + steps/ (ADR-0022)
data/{config,input,output}/   # M3LPaths dirs (output/ holds run archives)
```

The package.json `exports` map exposes exactly three entries — `.`, `./core`,
and `./aws`. New Core/AWS submodules are surfaced through the namespace barrel
(`src/core/index.ts` / `src/aws/index.ts`), NOT as new subpath entries. Adding,
removing, or retyping one of the three entries is a semver event. Anything under
`internal/` is private API.

## Environment Setup

<!--
================================================================
 SECTION: Environment Setup
 Scope/usage   : The exact commands to get from clone to a
                 runnable state.
 Status        : Recommended.
 Best practices: Copy-pasteable, idempotent commands. State env
                 vars by name only, never values/secrets.
 Model notes   : All tiers. Critical for Haiku-driven subagents
                 doing setup.
================================================================
-->

```bash
corepack enable     # activate the pnpm version pinned in packageManager
pnpm install        # install deps + lefthook git hooks (prepare script)
pnpm build          # turbo -> tsc -> dist/ (ESM .js + .d.ts)
pnpm test           # run the suite once
```

Node is pinned in `.node-version` (24); use a manager that reads it
(fnm/nvm/mise) plus `corepack enable` for pnpm. Git hooks install
automatically via the `prepare` script (`lefthook install`).
In CI, use `pnpm install --frozen-lockfile`. A pure library needs no
services and no publish credentials. CI uses only the auto-provided
`GITHUB_TOKEN`; never commit any secret — the `guard-secret-writes` hook and
`gitleaks` scan defensively block token literals (`NPM_TOKEN`, `GITHUB_TOKEN`,
AWS keys) at write time and in CI.

## Commands

<!--
================================================================
 SECTION: Build / Test / Run Commands
 Scope/usage   : The single highest-leverage section. The exact
                 verified commands Claude should run per task.
 Status        : Mandatory.
 Best practices: Use real, working invocations. Pair each with
                 WHEN to run it. If a command MUST run (e.g.
                 tests before commit), back it with a
                 PostToolUse/Stop hook — CLAUDE.md alone is
                 advisory and Claude may skip it.
 Model notes   : All tiers rely on this. Haiku 4.5 in particular
                 will not infer your test runner — name it. The
                 stronger tiers still benefit by avoiding the
                 wrong flag.
================================================================
-->

Run any task with `pnpm <script>`; the full list is in `package.json` `scripts`.
The table below is the source of truth for the git-hook cadence, machine-verified
against `lefthook.yml` by `pnpm check:cadence`.

| Stage                      | Checks run                                                                                                                                                                                  | Scope                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `pre-commit` (lefthook)    | `eslint --fix`, `prettier --write`                                                                                                                                                          | staged files only         |
| `commit-msg` (lefthook)    | `lint-commit`                                                                                                                                                                               | the commit message        |
| `pre-push` (lefthook)      | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm build`, `pnpm check:exports`, `verify-signed-range`, `pnpm check:agents`                                    | whole repo                |
| CI `verify` job (`ci.yml`) | everything the pre-push row runs, **plus** every `check:*` script, `pnpm build`, `pnpm knip`, `pnpm lint:md`, `gitleaks`, and `pnpm audit` — see the `verify` job for the full ordered list | whole repo, authoritative |

There is no pre-publish hook (package is internal/unpublished, ADR-0020); every
gate beyond pre-push runs only in CI. `pre-push` runs in parallel but still
takes minutes (`test:coverage`/`lint` are the slowest lanes) — budget for it
(background or a longer timeout) rather than `--no-verify`, since CI re-runs
everything anyway.

## CI/CD

Five GitHub Actions workflows in `.github/workflows/` (plus Dependabot via the
GitHub-native `.github/dependabot.yml`, which is config, not a workflow):

| Workflow                | Trigger                             | Purpose                                                                                                                                                      |
| ----------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ci.yml`                | push / PR → main                    | Full quality-gate pipeline — secrets, deps, lint, formatting, types, and tests must all pass before merge                                                    |
| `claude-pr-review.yml`  | PR opened / sync / reopened / ready | **Mandatory blocking gate** — produces PASS/FAIL verdict; merge requires PASS; skips re-review when a prior PASS still applies (no reviewable files changed) |
| `claude-assistant.yml`  | @claude in issues / PRs             | On-demand Claude Code assistant                                                                                                                              |
| `dependency-review.yml` | PR → main                           | Blocks HIGH/CRITICAL vulnerability advisories                                                                                                                |
| `scorecard.yml`         | push → main / weekly cron           | OpenSSF Scorecard supply-chain posture scoring (ADR-0015); uploads SARIF to the Security tab                                                                 |

## Coding, errors & tests (path-scoped)

<!--
================================================================
 SECTION: Code Style & Conventions
 Scope/usage   : Project-specific rules Claude wouldn't infer
                 from the linter.
 Status        : Recommended.
 Best practices: Encode ONLY what the formatter/linter can't, or
                 what Claude repeatedly gets wrong. Be verifiable.
                 Defer mechanical rules to Prettier/ESLint config
                 and say so.
 Model notes   : Haiku 4.5 needs explicit, enumerated rules plus
                 an example. Sonnet 4.6, Opus 4.8, and Fable 5
                 generalize from one canonical example.
================================================================
-->

The canonical code/test/refactoring **Style Guide** is
`docs/contributing/style-guide.md` (each rule tagged `[enforced]` vs `[advisory]`).
Its terse extracts live in `.claude/rules/` and load only when you touch matching
files (so they cost nothing in unrelated sessions):

- `packages/m3l-common/src/**` → `.claude/rules/library-src.md` — ESM `.js`
  imports, no `any`/`!`, named exports, `readonly`/`const`, the `M3LError`
  hierarchy (chain with `cause`), TSDoc, `internal/` privacy, the `exports`
  contract.
- `**/tests/**`, `*.test.ts` → `.claude/rules/tests.md` — Vitest, a happy +
  failure path per export, `expectTypeOf` where the type is the contract, the
  80 % coverage gate.
- source/scripts/tests → `.claude/rules/refactoring.md` — behavior-preserving
  changes: test-safety-net first, small isolated `refactor:` commits, the
  Boy-Scout rule, and the semver hazard of touching the public surface.
- `scripts/**` → `.claude/rules/scripts.md` — consuming the library via
  `workspace:*` (the only dependency, ADR-0029), service naming (ADR-0028),
  and the `M3LScript` lifecycle.
- Deeper reference: `.claude/rules/domain-knowledge.md`.

## Interaction Style

- **Before planning or implementing:** ask 5–7 clarifying questions to surface
  constraints, preferences, and edge cases before committing to an approach.
- **When multiple valid approaches exist:** present 3–5 solutions with a brief
  rationale and tradeoff for each; do not pick one without user input.
- Input-collection prompts (e.g. "what is the script name?") are exempt — they
  are required-parameter asks, not planning clarifications.

### Response Style

- Keep chat responses concise. For a long deliverable (audit report, plan, ADR,
  triage report), write it to a file and give only a short summary in chat —
  don't paste the whole thing inline.
- If a response would still run very large, split it across turns rather than
  emitting it in one oversized reply.

## Git Workflow

<!--
================================================================
 SECTION: Git Workflow & Commit Conventions
 Scope/usage   : Branching, commit message format, PR
                 expectations.
 Status        : Mandatory here — a named commit convention keeps
                 history readable and machine-scannable.
 Best practices: State the commit convention and the hard rules.
                 Enforce with a commit-msg hook (bin/lint-commit.mjs) or
                 branch protection, not prose alone.
 Model notes   : All tiers follow a named convention reliably;
                 ambiguous phrasing ("write good commits") is
                 ignored across tiers.
================================================================
-->

- **Conventional Commits (required)**, with an AI co-authorship trailer when
  Claude authored/assisted. Enforced by the `commit-msg` hook. Trailer
  mechanics and canonical model names: `docs/contributing/contributing.md`.
- **Before change-work, run `/start-work`** — the pre-work decision gate that
  settles location / branch / PR / push (ADR-0016). Branch from `main`:
  `feat/<slug>`, `fix/<slug>`; `guard-branch-isolation.mjs` blocks
  `packages/*/src/**`, `scripts/*/src/**`, `**/tests/**` writes while `HEAD` is
  `main`.
- Never `git push --force` to a shared branch. Commits should be small,
  incremental, and meaningful.
- **Worktrees** (ADR-0013/0014): `pnpm worktree:new <slug>` creates and
  provisions an isolated sibling checkout; `pnpm worktree:remove <slug>` tears
  it down. Full day-to-day mechanics (native `--worktree`, cleanup/prune
  semantics, merge-driver regen) live in the ADRs — don't duplicate them here.

## Architecture & Decisions

<!--
================================================================
 SECTION: Architecture & Design Decisions
 Scope/usage   : The "why" behind structure so Claude doesn't
                 fight conventions.
 Status        : Optional (Recommended for non-trivial systems).
 Best practices: Record decisions + rationale + what's explicitly
                 out of scope. Link to ADRs rather than inlining.
 Model notes   : Opus 4.8 and Fable 5 extract the most value here
                 — they reason about trade-offs and respect
                 boundaries. Keep terse for Haiku 4.5.
================================================================
-->

- The `exports` map IS the public contract: adding, removing, or
  retyping a subpath is a semver event.
- Everything under `internal/` is private and may change without a
  major bump; never re-export it.
- Stay environment-agnostic; keep runtime dependencies minimal so the
  package tree-shakes cleanly.
- Consumer scripts depend only on `@m3l-automation/m3l-common` — no
  script-local dependencies (ADR-0029); AWS-scoped scripts/submodules carry
  full official service names (ADR-0028).
- Decisions live in `docs/adr/`; see @docs/adr/README.md.

## Security

<!--
================================================================
 SECTION: Security & Secrets
 Scope/usage   : Hard data-handling and secrets rules.
 Status        : Recommended.
 Best practices: State what must NEVER happen. Back the critical
                 rules with a PreToolUse hook (e.g. block writes
                 to .env). CLAUDE.md is advisory.
 Model notes   : All tiers; phrase as absolute prohibitions.
================================================================
-->

- The library does not log by default; never log secrets, tokens, or
  caller data.
- CI's only credential is the auto-provided `GITHUB_TOKEN`; tokens of any kind
  (`NPM_TOKEN`, `GITHUB_TOKEN`, AWS keys) must never land in source, tests, or
  fixtures.
- Validate all external input at the public API boundary before use.
- Commits pushed to the remote must be signed (valid `%G?`). Enforced in three
  layers — the `guard-git-push-signed` Bash hook, the `verify-signed-range`
  `pre-push` backstop, and branch-protection "Require signed commits" (the
  authoritative one). See ADR-0016 and `docs/contributing/branch-protection.md`.

## Performance

<!--
================================================================
 SECTION: Performance
 Scope/usage   : Budgets and hot-path constraints.
 Status        : Optional / Niche.
 Best practices: Give measurable budgets, not "make it fast". For
                 a library, the relevant budget is import cost and
                 tree-shakeability.
 Model notes   : Opus 4.8 and Fable 5 reason about complexity
                 trade-offs from budgets; Haiku 4.5 needs the
                 explicit threshold to act on.
================================================================
-->

- No top-level side effects in modules, so consumers can tree-shake.
- Keep the import graph shallow; avoid pulling a heavy dependency into
  the main entry.

## Documentation

<!--
================================================================
 SECTION: Documentation Conventions
 Scope/usage   : Docstring/comment expectations.
 Status        : Optional.
 Best practices: State the doc style and when comments are
                 required ("why", not "what"). Keep short.
 Model notes   : All tiers honor a named style.
================================================================
-->

- Comment the _why_, not the _what_. The TSDoc rules (every exported symbol,
  `@example` on primary entry points) live in the
  [Style Guide](docs/contributing/style-guide.md#tsdoc) and its
  `.claude/rules/library-src.md` extract, loaded when editing `src/**`.

## Agent Operating Model

<!--
================================================================
 SECTION: Agent Operating Model (hub-and-spoke)
 Scope/usage   : How Claude should organize work in this repo —
                 the main agent coordinates; isolated subagents
                 do the substantive work.
 Status        : Recommended.
 Best practices: Keep code-writing and code-review in different
                 agents; track build-vs-spec progress in the
                 living status file so isolated spokes stay in sync.
================================================================
-->

This repo runs a **hub-and-spoke** model: the main agent (hub) plans and
dispatches to isolated subagents ("spokes") but never writes `src/`/test code
or reviews it itself — that split is structural (every spoke carries
`disallowedTools: Agent`, enforced by `pnpm check:agents`). Model tiering per
spoke is in `docs/contributing/model-selection.md`. Full detail — the spoke
roster, TDD loop, live-status trackers, and submodule/script pipelines — lives
in `docs/contributing/agent-operating-model.md`.

**Claude Code hooks** (`.claude/settings.json`) add deterministic enforcement
on top of this advisory file — the full 20-hook inventory is
`docs/contributing/hooks-reference.md`; `check:hooks` validates the wiring.
Subagent mid-turn truncation — this repo's most-recurring build divergence —
is covered in `docs/contributing/agent-operating-model.md`'s "Lessons
learned" bullet, backed by the full playbook at
`docs/contributing/subagent-context-management.md`. Which skills are expected
to fire often versus rarely (and why a quiet skill isn't necessarily a broken
one) is tracked in `docs/contributing/skills-catalog.md`.

## Task Workflow

<!--
================================================================
 SECTION: Task Workflow (Explore -> Plan -> Implement -> Verify)
 Scope/usage   : The loop Claude should follow for non-trivial
                 work.
 Status        : Recommended.
 Best practices: Make verification explicit and tie "done" to the
                 Commands section. Encourage plan mode for risky
                 areas (anything touching the public API).
 Model notes   : Opus 4.8 and Fable 5 self-direct this loop with
                 light prompting and are the right choice for the
                 Plan step on ambiguous tasks. Sonnet 4.6 is the
                 day-to-day default for Implement. Haiku 4.5 suits
                 narrow, well-specified Implement/Verify subtasks
                 — give it a plan rather than asking for one.
================================================================
-->

1. **Explore** the public API and the `exports` map before editing. When the
   task hinges on external Anthropic guidance rather than repo state — agent
   design, model-config practices, SDK/API usage, engineering-blog
   recommendations — run `researching-anthropic-guidance` first and fold its
   briefing into the plan; it complements `auditing` (which reads the repo)
   with a read of official Anthropic sources.
2. **Plan** in plan mode for any change to an exported signature or
   the `exports` map (it has semver impact).
3. **Implement** the smallest change that satisfies the task.
4. **Verify**: type-check, lint, tests, and `pnpm build` before
   reporting done.

## Definition of Done

<!--
================================================================
 SECTION: Definition of Done
 Scope/usage   : The checklist that gates "complete".
 Status        : Optional (pairs well with a Stop hook).
 Best practices: Make every item machine-checkable. Enforce with
                 a Stop hook so the session can't end red.
 Model notes   : All tiers; the more concrete the checklist, the
                 higher the adherence — Haiku 4.5 especially.
================================================================
-->

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` all
  pass.
- Public API changes carry a Conventional Commit reflecting the
  correct semver impact.
- New or changed exports have TSDoc and tests.

## Forbidden Patterns

<!--
================================================================
 SECTION: Forbidden Patterns / Anti-patterns
 Scope/usage   : Explicit "never do this" list for recurring
                 mistakes.
 Status        : Optional but high-value.
 Best practices: Add an entry the SECOND time Claude makes the
                 same mistake. Phrase as absolutes. Move anything
                 that must be guaranteed into a hook.
 Model notes   : All tiers respond well to short, absolute
                 prohibitions. Long rationale dilutes them.
================================================================
-->

**Enforced at write time or in CI:** `any` in the public API, a missing `.js`
extension, CommonJS (`require`/`module.exports`/`__dirname`), hand-edits to
`dist/`, non-Conventional commits, committed secrets/tokens, an
unsigned/invalid-signature push, and adding a dependency without updating the
lockfile. The `.js`-extension and CommonJS bans are guarded twice (a
PreToolUse hook plus ESLint/CI) — don't remove either as "redundant."

**No automated guard — need conscious care:** never swallow errors silently;
no top-level side effects; keep the import graph shallow; never
`git push --force`; surface new Core/AWS exports through the namespace barrel
only, never a new `exports` subpath.

## Known Gotchas

<!--
================================================================
 SECTION: Known Issues / Gotchas
 Scope/usage   : Traps that waste time if undocumented.
 Status        : Niche.
 Best practices: Capture the trap + the workaround. Prune once
                 fixed.
 Model notes   : All tiers; prevents repeated debugging loops.
================================================================
-->

- A new public subpath needs BOTH `src/<path>/index.ts` and an `exports` entry,
  or consumers cannot import it — but per the layout above, new submodules go
  through the namespace barrel, not a new subpath.

<!--
================================================================
 EXTENSION POINTS — reference, don't inline
================================================================
 The sections below document Claude Code mechanisms that
 COMPLEMENT CLAUDE.md. Prefer them over growing this file. They
 are not pasted into context the way CLAUDE.md is.

 .claude/rules/*.md
   Path-scoped instructions via YAML `paths:` frontmatter. Load
   only when Claude touches matching files — ideal for "exported
   symbols need TSDoc" tied to src/**/index.ts. Rules WITHOUT
   `paths:` load every session at the same priority as
   .claude/CLAUDE.md.

 .claude/skills/<name>/
   SKILL.md + optional scripts/assets. Load ON DEMAND when
   relevant to the prompt. Put multi-step procedures here
   (codemod, adding a subpath export, syncing docs). Keep
   SKILL.md < ~500 lines; split long reference into siblings.

 .claude/agents/<name>.md
   Subagents with frontmatter: name, description, tools, model.
   Run in isolated context — use for review and deep research so
   they don't bloat the main session.
   MODEL ROUTING: set `model: opus` for API/architecture review,
   `model: sonnet` for general work, `model: haiku` for fast,
   bounded, well-specified tasks.

 .claude/settings.json
   Hooks (PreToolUse, PostToolUse, Stop, SubagentStop,
   SessionStart/End, UserPromptSubmit, PreCompact,
   InstructionsLoaded, ...). DETERMINISTIC enforcement — use for
   anything that must happen every time. The highest-value hook
   here is a PostToolUse running `pnpm typecheck` (or tests)
   after edits.

 Plugins
   Bundle skills + hooks + subagents + MCP servers into one
   installable unit. Browse with /plugin.

 MCP servers
   External tools/data. Configure per project; keep them off
   unless needed (always-on servers cost context).
================================================================
-->

<!--
================================================================
 IMPORTS — pull in shared/contextual files at launch
================================================================
 `@path` imports expand into context AT LAUNCH (they do NOT save
 context — the imported file is loaded in full). Relative paths
 resolve from THIS file. Max recursion depth: 4 hops. First use
 prompts a one-time approval dialog.

 Examples (uncomment and adapt):
   See @README.md for the project overview.
   Contributing guide: @docs/contributing/contributing.md
   Personal prefs across worktrees: @~/.claude/my-notes.md
================================================================
-->

<!--
================================================================
 AGENTS.md INTEROP (niche)
================================================================
 Claude Code reads CLAUDE.md, NOT AGENTS.md. If the repo already
 maintains an AGENTS.md for other agents, avoid duplication by
 importing it as the FIRST line of this file and adding
 Claude-specific notes below:

     @AGENTS.md

     ## Claude Code
     Use plan mode for changes to the package.json exports map.

 A symlink (ln -s AGENTS.md CLAUDE.md) also works when you need
 no Claude-specific additions. On Windows, prefer the @AGENTS.md
 import (symlinks need elevated privileges).
================================================================
-->
