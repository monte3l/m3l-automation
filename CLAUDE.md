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
   Published npm library · TypeScript (strict) · ESM only ·
   built with tsc (no bundler) · pnpm · Node.js 24 LTS floor ·
   Vitest · ESLint + Prettier · semantic-release · public API
   exposed via package.json subpath exports.

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
- Dep/publish hygiene: `knip` (unused files/exports/deps),
  `publint` + `@arethetypeswrong/cli` (exports-map / ESM / types resolution)
- Release: `semantic-release` (Conventional Commits drive the version)

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
      aws/index.ts      # AWS namespace barrel (3 submodules surfaced here)
      internal/         # NOT exported; no "exports" entry; may change freely
    dist/               # tsc output (ESM .js + .d.ts) — generated, never edit
    tests/              # *.test.ts (Vitest)
scripts/                # automations consuming the library via workspace:*
  <name>/src/main.ts    # built on Core.M3LScript
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
services. The only secrets are CI-only release tokens (`NPM_TOKEN`,
`GITHUB_TOKEN`); never commit them — they load from the CI vault.

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

| Task          | Command                           | When        |
| ------------- | --------------------------------- | ----------- |
| Tests         | `pnpm test`                       | pre-commit  |
| Watch tests   | `pnpm test:watch`                 | iterating   |
| Single test   | `pnpm vitest run tests/x.test.ts` | iterating   |
| Lint          | `pnpm lint`                       | pre-commit  |
| Markdown lint | `pnpm lint:md`                    | CI          |
| Format        | `pnpm format`                     | pre-commit  |
| Type check    | `pnpm typecheck`                  | pre-commit  |
| Build         | `pnpm build` (turbo + tsc)        | pre-publish |
| Unused code   | `pnpm knip`                       | pre-publish |
| Export check  | `pnpm check:exports`              | pre-publish |
| Format check  | `pnpm format:check`               | CI          |
| API snapshot  | `pnpm check:api`                  | pre-commit  |
| Test coverage | `pnpm test:coverage`              | pre-push    |
| Barrel sync   | `pnpm check:scaffold`             | pre-publish |
| Dep hygiene   | `pnpm check:deps`                 | CI          |

These map to package.json scripts (`test` -> `vitest run`, `typecheck`
-> `turbo run typecheck`, `build` -> `turbo run build`, etc.). Turbo
fans tasks out per workspace package and caches them. Keep the scripts
and this table in sync.

## CI/CD

Six GitHub Actions workflows in `.github/workflows/`:

| Workflow                | Trigger                     | Purpose                                                                                                                                                               |
| ----------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                | push / PR → main            | 13-step pipeline: secrets → audit → lint → format:check → lint:md → typecheck → check:api → test:coverage (80 % gate) → build → check:exports → check:scaffold → knip |
| `release.yml`           | `ci.yml` success on main    | semantic-release: npm publish + GitHub release                                                                                                                        |
| `claude-pr-review.yml`  | PR opened / sync / reopened | **Mandatory blocking gate** — produces PASS/FAIL verdict; merge requires PASS                                                                                         |
| `claude-assistant.yml`  | @claude in issues / PRs     | On-demand Claude Code assistant                                                                                                                                       |
| `dependabot.yml`        | Weekly (Mondays)            | Grouped dependency updates (toolchain + release-tooling groups)                                                                                                       |
| `dependency-review.yml` | PR → main                   | Blocks HIGH/CRITICAL vulnerability advisories                                                                                                                         |

## Code Style

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

- Formatting/import order: enforced by Prettier + ESLint — don't
  hand-format.
- `strict: true`; no `any` (use `unknown` and narrow); avoid non-null
  `!` assertions in `src/`.
- **ESM:** relative imports MUST carry the `.js` extension
  (`./util.js`); `tsc` does not add it and Node will not resolve
  without it.
- Public API fully typed; export types next to the values they
  describe.

```typescript
export type UserId = string & { readonly __brand: unique symbol };
export type Page<T> = { items: readonly T[]; total: number };

export function paginate<T>(items: readonly T[], limit: number): Page<T> {
  return { items: items.slice(0, limit), total: items.length };
}
```

## Error Handling

<!--
================================================================
 SECTION: Error Handling
 Scope/usage   : How errors are raised, wrapped, and surfaced in
                 this codebase.
 Status        : Recommended.
 Best practices: State the project's error hierarchy and where
                 errors cross the public boundary. Specify when to
                 chain with `cause`.
 Model notes   : All tiers. Sonnet 4.6 / Opus 4.8 / Fable 5 apply
                 patterns broadly from one example; Haiku 4.5
                 should be given the exact base class to subclass.
================================================================
-->

- The library throws typed errors from one hierarchy (`M3LError`
  base); subclass per failure mode.
- Never throw bare strings; never swallow errors silently.
- Chain underlying failures with the `cause` option.

```typescript
export class M3LError extends Error {}
export class NotFoundError extends M3LError {}

export function load(id: UserId): User {
  const user = repo.get(id);
  if (user === undefined) throw new NotFoundError(`user ${String(id)}`);
  return user;
}
```

## Testing Strategy

<!--
================================================================
 SECTION: Testing Strategy
 Scope/usage   : What "tested" means here, so Claude writes the
                 right tests.
 Status        : Recommended.
 Best practices: State the framework, the unit boundary, the
                 coverage bar, and what to mock vs hit for real.
                 Detailed how-to belongs in a skill.
 Model notes   : Opus 4.8 and Fable 5 design test suites from a
                 one-line policy. Haiku 4.5 needs the naming
                 convention and an example spelled out.
================================================================
-->

- Vitest; test files are `*.test.ts`, importing from `src/` (with the
  `.js` extension).
- Unit tests are pure: no network, no filesystem; mock collaborators.
- Every exported function needs a happy-path test plus one failure
  path.
- Where the type IS the contract, add a type-level test with
  `expectTypeOf`.
- Coverage is enforced by V8: `pnpm test:coverage` requires 80 % across
  lines, functions, branches, and statements.

```typescript
import { expect, test } from "vitest";
import { paginate } from "../src/index.js";

test("paginate respects the limit", () => {
  expect(paginate([1, 2, 3, 4, 5], 2).items).toHaveLength(2);
});
```

## Git Workflow

<!--
================================================================
 SECTION: Git Workflow & Commit Conventions
 Scope/usage   : Branching, commit message format, PR
                 expectations.
 Status        : Mandatory here — semantic-release PARSES commit
                 messages to compute the next version.
 Best practices: State the commit convention and the hard rules.
                 Enforce with a commit-msg hook (bin/lint-commit.mjs) or
                 branch protection, not prose alone.
 Model notes   : All tiers follow a named convention reliably;
                 ambiguous phrasing ("write good commits") is
                 ignored across tiers.
================================================================
-->

- **Conventional Commits (required):** `feat:` -> minor, `fix:` ->
  patch, `feat!:` or a `BREAKING CHANGE:` footer -> major. Other
  types (`docs:`, `refactor:`, `test:`, `chore:`) do not release.
  Enforced by `lefthook` `commit-msg` -> `bin/lint-commit.mjs` (`@commitlint/lint` core, no CLI).
- Git hooks run via **lefthook** (`lefthook.yml`): `pre-commit` runs
  eslint + prettier on staged files; `pre-push` runs typecheck + tests.
- Branch from `main`: `feat/<slug>`, `fix/<slug>`.
- Releases are automated from `main`; **never** bump `version` in
  package.json by hand — semantic-release owns it.
- Never `git push --force` to a shared branch.
- Commits should always be small, incremental and, above all, meaningful.

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
- `NPM_TOKEN` / `GITHUB_TOKEN` exist only in CI env — never in source,
  tests, or fixtures.
- Validate all external input at the public API boundary before use.

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

- TSDoc on every exported symbol; include an `@example` on primary
  entry points. Comment the _why_, not the _what_.

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

This repo runs a **hub-and-spoke** model. The main agent is the **hub**: it
plans, dispatches work to isolated subagents ("spokes"), reads their results,
updates the status file, and decides the next step. The hub **does not write
`src/`/test code and does not review code itself** — those run in spokes with
the right tool grants. This makes "the agent that writes code is never the one
that reviews it" structural, and keeps the hub's context lean.

- **Spokes**: `Explore` (research), `spec-conformance-reviewer` (contract +
  doc-vs-code), `test-author` (tests-first / RED), `submodule-implementer`
  (implementation / GREEN), `code-reviewer`, `security-reviewer`,
  `type-design-analyzer`, and `silent-failure-hunter` (review).
- **TDD**: tests are written from the documented contract and fail first, then
  the implementer makes them pass; review follows.
- **Live status**: `docs/implementation-status.md` is the source of truth for
  what is built vs. documented. The hub updates it after each phase — it is the
  durable memory the isolated spokes do not share.
- The `implement-submodule` skill encodes this loop end-to-end; `new-subpath`
  scaffolds a greenfield module and hands off to it.
- **Current state**: 2 of 22 submodules are implemented (`errors`, `events`). See `docs/implementation-status.md` for the authoritative tracker and suggested build order.
- **Lessons learned**: `docs/logs/` holds per-submodule work logs. The
  `core/errors` log (`docs/logs/2026-06-29-core-errors.md`) is the durable
  source for the process lessons baked into the spoke prompts — front-load exact
  contract nuances, lint in-loop, justify error-channel `eslint-disable`, read
  coverage from `coverage-final.json` (the v8 text table hides 100% files), and
  trust the CLI over the IDE/LSP.

**Claude Code hooks** (`.claude/settings.json`) provide runtime enforcement on
top of the advisory text in this file:

- **PreToolUse (Write/Edit):** `guard-js-extension.mjs` blocks relative imports
  missing `.js`; `guard-no-commonjs.mjs` blocks `require` / `__dirname` /
  `module.exports`; `guard-protected-paths.mjs` guards `dist/`, version fields,
  and `node_modules/`.
- **PostToolUse (Write/Edit):** `guard-exports-semver.mjs` warns when the exports
  map changes without a matching semver commit; `post-edit-verify.mjs`
  auto-formats, **lints (eslint)**, type-checks, and runs the related tests on
  the edited package — so eslint-only failures surface in the spoke loop, not a
  round later at the hub's `pnpm lint` gate; `guard-eslint-disable-red.mjs`
  warns when a test file written during the RED phase contains `eslint-disable`
  directives for import-resolution or type-inference rules that self-resolve once
  the implementation exists.

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

1. **Explore** the public API and the `exports` map before editing.
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

- Never use `any`; use `unknown` and narrow.
- Never omit the `.js` extension on a relative ESM import.
- Never use a CommonJS construct (`require`, `module.exports`,
  `__dirname`) — this package is ESM only.
- Never hand-edit `version` in package.json or anything in `dist/`
  (both are tool-owned).
- Never add a dependency without updating the pnpm lockfile.

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

- ESM + tsc: a relative import without the `.js` extension type-checks
  but fails to resolve at runtime in Node.
- A new public subpath needs BOTH `src/<path>/index.ts` and an
  `exports` entry, or consumers cannot import it.

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
   (release dry-run, codemod, adding a subpath export). Keep
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
   Release process: @docs/releasing.md
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

<!--
================================================================
 MODEL RECOMMENDATION MATRIX (routing guidance, as of 2026-06)
================================================================
 Capability tiers, strongest to fastest:
   Fable 5 > Opus 4.8 > Sonnet 4.6 > Haiku 4.5

 Fable 5
   Highest-capability tier. Hardest multi-step agentic work,
   deep architecture, gnarly cross-cutting refactors, ambiguous
   specs needing strong synthesis. Infers intent from terse
   framing. Highest cost/latency — reserve for genuinely hard
   work.

 Opus 4.8
   Top day-to-day reasoning model. Planning, public-API and
   architecture review, multi-file refactors. Works from
   high-level guidance; literal, so state scope explicitly.

 Sonnet 4.6
   Balanced default driver for implementation, reviews, and most
   coding. Reliable with moderate detail.

 Haiku 4.5
   Fastest / cheapest. Narrow, well-specified tasks, hook
   scripts, bounded subagents. Needs explicit, concrete,
   enumerated rules plus an example. THIS is the weakest model
   routed to.

 Sections that matter most, by tier:
   Fable 5 / Opus 4.8 -> Architecture, Task Workflow, Decisions
   Sonnet 4.6         -> Commands, Code Style, Testing
   Haiku 4.5          -> Commands, Layout, Forbidden, Glossary

 RULE OF THUMB: write CLAUDE.md for the WEAKEST model you route
 to — Haiku 4.5. Concrete, verifiable instructions that satisfy
 Haiku 4.5 never hurt Sonnet 4.6, Opus 4.8, or Fable 5; vague
 instructions the stronger models tolerate will fail on
 Haiku 4.5.
================================================================
-->
