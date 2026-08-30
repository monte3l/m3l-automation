# Project: m3l-automation

<!--
================================================================
 CLAUDE.md maintainer notes — stripped before injection, costs 0 runtime
 tokens. Design rationale: Anthropic's docs.claude.com/en/memory + best-practices.

 BUDGET: keep runtime content (everything outside HTML comments) under
 ~200 lines / ~3,000 tokens — longer files reduce Claude's instruction
 adherence ("Bloated CLAUDE.md files cause Claude to ignore your actual
 instructions," docs.claude.com/en/best-practices). Every custom subagent
 in this repo's spoke roster reloads this file at launch (only the built-in
 Explore/Plan agents skip it), so its size is paid per-dispatch, not once
 per session. `pnpm check:context-budget` (ADR-0078) enforces the
 line/token budget in CI, resolving any `@path` import before measuring —
 an import "expands in full at launch" (docs.claude.com/en/memory) and is
 injected as its OWN block, not spliced inline, so it must be measured, not
 assumed away. It also warns when a table row's Prettier alignment padding
 exceeds 200 chars — the recurring cause of this file's largest blocks
 historically.

 EVICTION RULES: a multi-step procedure -> a skill (.claude/skills/); a
 constraint scoped to one path -> a rule with `paths:` frontmatter
 (.claude/rules/*.md); a rule that must ALWAYS hold -> a
 .claude/settings.json hook, not prose (CLAUDE.md is advisory context, never
 enforced config). Keep here only facts every session needs. `@path`
 imports do NOT save context — they expand in full at launch; prefer a
 pointer sentence over an import when the target is large (this file no
 longer imports anything for exactly that reason — ADR-0078).

 WARNING — three scripts parse this file's exact prose; do not restructure
 the sections below without updating them:
   bin/check-cadence-doc.mjs     reads "## Commands" here — the stage cell
                                  + backticked check tokens per lefthook
                                  stage (the `ci.yml` row is skipped); a
                                  stage MAY span several rows, unioned.
   bin/check-context-budget.mjs  reads this whole file (comments stripped)
                                  plus any resolved `@path` import.
   bin/lib/count-sites.mjs       reads the literal "Core namespace barrel
                                  (N documented submodules)" / "AWS
                                  namespace barrel (N documented submodules)"
                                  phrases here.
 The CI/CD workflow table used to live here too; it moved to
 docs/contributing/ci-cd.md and bin/check-workflows-doc.mjs was repointed
 there — see that file's header for why.
================================================================
-->

A utilities library designed to support automation scripts with enterprise-grade abstractions for configuration management, logging, error handling, data import/export, asynchronous polling/retry mechanisms, and cross-cutting concerns. Package @m3l-automation/m3l-common, written in **TypeScript 6.x** (`strict: true`), compiled with `tsc` to **ESM-only** output, managed with `pnpm`, targeting **Node.js 24 LTS+**. Primary consumers: automation scripts. The non-negotiable constraint is: minimal runtime dependencies, no breaking changes outside a major release, strict semver, no `any` in the public API, Node 24+ only.

**Owner:** the repo maintainer (single-maintainer project). Review this file whenever a submodule/script pipeline ships, or every ~6 months, whichever comes first.

## Tech Stack

- TypeScript 6.x, `strict: true`, compiled with `tsc` (no bundler); ESM only
  (`"type": "module"`); Node.js 24 LTS floor (`.node-version`)
- `pnpm` (lockfile authoritative, pinned via `packageManager` + Corepack);
  `turbo` orchestrates/caches `build` + `typecheck`
- Test: `vitest`. Lint/format: `eslint` (flat config) + `prettier`. Git
  hooks: `lefthook` (replaces husky + lint-staged)
- Dep/exports hygiene: `knip`, `publint` + `@arethetypeswrong/cli`
- Versioning is manual (`version` hand-managed; internal, unpublished
  package, ADR-0020)

Run `pnpm commands` for the full script list; `package.json` has the
dependency set and the `exports` map.

## Repository Layout

This is a **pnpm monorepo** — `pnpm-workspace.yaml` also triggers
`M3LExecutionEnvironment`'s MONOREPO mode, anchoring `data/` at the workspace
root.

```text
packages/m3l-common/    # @m3l-automation/m3l-common — the library
packages/m3l-cli/       # @m3l-automation/m3l-cli
scripts/<name>/src/     # automations consuming the library via workspace:*
```

`exports` exposes `.`, `./core`, `./aws`, `./core/errors` — Core namespace barrel (25 documented submodules) and AWS namespace barrel (20 documented submodules) surface through the namespace entries; `./core/errors` is ADR-0004's gated exception. New submodules join the barrel, never a new subpath (semver event). `internal/` is NOT exported, may change freely. Full tree: `docs/contributing/contributing.md` § Repository Layout.

## Environment Setup

```bash
corepack enable     # activate the pnpm version pinned in packageManager
pnpm install        # install deps + lefthook git hooks (prepare script)
pnpm build          # turbo -> tsc -> dist/ (ESM .js + .d.ts)
pnpm test           # run the suite once
```

Node is pinned in `.node-version` (24). In CI, use
`pnpm install --frozen-lockfile`. A pure library needs no services to run
locally. Full setup detail: `docs/contributing/contributing.md`
§ Environment Setup.

## Commands

Run any task with `pnpm <script>` (`pnpm commands` lists every one with its
scope). The table is the pre-push cadence, machine-verified against
`lefthook.yml` by `pnpm check:cadence`; CI runs every pre-push check plus
every `check:*`, `knip`, `lint:md`, `audit`, and gitleaks secret scanning
(no local `pnpm` equivalent) — see `docs/contributing/ci-cd.md`. `pre-push`
takes minutes — background it rather than `--no-verify`, since CI re-runs
everything anyway.

| Stage                   | Checks                                                                       | Scope  |
| ----------------------- | ---------------------------------------------------------------------------- | ------ |
| `pre-commit` (lefthook) | `eslint`, `prettier`                                                         | staged |
| `commit-msg` (lefthook) | `lint-commit`                                                                | commit |
| `pre-push` (lefthook)   | `format:check`, `lint`, `typecheck`, `test:coverage`, `check:test-counts`    | repo   |
| `pre-push` (lefthook)   | `build`, `check:exports`, `verify-signed-range`, `check:control-chars`       | repo   |
| `pre-push` (lefthook)   | `check:file-budget`, `check:agents`, `check:script-docs`, `check:provenance` | repo   |
| `pre-push` (lefthook)   | `check:cli-docs`, `check:review-size`, `check:context-budget`, `check:index` | repo   |
| `pre-push` (lefthook)   | `check:harness-freshness`                                                    | repo   |

`pnpm verify` reproduces every CI check locally; `pnpm check:verify-parity`
keeps it in sync with `ci.yml`. The table splits across rows for width;
`check:cadence` unions rows per stage against `lefthook.yml`.

## Compact Instructions

When this session compacts, preserve: the current branch/worktree and any
open PR number; a failing `pnpm` gate and its exact error text; the ADR or
plan being implemented and which step is in progress; any `AskUserQuestion`
answer not yet acted on. Prefer dropping exploratory tool-call detail (file
reads, passing test output) over any of the above.

## CI/CD

Eight GitHub Actions workflows in `.github/workflows/` (plus Dependabot).
Full table — triggers, purpose, required status checks:
`docs/contributing/ci-cd.md`.

## Coding, errors & tests (path-scoped)

Canonical **Style Guide**: `docs/contributing/style-guide.md` (`[enforced]` vs `[advisory]` per rule). Its `.claude/rules/*.md` extracts load only on matching files (cost nothing otherwise):

- `packages/m3l-common/src/**` → `library-src.md` — ESM imports, no `any`, TSDoc, `M3LError`, `internal/` privacy
- `**/tests/**`, `**/*.test.ts` → `tests.md` — Vitest, coverage gate
- `packages/m3l-common/src/**`, `scripts/**`, `**/tests/**`, `**/*.test.ts` → `refactoring.md` — behavior-preserving changes
- `scripts/**` → `scripts.md` — `workspace:*` (ADR-0029), naming (ADR-0028)
- `packages/**/*.ts`, `scripts/**/*.ts`, `**/*.test.ts` → `domain-knowledge.md`
- `.claude/skills/**`, `.claude/agents/**` → `subagent-dispatch.md` — truncation recovery

## Interaction Style

- **Before planning or implementing:** ask 5–7 clarifying questions to surface constraints, preferences, and edge cases before committing to an approach.
- **When multiple valid approaches exist:** present 3–5 solutions with a brief rationale and tradeoff for each; do not pick one without user input.
- Input-collection prompts (e.g. "what is the script name?") are exempt.
- **Response style:** keep chat responses concise — a long deliverable (audit, plan, ADR, report) goes to a file with a short chat summary; split an oversized response across turns rather than one long reply.

## Git Workflow

- **Conventional Commits (required)**, with an AI co-authorship trailer when Claude authored/assisted. Enforced by the `commit-msg` hook. Trailer mechanics and canonical model names: `docs/contributing/contributing.md`.
- **Before change-work, run the `starting-work` skill** — the pre-work decision gate that settles location / branch / PR / push (ADR-0016). Branch from `main`: `feat/<slug>`, `fix/<slug>`; `guard-branch-isolation.mjs` blocks `packages/*/src/**`, `scripts/*/src/**`, `**/tests/**` writes while `HEAD` is `main`.
- Never `git push --force` to a shared branch. Commits should be small, incremental, and meaningful. **Prefer several small, independently reviewable PRs over a few large ones** (ADR-0072); run `pnpm check:review-size` before opening one.
- **Worktrees** (ADR-0013/0014): `pnpm worktree:new <slug>` / `pnpm worktree:remove <slug>` create/tear down an isolated sibling checkout. Full mechanics: the ADRs.

## Architecture & Decisions

The `exports` map is the public contract (semver-gated); `internal/` is private and may change freely. Full rationale: `docs/contributing/contributing.md` § The `exports` Map / § `internal/` Is Private.

Decisions live in `docs/adr/`; start at `docs/adr/README.md` for the index.

## Security

- The library does not log by default; never log secrets, tokens, or caller data.
- CI has no publish credentials; tokens of any kind (`NPM_TOKEN`, `GITHUB_TOKEN`, AWS keys, `CLAUDE_CODE_OAUTH_TOKEN`) must never land in source, tests, or fixtures.
- Validate all external input at the public API boundary before use.
- Commits pushed to the remote must be signed (valid `%G?`). Enforced in three layers — the `guard-git-push-signed` Bash hook, the `verify-signed-range` `pre-push` backstop, and branch-protection "Require signed commits" (the authoritative one). See ADR-0016 and `docs/contributing/branch-protection.md`.

## Performance

No top-level side effects (tree-shaking); keep the import graph shallow. Full rules: `docs/contributing/style-guide.md` § Imports & modules (ESM).

## Documentation

Comment the _why_, not the _what_. TSDoc rules (every exported symbol, `@example` on primary entry points): `docs/contributing/style-guide.md#tsdoc` and its `.claude/rules/library-src.md` extract.

## Agent Operating Model

This repo runs a **hub-and-spoke** model: the hub plans and dispatches to isolated spokes but never writes `src/`/test code or reviews it itself — enforced by `guard-hub-src-writes.mjs` (blocks the hub, any branch) and `disallowedTools: Agent` on every spoke (`pnpm check:agents`). Model tiering: `docs/contributing/model-selection.md`. Full spoke roster, TDD loop, and recurring-failure lessons: `docs/contributing/agent-operating-model.md`.

**Hooks** (`.claude/settings.json`) add deterministic enforcement on top of this advisory file — full inventory: `docs/contributing/hooks-reference.md` (`check:hooks` validates wiring). Subagent mid-turn truncation, this repo's other recurring failure mode: `docs/contributing/subagent-context-management.md`.

## Task Workflow

1. **Explore** the public API and `exports` map before editing; run `researching-anthropic-guidance` first when the task hinges on external Anthropic guidance rather than repo state. **Re-derive any authored claim** you're about to act on (an ADR's census, a tracker's scope) — these rot between authoring and use (`docs/logs/2026-08-19-hub-sync-key-namespace.md`).
2. **Plan** in plan mode for any change to an exported signature or the `exports` map (it has semver impact).
3. **Implement** the smallest change that satisfies the task.
4. **Verify**: type-check, lint, tests, and `pnpm build` before reporting done.

## Definition of Done

`pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` all pass; a public API change carries a Conventional Commit with the correct semver impact; new/changed exports have TSDoc and tests. Full checklist: `docs/contributing/contributing.md` § Definition of Done.

## Forbidden Patterns

**Enforced at write time or in CI:** `any` in the public API, a missing `.js` extension, CommonJS (`require`/`module.exports`/`__dirname`), hand-edits to `dist/`, non-Conventional commits, committed secrets/tokens, an unsigned/invalid-signature push, and adding a dependency without updating the lockfile. The `.js`-extension and CommonJS bans are guarded twice (a PreToolUse hook plus ESLint/CI) — don't remove either as "redundant."

**No automated guard — need conscious care:** never swallow errors silently; no top-level side effects; keep the import graph shallow; never `git push --force`; surface new Core/AWS exports through the namespace barrel only, never a new `exports` subpath.

## Known Gotchas

- A new public subpath needs BOTH `src/<path>/index.ts` and an `exports` entry, or consumers cannot import it — but per the layout above, new submodules go through the namespace barrel, not a new subpath.
- A fresh dependency bump can trip pnpm's `minimumReleaseAge` and block every command. Add the exact `name@version` to `minimumReleaseAgeExclude` (own `build:` commit); never weaken the policy.
- What a `check:*` gate enforces is defined by its `bin/*.mjs` source, not nearby prose (e.g. `check:api` moves only on an `exports`-map subpath change, never a barrel-surfaced symbol). Read the script before designing a plan around a gate.
- 2+ concurrent Claude Code sessions can livelock a memory-constrained host (uncapped `pre-push` fan-out). Run `pnpm check:host-resources` first — see ADR-0080.
