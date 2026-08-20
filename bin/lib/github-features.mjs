// Pure derivation for `bin/check-github-features.mjs` (ADR-0050's drift
// gate). Nothing here reads a filesystem or shells out — the CLI wrapper
// collects a live `gh api repos/<repo>` payload and the committed
// `.github/ISSUE_TEMPLATE/config.yml` text and hands them to
// `deriveFeatureIssues`, mirroring `bin/lib/integration-stance.mjs`'s
// gen/check-shared-derivation shape so this stays exercisable in tests
// without spawning anything.
//
// Deliberate scope limit — repeat this at every call site, not just here:
// this only covers what a plain `GITHUB_TOKEN` can read — repository
// feature flags and metadata, plus the committed issue-template config. It
// does NOT cover the Projects board's link/visibility/views from ADR-0050 —
// those need the `project` OAuth scope the Actions token never carries
// (ADR-0032's 2026-07-22 correction), so they stay a maintainer-verified
// manual step, not a CI-gated one. Do not widen this gate to try.

/**
 * The platform-feature flags ADR-0050 decided, keyed exactly as the GitHub
 * REST API's `GET /repos/{owner}/{repo}` response names them.
 *
 * @type {{ has_wiki: boolean, has_discussions: boolean, has_issues: boolean, has_projects: boolean }}
 */
export const EXPECTED_REPO_FEATURES = {
  has_wiki: false,
  has_discussions: true,
  has_issues: true,
  has_projects: true,
};

// The Pages dashboard's own URL (ADR-0032) — the repo's `homepage` field
// should point at it, both for the community-profile checklist and so
// Insights' repo summary links somewhere real instead of nothing.
export const EXPECTED_HOMEPAGE = "https://monte3l.github.io/m3l-automation/";

const BLANK_ISSUES_DISABLED_PATTERN = /blank_issues_enabled:\s*false/;
const IDEAS_CONTACT_LINK_PATTERN = /discussions\/categories\/ideas/;
const QA_CONTACT_LINK_PATTERN = /discussions\/categories\/q-a/;

/**
 * @typedef {{
 *   has_wiki: boolean,
 *   has_discussions: boolean,
 *   has_issues: boolean,
 *   has_projects: boolean,
 *   description: string | null,
 *   homepage: string | null,
 *   topics: string[],
 * }} RepoFeaturePayload
 *
 * @typedef {{
 *   featureMismatches: string[],
 *   metadataGaps: string[],
 *   templateGaps: string[],
 * }} FeatureStanceIssues
 */

/**
 * Derive every drift between ADR-0050's declared GitHub platform-feature
 * stance and a live repository payload, plus the committed issue-template
 * config's Discussions-based contact links.
 *
 * @param {RepoFeaturePayload} repo
 * @param {string} issueTemplateConfigContent raw text of
 *   `.github/ISSUE_TEMPLATE/config.yml`
 * @returns {FeatureStanceIssues}
 * @example
 * ```js
 * import { deriveFeatureIssues } from "@m3l-automation/workspace/bin/lib/github-features.mjs";
 *
 * deriveFeatureIssues(
 *   {
 *     has_wiki: false,
 *     has_discussions: true,
 *     has_issues: true,
 *     has_projects: true,
 *     description: "Automation utilities library",
 *     homepage: "https://monte3l.github.io/m3l-automation/",
 *     topics: ["automation"],
 *   },
 *   "blank_issues_enabled: false\ncontact_links:\n  - url: https://github.com/monte3l/m3l-automation/discussions/categories/ideas\n  - url: https://github.com/monte3l/m3l-automation/discussions/categories/q-a\n",
 * );
 * // { featureMismatches: [], metadataGaps: [], templateGaps: [] }
 * ```
 */
export function deriveFeatureIssues(repo, issueTemplateConfigContent) {
  /** @type {string[]} */
  const featureMismatches = [];
  for (const [key, expected] of Object.entries(EXPECTED_REPO_FEATURES)) {
    const actual = repo[key];
    if (actual !== expected) {
      featureMismatches.push(
        `${key} is ${actual}, expected ${expected} per ADR-0050 — ` +
          `${expected ? "enable" : "disable"} it in repository settings.`,
      );
    }
  }

  /** @type {string[]} */
  const metadataGaps = [];
  if (!repo.description || repo.description.trim() === "") {
    metadataGaps.push(
      "Repository description is empty — set one (ADR-0050 §Insights).",
    );
  }
  if (repo.homepage !== EXPECTED_HOMEPAGE) {
    metadataGaps.push(
      `Repository homepage is "${repo.homepage ?? ""}", expected ` +
        `"${EXPECTED_HOMEPAGE}" (the ADR-0032 Pages dashboard).`,
    );
  }
  if (!Array.isArray(repo.topics) || repo.topics.length === 0) {
    metadataGaps.push(
      "Repository has no topics set — add at least one (ADR-0050 §Insights).",
    );
  }

  /** @type {string[]} */
  const templateGaps = [];
  if (!BLANK_ISSUES_DISABLED_PATTERN.test(issueTemplateConfigContent)) {
    templateGaps.push(
      ".github/ISSUE_TEMPLATE/config.yml no longer sets " +
        "blank_issues_enabled: false.",
    );
  }
  if (!IDEAS_CONTACT_LINK_PATTERN.test(issueTemplateConfigContent)) {
    templateGaps.push(
      ".github/ISSUE_TEMPLATE/config.yml is missing a contact link to the " +
        "Discussions Ideas category (ADR-0050).",
    );
  }
  if (!QA_CONTACT_LINK_PATTERN.test(issueTemplateConfigContent)) {
    templateGaps.push(
      ".github/ISSUE_TEMPLATE/config.yml is missing a contact link to the " +
        "Discussions Q&A category (ADR-0050).",
    );
  }

  return { featureMismatches, metadataGaps, templateGaps };
}
