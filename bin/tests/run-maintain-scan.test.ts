import { describe, expect, test } from "vitest";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  FINDINGS_SCHEMA,
  MAX_CITATION_LENGTH,
  MAX_FIELD_LENGTH,
  MAX_FINDINGS,
  SECTION_HEADING,
  buildTriagePrompt,
  formatFindingsSection,
  insertFindingsSection,
  parseFindingsEnvelope,
} from "../../bin/run-maintain-scan.mjs";

type Finding = { title: string; description: string; citation: string };

function makeFinding(index: number): Finding {
  return {
    title: `title-${index}`,
    description: `description-${index}`,
    citation: `file${index}.ts:${index}`,
  };
}

// Array destructuring types `finding` as `Finding | undefined` under
// noUncheckedIndexedAccess; `expect(...).toBeDefined()` only narrows at
// runtime, not for TypeScript. Throwing gives real narrowing to `Finding`
// while also asserting the invariant under test — exactly one finding
// survived parsing.
function requireOnlyFinding(findings: readonly Finding[]): Finding {
  expect(findings).toHaveLength(1);
  const [finding] = findings;
  if (finding === undefined) {
    throw new Error("expected exactly one finding");
  }
  return finding;
}

describe("DEFAULT_MODEL, DEFAULT_EFFORT, MAX_FINDINGS, SECTION_HEADING", () => {
  test("pin the documented constants for this workflow script", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5");
    expect(DEFAULT_EFFORT).toBe("medium");
    expect(MAX_FINDINGS).toBe(5);
    expect(SECTION_HEADING).toBe("## Automated maintain-scan findings");
  });
});

describe("FINDINGS_SCHEMA", () => {
  test("declares the structured findings array shape", () => {
    expect(FINDINGS_SCHEMA.type).toBe("object");
    expect(FINDINGS_SCHEMA.properties.findings.type).toBe("array");
    expect(FINDINGS_SCHEMA.properties.findings.maxItems).toBe(MAX_FINDINGS);
    expect(FINDINGS_SCHEMA.properties.findings.items.required).toEqual([
      "title",
      "description",
      "citation",
    ]);
    expect(FINDINGS_SCHEMA.properties.findings.items.additionalProperties).toBe(
      false,
    );
    expect(FINDINGS_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("buildTriagePrompt", () => {
  test("contains the structured-output marker, the finding cap, and the citation format", () => {
    const prompt = buildTriagePrompt();
    expect(prompt).toContain("Return ONLY the findings as structured JSON.");
    expect(prompt).toContain(String(MAX_FINDINGS));
    expect(prompt).toContain("file:line");
  });
});

describe("parseFindingsEnvelope", () => {
  test("parses a successful envelope into a findings array", () => {
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      structured_output: {
        findings: [{ title: "t", description: "d", citation: "file.ts:1" }],
      },
    });

    expect(parseFindingsEnvelope(stdout)).toEqual({
      findings: [{ title: "t", description: "d", citation: "file.ts:1" }],
    });
  });

  test("truncates a findings array longer than MAX_FINDINGS, keeping the first entries", () => {
    const findings = Array.from({ length: 7 }, (_, i) => makeFinding(i));
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      structured_output: { findings },
    });

    const result = parseFindingsEnvelope(stdout);
    expect(result).toHaveProperty("findings");
    const resultFindings = (result as { findings: Finding[] }).findings;
    expect(resultFindings).toHaveLength(MAX_FINDINGS);
    expect(resultFindings).toEqual(findings.slice(0, MAX_FINDINGS));
  });

  test("returns an empty findings array when structured_output.findings is missing or not an array", () => {
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      structured_output: {},
    });

    expect(parseFindingsEnvelope(stdout)).toEqual({ findings: [] });
  });

  test("returns an error when stdout is not valid JSON", () => {
    const result = parseFindingsEnvelope("not json");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain(
      "did not return valid JSON",
    );
    expect(result).not.toHaveProperty("findings");
  });

  test("returns an error when the envelope reports is_error true", () => {
    const stdout = JSON.stringify({
      is_error: true,
      subtype: "error_max_turns",
      structured_output: { findings: [] },
    });

    const result = parseFindingsEnvelope(stdout);
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty("findings");
  });

  test("returns an error when structured_output is absent", () => {
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
    });

    const result = parseFindingsEnvelope(stdout);
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty("findings");
  });

  test("returns an empty findings array when structured_output is literally null", () => {
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      structured_output: null,
    });

    expect(() => parseFindingsEnvelope(stdout)).not.toThrow();
    expect(parseFindingsEnvelope(stdout)).toEqual({ findings: [] });
  });

  test("drops a finding entry whose field is not a string, rather than coercing it", () => {
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      structured_output: {
        findings: [
          { title: "t", description: 42, citation: "file.ts:1" },
          { title: "kept", description: "d", citation: "file.ts:2" },
        ],
      },
    });

    const result = parseFindingsEnvelope(stdout);
    expect(result).toEqual({
      findings: [{ title: "kept", description: "d", citation: "file.ts:2" }],
    });
  });

  test("collapses embedded newlines and pipes to spaces and trims title/description", () => {
    const dirty = "line one\nline two | with a pipe";
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      structured_output: {
        findings: [{ title: dirty, description: dirty, citation: "file.ts:1" }],
      },
    });

    const result = parseFindingsEnvelope(stdout);
    expect(result).toHaveProperty("findings");
    const finding = requireOnlyFinding(
      (result as { findings: Finding[] }).findings,
    );
    for (const field of [finding.title, finding.description]) {
      expect(field).not.toContain("\n");
      expect(field).not.toContain("\r");
      expect(field).not.toContain("|");
      expect(field).toBe(field.trim());
    }
  });

  test("truncates a description longer than MAX_FIELD_LENGTH with a trailing ellipsis", () => {
    const longDescription = "x".repeat(MAX_FIELD_LENGTH + 50);
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      structured_output: {
        findings: [
          { title: "t", description: longDescription, citation: "file.ts:1" },
        ],
      },
    });

    const result = parseFindingsEnvelope(stdout);
    expect(result).toHaveProperty("findings");
    const finding = requireOnlyFinding(
      (result as { findings: Finding[] }).findings,
    );
    expect(finding.description.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
    expect(finding.description.endsWith("…")).toBe(true);
  });

  test("truncates a citation longer than MAX_CITATION_LENGTH with a trailing ellipsis", () => {
    const longCitation = "x".repeat(MAX_CITATION_LENGTH + 50);
    const stdout = JSON.stringify({
      is_error: false,
      subtype: "success",
      structured_output: {
        findings: [{ title: "t", description: "d", citation: longCitation }],
      },
    });

    const result = parseFindingsEnvelope(stdout);
    expect(result).toHaveProperty("findings");
    const finding = requireOnlyFinding(
      (result as { findings: Finding[] }).findings,
    );
    expect(finding.citation.length).toBeLessThanOrEqual(MAX_CITATION_LENGTH);
    expect(finding.citation.endsWith("…")).toBe(true);
  });
});

describe("formatFindingsSection", () => {
  test("formats a dated heading and one bullet per finding with an em-dash and backtick-wrapped citation", () => {
    const section = formatFindingsSection("2026-08-31", [
      { title: "A title", description: "A description", citation: "a.ts:1" },
    ]);
    expect(section).toContain("### Automated scan — 2026-08-31");
    expect(section).toContain("- **A title** — A description (`a.ts:1`)");
  });

  test("does not throw and omits bullet lines for an empty findings array", () => {
    let section = "";
    expect(() => {
      section = formatFindingsSection("2026-08-31", []);
    }).not.toThrow();
    expect(section).toContain("### Automated scan — 2026-08-31");
    expect(section).not.toContain("- **");
  });
});

describe("insertFindingsSection", () => {
  test("creates the heading, intro paragraph, and appended subsection when absent, preserving original content", () => {
    const original = "# Implementation\n\nSome existing content.\n";
    const subsection = "### Automated scan — 2026-08-31\n\n- finding";
    const result = insertFindingsSection(original, subsection);

    expect(
      result.startsWith("# Implementation\n\nSome existing content."),
    ).toBe(true);
    expect(result).toContain(SECTION_HEADING);
    expect(result).toContain("Not filed work");
    expect(result).toContain(subsection);
    const headingIndex = result.indexOf(SECTION_HEADING);
    const originalIndex = result.indexOf("Some existing content.");
    expect(headingIndex).toBeGreaterThan(originalIndex);
  });

  test("does not throw and always ends with exactly one trailing newline (no double-blank-line pile-up)", () => {
    const original = "# Implementation\n\nSome existing content.\n";
    const subsection = "### Automated scan — 2026-08-31\n\n- finding";
    const result = insertFindingsSection(original, subsection);
    expect(result).not.toMatch(/\n\n\n/);
    expect(result).toMatch(/[^\n]\n$/);
  });

  test("appends only the new subsection, keeping the original heading occurrence exactly once, when the heading already exists", () => {
    const original = [
      "# Implementation",
      "",
      "Some existing content.",
      "",
      SECTION_HEADING,
      "",
      "Unreviewed candidates from the weekly automated scan.",
      "Not filed work — no Status column.",
      "",
      "### Automated scan — 2026-08-24",
      "",
      "- **Old finding** — Old description (`old.ts:1`)",
      "",
    ].join("\n");
    const subsection =
      "### Automated scan — 2026-08-31\n\n- **New finding** — New description (`new.ts:2`)";

    const result = insertFindingsSection(original, subsection);

    const headingOccurrences = result.split(SECTION_HEADING).length - 1;
    expect(headingOccurrences).toBe(1);
    expect(result).toContain("Some existing content.");
    expect(result).toContain("### Automated scan — 2026-08-24");
    expect(result).toContain(subsection);
    expect(result.indexOf(subsection)).toBeGreaterThan(
      result.indexOf("### Automated scan — 2026-08-24"),
    );
  });

  test("does not throw and always ends with exactly one trailing newline when the heading already exists", () => {
    const original = `# Implementation\n\n${SECTION_HEADING}\n\nExisting intro.\n`;
    const subsection = "### Automated scan — 2026-08-31\n\n- finding";
    let result = "";
    expect(() => {
      result = insertFindingsSection(original, subsection);
    }).not.toThrow();
    expect(result).not.toMatch(/\n\n\n/);
    expect(result).toMatch(/[^\n]\n$/);
  });
});
