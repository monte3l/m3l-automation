import { describe, expect, test } from "vitest";
import {
  deriveFeatureIssues,
  EXPECTED_HOMEPAGE,
  EXPECTED_REPO_FEATURES,
} from "../lib/github-features.mjs";

const COMPLIANT_REPO = {
  has_wiki: false,
  has_discussions: true,
  has_issues: true,
  has_projects: true,
  description: "Automation utilities library",
  homepage: EXPECTED_HOMEPAGE,
  topics: ["automation"],
};

const COMPLIANT_TEMPLATE_CONFIG =
  "blank_issues_enabled: false\n" +
  "contact_links:\n" +
  "  - name: Ideas\n" +
  "    url: https://github.com/monte3l/m3l-automation/discussions/categories/ideas\n" +
  "  - name: Q&A\n" +
  "    url: https://github.com/monte3l/m3l-automation/discussions/categories/q-a\n";

// ---------------------------------------------------------------------------
// EXPECTED_REPO_FEATURES / EXPECTED_HOMEPAGE
// ---------------------------------------------------------------------------

describe("EXPECTED_REPO_FEATURES", () => {
  test("declares ADR-0050's platform-feature stance", () => {
    expect(EXPECTED_REPO_FEATURES).toEqual({
      has_wiki: false,
      has_discussions: true,
      has_issues: true,
      has_projects: true,
    });
  });
});

describe("EXPECTED_HOMEPAGE", () => {
  test("is the Pages dashboard URL", () => {
    expect(EXPECTED_HOMEPAGE).toBe("https://monte3l.github.io/m3l-automation/");
  });
});

// ---------------------------------------------------------------------------
// deriveFeatureIssues
// ---------------------------------------------------------------------------

describe("deriveFeatureIssues", () => {
  test("a fully-compliant repo and template config reports no issues", () => {
    expect(
      deriveFeatureIssues(COMPLIANT_REPO, COMPLIANT_TEMPLATE_CONFIG),
    ).toEqual({
      featureMismatches: [],
      metadataGaps: [],
      templateGaps: [],
    });
  });

  test("flags a single feature-flag mismatch with the key and expected/actual values", () => {
    const repo = { ...COMPLIANT_REPO, has_wiki: true };
    const result = deriveFeatureIssues(repo, COMPLIANT_TEMPLATE_CONFIG);
    expect(result.featureMismatches).toEqual([
      "has_wiki is true, expected false per ADR-0050 — disable it in repository settings.",
    ]);
  });

  test("flags an enable-direction mismatch when a feature expected true is false", () => {
    const repo = { ...COMPLIANT_REPO, has_discussions: false };
    const result = deriveFeatureIssues(repo, COMPLIANT_TEMPLATE_CONFIG);
    expect(result.featureMismatches).toEqual([
      "has_discussions is false, expected true per ADR-0050 — enable it in repository settings.",
    ]);
  });

  test("flags every mismatched feature key at once, not just the first", () => {
    const repo = {
      ...COMPLIANT_REPO,
      has_wiki: true,
      has_issues: false,
      has_projects: false,
    };
    const result = deriveFeatureIssues(repo, COMPLIANT_TEMPLATE_CONFIG);
    expect(result.featureMismatches).toEqual([
      "has_wiki is true, expected false per ADR-0050 — disable it in repository settings.",
      "has_issues is false, expected true per ADR-0050 — enable it in repository settings.",
      "has_projects is false, expected true per ADR-0050 — enable it in repository settings.",
    ]);
  });

  test("flags an empty description", () => {
    const repo = { ...COMPLIANT_REPO, description: "" };
    const result = deriveFeatureIssues(repo, COMPLIANT_TEMPLATE_CONFIG);
    expect(result.metadataGaps).toEqual([
      "Repository description is empty — set one (ADR-0050 §Insights).",
    ]);
  });

  test("flags a whitespace-only description", () => {
    const repo = { ...COMPLIANT_REPO, description: "   " };
    const result = deriveFeatureIssues(repo, COMPLIANT_TEMPLATE_CONFIG);
    expect(result.metadataGaps).toEqual([
      "Repository description is empty — set one (ADR-0050 §Insights).",
    ]);
  });

  test("flags a null description", () => {
    const repo = { ...COMPLIANT_REPO, description: null };
    const result = deriveFeatureIssues(repo, COMPLIANT_TEMPLATE_CONFIG);
    expect(result.metadataGaps).toEqual([
      "Repository description is empty — set one (ADR-0050 §Insights).",
    ]);
  });

  test("flags a homepage that does not match the Pages dashboard URL, naming actual and expected", () => {
    const repo = { ...COMPLIANT_REPO, homepage: "https://example.com/" };
    const result = deriveFeatureIssues(repo, COMPLIANT_TEMPLATE_CONFIG);
    expect(result.metadataGaps).toEqual([
      `Repository homepage is "https://example.com/", expected "${EXPECTED_HOMEPAGE}" (the ADR-0032 Pages dashboard).`,
    ]);
  });

  test("flags a null homepage without throwing, showing an empty actual value", () => {
    const repo = { ...COMPLIANT_REPO, homepage: null };
    const result = deriveFeatureIssues(repo, COMPLIANT_TEMPLATE_CONFIG);
    expect(result.metadataGaps).toEqual([
      `Repository homepage is "", expected "${EXPECTED_HOMEPAGE}" (the ADR-0032 Pages dashboard).`,
    ]);
  });

  test("flags an empty topics array", () => {
    const repo = { ...COMPLIANT_REPO, topics: [] };
    const result = deriveFeatureIssues(repo, COMPLIANT_TEMPLATE_CONFIG);
    expect(result.metadataGaps).toEqual([
      "Repository has no topics set — add at least one (ADR-0050 §Insights).",
    ]);
  });

  test("flags a non-array topics value", () => {
    const repo = { ...COMPLIANT_REPO, topics: undefined };
    const result = deriveFeatureIssues(repo, COMPLIANT_TEMPLATE_CONFIG);
    expect(result.metadataGaps).toEqual([
      "Repository has no topics set — add at least one (ADR-0050 §Insights).",
    ]);
  });

  test("flags a missing blank_issues_enabled: false setting", () => {
    const content = COMPLIANT_TEMPLATE_CONFIG.replace(
      "blank_issues_enabled: false\n",
      "",
    );
    const result = deriveFeatureIssues(COMPLIANT_REPO, content);
    expect(result.templateGaps).toEqual([
      ".github/ISSUE_TEMPLATE/config.yml no longer sets " +
        "blank_issues_enabled: false.",
    ]);
  });

  test("flags a missing Discussions Ideas contact link", () => {
    const content =
      "blank_issues_enabled: false\n" +
      "contact_links:\n" +
      "  - name: Q&A\n" +
      "    url: https://github.com/monte3l/m3l-automation/discussions/categories/q-a\n";
    const result = deriveFeatureIssues(COMPLIANT_REPO, content);
    expect(result.templateGaps).toEqual([
      ".github/ISSUE_TEMPLATE/config.yml is missing a contact link to the " +
        "Discussions Ideas category (ADR-0050).",
    ]);
  });

  test("flags a missing Discussions Q&A contact link", () => {
    const content =
      "blank_issues_enabled: false\n" +
      "contact_links:\n" +
      "  - name: Ideas\n" +
      "    url: https://github.com/monte3l/m3l-automation/discussions/categories/ideas\n";
    const result = deriveFeatureIssues(COMPLIANT_REPO, content);
    expect(result.templateGaps).toEqual([
      ".github/ISSUE_TEMPLATE/config.yml is missing a contact link to the " +
        "Discussions Q&A category (ADR-0050).",
    ]);
  });

  test("flags all three template gaps when the config is entirely empty", () => {
    const result = deriveFeatureIssues(COMPLIANT_REPO, "");
    expect(result.templateGaps).toEqual([
      ".github/ISSUE_TEMPLATE/config.yml no longer sets " +
        "blank_issues_enabled: false.",
      ".github/ISSUE_TEMPLATE/config.yml is missing a contact link to the " +
        "Discussions Ideas category (ADR-0050).",
      ".github/ISSUE_TEMPLATE/config.yml is missing a contact link to the " +
        "Discussions Q&A category (ADR-0050).",
    ]);
  });

  test("reports issues across all three categories simultaneously without short-circuiting", () => {
    const repo = {
      ...COMPLIANT_REPO,
      has_wiki: true,
      description: "",
      homepage: "https://example.com/",
      topics: [],
    };
    const result = deriveFeatureIssues(repo, "");
    expect(result.featureMismatches).toEqual([
      "has_wiki is true, expected false per ADR-0050 — disable it in repository settings.",
    ]);
    expect(result.metadataGaps).toEqual([
      "Repository description is empty — set one (ADR-0050 §Insights).",
      `Repository homepage is "https://example.com/", expected "${EXPECTED_HOMEPAGE}" (the ADR-0032 Pages dashboard).`,
      "Repository has no topics set — add at least one (ADR-0050 §Insights).",
    ]);
    expect(result.templateGaps).toEqual([
      ".github/ISSUE_TEMPLATE/config.yml no longer sets " +
        "blank_issues_enabled: false.",
      ".github/ISSUE_TEMPLATE/config.yml is missing a contact link to the " +
        "Discussions Ideas category (ADR-0050).",
      ".github/ISSUE_TEMPLATE/config.yml is missing a contact link to the " +
        "Discussions Q&A category (ADR-0050).",
    ]);
  });
});
