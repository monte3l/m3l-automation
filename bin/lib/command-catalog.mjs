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
      "Runs the flat ESLint config (strict TS, no any, ESM-only, dependency-direction zones) over the whole repo. Pre-push gate; pre-commit only lints staged files.",
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
      "Verifies bin/lib/verify-steps.mjs (the `pnpm verify` aggregate gate's step list) matches the union of project-check steps across every lane job in .github/workflows/ci.yml exactly, in both directions. Run after adding/removing/renaming a step in any ci.yml lane job.",
  },
  {
    name: "check:api",
    description:
      "Diffs the live `exports` map against a committed snapshot so any change to the public API contract (`.`, `./core`, `./aws`) shows up as a deliberate, reviewed diff. Run after touching a namespace barrel.",
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
    name: "check:agents",
    description:
      "Verifies every skill/CLAUDE.md agent reference resolves to a real subagent or built-in, and that no spoke is granted the Agent tool (the no-nesting invariant). Run after editing .claude/agents/** or a skill's dispatch prompt.",
  },
  {
    name: "check:hooks",
    description:
      "Verifies every .claude/settings.json hook command resolves to a real .claude/hooks/*.mjs file, every event name is a real Claude Code lifecycle event, and no hook file is left unwired. Run after editing hooks or settings.json.",
  },
  {
    name: "check:integration-stance",
    description:
      "Verifies every GitHub-talking .claude/skills/*/SKILL.md carries an ADR-0030 stance reference, contains no retired policy claim, and names the mechanism (gh CLI vs GitHub MCP) it actually uses. Run after editing a GitHub-facing skill.",
  },
  {
    name: "check:github-features",
    description:
      "Verifies the live repository's GitHub platform-feature flags (wiki/discussions/issues/projects) and metadata (description/homepage/topics) match ADR-0050's declared stance, and that .github/ISSUE_TEMPLATE/config.yml still links to the Discussions Ideas/Q&A categories. Needs gh auth; run push-only in CI (ci.yml), same as check:hub-drift.",
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
    name: "check:claude-md-budget",
    description:
      "Verifies CLAUDE.md's runtime content (HTML comments stripped) stays under its line/token budget, and warns on Prettier-padded table rows. Run after editing CLAUDE.md.",
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
    name: "check:signed-range",
    description:
      "Refuses an unsigned/unverified outgoing commit range (@{upstream}..HEAD, falling back to origin/main) — the same check the pre-push hook runs. Run locally to preflight a push before it's rejected.",
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
    name: "check:index",
    description:
      "Verifies docs/reference/catalog.json, symbol-map.json, and the README catalog block are current against docs/reference/ + the provenance sidecars. Run after gen:index.",
  },
  {
    name: "worktree:new",
    description:
      "Creates and provisions a linked sibling worktree in one step (git worktree add + worktree:setup) — the entry point for concurrent work in an isolated checkout. `-- <slug>` (branch feat/<slug>), `-- <slug> --fix`, or `-- <slug> --from <ref>` (detached HEAD at an existing ref, e.g. to investigate an abandoned branch).",
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
    name: "spoke:recover",
    description:
      "Automates the first step of the subagent-truncation recovery playbook: cross-references a spoke's journal against `git status`/`git diff` and recommends resume/redispatch/none. `-- --journal <path>` (required); the MCP `spoke_recover` tool wraps this same script.",
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
