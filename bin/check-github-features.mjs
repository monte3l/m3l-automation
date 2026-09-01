#!/usr/bin/env node
// Verifies the live repository's GitHub platform-feature flags and metadata
// match ADR-0050's declared stance, and that
// `.github/ISSUE_TEMPLATE/config.yml` still points at the Discussions-based
// idea/support channels ADR-0050 adopted. Push-only in CI (ci.yml, mirroring
// "Check hub drift") — needs a `gh`-authenticated session; see
// `bin/lib/github-features.mjs`'s header for the deliberate scope limit
// (the Projects board's link/visibility/views are NOT covered here — they
// need the `project` OAuth scope `GITHUB_TOKEN` never carries).
//
// Usage:
//   node bin/check-github-features.mjs
//   pnpm check:github-features
import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveFeatureIssues } from "./lib/github-features.mjs";
import { createReporter, parseJsonFlag, repoRoot } from "./lib/report.mjs";

const root = repoRoot(import.meta.url);
const REPO = "monte3l/m3l-automation";
const ISSUE_TEMPLATE_CONFIG_PATH = ".github/ISSUE_TEMPLATE/config.yml";

/**
 * The single injected `gh` execution seam: every call in this file goes
 * through this function (or a test double shaped like it), mirroring
 * `bin/sync-hub-issues.mjs`'s `runGh` so nothing here shells out directly in
 * `bin/tests/**`.
 *
 * @param {string[]} args
 * @returns {string} the child process's captured stdout
 */
function runGh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

/** Extract the clearest available message from a failed `execFileSync` call. */
function ghErrorMessage(cause) {
  if (
    cause &&
    typeof cause === "object" &&
    "stderr" in cause &&
    typeof cause.stderr === "string" &&
    cause.stderr.trim() !== ""
  ) {
    return cause.stderr.trim();
  }
  return cause instanceof Error ? cause.message : String(cause);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseJsonFlag();
  const reporter = createReporter(json);

  try {
    const raw = runGh(["api", `repos/${REPO}`]);
    const payload = JSON.parse(raw);
    /** @type {import("./lib/github-features.mjs").RepoFeaturePayload} */
    const repo = {
      has_wiki: payload.has_wiki,
      has_discussions: payload.has_discussions,
      has_issues: payload.has_issues,
      has_projects: payload.has_projects,
      delete_branch_on_merge: payload.delete_branch_on_merge,
      description: payload.description,
      homepage: payload.homepage,
      topics: payload.topics ?? [],
    };

    const issueTemplateConfigContent = readFileSync(
      join(root, ISSUE_TEMPLATE_CONFIG_PATH),
      "utf8",
    );

    const { featureMismatches, metadataGaps, templateGaps, cleanupWarnings } =
      deriveFeatureIssues(repo, issueTemplateConfigContent);

    for (const message of featureMismatches) reporter.error(message);
    for (const message of metadataGaps) reporter.error(message);
    for (const message of templateGaps) {
      reporter.error(message, { file: ISSUE_TEMPLATE_CONFIG_PATH });
    }
    // Warn-severity, not error — see EXPECTED_DELETE_BRANCH_ON_MERGE's
    // header comment for why this doesn't join featureMismatches.
    for (const message of cleanupWarnings) reporter.warn(message);

    if (
      featureMismatches.length > 0 ||
      metadataGaps.length > 0 ||
      templateGaps.length > 0
    ) {
      reporter.finish({
        featureMismatches,
        metadataGaps,
        templateGaps,
        cleanupWarnings,
      });
      process.exit(1);
    }

    reporter.succeed(
      "GitHub platform-feature stance (ADR-0050) matches the live repository.",
    );
    reporter.finish({
      featureMismatches,
      metadataGaps,
      templateGaps,
      cleanupWarnings,
    });
  } catch (cause) {
    const message =
      cause instanceof Error && "stderr" in cause
        ? `gh api repos/${REPO} failed — run \`gh auth login\` first if this ` +
          `is an auth error: ${ghErrorMessage(cause)}`
        : cause instanceof Error
          ? cause.message
          : String(cause);
    reporter.error(message);
    reporter.finish();
    process.exit(1);
  }
}
