import { describe, expect, test } from "vitest";
import {
  extractFrontmatterBody,
  extractFrontmatterField,
  parseSkillFrontmatter,
  deriveFrontmatterIssues,
  deriveNameIssues,
  GRANDFATHERED_NAMES,
  deriveMissingFromCatalog,
  tokenize,
  jaccardSimilarity,
  deriveOverlappingPairs,
  OVERLAP_WARN_THRESHOLD,
} from "../lib/skill-frontmatter.mjs";

// bin/lib/skill-frontmatter.mjs is a PURE module — no node:fs import at all,
// it takes file contents as plain data — so every test below calls the
// exported functions directly with literal fixtures, no fs mocking needed.

describe("exported constants", () => {
  test("OVERLAP_WARN_THRESHOLD is 0.15", () => {
    expect(OVERLAP_WARN_THRESHOLD).toBe(0.15);
  });
});

// ---------------------------------------------------------------------------
// extractFrontmatterBody
// ---------------------------------------------------------------------------

describe("extractFrontmatterBody", () => {
  test("returns the body between the first two --- lines", () => {
    const content = [
      "---",
      "name: auditing",
      "description: audit things",
      "---",
      "# Body",
    ].join("\n");
    expect(extractFrontmatterBody(content)).toBe(
      "name: auditing\ndescription: audit things",
    );
  });

  test("returns null when there is no frontmatter block", () => {
    expect(extractFrontmatterBody("# Just a heading\n\nNo frontmatter.")).toBe(
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// extractFrontmatterField
// ---------------------------------------------------------------------------

describe("extractFrontmatterField", () => {
  test("an inline scalar returns the trimmed value", () => {
    const fmBody = "name: auditing";
    expect(extractFrontmatterField(fmBody, "name")).toBe("auditing");
  });

  test("a folded block scalar (>-) returns the space-joined, trimmed lines", () => {
    const fmBody = ["description: >-", "  line one", "  line two"].join("\n");
    expect(extractFrontmatterField(fmBody, "description")).toBe(
      "line one line two",
    );
  });

  test("a missing key returns an empty string", () => {
    expect(extractFrontmatterField("name: auditing", "description")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseSkillFrontmatter
// ---------------------------------------------------------------------------

describe("parseSkillFrontmatter", () => {
  test("parses a well-formed skill's name and description", () => {
    const content = [
      "---",
      "name: auditing",
      "description: audit things",
      "---",
      "# Body",
    ].join("\n");

    const result = parseSkillFrontmatter([{ dirName: "auditing", content }]);

    expect(result).toEqual([
      { dirName: "auditing", name: "auditing", description: "audit things" },
    ]);
  });

  test("a skill with no frontmatter at all yields empty strings for both fields, not a throw", () => {
    const result = parseSkillFrontmatter([
      {
        dirName: "no-frontmatter",
        content: "# Just a heading, no frontmatter.",
      },
    ]);

    expect(result).toEqual([
      { dirName: "no-frontmatter", name: "", description: "" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// deriveFrontmatterIssues
// ---------------------------------------------------------------------------

describe("deriveFrontmatterIssues", () => {
  test("an empty/whitespace-only description is flagged in emptyDescription", () => {
    const parsed = [
      { dirName: "auditing", name: "auditing", description: "   " },
    ];

    expect(deriveFrontmatterIssues(parsed)).toEqual({
      emptyDescription: ["auditing"],
      nameMismatch: [],
    });
  });

  test("a name field that doesn't match dirName is flagged in nameMismatch, naming both actual and expected", () => {
    const parsed = [
      { dirName: "auditing", name: "wrong-name", description: "audit things" },
    ];

    const issues = deriveFrontmatterIssues(parsed);

    expect(issues.emptyDescription).toEqual([]);
    expect(issues.nameMismatch).toEqual([
      'auditing: name: field is "wrong-name", expected "auditing"',
    ]);
  });

  // [GUARD TEETH] A fully well-formed skill (description present AND name
  // matches dirName) must produce neither issue — confirms a future
  // regression that silently stops checking one of the two conditions would
  // be caught, rather than the array always coincidentally being empty.
  test("a fully well-formed skill produces neither issue", () => {
    const parsed = [
      { dirName: "auditing", name: "auditing", description: "audit things" },
    ];

    expect(deriveFrontmatterIssues(parsed)).toEqual({
      emptyDescription: [],
      nameMismatch: [],
    });
  });
});

// ---------------------------------------------------------------------------
// deriveNameIssues
// ---------------------------------------------------------------------------

/** Builds a SkillFrontmatter fixture where only `dirName` matters. */
const nameOnly = (dirName: string) => ({
  dirName,
  name: dirName,
  description: "x",
});

describe("deriveNameIssues", () => {
  test("a gerund name produces no issues at all", () => {
    expect(deriveNameIssues([nameOnly("creating-prs")])).toEqual({
      specViolations: [],
      shapeViolations: [],
      reservedWordWarnings: [],
    });
  });

  test("a <topic>-<head-noun> name using a recognized head noun produces no issues at all", () => {
    expect(deriveNameIssues([nameOnly("vitest-testing")])).toEqual({
      specViolations: [],
      shapeViolations: [],
      reservedWordWarnings: [],
    });
  });

  test("a two-segment name whose second segment is NOT a recognized head noun is a shape violation", () => {
    const issues = deriveNameIssues([nameOnly("vitest-coverage")]);
    expect(issues.shapeViolations).toHaveLength(1);
    expect(issues.shapeViolations[0]).toContain("vitest-coverage");
    expect(issues.specViolations).toEqual([]);
    expect(issues.reservedWordWarnings).toEqual([]);
  });

  test("a four-token pile with no gerund and no valid two-segment shape is exactly one shape violation", () => {
    const issues = deriveNameIssues([nameOnly("vitest-coverage-types-mocks")]);
    expect(issues.shapeViolations).toHaveLength(1);
    expect(issues.shapeViolations[0]).toContain("vitest-coverage-types-mocks");
    expect(issues.specViolations).toEqual([]);
    expect(issues.reservedWordWarnings).toEqual([]);
  });

  // Both entries are 2+-segment names whose last segment ("config", "guide")
  // is NOT a recognized head noun, so this confirms they pass BECAUSE of the
  // GRANDFATHERED_NAMES exemption, not because they'd clear the shape check
  // on their own merits.
  test.each(Array.from(GRANDFATHERED_NAMES))(
    "grandfathered name %j produces no shapeViolations despite failing the shape check on its own",
    (dirName) => {
      expect(deriveNameIssues([nameOnly(dirName)])).toEqual({
        specViolations: [],
        shapeViolations: [],
        reservedWordWarnings: [],
      });
    },
  );

  test("a name longer than 64 characters produces a specViolations entry", () => {
    const longName = "a".repeat(65);
    const issues = deriveNameIssues([nameOnly(longName)]);
    expect(issues.specViolations).toHaveLength(1);
    expect(issues.specViolations[0]).toContain("65");
  });

  test("a name containing an uppercase letter produces a specViolations entry (kebab-case)", () => {
    const issues = deriveNameIssues([nameOnly("Creating-PRs")]);
    expect(issues.specViolations).toHaveLength(1);
    expect(issues.shapeViolations).toEqual([]);
    expect(issues.reservedWordWarnings).toEqual([]);
  });

  test("a name with a doubled hyphen produces a specViolations entry (kebab-case)", () => {
    const issues = deriveNameIssues([nameOnly("creating--prs")]);
    expect(issues.specViolations).toHaveLength(1);
    expect(issues.shapeViolations).toEqual([]);
    expect(issues.reservedWordWarnings).toEqual([]);
  });

  // "refreshing-anthropic-guidance" is a real, live skill name whose first
  // segment "refreshing" ends in "ing" — a valid gerund shape — so this also
  // incidentally confirms the reserved-word check is independent of the
  // shape check (warn-only, doesn't also fail shape/spec).
  test('a name containing "anthropic" produces exactly one reservedWordWarnings entry and no other issues', () => {
    expect(
      deriveNameIssues([nameOnly("refreshing-anthropic-guidance")]),
    ).toEqual({
      specViolations: [],
      shapeViolations: [],
      reservedWordWarnings: [
        expect.stringContaining("refreshing-anthropic-guidance"),
      ],
    });
  });

  test('a name containing "claude" produces a reservedWordWarnings entry too', () => {
    const issues = deriveNameIssues([nameOnly("testing-claude-things")]);
    expect(issues.reservedWordWarnings).toHaveLength(1);
    expect(issues.reservedWordWarnings[0]).toContain("testing-claude-things");
  });

  // [GUARD TEETH] A fully clean batch mixing both accepted shape families
  // must produce empty arrays across all three categories — confirms the
  // function doesn't just coincidentally return empty arrays.
  test("a fully clean multi-item batch produces no issues in any category", () => {
    const parsed = [
      nameOnly("typescript-configuration"),
      nameOnly("vitest-testing"),
      nameOnly("triaging-ci"),
    ];
    expect(deriveNameIssues(parsed)).toEqual({
      specViolations: [],
      shapeViolations: [],
      reservedWordWarnings: [],
    });
  });
});

// ---------------------------------------------------------------------------
// deriveMissingFromCatalog
// ---------------------------------------------------------------------------

describe("deriveMissingFromCatalog", () => {
  test("a name present in the catalog text is not flagged", () => {
    const catalogContent = "See the `auditing` skill for audit workflows.";
    expect(deriveMissingFromCatalog(["auditing"], catalogContent)).toEqual([]);
  });

  test("a name absent from the catalog text IS flagged", () => {
    const catalogContent = "See the `auditing` skill for audit workflows.";
    expect(
      deriveMissingFromCatalog(["totally-absent"], catalogContent),
    ).toEqual(["totally-absent"]);
  });

  // This is a literal substring check (catalogContent.includes(name)), not a
  // word-boundary match — a dirName that happens to be a substring of a
  // DIFFERENT mentioned skill's name is honestly reported as "not missing",
  // even though it was never itself mentioned. Documenting the real
  // behavior, not a wished-for word-boundary variant.
  test("a name that is a substring of a different, unrelated mentioned name is NOT flagged as missing (literal substring check, not word-boundary)", () => {
    const catalogContent = "See the `finishing-work` skill for wrap-up steps.";
    expect(deriveMissingFromCatalog(["work"], catalogContent)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  test("mixed-case input with stopwords and short words produces the expected filtered lowercase set", () => {
    const text =
      "Use THE Auditing skill to audit AWS resources when the user says go";
    const result = tokenize(text);

    expect(result).toEqual(new Set(["auditing", "audit", "aws", "resources"]));
  });

  test.each(["the", "use", "skill"])(
    "excludes the stopword %j even though it appears in the input",
    (stopword) => {
      const result = tokenize(`${stopword} auditing resources`);
      expect(result.has(stopword)).toBe(false);
      expect(result).toContain("auditing");
    },
  );
});

// ---------------------------------------------------------------------------
// jaccardSimilarity
// ---------------------------------------------------------------------------

describe("jaccardSimilarity", () => {
  test("identical sets produce similarity 1", () => {
    const a = new Set(["foo", "bar"]);
    const b = new Set(["foo", "bar"]);
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  test("fully disjoint sets produce similarity 0", () => {
    const a = new Set(["foo", "bar"]);
    const b = new Set(["baz", "qux"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  test("a partial-overlap case matches the hand-computed ratio (intersection=1, union=5 -> 0.2)", () => {
    const a = new Set(["foo", "bar", "baz"]);
    const b = new Set(["baz", "qux", "quux"]);
    expect(jaccardSimilarity(a, b)).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// deriveOverlappingPairs
// ---------------------------------------------------------------------------

describe("deriveOverlappingPairs", () => {
  test("two skills with near-identical descriptions appear as a pair at high similarity", () => {
    const parsed = [
      {
        dirName: "skill-one",
        name: "skill-one",
        description: "audit resources across AWS accounts for compliance drift",
      },
      {
        dirName: "skill-two",
        name: "skill-two",
        description: "audit resources across AWS accounts for compliance gaps",
      },
    ];

    const pairs = deriveOverlappingPairs(parsed);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.pair).toEqual(["skill-one", "skill-two"]);
    expect(pairs[0]?.similarity).toBeGreaterThan(0.5);
  });

  test("two skills with completely unrelated descriptions do NOT appear at the default threshold", () => {
    const parsed = [
      {
        dirName: "skill-one",
        name: "skill-one",
        description: "audit resources across AWS accounts for compliance drift",
      },
      {
        dirName: "skill-two",
        name: "skill-two",
        description: "scaffold a brand new submodule directory structure",
      },
    ];

    expect(deriveOverlappingPairs(parsed)).toEqual([]);
  });

  test("results are sorted highest-similarity-first across multiple qualifying pairs", () => {
    const parsed = [
      {
        dirName: "alpha",
        name: "alpha",
        description: "audit resources compliance drift accounts",
      },
      {
        dirName: "beta",
        name: "beta",
        description: "audit resources compliance drift",
      },
      {
        dirName: "gamma",
        name: "gamma",
        description: "audit resources",
      },
    ];

    const pairs = deriveOverlappingPairs(parsed);

    expect(pairs.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < pairs.length; i++) {
      const previous = pairs[i - 1];
      const current = pairs[i];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      expect(previous?.similarity).toBeGreaterThanOrEqual(
        current?.similarity ?? 0,
      );
    }
  });
});
