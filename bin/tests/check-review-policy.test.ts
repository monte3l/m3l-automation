import { describe, expect, test } from "vitest";
import {
  diffCapSources,
  diffExclusions,
  diffOutputFormatLiterals,
  diffSeverityTiers,
  extractCap,
  extractExclusions,
  extractOutputFormatLiterals,
  extractSection,
  extractSeverityTiers,
  normalizeWhitespace,
} from "../../bin/check-review-policy.mjs";

describe("extractCap", () => {
  test("extracts the number from the bold REVIEW.md phrasing", () => {
    expect(
      extractCap(
        "Cap each section at its **10** most severe findings, most-severe first.",
      ),
    ).toBe(10);
  });

  test("extracts the number from plain (non-bold) phrasing", () => {
    expect(extractCap("its 10 most severe findings")).toBe(10);
  });

  test("extracts the number when the phrase wraps across a line break", () => {
    expect(
      extractCap(
        "Cap each section at its 10 most\nsevere findings, most-severe first.",
      ),
    ).toBe(10);
  });

  test("returns null when the phrase is absent entirely", () => {
    expect(extractCap("nothing relevant here")).toBeNull();
  });
});

describe("diffCapSources", () => {
  test("a source with cap: null produces an error mentioning the missing phrase and its label", () => {
    const errors = diffCapSources(10, [{ label: "some/file.md", cap: null }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("has no");
    expect(errors[0]).toContain("most severe findings");
    expect(errors[0]).toContain("some/file.md");
  });

  test("a source with a differing cap produces an error mentioning both numbers and its label", () => {
    const errors = diffCapSources(10, [{ label: "some/file.md", cap: 8 }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("10");
    expect(errors[0]).toContain("8");
    expect(errors[0]).toContain("some/file.md");
  });

  test("a source with a matching cap produces no error", () => {
    expect(diffCapSources(10, [{ label: "some/file.md", cap: 10 }])).toEqual(
      [],
    );
  });

  test("a mix of matching, null, and mismatched sources yields exactly one message per problem source in input order, referencing the correct label", () => {
    const sources = [
      { label: "matching-one.md", cap: 10 },
      { label: "missing-phrase.md", cap: null },
      { label: "mismatched.md", cap: 7 },
      { label: "matching-two.md", cap: 10 },
    ];
    const errors = diffCapSources(10, sources);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("missing-phrase.md");
    expect(errors[0]).not.toContain("mismatched.md");
    expect(errors[1]).toContain("mismatched.md");
    expect(errors[1]).toContain("7");
    expect(errors[1]).not.toContain("missing-phrase.md");
  });
});

describe("extractSection", () => {
  test("returns the trimmed body up to the next ## heading", () => {
    expect(
      extractSection("## Foo\n\nbody text\n\n## Bar\n\nother", "Foo"),
    ).toBe("body text");
  });

  test("returns null when the heading is not found", () => {
    expect(extractSection("## Foo\n\nbody", "Missing")).toBeNull();
  });

  test("a heading at the very end still returns its body up to EOF, trimmed", () => {
    expect(extractSection("## Foo\n\nbody\n\n## Bar\n\ntrailing", "Bar")).toBe(
      "trailing",
    );
  });

  test("does not match a heading name that is a substring of another heading", () => {
    expect(extractSection("## Foobar\n\nwrong section", "Foo")).toBeNull();
  });
});

describe("normalizeWhitespace", () => {
  test("collapses mixed whitespace runs to a single space", () => {
    expect(normalizeWhitespace("a  \n  b\tc")).toBe("a b c");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalizeWhitespace("  leading and trailing  ")).toBe(
      "leading and trailing",
    );
  });

  test("returns an empty string for whitespace-only input", () => {
    expect(normalizeWhitespace("   \n\t  ")).toBe("");
  });

  test("leaves already-normalized text unchanged", () => {
    expect(normalizeWhitespace("already normal")).toBe("already normal");
  });
});

describe("extractSeverityTiers", () => {
  // Verified by running extractSeverityTiers directly against the live
  // REVIEW.md's Severity tiers section — used here verbatim as a fixture.
  const severityMd = [
    "## Severity tiers",
    "",
    "- **Must-fix** — breaks correctness, violates a stated project rule (this",
    "  repo's `docs/contributing/style-guide.md` and `.claude/rules/*.md`), or",
    "  introduces a security/silent-failure defect. Blocks merge.",
    "- **Should-fix** — a real quality issue that does not block merge on its",
    "  own: a missed edge case, a weak type, a maintainability concern.",
    "- **Nit** — style, naming, or preference. Never blocks merge.",
  ].join("\n");

  test("parses each bullet into a name/normalized-description entry", () => {
    expect(extractSeverityTiers(severityMd)).toEqual({
      "Must-fix":
        "breaks correctness, violates a stated project rule (this repo's `docs/contributing/style-guide.md` and `.claude/rules/*.md`), or introduces a security/silent-failure defect. Blocks merge.",
      "Should-fix":
        "a real quality issue that does not block merge on its own: a missed edge case, a weak type, a maintainability concern.",
      Nit: "style, naming, or preference. Never blocks merge.",
    });
  });

  test("returns {} when the section is missing", () => {
    expect(extractSeverityTiers("## Something else\n\nno tiers here")).toEqual(
      {},
    );
  });

  test("returns {} for a section with no bullets", () => {
    expect(
      extractSeverityTiers("## Severity tiers\n\nno bullets here"),
    ).toEqual({});
  });

  test("parses a single-tier section", () => {
    expect(
      extractSeverityTiers("## Severity tiers\n\n- **Only** — one tier here."),
    ).toEqual({ Only: "one tier here." });
  });
});

describe("diffSeverityTiers", () => {
  test("no error when the description is found (whitespace-normalized) in the prompt", () => {
    expect(
      diffSeverityTiers(
        { "Must-fix": "breaks things" },
        "the prompt says breaks things somewhere",
      ),
    ).toEqual([]);
  });

  test("one error, naming the tier and its description, when the description is absent", () => {
    const errors = diffSeverityTiers(
      { "Must-fix": "breaks things" },
      "the prompt never mentions it",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Must-fix");
    expect(errors[0]).toContain("breaks things");
  });

  test("returns [] when every tier's description is found", () => {
    expect(
      diffSeverityTiers(
        { "Must-fix": "breaks things", "Should-fix": "a real issue" },
        "prompt text mentioning breaks things and also a real issue",
      ),
    ).toEqual([]);
  });

  test("reports only the missing tier when one of several matches and one does not", () => {
    const errors = diffSeverityTiers(
      {
        "Must-fix": "breaks things",
        "Should-fix": "never mentioned anywhere",
      },
      "prompt text mentioning breaks things only",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Should-fix");
  });
});

describe("extractExclusions", () => {
  // Verified by running extractExclusions directly against the live
  // REVIEW.md's Exclusions section — used here verbatim as a fixture.
  const exclusionsMd = [
    "## Exclusions",
    "",
    "- `*.md` (any Markdown file)",
    "- `docs/**`",
    "- `.github/dependabot.yml`",
    "- `pnpm-lock.yaml`",
  ].join("\n");

  test("parses the backtick-quoted patterns in order", () => {
    expect(extractExclusions(exclusionsMd)).toEqual([
      "*.md",
      "docs/**",
      ".github/dependabot.yml",
      "pnpm-lock.yaml",
    ]);
  });

  test("returns [] when the section is missing", () => {
    expect(
      extractExclusions("## Something else\n\nno exclusions here"),
    ).toEqual([]);
  });

  test("returns [] for a section with no backtick-quoted bullets", () => {
    expect(
      extractExclusions("## Exclusions\n\nno patterns listed here"),
    ).toEqual([]);
  });

  test("parses a single-exclusion section", () => {
    expect(extractExclusions("## Exclusions\n\n- `*.md`")).toEqual(["*.md"]);
  });
});

describe("diffExclusions", () => {
  test("no error when the backtick-wrapped pattern is a literal substring of the prompt", () => {
    expect(diffExclusions(["*.md"], "docs (`*.md`, `docs/**`)")).toEqual([]);
  });

  test("one error, containing the pattern, when it is absent", () => {
    const errors = diffExclusions(["*.md"], "no mention of markdown here");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("*.md");
  });

  test("returns [] when every pattern is found", () => {
    expect(
      diffExclusions(
        ["*.md", "docs/**"],
        "excludes `*.md` and `docs/**` from review",
      ),
    ).toEqual([]);
  });

  test("reports only the missing pattern when one of several matches and one does not", () => {
    const errors = diffExclusions(
      ["*.md", "pnpm-lock.yaml"],
      "excludes `*.md` from review",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("pnpm-lock.yaml");
  });

  test("is a literal substring check, not whitespace-normalized — a reflowed match does not count", () => {
    const errors = diffExclusions(
      ["*.md"],
      "excludes `*.md\n` (a stray newline inside the backticks)",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("*.md");
  });
});

describe("extractOutputFormatLiterals", () => {
  // Verified by running extractOutputFormatLiterals directly against the live
  // REVIEW.md's Output format section — used here verbatim as a fixture.
  //
  // [KNOWN DISCREPANCY] The hub's task description predicted an 8-element
  // result ending at "pnpm check:review-policy". Running the function
  // against this exact fixture actually produces a 9th trailing element,
  // "claude-pr-review.yml" — the closing sentence's second inline
  // backtick span ("...is restated somewhere in `claude-pr-review.yml`'s
  // prompt.") is also picked up by the inline-span pass, which the task
  // description's manual trace missed. This test asserts the OBSERVED
  // 9-element behavior, per instruction to trust actual output over the
  // hand-derived description.
  const outputFormatMd = [
    "## Output format",
    "",
    "Every review surface using this cap follows the same section order and",
    "markers, so a reviewer or a parser reading multiple surfaces' output never",
    "has to special-case one of them:",
    "",
    "- Headings, in order: `### Must-fix`, `### Should-fix`, `### Nits`, `### Verdict`",
    "- An empty section reads `_None._` rather than an empty bullet list.",
    "- Each finding is one bullet, exactly:",
    "",
    "  ```",
    "  - **`path/to/file.ts:line`** — <violation> (<which rule>).",
    "  ```",
    "",
    "- The verdict line, exactly:",
    "",
    "  ```",
    "  - PASS|FAIL — <one-line reason>",
    "  ```",
    "",
    "`pnpm check:review-policy` verifies each of the six literal strings above",
    "is restated somewhere in `claude-pr-review.yml`'s prompt.",
  ].join("\n");

  test("extracts fenced-block content first, then remaining inline backtick spans in appearance order", () => {
    expect(extractOutputFormatLiterals(outputFormatMd)).toEqual([
      "- **`path/to/file.ts:line`** — <violation> (<which rule>).",
      "- PASS|FAIL — <one-line reason>",
      "### Must-fix",
      "### Should-fix",
      "### Nits",
      "### Verdict",
      "_None._",
      "pnpm check:review-policy",
      "claude-pr-review.yml",
    ]);
  });

  test("returns [] when the section is missing", () => {
    expect(
      extractOutputFormatLiterals("## Something else\n\nnothing relevant"),
    ).toEqual([]);
  });

  test("returns [] for a section with no fenced blocks or backtick spans", () => {
    expect(
      extractOutputFormatLiterals("## Output format\n\nplain prose only"),
    ).toEqual([]);
  });

  test("a section with only a fenced block and no inline spans yields just that literal", () => {
    expect(
      extractOutputFormatLiterals(
        "## Output format\n\n```\nfenced content\n```\n",
      ),
    ).toEqual(["fenced content"]);
  });
});

describe("diffOutputFormatLiterals", () => {
  test("no error when the literal is a substring of the prompt", () => {
    expect(
      diffOutputFormatLiterals(
        ["### Must-fix"],
        "text with ### Must-fix in it",
      ),
    ).toEqual([]);
  });

  test("one error, containing the literal, when it is absent", () => {
    const errors = diffOutputFormatLiterals(
      ["### Must-fix"],
      "no heading here",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("### Must-fix");
  });

  test("returns [] when every literal is found", () => {
    expect(
      diffOutputFormatLiterals(
        ["### Must-fix", "_None._"],
        "### Must-fix section, empty reads _None._",
      ),
    ).toEqual([]);
  });

  test("reports only the missing literal when one of several matches and one does not", () => {
    const errors = diffOutputFormatLiterals(
      ["### Must-fix", "### Verdict"],
      "only has ### Must-fix here",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("### Verdict");
  });
});
