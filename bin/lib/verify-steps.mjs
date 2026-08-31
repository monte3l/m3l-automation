// Shared source of truth for CI's project-check steps, consumed by both the
// local aggregate runner (verify-all.mjs, `pnpm verify`) and the drift
// checker (check-verify-parity.mjs, `pnpm check:verify-parity`) — a gen/check
// pair in the same spirit as bin/lib/count-sites.mjs and
// bin/check-cadence-doc.mjs, but for `.github/workflows/ci.yml` instead of
// lefthook.yml.
//
// Problem this solves: `.github/workflows/ci.yml` runs ~41 project-check
// steps spread across parallel lane jobs (secrets, deps, lint, format, build,
// test, gates — see that file's own header comment); `lefthook.yml` pre-push
// covers 8 of them. Nothing reproduces the full CI gate in one local command,
// so a contributor either trusts a stale mental model of "what CI checks" or
// chains ~30 `pnpm check:*` invocations by hand. VERIFY_STEPS is the ordered,
// hand-authored mirror of every lane's steps; `pnpm verify` runs it locally,
// `pnpm check:verify-parity` asserts it still matches `ci.yml` in both
// directions.
//
// Anchor field: each entry's `ciStepName` must match a `name:` value
// SOMEWHERE in ci.yml's lane jobs EXACTLY — that is the join key the parity
// checker diffs on, not the command string (command strings drift in
// harmless ways — flags, wrapper choice — that would produce false-positive
// drift). The `verify` aggregator job itself carries no project checks and
// is excluded from both the parser and this list (see
// `parseCiVerifyStepNames`).
//
// Two steps are deliberately not run by `pnpm verify` by default even though
// they are tracked for parity:
//   - "Secret scan (gitleaks)" has no local CLI equivalent (see
//     `.claude/skills/triaging-ci/SKILL.md`'s reproduction table).
//   - PR-only steps ("Validate commit messages", "Check exports semver
//     labeling") need a PR base/head range; they run against
//     `origin/main...HEAD` when that range resolves, else are skipped with a
//     printed note (mirrors ci.yml's `if: github.event_name == 'pull_request'`).
// "Install (frozen lockfile)" is no longer tracked here — the job split moved
// it into the shared `.github/actions/setup` composite action, which this
// file's ci.yml-only parser cannot see and which is bootstrap, not a project
// check, in any case.
//
// Path scoping: every entry marked `conditional: true` is gated in ci.yml on
// bin/ci-changed-paths.mjs's category outputs, job-level for lint/build/test/
// deps/format — CI may legitimately skip it when its category didn't change.
// The `gates` lane deliberately carries NO step-level category gating (after
// four review rounds each found a different check whose real inputs spanned
// a category narrower than its gate — see that job's header comment in
// ci.yml): its ~24 steps together cost only ~20s, so they all run
// unconditionally rather than being individually audited against a
// 7-category scheme forever. `pnpm verify` still runs every entry
// unconditionally regardless of this flag; it exists purely so a CI-side
// skip of a conditional step reads as expected behavior, not as parity
// drift, when someone is reading this file to understand what "skipped"
// means for a given step.
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
 * @property {boolean} [needsLiveState] - true when this step compares committed
 *   state against MUTABLE remote state (GitHub Issues/Milestones/labels/repo
 *   metadata/the Projects board) that can change with no corresponding code
 *   change — {@link findHermeticityViolations} fails if such a step is wired
 *   into a job that feeds the required `verify` aggregate's `needs:` list
 *   (ADR-0079: check:hub-drift and three siblings were exactly this).
 * @property {boolean} [conditional] - true when this step is path-gated in CI
 *   (skipped when its category's inputs didn't change — see the file header).
 *   `pnpm verify` still runs it unconditionally either way.
 */

/** @type {VerifyStep[]} */
export const VERIFY_STEPS = [
  {
    ciStepName: "Secret scan (gitleaks)",
    id: "gitleaks",
    skipReason: "no local gitleaks CLI equivalent (see triaging-ci)",
  },
  {
    ciStepName: "Cache turbo",
    id: "cache-turbo",
    skipReason:
      "CI-only actions/cache plumbing for turbo's .turbo/ directory across jobs/runners; a local checkout already has a persistent .turbo/ across runs with nothing to restore",
  },
  {
    ciStepName: "Security audit",
    id: "audit",
    cmd: () => "pnpm audit --audit-level=high",
    conditional: true,
  },
  {
    ciStepName: "Check dependencies",
    id: "check-deps",
    cmd: () => "pnpm check:deps",
    conditional: true,
  },
  {
    ciStepName: "Check dependency licenses",
    id: "check-licenses",
    cmd: () => "pnpm check:licenses",
    conditional: true,
  },
  {
    ciStepName: "Build CLI (scaffold checkers read packages/m3l-cli/dist)",
    id: "build-cli-for-gates",
    cmd: () => "pnpm turbo run build --filter=@m3l-automation/m3l-cli",
  },
  {
    ciStepName: "Check workflow build order",
    id: "check-workflow-build-order",
    cmd: () => "pnpm check:workflow-build-order",
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
  {
    ciStepName: "Check review size",
    id: "check-review-size",
    prOnly: true,
    cmd: ({ baseRef }) =>
      `node bin/check-review-size.mjs --base ${baseRef} --head HEAD`,
  },
  {
    ciStepName: "Lint (library)",
    id: "lint-library",
    cmd: () => "pnpm lint:library",
    conditional: true,
  },
  {
    ciStepName: "Lint (workspace)",
    id: "lint-workspace",
    cmd: () => "pnpm lint:workspace",
    conditional: true,
  },
  {
    ciStepName: "Format check",
    id: "format-check",
    cmd: () => "pnpm format:check",
  },
  {
    ciStepName: "Lint Markdown",
    id: "lint-md",
    cmd: () => "pnpm lint:md",
    conditional: true,
  },
  {
    ciStepName: "Type-check",
    id: "typecheck",
    cmd: () => "pnpm typecheck",
    conditional: true,
  },
  {
    ciStepName: "Check public API snapshot",
    id: "check-api",
    cmd: () => "pnpm check:api",
    conditional: true,
  },
  {
    ciStepName: "Check browser-safe exports subpaths",
    id: "check-browser-safe-subpath",
    cmd: () => "pnpm check:browser-safe-subpath",
    conditional: true,
  },
  {
    ciStepName: "Check exports semver labeling",
    id: "check-exports-semver",
    prOnly: true,
    cmd: ({ baseRef }) =>
      `node bin/check-exports-semver.mjs --base ${baseRef} --head HEAD`,
    conditional: true,
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
    ciStepName: "Check context budget",
    id: "check-context-budget",
    cmd: () => "pnpm check:context-budget",
  },
  {
    ciStepName: "Check harness freshness",
    id: "check-harness-freshness",
    cmd: () => "pnpm check:harness-freshness",
  },
  {
    ciStepName: "Check skill evals",
    id: "check-skill-evals",
    cmd: () => "pnpm check:skill-evals",
  },
  {
    ciStepName: "Check review policy",
    id: "check-review-policy",
    cmd: () => "pnpm check:review-policy",
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
    conditional: true,
  },
  {
    ciStepName: "Build m3l-common",
    id: "build-m3l-common-for-e2e",
    cmd: () => "pnpm --filter @m3l-automation/m3l-common build",
    skipReason:
      "prerequisite for the e2e lane's own vite build, which bypasses turbo's dependsOn graph — path-scoped like the rest of this lane (pass --full to run it)",
    conditional: true,
  },
  {
    ciStepName: "Cache Playwright browsers",
    id: "cache-playwright",
    skipReason:
      "CI-only actions/cache plumbing for the installed browser binary across runners; a local checkout already has whatever it installed on a prior run with nothing to restore",
  },
  {
    ciStepName: "Install Playwright browsers",
    id: "install-playwright",
    cmd: () =>
      "pnpm --filter @m3l-automation/m3l-console-web exec playwright install --with-deps chromium",
    skipReason:
      "a full Chromium install is exactly the per-run cost ADR-0067's X9 row path-scoped e2e to avoid paying by default; pass --full to install and run the suite locally",
    conditional: true,
  },
  {
    ciStepName: "Run e2e suite",
    id: "test-e2e",
    cmd: () => "pnpm test:e2e",
    skipReason:
      "path-scoped like CI's own e2e job (ADR-0067) — expensive enough that a routine `pnpm verify` shouldn't pay for it on every run regardless of what changed; pass --full to run it",
    conditional: true,
  },
  {
    ciStepName: "Check test counts",
    id: "check-test-counts",
    cmd: () => "pnpm check:test-counts",
  },
  {
    ciStepName: "Build",
    id: "build",
    cmd: () => "pnpm build",
    conditional: true,
  },
  {
    ciStepName: "Check package exports (publint + are-the-types-wrong)",
    id: "check-exports",
    cmd: () => "pnpm check:exports",
    conditional: true,
  },
  {
    ciStepName: "Check barrel re-exports (scaffold)",
    id: "check-scaffold",
    cmd: () => "pnpm check:scaffold",
    conditional: true,
  },
  {
    ciStepName: "Check scaffold seam (test + status row + landing plan)",
    id: "check-scaffold-seam",
    cmd: () => "pnpm check:scaffold-seam",
  },
  {
    ciStepName: "Check file budget",
    id: "check-file-budget",
    cmd: () => "pnpm check:file-budget",
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
    ciStepName: "Check CLI scaffold conformance",
    id: "check-cli-scaffold",
    cmd: () => "pnpm check:cli-scaffold",
  },
  {
    ciStepName: "Check CLI doc structure",
    id: "check-cli-docs",
    cmd: () => "pnpm check:cli-docs",
  },
  {
    ciStepName: "Check scaffold template format",
    id: "check-template-format",
    cmd: () => "pnpm check:template-format",
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
    ciStepName: "Check Node version pin",
    id: "check-node-version",
    cmd: () => "pnpm check:node-version",
  },
  {
    ciStepName: "Check Claude Code CLI pin",
    id: "check-claude-cli-version",
    cmd: () => "pnpm check:claude-cli-version",
  },
  {
    ciStepName: "Check GitHub-integration stance (integration-stance)",
    id: "check-integration-stance",
    cmd: () => "pnpm check:integration-stance",
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
    needsLiveState: true,
  },
  {
    ciStepName: "Check GitHub platform-feature stance (push-only)",
    id: "check-github-features",
    cmd: () => "pnpm check:github-features",
    skipReason:
      "needs a `gh`-authenticated session and live GitHub state; ci.yml also runs it push-only, not on PRs",
    needsLiveState: true,
  },
  {
    ciStepName: "Check label drift (push-only)",
    id: "check-label-drift",
    cmd: () => "pnpm check:label-drift",
    skipReason:
      "needs a `gh`-authenticated session and live GitHub state; ci.yml also runs it push-only, not on PRs",
    needsLiveState: true,
  },
  {
    ciStepName: "Check for literal control characters",
    id: "check-control-chars",
    cmd: () => "pnpm check:control-chars",
  },
  {
    ciStepName: "Check hub board views (push-only)",
    id: "check-hub-views",
    cmd: () => "pnpm check:hub-views",
    skipReason:
      "needs a `gh` session with the `project` OAuth scope, which GITHUB_TOKEN never carries; ci.yml also runs it push-only, not on PRs",
    needsLiveState: true,
  },
];

/**
 * Parse the union of `name:` values across every job in
 * `.github/workflows/ci.yml`'s `jobs:` section, EXCLUDING the `verify`
 * aggregator job (which carries no project checks of its own — see that
 * job's comment in ci.yml). Deliberately regex-based (no YAML dependency),
 * matching the style of check-workflows-doc.mjs / check-cadence-doc.mjs.
 * Only steps that declare a `name:` are picked up — `uses:`-only bootstrap
 * steps (checkout, the local `./.github/actions/setup` composite action)
 * have none and are correctly excluded, the same way they're absent from
 * VERIFY_STEPS.
 *
 * Job boundaries are found by matching 2-space-indented `key:` lines
 * directly under `jobs:` — every job's own body content (`runs-on:`,
 * `steps:`, and everything nested under them) sits at 4-space indent or
 * deeper, so this cannot false-positive on job-body content.
 *
 * @param {string} ciYamlText
 * @returns {string[]}
 */
export function parseCiVerifyStepNames(ciYamlText) {
  const names = new Set();
  for (const { jobName, body } of parseCiJobBoundaries(ciYamlText)) {
    if (jobName === "verify") continue;
    for (const m of body.matchAll(/^ {6}- name:\s*(.+?)\s*$/gm)) {
      names.add(m[1]);
    }
  }
  return [...names];
}

/**
 * Split ci.yml's `jobs:` section into per-job bodies — the shared boundary
 * walk {@link parseCiVerifyStepNames}, {@link parseCiJobStepNames}, and
 * {@link parseVerifyNeeds} all build on, so the job-boundary regex is
 * defined exactly once. Job boundaries are 2-space-indented `key:` lines
 * directly under `jobs:` — every job's own body content (`runs-on:`,
 * `steps:`, and everything nested under them) sits at 4-space indent or
 * deeper, so this cannot false-positive on job-body content.
 *
 * @param {string} ciYamlText
 * @returns {{ jobName: string, body: string }[]}
 */
function parseCiJobBoundaries(ciYamlText) {
  const jobsMatch = /\njobs:\n([\s\S]*)$/.exec(`\n${ciYamlText}`);
  if (!jobsMatch) {
    throw new Error("could not locate a `jobs:` section in ci.yml");
  }
  const jobsSection = jobsMatch[1];

  const boundaries = [...jobsSection.matchAll(/^ {2}([\w-]+):\n/gm)];
  if (boundaries.length === 0) {
    throw new Error("could not locate any job definitions in ci.yml");
  }

  return boundaries.map((boundary, index) => {
    const start = boundary.index + boundary[0].length;
    const end = boundaries[index + 1]?.index ?? jobsSection.length;
    return { jobName: boundary[1], body: jobsSection.slice(start, end) };
  });
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

/**
 * Parse each job's own ordered `name:` step values in ci.yml, keyed by job
 * id — the same per-job walk {@link parseCiVerifyStepNames} does, but
 * keeping the job boundary instead of flattening into one set. Used by
 * {@link findHermeticityViolations} to check which JOB a live-state step
 * lives in, not just whether the step exists somewhere in ci.yml.
 *
 * @param {string} ciYamlText
 * @returns {Map<string, string[]>} job id -> ordered step names (verify excluded)
 */
export function parseCiJobStepNames(ciYamlText) {
  const jobSteps = new Map();
  for (const { jobName, body } of parseCiJobBoundaries(ciYamlText)) {
    if (jobName === "verify") continue;
    const names = [...body.matchAll(/^ {6}- name:\s*(.+?)\s*$/gm)].map(
      (m) => m[1],
    );
    jobSteps.set(jobName, names);
  }
  return jobSteps;
}

/**
 * Parse the required `verify` job's own `needs:` array from ci.yml — the
 * set of lane jobs whose failure fails the required status check.
 *
 * @param {string} ciYamlText
 * @returns {string[]}
 */
export function parseVerifyNeeds(ciYamlText) {
  const verifyJob = parseCiJobBoundaries(ciYamlText).find(
    (job) => job.jobName === "verify",
  );
  if (!verifyJob) {
    throw new Error("could not locate the `verify` job in ci.yml");
  }

  const needsMatch = /^ {4}needs:\s*\[([^\]]*)\]/m.exec(verifyJob.body);
  if (!needsMatch) {
    throw new Error("could not locate `verify`'s `needs:` array in ci.yml");
  }
  return needsMatch[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @typedef {Object} HermeticityViolation
 * @property {string} ciStepName
 * @property {string} job
 */

/**
 * A `needsLiveState: true` step wired into a job that feeds the required
 * `verify` aggregate is a hermeticity violation: `verify` would gate `main`
 * on a step that can fail or pass based on mutable remote state alone, with
 * no corresponding code change — exactly the defect ADR-0079 fixed for
 * `check:hub-drift` and its three siblings. This makes that fix permanent
 * rather than a one-time correction: a future live-state check wired the
 * same wrong way fails this gate instead of silently repeating the failure
 * mode.
 *
 * @param {string} ciYamlText
 * @param {VerifyStep[]} [steps] defaults to {@link VERIFY_STEPS}
 * @returns {HermeticityViolation[]}
 */
export function findHermeticityViolations(ciYamlText, steps = VERIFY_STEPS) {
  const jobSteps = parseCiJobStepNames(ciYamlText);
  const verifyNeeds = new Set(parseVerifyNeeds(ciYamlText));

  const violations = [];
  for (const step of steps) {
    if (!step.needsLiveState) continue;
    for (const [jobName, stepNames] of jobSteps) {
      if (stepNames.includes(step.ciStepName) && verifyNeeds.has(jobName)) {
        violations.push({ ciStepName: step.ciStepName, job: jobName });
      }
    }
  }
  return violations;
}
