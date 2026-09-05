// Hand-authored catalog of every `package.json` `scripts` entry — the single
// source of truth `bin/list-commands.mjs` (the `pnpm commands` lister) and
// `bin/check-command-catalog.mjs` (the `pnpm check:command-catalog` gate)
// both read. Pure data + pure derivation only: no fs/process here, so both
// consumers can be exercised in tests without spawning anything (mirrors
// `bin/lib/count-sites.mjs`'s gen/check-shared-derivation shape).
//
// Each description is one sentence covering both scope (what the command
// does) and intended usage (when a human reaches for it), sourced from the
// script's own header comment or its `.github/workflows/ci.yml` step comment
// — both already carry exactly this information, written by the maintainer.
// This module does not re-derive those sentences from the source files at
// runtime (there is no reliable machine-checkable "this prose is accurate"
// signal), so `deriveCommandCatalogDiff` only guards the STRUCTURAL
// invariant: every `package.json` script has exactly one row here, and vice
// versa. A stale or misleading sentence is a review-time concern, not a
// machine-checkable one.

/**
 * One entry per `package.json` `scripts` key, in the exact order they appear
 * there. `name` must match the `package.json` key verbatim — `check:command-catalog`
 * (via {@link deriveCommandCatalogDiff}) fails loudly on any mismatch in either
 * direction.
 *
 * @type {{ name: string, description: string }[]}
 */
export const COMMAND_CATALOG = [
  {
    name: "build",
    description:
      "Compiles every workspace package (m3l-common + all consumer scripts) via turbo, emitting dist/ ESM .js + .d.ts. Run before publint/attw or a manual smoke test.",
  },
  {
    name: "typecheck",
    description:
      "Runs tsc across every workspace package via turbo with no emit. The fastest full-repo type-error signal; run after any source or test edit.",
  },
  {
    name: "lint",
    description:
      "Runs lint:library then lint:workspace (the flat ESLint config — strict TS, no any, ESM-only, dependency-direction zones — split across two sequential single-threaded passes to keep peak memory bounded). Pre-push gate; pre-commit only lints staged files.",
  },
  {
    name: "lint:library",
    description:
      "Lints packages/m3l-common alone at --concurrency=1. Split out from `lint` (2026-08-29) because two concurrent ESLint workers can each build their own full copy of this package's TypeScript program, roughly doubling peak memory on a large project.",
  },
  {
    name: "lint:workspace",
    description:
      "Lints everything except packages/m3l-common (its own pass keeps that package's large TypeScript program from being loaded twice under --concurrency>1) at --concurrency=1.",
  },
  {
    name: "lint:commit",
    description:
      "Lints a commit message: `-- --edit <file>` (the commit-msg hook's mode) or `-- --from <sha> --to <sha>` to lint every subject in a range — e.g. `pnpm lint:commit -- --from origin/main --to HEAD` before opening a PR.",
  },
  {
    name: "format",
    description:
      "Applies Prettier's `--write` across the repo. Use to fix formatting drift; pre-commit already auto-formats staged files.",
  },
  {
    name: "format:check",
    description:
      "Verifies Prettier formatting with no writes. Catches drift from any commit that bypassed the pre-commit hook; CI and pre-push both run this, not `format`.",
  },
  {
    name: "lint:md",
    description:
      "Lints every Markdown file (rumdl) excluding generated/vendored/archived paths. Run after any docs edit; wired into `/syncing-docs` and CI.",
  },
  {
    name: "test",
    description:
      "Runs the full Vitest suite once, no coverage. Fastest local test signal during iteration.",
  },
  {
    name: "test:coverage",
    description:
      "Runs the full suite with the v8 coverage gate evaluated: vitest.config.ts (packages/*/src, 80% perFile) then vitest.bin.config.ts (bin/**/*.mjs, aggregate). `test` alone never evaluates the thresholds — CI and pre-push both use this one.",
  },
  {
    name: "test:watch",
    description:
      "Runs Vitest in watch mode for interactive TDD (RED → GREEN → refactor) against the files you're actively editing.",
  },
  {
    name: "test:e2e",
    description:
      "Runs the m3l-console-web Playwright suite (packages/m3l-console-web/tests/e2e, ADR-0067): builds the production bundle, serves it via `vite preview`, and drives it with Chromium. CI runs this job only when packages/m3l-console-web{,-server}/** changed, on a PR carrying the `e2e` label, or on push to main — not on every PR by default.",
  },
  {
    name: "knip",
    description:
      "Detects unused files, exports, and dependencies across the workspace. CI-only dead-code gate; run locally after removing a symbol or dependency.",
  },
  {
    name: "verify",
    description:
      "Runs every ci.yml lane job's project-check steps locally in one command (bin/lib/verify-steps.mjs), fail-fast by default. `-- --continue` runs every step and summarises; `-- --full` also runs steps with no local equivalent by default (e.g. `pnpm check:hub-drift`, which needs a `gh`-authenticated session). Use before opening a PR to reproduce the CI gate ahead of time.",
  },
  {
    name: "commands",
    description:
      "Lists every pnpm command in this file, grouped by family, with its description — this catalog, rendered. Add `-- --json` for a structured payload.",
  },
  {
    name: "check:command-catalog",
    description:
      "Verifies every `package.json` script has exactly one row in bin/lib/command-catalog.mjs and vice versa — the non-drift gate for `pnpm commands`'s data. Run after adding/removing/renaming a script.",
  },
  {
    name: "check:verify-parity",
    description:
      "Verifies bin/lib/verify-steps.mjs (the `pnpm verify` aggregate gate's step list) matches the union of project-check steps across every lane job in .github/workflows/ci.yml exactly, in both directions, and that no `needsLiveState: true` step is wired into a job feeding the required `verify` aggregate (ADR-0079). Run after adding/removing/renaming a step in any ci.yml lane job.",
  },
  {
    name: "check:workflow-build-order",
    description:
      "Derives which bin/**/*.mjs scripts transitively require packages/m3l-cli/dist to be built, then verifies every GitHub Actions workflow step invoking one is preceded, in the same job, by a step that builds @m3l-automation/m3l-cli. Run after adding a bin/ script that imports from packages/m3l-cli or wiring a new workflow step.",
  },
  {
    name: "check:api",
    description:
      "Diffs the live `exports` map against a committed snapshot so any change to the public API contract (`.`, `./core`, `./aws`) shows up as a deliberate, reviewed diff. Run after touching a namespace barrel.",
  },
  {
    name: "check:browser-safe-subpath",
    description:
      "Walks each ADR-0004-exception exports subpath's (currently `./core/errors`) transitive TS-source import graph and fails if it reaches a `node:` builtin or a bare third-party specifier. Run after editing a file reachable from a browser-safe subpath's entry point.",
  },
  {
    name: "check:provenance",
    description:
      "Verifies every docs/reference/**.provenance.json sidecar's heading/source/symbol still resolves and warns on staleness. Run after editing a submodule's source or its reference page.",
  },
  {
    name: "check:doc-counts",
    description:
      "Verifies the submodule-count denominator ('N of M') matches the files on disk under docs/reference/{core,aws}/ across every badge/prose site. Run after adding/removing a reference page.",
  },
  {
    name: "check:impl-counts",
    description:
      "Verifies the implemented-count numerator ('N of M') matches the ✅ rows in docs/implementation-status.md across every badge/prose/HTML site, plus the generated implemented-list sentence. Run after flipping a submodule's status.",
  },
  {
    name: "gen:counts",
    description:
      "Regenerates every 'N of M' count site (both counts) and the implemented-list block in docs/implementation-status.md from the filesystem-derived truth. Run before check:doc-counts/check:impl-counts after a status change.",
  },
  {
    name: "sync:docs",
    description:
      "Runs the full /syncing-docs reconciliation sequence (provenance restamp, counts, doc-exports, reference index, script-scaffold, markdown lint) as one deterministic entry point. Run after any submodule or script ships.",
  },
  {
    name: "sync:hub-issues",
    description:
      "Maintainer-run, local-only: syncs docs/ROADMAP.md + IMPLEMENTATION.md into GitHub Issues/Milestones (title, body, labels, milestone, and GitHub Issue Type). Dry-run by default; pass `-- --apply` to execute, or `-- --check` for the CI drift-gate mode (fails on a non-empty plan). Three one-shots, each mutually exclusive with the others: `-- --backfill` (composes with `--apply`) for the historical backfill of Done/Rejected rows that predate sync:hub — creates each backfilled issue already closed, with a fuzzy-match collision guard against every existing issue title; `-- --init-issue-types` to provision the org's Issue Types from ISSUE_TYPE_DEFS and retire the ones no longer declared (needs org admin); and `-- --retype-closed` to backfill the type on closed marker-bearing issues, a type-only edit that never rewrites their title, body, labels or milestone.",
  },
  {
    name: "sync:hub-projects",
    description:
      "Maintainer-run, local-only: syncs hub-sync-tracked issues onto the GitHub Projects (v2) board. Dry-run by default; pass `-- --apply`, and `-- --init` once to create/reuse the board and reconcile its fields and saved views. `-- --prune-views` additionally deletes any view VIEW_DEFS does not declare — opt-in and never a side effect of `--init`, because deleting a view is irreversible through the API.",
  },
  {
    name: "sync:hub",
    description:
      "Runs sync:hub-issues then sync:hub-projects as one umbrella pass (issues before projects, so the board sees already-closed issues). Same `-- --apply`/`-- --init` flags forward to both phases.",
  },
  {
    name: "check:doc-exports",
    description:
      "Verifies every public export surfaced through a namespace barrel is documented (present in its reference page heading or provenance sidecar). Run after adding an export.",
  },
  {
    name: "check:exports",
    description:
      "Runs publint + are-the-types-wrong against the built package to validate the exports map's shape (ESM-only, types resolution). Run after `pnpm build`, before publishing/reviewing an API change.",
  },
  {
    name: "check:dts-deps",
    description:
      "Verifies every module specifier surviving into packages/m3l-common/dist/**/*.d.ts is declared in `dependencies`/`peerDependencies` with types reachable — a `@types/*` counterpart left in `devDependencies` breaks every consumer's typecheck. Run after `pnpm build`, whenever a public type aliases a third-party type.",
  },
  {
    name: "check:scaffold",
    description:
      "Verifies every src/{core,aws}/<module>/index.ts is re-exported from its namespace barrel (and that no barrel line points to a deleted directory), plus that every packages/* workspace has a root tsconfig.json project reference. Run after scaffolding or removing a submodule, or adding a new packages/* workspace.",
  },
  {
    name: "check:scaffold-seam",
    description:
      "Verifies every scaffolded submodule carries both its TDD test file and its docs/implementation-status.md row — the backstop for the scaffolding-submodules skill. Run after scaffolding a new submodule.",
  },
  {
    name: "check:script-scaffold",
    description:
      "Verifies every scripts/<name>/ package matches the ADR-0022 shape (modular src/, contract page, README, package.json script values, tsconfig extends/references shape, root tsconfig ref, smoke test). Run after scaffolding or editing a consumer script's structure.",
  },
  {
    name: "check:script-docs",
    description:
      "Verifies every script README and reference page follows the canonical structure spec (docs/contributing/script-docs-structure.md): required sections present, contract blockquotes, ≥3 runnable examples, Validation config-table column, Operation column in Operations-at-a-glance. Run after editing a script README or docs/reference/scripts/ page.",
  },
  {
    name: "check:script-deps",
    description:
      "Verifies every scripts/*/package.json declares exactly the ADR-0029 dependency boundary (@m3l-automation/m3l-common via workspace:*, no devDependencies). Run after editing a consumer script's package.json.",
  },
  {
    name: "check:cli-scaffold",
    description:
      "Verifies packages/m3l-cli matches the CLI package shape (docs/contributing/cli-structure.md): required files, the src/ layer allowlist, the single bin/ process entry, the bin-first manifest contract (one bin entry, no scripts.start, no exports map, no third-party dependency), and both tsconfig shapes. Run after editing the CLI package's structure or manifest.",
  },
  {
    name: "check:cli-docs",
    description:
      "Verifies docs/reference/cli.md follows the canonical structure spec (docs/contributing/cli-structure.md): title and preamble, required sections in canonical order, conditional sections validated when present, an `## Exit codes` table, and a `## Commands` cross-check against main.ts's STATIC_COMMAND_NAMES. Run after editing the CLI contract page or adding a CLI command.",
  },
  {
    name: "check:template-format",
    description:
      "Verifies every templates/script/*.tmpl file stays prettier-conformant after plain __TOKEN__ substitution, across several token sets (short/typical/edge-case names and purposes) — the invariant packages/m3l-cli/src/scaffold/generate.ts depends on, since it emits scaffolded files with no reformatting pass (the CLI carries a zero-third-party-runtime-dependency contract that forbids importing prettier). Run after editing any templates/script/*.tmpl file.",
  },
  {
    name: "scaffold:script",
    description:
      "Deterministic generator for a brand-new scripts/<name>/ consumer-script package from templates/script/ (ADR-0022). The greenfield entry point when scripts/<name>/ doesn't exist yet.",
  },
  {
    name: "m3l",
    description:
      "The script-facing m3l CLI (packages/m3l-cli, ADR-0042): `pnpm m3l list` enumerates the scripts/* packages, `pnpm m3l inspect <script>` shows a script's declared configParameters. Contract: docs/reference/cli.md.",
  },
  {
    name: "console:server",
    description:
      "Runs the m3l operations-console backend (packages/m3l-console-server, ADR-0064/0065) in the foreground: binds a loopback-only listener, serves /health and /ready, and drains gracefully on SIGINT/SIGTERM/SIGQUIT. Requires M3L_CONSOLE_OPERATOR_NAME (ADR-0071). Settings: the package README's Configuration table.",
  },
  {
    name: "console:web",
    description:
      "Runs the m3l operations-console frontend's Vite dev server (packages/m3l-console-web, ADR-0064/0067). Proxies /health and /ready to console:server's default loopback bind so the shell's health check works against the real backend.",
  },
  {
    name: "console:up",
    description:
      "Builds both console container images and plays console-pod.yaml under rootless Podman (bin/console-up.mjs, ADR-0091): validates M3L_CONSOLE_OPERATOR_NAME/HOME, resolves the manifest's host-specific hostPath tokens, generates a ConfigMap carrying the operator env vars, and runs `podman kube play --network pasta --userns keep-id`. Requires Podman.",
  },
  {
    name: "console:down",
    description:
      "Tears down the pod started by console:up via `podman kube down console-pod.yaml` (bin/console-down.mjs, ADR-0091).",
  },
  {
    name: "check:agents",
    description:
      "Verifies every skill/CLAUDE.md agent reference resolves to a real subagent or built-in, and that no spoke is granted the Agent tool (the no-nesting invariant). Run after editing .claude/agents/** or a skill's dispatch prompt.",
  },
  {
    name: "check:skill-frontmatter",
    description:
      "Verifies every .claude/skills/*/SKILL.md has a non-empty description, its name: matches the directory, and every skill has a row in docs/contributing/skills-catalog.md; warns (never fails) on description-vocabulary overlap between skill pairs. Run after adding or editing a skill.",
  },
  {
    name: "check:hooks",
    description:
      "Verifies every .claude/settings.json hook command resolves to a real .claude/hooks/*.mjs file, every event name is a real Claude Code lifecycle event, and no hook file is left unwired. Run after editing hooks or settings.json.",
  },
  {
    name: "statusline:preview",
    description:
      "Renders .claude/hooks/statusline-context-pressure.mjs's five-row output against fixture payloads (early-session, mid-session, ≥90% context, no rate limits, derived/literal/all-landed/absent slice progress, no git) at COLUMNS 60/80/120/160, plus live malformed-JSON and corrupt-tmp-state probes of the real script. Dev-only display tool, not a gate — run it after changing the statusLine renderer or the layout module.",
  },
  {
    name: "slice:set",
    description:
      "Writes tmp/slice-progress.json, the state the statusline's slice-progress segment reads: --page <reference-page> derives N/M from that page's ## Landing plan table (ADR-0072), or --wave <ID> --current <N> --total <M> [--label ...] records a literal count for a non-submodule multi-PR wave. Stamps the current branch itself. Run from starting-work/finishing-work when advancing through a slice sequence.",
  },
  {
    name: "slice:clear",
    description:
      "Removes tmp/slice-progress.json, blanking the statusline's slice-progress segment. Run from finishing-work once a slice sequence's last row lands.",
  },
  {
    name: "usage:refresh",
    description:
      "Fetches Anthropic's undocumented /api/oauth/usage endpoint (credential from CLAUDE_CODE_OAUTH_TOKEN or ~/.claude/.credentials.json) and writes tmp/usage-weekly.json, the state the statusline's per-model weekly-usage segments read (ADR-0092). Fail-soft: no credential, a non-200 response, or an unparseable body all leave any existing cache untouched. Normally run out-of-band by the refresh-usage-cache.mjs Stop hook, not by hand.",
  },
  {
    name: "check:integration-stance",
    description:
      "Verifies every GitHub-talking .claude/skills/*/SKILL.md carries an ADR-0030 stance reference, contains no retired policy claim, and names the mechanism (gh CLI vs GitHub MCP) it actually uses. Run after editing a GitHub-facing skill.",
  },
  {
    name: "check:github-features",
    description:
      "Verifies the live repository's GitHub platform-feature flags (wiki/discussions/issues/projects) and metadata (description/homepage/topics) match ADR-0050's declared stance, and that .github/ISSUE_TEMPLATE/config.yml still links to the Discussions Ideas/Q&A categories. Also warns (non-blocking) when delete_branch_on_merge is disabled — the precondition bin/worktree-prune.mjs's [gone]-upstream heuristic depends on. Needs gh auth; run push-only in CI (ci.yml), same as check:hub-drift.",
  },
  {
    name: "check:label-drift",
    description:
      "Verifies every hub-managed GitHub label (bin/lib/label-defs.mjs) exists on the live repository with the exact name/description/color bin/sync-hub-issues.mjs would bootstrap it with (ADR-0051's semantic priority vocabulary). Needs gh auth; run push-only in CI (ci.yml), same as check:hub-drift.",
  },
  {
    name: "check:zones",
    description:
      "Verifies the ADR-0009 dependency-direction zones (import-x/no-restricted-paths) and the ADR-0035 repo-wide import-x/no-cycle rule are still present and correctly shaped in eslint.config.js — a deleted zone or rule would otherwise pass `pnpm lint` silently. Run after editing eslint.config.js.",
  },
  {
    name: "check:deps",
    description:
      "Dependency hygiene gate covering what `pnpm audit` misses: outdated majors, deprecated packages, and peer mismatches. Run periodically or after a dependency bump.",
  },
  {
    name: "check:licenses",
    description:
      "Dependency license-policy gate (ADR-0036): fails on a non-allow-listed license among packages/m3l-common's runtime dependencies or optional peerDependencies, warns for dev-only tooling. Run after a dependency bump.",
  },
  {
    name: "check:test-counts",
    description:
      "Verifies the per-submodule test counts recorded in docs/implementation-status.md's Notes column match the live Vitest suite. CI and pre-push both run this. Run after adding/removing tests for an implemented submodule.",
  },
  {
    name: "check:review-size",
    description:
      "Reproduces claude-pr-review.yml's reviewable-size measurement locally against origin/main...HEAD (ADR-0072): warns above the 75,000-char soft target, fails above the workflow's MAX_REVIEWABLE_BYTES ceiling. Run before opening a PR.",
  },
  {
    name: "check:file-budget",
    description:
      "Per-file size ratchet (ADR-0072) over each package's src/tests trees: a file not in bin/file-budget-baseline.json must stay under 25,000 (src) / 60,000 (tests) chars; a baselined file may shrink but never grow. Run --update to regenerate the baseline after a deliberate size change.",
  },
  {
    name: "check:workflows",
    description:
      "Verifies the .claude/workflows/ dynamic-workflow surface against the MODEL-MATRIX in docs/contributing/model-selection.md and the per-script agent-count guardrail (ADR-0025). Run after adding/editing a workflow script.",
  },
  {
    name: "check:workflows-doc",
    description:
      "Verifies docs/contributing/ci-cd.md's CI/CD table documents exactly the workflow files under .github/workflows/ — count plus one row each. Run after adding/removing a GitHub Actions workflow.",
  },
  {
    name: "check:cadence",
    description:
      "Verifies CLAUDE.md's Commands cadence table matches lefthook.yml's pre-commit/commit-msg/pre-push stages exactly. Run after editing lefthook.yml.",
  },
  {
    name: "check:context-budget",
    description:
      "ADR-0078: resolves CLAUDE.md's @-imports before measuring the always-loaded budget (CLAUDE.md is injected in full into every session and every custom subagent launch), ratchets .claude/rules/*.md conditional-load weight against a committed baseline, and reports .claude/skills/*/SKILL.md description weight. Run after editing CLAUDE.md, a rule file, or a skill's frontmatter description; --update refreshes the rules baseline.",
  },
  {
    name: "check:harness-freshness",
    description:
      "ADR-0082: warns (non-blocking) when docs/research/harness-refresh.md's last-verified date is more than 90 days old, or the tracker has never been swept (last-verified=unset) — the self-polling half of the refreshing-anthropic-guidance cadence. Reads only the tracker's header comment; no network call. Run after editing the tracker, or let pre-push catch staleness.",
  },
  {
    name: "check:retrospective",
    description:
      "ADR-0084: warns (non-blocking) on two kinds of retrospective-loop drift. Section A audits the auto-memory store at ~/.claude/projects/<slug>/memory/ — MEMORY.md/file reconciliation both ways, literal control bytes (the blind spot check:control-chars structurally cannot reach, since it scans git-TRACKED files and the store lives outside the repo), unresolvable [[wikilinks]], frontmatter name/description/metadata.type, and MEMORY.md against the 200-line/25 KB load cap. Section B reads docs/research/retrospective.md's header and warns once the unswept work-log backlog crosses the 5-log cadence or the sweep goes stale. Offline, always exits 0, and a clean no-op when the store is absent (the CI condition). --dir points it at a fixture store.",
  },
  {
    name: "check:staleness",
    description:
      "Issue #995 (ROADMAP H2): warns (non-blocking) on post-merge local residue that finishing-work's manual, never hook-triggered invocation leaves unswept — a stale worktree or local branch (merged into main or upstream [gone]), a stale remote-tracking ref a `git fetch --prune` would clear, and an orphaned tmp/ file (a spoke dispatch journal, or residue from a retired hook) untouched past --journal-age days (default 7) and not on the LIVE_TMP_FILES allowlist. Reuses bin/lib/worktree-prune.mjs's merged/[gone] signals rather than re-deriving them; also covers the class worktree:prune structurally cannot see, a stale branch never attached to any worktree. Detection only, always exits 0 — the fix is pnpm worktree:prune / pnpm branch:cleanup <branch> / git fetch --prune. Runs from post-merge/post-rewrite (the actual merge moment) and the pre-push checks lane. --no-fetch skips the network-dependent remote-prune check.",
  },
  {
    name: "check:skill-evals",
    description:
      "Verifies every .claude/skills/<name>/SKILL.md has a sibling evals/evals.json with >= 3 cases, AND that every case is gradeable — a prompt, an expected_output, and at least one checklist entry the runner can actually render (validated with the same renderChecklistEntry the runner uses, so the gate and the runner cannot disagree). Catches the shapes that graded against nothing: object entries interpolated as [object Object], identifier-only entries, and a case with no expectations/assertions key at all. Every case needs >= 3 checklist entries. The named EXEMPT_SKILLS grandfather list (empty since the #775 backfill completed; kept for the next new skill) covers both a missing file and unresolved case shape, and a redundant exemption is an error so it cannot outlive its purpose. Run after adding a skill or editing its evals.json.",
  },
  {
    name: "eval:skills",
    description:
      "Repo-owned eval runner: drives a real `claude -p` invocation per .claude/skills/*/evals/evals.json case inside a disposable synthetic project root (a tmpdir holding a copy of .claude/skills/, so skills actually LOAD, but no settings.json, hooks or git tree come with it), asking it to self-grade against the case's checklist via --json-schema structured output, and prints a pass/fail summary. Read-only-plus-confined-write tool allowlist, no Bash and no network, so a case that would `git push` is denied and grades as an unmet expectation rather than executing. Costs real API spend — not part of pre-push; run manually or via .github/workflows/skill-evals.yml.",
  },
  {
    name: "check:review-policy",
    description:
      "Verifies REVIEW.md's review finding cap (currently 10) is restated identically in claude-pr-review.yml's prompt and every SEVERITY_CAPPED_SPOKES agent file (bin/lib/agent-roster.mjs). Run after changing the cap number anywhere.",
  },
  {
    name: "maintain:scan",
    description:
      "Runs the weekly automated maintain-scan (bin/run-maintain-scan.mjs) locally: a bounded, read-only `claude -p --restricted` triage pass against the current tree, opening a PR with unreviewed findings under docs/plans/IMPLEMENTATION.md only when it finds something concrete. Requires GH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN; normally runs via .github/workflows/maintain-scan.yml on a weekly cron.",
  },
  {
    name: "check:tracker-coverage",
    description:
      "Verifies every status-bearing table in ROADMAP.md/IMPLEMENTATION.md is registered with the sync:hub extractor (bin/lib/project-hub.mjs), so a newly added tracker table can't silently go unsynced. Run after adding a new '## ' section with a Status column to either tracker.",
  },
  {
    name: "check:tracker-status",
    description:
      "Verifies every Status cell in ROADMAP.md/IMPLEMENTATION.md is one of ADR-0032's six tracker values (Done/To Do/In Progress/Deferred/Blocked/Rejected), rejecting board-side tokens like 'In review' that classifyStatus would otherwise silently read as To Do. Run after editing a Status cell in either tracker.",
  },
  {
    name: "check:hub-keys",
    description:
      "Verifies every sync:hub item key derived from ROADMAP.md/IMPLEMENTATION.md is unique — no two rows deriving the same key, no two keys differing only by case, no legacy alias shadowing another item's key. Run after adding a tracker row or renaming an item label.",
  },
  {
    name: "check:hub-drift",
    description:
      "CI-gated dry-run of sync:hub-issues that fails when the plan is non-empty — GitHub Issues/Milestones no longer match ROADMAP.md/IMPLEMENTATION.md. Needs gh auth; run push-only in CI (ci.yml), and locally before pushing to main if you have gh authenticated.",
  },
  {
    name: "check:control-chars",
    description:
      "Fails when any git-tracked source file carries a LITERAL control byte (C0 plus DEL; tab and newline excepted). Such a byte makes the whole file binary to git — no diff, no review — while prettier, eslint and gitleaks all still pass. Exemption-free by design: a control character written as an escape sequence (`\\x00`) is byte-identical at runtime and stays reviewable, so the fix is always to escape it; genuinely binary formats are skipped by extension via BINARY_EXTENSIONS. Needs no network or auth, so it runs on pre-push and on every CI event.",
  },
  {
    name: "check:no-docker",
    description:
      "Enforces ADR-0091 (Docker/Dockerfiles banned project-wide in favor of Podman + Containerfile + a `podman kube play` pod manifest). Fails on a tracked file named `Dockerfile`, `*.dockerfile`, `.dockerignore`, or a Docker Compose YAML file, and on a Docker or Docker Compose invocation in a GitHub Actions workflow, `bin/**`, `lefthook.yml`, or any `package.json` scripts block. Allowlists `docs/adr/**`, `docs/logs/**`, and `docs/plans/archive/**` (historical record of Docker-era X12) plus `docker.io/` image references (a registry hostname, not the banned tool). Needs no network or auth, so it runs on pre-push and on every CI event.",
  },
  {
    name: "check:hub-views",
    description:
      "Asserts the GitHub Projects board matches bin/lib/hub-views.mjs: the view set both directions, each view's layout, filter, ordered columns and sort, the presence of the built-in Issue Type field, and the Status/Priority option sets (ADR-0073). Needs a `gh` session with the `project` OAuth scope; GITHUB_TOKEN cannot read Projects v2, so without it the gate prints each unverified facet and exits 0 rather than failing for a missing capability. Run push-only in CI (ci.yml) and locally before an apply session.",
  },
  {
    name: "check:worktree",
    description:
      ".worktreeinclude hygiene gate: every literal entry is gitignored and every path resolves, so `pnpm worktree:setup` provisions a fresh worktree correctly. Run after editing .worktreeinclude.",
  },
  {
    name: "check:host-resources",
    description:
      "Warn-only preflight (ADR-0080) reporting missing OOM-livelock mitigations on this host — earlyoom/systemd-oomd inactive, no zram swap, no user-.slice MemoryMax, CLAUDE_CODE_TOOL_MEMORY_LIMIT unset, another claude process already running. Never exits non-zero; runs automatically once per session via a SessionStart hook. Run setup:host-resources to apply the fixes it reports.",
  },
  {
    name: "check:claude-cli-version",
    description:
      "Makes .claude-code-version the single authority for the Claude Code CLI that skill-evals.yml and maintain-scan.yml install with `npm install -g` (Scorecard alert #17, PinnedDependenciesID). Asserts every install site names the exact pinned version, rejecting an unpinned install, a shell-substituted version (Scorecard parses the command text, so `@$(cat ...)` still reads as unpinned), a version disagreeing with the file, and a pin no workflow reads at all. The deliberate inverse of check:node-version, which forbids a literal because setup-node can read a file; a `run:` step cannot, so here the literal is required and this gate keeps it honest. Dependabot does not bump versions inside `run:` steps, so this is the only drift detector.",
  },
  {
    name: "check:node-version",
    description:
      "Makes .node-version the single authority for the dev/CI Node runtime (ADR-0003 amendment). Static half (exits non-zero): every workspace manifest's engines.node floor agrees with the pin, every .github/ actions/setup-node site reads node-version-file: .node-version instead of a literal, and @types/node's major tracks the pin so typecheck validates the declared floor rather than a newer API surface. Runtime half (warn-only): the Node executing the command matches the pinned major — run it when a test fails locally but is green in CI. Also runs once per session via a SessionStart hook.",
  },
  {
    name: "setup:host-resources",
    description:
      "Idempotent host-level applier (ADR-0080) for the mitigations check:host-resources reports — earlyoom, zram, vm.swappiness, user-.slice MemoryMax, claude-rc.service ceiling, CLAUDE_CODE_TOOL_MEMORY_LIMIT. Dry-run by default; pass --apply to mutate the host (uses sudo). Never weakens an existing stricter setting it finds.",
  },
  {
    name: "check:signed-range",
    description:
      "Refuses an unsigned/unverified outgoing commit range (@{upstream}..HEAD, falling back to origin/main) — the same check the pre-push hook runs. Run locally to preflight a push before it's rejected.",
  },
  {
    name: "check:commit-trailers",
    description:
      "Refuses an outgoing commit whose message still carries a harness-injected Claude-* trailer other than Co-Authored-By (e.g. Claude-Session:) — the pre-push backstop for a commit-msg bypassed with --no-verify.",
  },
  {
    name: "check:dup",
    description:
      "Copy-paste duplication density gate (jscpd, ADR-0034) — the one Sonar-style metric ESLint's per-function complexity rules don't cover. CI-only; run locally after a large refactor to spot-check duplication.",
  },
  {
    name: "gen:index",
    description:
      "Regenerates docs/reference/catalog.json + symbol-map.json (and the consumer-scripts catalog block in docs/reference/README.md) from each module's provenance sidecar. Run after any symbol or script changes, before check:index.",
  },
  {
    name: "gen:commit-stats-endpoint",
    description:
      "Emits shields.io endpoint-badge JSON (aggregate + per-model) to dist/commit-stats/ from the AI co-authorship commit history. Published by pages.yml on every push to main; rarely run by hand.",
  },
  {
    name: "gen:project-hub",
    description:
      "Renders the ADR-0032 visibility-hub dashboard (dist/index.html) from docs/ROADMAP.md, docs/plans/IMPLEMENTATION.md, and docs/implementation-status.md. Run to preview the hub locally after editing a tracker table.",
  },
  {
    name: "notify:main-health",
    description:
      'Opens, updates, or closes the single "main is red" tracking issue from a workflow_run event on CI or Pages. Invoked by .github/workflows/main-health.yml only — needs WORKFLOW_NAME/RUN_URL/HEAD_SHA/CONCLUSION env vars from a real workflow_run payload, so not meaningfully runnable by hand.',
  },
  {
    name: "check:index",
    description:
      "Verifies docs/reference/catalog.json, symbol-map.json, and the README catalog block are current against docs/reference/ + the provenance sidecars. Run after gen:index.",
  },
  {
    name: "worktree:new",
    description:
      "Creates and provisions a linked sibling worktree in one step (git worktree add + worktree:setup) — the entry point for concurrent work in an isolated checkout. `-- <slug>` (branch feat/<slug>), `-- <slug> --kind <kind>` for kind in feat|fix|docs|chore|refactor|ci, `-- <slug> --fix` (alias for `--kind fix`), or `-- <slug> --from <ref>` (detached HEAD at an existing ref, e.g. to investigate an abandoned branch).",
  },
  {
    name: "worktree:setup",
    description:
      "Provisions a worktree created via the manual `git worktree add` flow (install deps, register the merge driver, copy .worktreeinclude files). Run from inside a fresh manually-created worktree.",
  },
  {
    name: "worktree:remove",
    description:
      "Symmetric teardown for a worktree: removes it, prunes stale admin entries, and deletes its branch if safely merged. `-- <slug>` to remove a specific worktree once its work has landed.",
  },
  {
    name: "worktree:prune",
    description:
      "Cleans up every worktree whose branch is merged into main by ancestry, whose upstream reports [gone] (the marker left after a squash/rebase/merge-commit PR lands and the remote branch auto-deletes), a detached (--from) worktree whose HEAD is itself merged, or that git reports prunable. Refreshes remote-tracking refs first (git fetch --prune) unless `-- --no-fetch` is passed. `-- --dry-run` to preview, `-- --force` to also remove ones with uncommitted changes.",
  },
  {
    name: "branch:cleanup",
    description:
      "Shared-checkout equivalent of `worktree:remove`'s branch-delete step — deletes a merged local branch from the CURRENT checkout without any worktree-specific bookkeeping. `-- <branch>` (required, `git branch -d`; refuses `main` and the currently-checked-out branch), `-- <branch> --force` (`git branch -D`). The primary caller is `/finishing-work`, the post-merge close-out skill.",
  },
  {
    name: "telemetry:sessions",
    description:
      "ADR-0084: the ONLY sanctioned reader of Claude Code's session transcripts — a thin adapter over the session-report plugin's bundled analyze-sessions.mjs, invoked on demand by /promoting-work-log-lessons and NEVER a pre-push gate. Always pins --dir to this project's transcript directory and bounds --since (default 30d); the full store measured 1,759 files / 932 MB and an unscoped scan is the workload ADR-0080 budgets against. Asserts every required top-level key (overall, by_project, by_subagent_type, by_skill, cache_breaks, top_prompts, by_day) and exits NON-ZERO naming the transcript-format instability when one is missing — the format is internal to Claude Code and officially unsupported to parse, so without this a version upgrade degrades silently to zeros. --analyzer pins a specific cached revision.",
  },
  {
    name: "spoke:recover",
    description:
      "Automates the first step of the subagent-truncation recovery playbook: cross-references a spoke's journal against `git status`/`git diff` and recommends resume/redispatch/none. `-- --journal <path>` (required); the MCP `spoke_recover` tool wraps this same script.",
  },
  {
    name: "session:launch",
    description:
      "ADR-0088: launches Claude Code already named `<kind>-<slug>`, applying ADR-0087's session-naming convention at process start instead of a user-run `/rename`. On a branch-derivable `<kind>/<slug>` (feat|fix|docs|chore|refactor|ci), derives the name with no other input; otherwise requires `-- --kind <kind> <slug>` (main-resident-only kinds — audit, research, review, merge — have no branch to derive from). `-- -- <args>` forwards a literal `--`-prefixed tail to the underlying `claude` invocation. A session already open can't be renamed by this launcher — that residual case still needs `/rename` by hand.",
  },
  {
    name: "session:install-shell-hook",
    description:
      "ADR-0088: opt-in, idempotent installer that appends a `claude`-shadowing shell function to your detected shell rc file (or `-- --rc-path <path>`), delegating to `pnpm session:launch` unless an explicit naming/resume flag is already present or `CLAUDE_SESSION_LAUNCH_DISABLE` is set. Defaults to a dry run; `-- --write` actually mutates the file. Never wired into `prepare` — mutates a file outside the repo, so it stays a deliberate, separate command.",
  },
  {
    name: "prepare",
    description:
      "Lifecycle script (auto-runs on `pnpm install`): installs the lefthook git hooks and registers the m3l-generated merge driver. Never run directly; re-run manually only to repair a broken hook install.",
  },
];

/**
 * Compare `package.json`'s live `scripts` object against {@link COMMAND_CATALOG}
 * and report any structural drift in either direction. Both arrays are
 * sorted for a deterministic, diffable result.
 *
 * @param {Record<string, string>} packageScripts `package.json`'s `scripts` object
 * @param {{ name: string, description: string }[]} [catalog] defaults to {@link COMMAND_CATALOG}
 * @returns {{ missingFromCatalog: string[], staleInCatalog: string[] }}
 * @example
 * ```js
 * import { deriveCommandCatalogDiff } from "@m3l-automation/workspace/bin/lib/command-catalog.mjs";
 *
 * deriveCommandCatalogDiff({ build: "turbo run build" });
 * // { missingFromCatalog: [], staleInCatalog: [...every other catalog name] }
 * ```
 */
export function deriveCommandCatalogDiff(
  packageScripts,
  catalog = COMMAND_CATALOG,
) {
  const catalogNames = new Set(catalog.map((entry) => entry.name));
  const scriptNames = new Set(Object.keys(packageScripts));

  const missingFromCatalog = [...scriptNames]
    .filter((name) => !catalogNames.has(name))
    .sort();
  const staleInCatalog = [...catalogNames]
    .filter((name) => !scriptNames.has(name))
    .sort();

  return { missingFromCatalog, staleInCatalog };
}

// A script name's family is the substring before its first ":", or the whole
// name when there is none — e.g. "check:hooks" -> "check", "build" -> "build".
// This is why "lint:md"/"lint:commit" group with bare "lint", and
// "format:check" groups with bare "format": no hand-maintained grouping
// config exists to drift from the naming itself.
function familyOf(name) {
  const colonIndex = name.indexOf(":");
  return colonIndex === -1 ? name : name.slice(0, colonIndex);
}

/**
 * Group every `package.json` script by {@link familyOf}, joined against
 * {@link COMMAND_CATALOG} for its description. A script with no catalog entry
 * still appears (falling back to its raw command string as the description,
 * flagged via `hasDescription: false`) so the lister never hides an
 * undocumented command — {@link deriveCommandCatalogDiff} is the blocking
 * half of that gap. Families and the entries within them are both sorted
 * alphabetically — fully mechanical, nothing hand-ordered to go stale.
 *
 * @param {Record<string, string>} packageScripts `package.json`'s `scripts` object
 * @param {{ name: string, description: string }[]} [catalog] defaults to {@link COMMAND_CATALOG}
 * @returns {{ family: string, entries: { name: string, description: string, hasDescription: boolean }[] }[]}
 * @example
 * ```js
 * import { groupByFamily } from "@m3l-automation/workspace/bin/lib/command-catalog.mjs";
 *
 * groupByFamily({ "lint": "eslint .", "lint:md": "rumdl check ." });
 * // [{ family: "lint", entries: [{ name: "lint", ... }, { name: "lint:md", ... }] }]
 * ```
 */
export function groupByFamily(packageScripts, catalog = COMMAND_CATALOG) {
  const descriptionByName = new Map(
    catalog.map((entry) => [entry.name, entry.description]),
  );
  const groups = new Map();

  for (const [name, command] of Object.entries(packageScripts)) {
    const family = familyOf(name);
    const description = descriptionByName.get(name);
    const entry = {
      name,
      description: description ?? command,
      hasDescription: description !== undefined,
    };
    const existing = groups.get(family);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(family, [entry]);
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, entries]) => ({
      family,
      entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}
