// Shared source of truth for the CI `verify` job's step list, consumed by both
// the local aggregate runner (verify-all.mjs, `pnpm verify`) and the drift
// checker (check-verify-parity.mjs, `pnpm check:verify-parity`) — a gen/check
// pair in the same spirit as bin/lib/count-sites.mjs and
// bin/check-cadence-doc.mjs, but for the CI `verify` job instead of
// lefthook.yml.
//
// Problem this solves: `.github/workflows/ci.yml`'s `verify` job runs ~35
// ordered steps; `lefthook.yml` pre-push covers 8 of them. Nothing reproduces
// the full CI gate in one local command, so a contributor either trusts a
// stale mental model of "what CI checks" or chains ~30 `pnpm check:*`
// invocations by hand. VERIFY_STEPS is the ordered, hand-authored mirror of
// the `verify` job; `pnpm verify` runs it locally, `pnpm check:verify-parity`
// asserts it still matches `ci.yml` in both directions.
//
// Anchor field: each entry's `ciStepName` must match a `name:` value in
// ci.yml's `verify` job EXACTLY — that is the join key the parity checker
// diffs on, not the command string (command strings drift in harmless ways
// — flags, wrapper choice — that would produce false-positive drift).
//
// Three steps are deliberately not run by `pnpm verify` by default even
// though they are tracked for parity:
//   - "Secret scan (gitleaks)" has no local CLI equivalent (see
//     `.claude/skills/triaging-ci/SKILL.md`'s reproduction table).
//   - "Install (frozen lockfile)" is environment bootstrap, not a project
//     check; a local checkout is assumed to already have deps installed.
//   - PR-only steps ("Validate commit messages", "Check exports semver
//     labeling") need a PR base/head range; they run against
//     `origin/main...HEAD` when that range resolves, else are skipped with a
//     printed note (mirrors ci.yml's `if: github.event_name == 'pull_request'`).
//
// Usage:
//   node bin/verify-all.mjs            # pnpm verify
//   node bin/check-verify-parity.mjs   # pnpm check:verify-parity

/**
 * @typedef {Object} VerifyStep
 * @property {string} ciStepName  - exact `name:` value of the matching ci.yml step
 * @property {string} id          - short kebab-case id for CLI output / tests
 * @property {(ctx: { baseRef: string }) => string} [cmd] - local command to run;
 *   absent for steps with no local equivalent (see `skipReason`)
 * @property {boolean} [prOnly]   - only meaningful against a PR diff range
 * @property {string} [skipReason] - why `pnpm verify` does not run this by default
 */

/** @type {VerifyStep[]} */
export const VERIFY_STEPS = [
  {
    ciStepName: "Secret scan (gitleaks)",
    id: "gitleaks",
    skipReason: "no local gitleaks CLI equivalent (see triaging-ci)",
  },
  {
    ciStepName: "Install (frozen lockfile)",
    id: "install",
    cmd: () => "pnpm install --frozen-lockfile",
    skipReason: "environment bootstrap; assumes deps are already installed",
  },
  {
    ciStepName: "Security audit",
    id: "audit",
    cmd: () => "pnpm audit --audit-level=high",
  },
  {
    ciStepName: "Check dependencies",
    id: "check-deps",
    cmd: () => "pnpm check:deps",
  },
  {
    ciStepName: "Check dependency licenses",
    id: "check-licenses",
    cmd: () => "pnpm check:licenses",
  },
  {
    ciStepName: "Check verify parity",
    id: "check-verify-parity",
    cmd: () => "pnpm check:verify-parity",
  },
  {
    ciStepName: "Validate commit messages",
    id: "lint-commit",
    prOnly: true,
    cmd: ({ baseRef }) =>
      `node bin/lint-commit.mjs --from ${baseRef} --to HEAD`,
  },
  { ciStepName: "Lint", id: "lint", cmd: () => "pnpm lint" },
  {
    ciStepName: "Format check",
    id: "format-check",
    cmd: () => "pnpm format:check",
  },
  { ciStepName: "Lint Markdown", id: "lint-md", cmd: () => "pnpm lint:md" },
  { ciStepName: "Type-check", id: "typecheck", cmd: () => "pnpm typecheck" },
  {
    ciStepName: "Check public API snapshot",
    id: "check-api",
    cmd: () => "pnpm check:api",
  },
  {
    ciStepName: "Check exports semver labeling",
    id: "check-exports-semver",
    prOnly: true,
    cmd: ({ baseRef }) =>
      `node bin/check-exports-semver.mjs --base ${baseRef} --head HEAD`,
  },
  {
    ciStepName: "Check doc provenance",
    id: "check-provenance",
    cmd: () => "pnpm check:provenance",
  },
  {
    ciStepName: "Check doc counts",
    id: "check-doc-counts",
    cmd: () => "pnpm check:doc-counts",
  },
  {
    ciStepName: "Check workflow docs",
    id: "check-workflows-doc",
    cmd: () => "pnpm check:workflows-doc",
  },
  {
    ciStepName: "Check cadence docs",
    id: "check-cadence",
    cmd: () => "pnpm check:cadence",
  },
  {
    ciStepName: "Check tracker coverage",
    id: "check-tracker-coverage",
    cmd: () => "pnpm check:tracker-coverage",
  },
  {
    ciStepName: "Check tracker status vocabulary",
    id: "check-tracker-status",
    cmd: () => "pnpm check:tracker-status",
  },
  {
    ciStepName: "Check hub-sync key uniqueness",
    id: "check-hub-keys",
    cmd: () => "pnpm check:hub-keys",
  },
  {
    ciStepName: "Check implementation count",
    id: "check-impl-counts",
    cmd: () => "pnpm check:impl-counts",
  },
  {
    ciStepName: "Check reference index",
    id: "check-index",
    cmd: () => "pnpm check:index",
  },
  {
    ciStepName: "Test (with coverage gate)",
    id: "test-coverage",
    cmd: () => "pnpm test:coverage",
  },
  {
    ciStepName: "Check test counts",
    id: "check-test-counts",
    cmd: () => "pnpm check:test-counts",
  },
  { ciStepName: "Build", id: "build", cmd: () => "pnpm build" },
  {
    ciStepName: "Check package exports (publint + are-the-types-wrong)",
    id: "check-exports",
    cmd: () => "pnpm check:exports",
  },
  {
    ciStepName: "Check barrel re-exports (scaffold)",
    id: "check-scaffold",
    cmd: () => "pnpm check:scaffold",
  },
  {
    ciStepName: "Check scaffold seam (test + status row)",
    id: "check-scaffold-seam",
    cmd: () => "pnpm check:scaffold-seam",
  },
  {
    ciStepName: "Check script scaffold conformance",
    id: "check-script-scaffold",
    cmd: () => "pnpm check:script-scaffold",
  },
  {
    ciStepName: "Check script doc structure",
    id: "check-script-docs",
    cmd: () => "pnpm check:script-docs",
  },
  {
    ciStepName: "Check script dependency boundary",
    id: "check-script-deps",
    cmd: () => "pnpm check:script-deps",
  },
  {
    ciStepName: "Check barrel vs docs exports",
    id: "check-doc-exports",
    cmd: () => "pnpm check:doc-exports",
  },
  {
    ciStepName: "Check subagent configuration (agents)",
    id: "check-agents",
    cmd: () => "pnpm check:agents",
  },
  {
    ciStepName: "Check dynamic-workflow surface (workflows)",
    id: "check-workflows",
    cmd: () => "pnpm check:workflows",
  },
  {
    ciStepName: "Check hook wiring (hooks)",
    id: "check-hooks",
    cmd: () => "pnpm check:hooks",
  },
  {
    ciStepName: "Check GitHub-integration stance (github-stance)",
    id: "check-github-stance",
    cmd: () => "pnpm check:github-stance",
  },
  {
    ciStepName: "Check dependency-direction zones (zones)",
    id: "check-zones",
    cmd: () => "pnpm check:zones",
  },
  {
    ciStepName: "Check worktree include",
    id: "check-worktree",
    cmd: () => "pnpm check:worktree",
  },
  {
    ciStepName: "Check command catalog",
    id: "check-command-catalog",
    cmd: () => "pnpm check:command-catalog",
  },
  {
    ciStepName: "Check code duplication (jscpd)",
    id: "check-dup",
    cmd: () => "pnpm check:dup",
  },
  {
    ciStepName: "Unused files / exports / dependencies (knip)",
    id: "knip",
    cmd: () => "pnpm knip",
  },
  {
    ciStepName: "Check hub drift (push-only)",
    id: "check-hub-drift",
    cmd: () => "pnpm check:hub-drift",
    skipReason:
      "needs a `gh`-authenticated session and live GitHub state; ci.yml also runs it push-only, not on PRs",
  },
];

/**
 * Parse the ordered list of `name:` values from `.github/workflows/ci.yml`'s
 * `verify` job. Deliberately regex-based (no YAML dependency), matching the
 * style of check-workflows-doc.mjs / check-cadence-doc.mjs. Only steps that
 * declare a `name:` are picked up — the three `uses:`-only bootstrap steps
 * (checkout, pnpm/action-setup, actions/setup-node) have none and are
 * correctly excluded, the same way they're absent from VERIFY_STEPS.
 *
 * @param {string} ciYamlText
 * @returns {string[]}
 */
export function parseCiVerifyStepNames(ciYamlText) {
  const jobMatch = /\n {2}verify:\n([\s\S]*?)(?:\n {2}\S|\n?$)/.exec(
    `\n${ciYamlText}`,
  );
  if (!jobMatch) {
    throw new Error("could not locate the `verify` job in ci.yml");
  }
  const names = [];
  for (const m of jobMatch[1].matchAll(/^ {6}- name:\s*(.+?)\s*$/gm)) {
    names.push(m[1]);
  }
  return names;
}

/**
 * Compare the ci.yml-derived step-name set against {@link VERIFY_STEPS} and
 * report any structural drift in either direction. Mirrors the shape of
 * {@link import("./command-catalog.mjs").deriveCommandCatalogDiff}.
 *
 * @param {string[]} ciStepNames
 * @param {VerifyStep[]} [steps] defaults to {@link VERIFY_STEPS}
 * @returns {{ missingFromList: string[], staleInList: string[] }}
 */
export function diffVerifySteps(ciStepNames, steps = VERIFY_STEPS) {
  const listedNames = new Set(steps.map((s) => s.ciStepName));
  const ciNames = new Set(ciStepNames);

  const missingFromList = [...ciNames]
    .filter((name) => !listedNames.has(name))
    .sort();
  const staleInList = [...listedNames]
    .filter((name) => !ciNames.has(name))
    .sort();

  return { missingFromList, staleInList };
}
