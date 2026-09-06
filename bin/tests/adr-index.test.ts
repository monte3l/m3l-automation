import { describe, expect, test } from "vitest";
import {
  BEGIN_MARKER,
  END_MARKER,
  RECIPROCAL_VERB,
  VALID_RELATION_VERBS,
  buildAdrIndexTable,
  buildGeneratedBlock,
  checkAdrIndex,
  findGeneratedBlockRange,
  parseAdrEntry,
  parseRelations,
} from "../lib/adr-index.mjs";

// ---------------------------------------------------------------------------
// parseRelations
// ---------------------------------------------------------------------------

describe("parseRelations", () => {
  test("returns [] for undefined input", () => {
    // The JSDoc types relationsText as `string`, but the implementation
    // defensively tolerates `undefined` — the real call site in
    // parseAdrEntry passes `relationsMatch?.[1]?.trim() ?? ""`, so this
    // exercises the defensive branch directly.
    expect(parseRelations(undefined as unknown as string)).toEqual([]);
  });

  test("returns [] for empty-string input", () => {
    expect(parseRelations("")).toEqual([]);
  });

  test("parses a single entry with no clauses", () => {
    expect(parseRelations("amends: 0030")).toEqual([
      { verb: "amends", number: 30, clauses: undefined },
    ]);
  });

  test("parses a single entry with clauses, preserving internal punctuation intact", () => {
    const result = parseRelations(
      "partially-superseded-by: 0057 (clauses: the publish pipeline; §Decision 2)",
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      verb: "partially-superseded-by",
      number: 57,
      clauses: "the publish pipeline; §Decision 2",
    });
  });

  test("parses multiple comma-separated entries in order", () => {
    const result = parseRelations("amends: 0087, fires-trigger-of: 0056");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      verb: "amends",
      number: 87,
      clauses: undefined,
    });
    expect(result[1]).toEqual({
      verb: "fires-trigger-of",
      number: 56,
      clauses: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// parseAdrEntry
// ---------------------------------------------------------------------------

describe("parseAdrEntry", () => {
  test("returns null for a filename that doesn't match the ADR naming convention", () => {
    expect(parseAdrEntry("README.md", "# ADR index\n")).toBeNull();
    expect(parseAdrEntry("template.md", "# Template\n")).toBeNull();
  });

  test("parses a Relations line in the header block into an entry's relations array", () => {
    const content = `# 0032. Centralized project-state and roadmap visibility hub

- **Status:** Accepted
- **Relations:** amends: 0013
- **Date:** 2026-07-18
- **Deciders:** Enrico Lionello

## Context

Tracks project state.
`;
    const result = parseAdrEntry(
      "0032-project-management-visibility-hub.md",
      content,
    );
    expect(result).not.toBeNull();
    expect(result?.relations).toEqual([
      { verb: "amends", number: 13, clauses: undefined },
    ]);
  });

  // Regression test: headerBlock() scopes the Relations search to before the
  // first "## " heading. A whole-document regex would also match an
  // illustrative "- **Relations:** ..." example shown inside the body (as
  // ADR-0094's own file does, in its "### The schema" section), falsely
  // reporting a relation the file does not actually declare.
  test("[KNOWN FIX] ignores an illustrative Relations example inside the body, after the first heading", () => {
    const content = `# 0094. ADR relations and lifecycle schema

- **Status:** Accepted
- **Date:** 2026-09-01
- **Deciders:** Enrico Lionello

## Context

Establishes a machine-readable Relations schema.

### The schema

An entry looks like this:

\`\`\`
- **Relations:** partially-superseded-by: 0057 (clauses: the publish pipeline)
\`\`\`

This is illustrative only, not a real relation declared by this file.
`;
    const result = parseAdrEntry("0094-adr-relations-schema.md", content);
    expect(result).not.toBeNull();
    expect(result?.relations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildAdrIndexTable
// ---------------------------------------------------------------------------

describe("buildAdrIndexTable", () => {
  const entries = [
    {
      number: 11,
      filename: "0011-release-and-publishing-workflow.md",
      title: "Release and publishing workflow",
      statusText: "Superseded by [ADR-0020](0020-drop-release-automation.md)",
      statusKind: "Superseded",
      relations: [],
      date: "2026-06-29",
    },
    {
      number: 20,
      filename: "0020-drop-release-automation.md",
      title: "Drop release automation",
      statusText: "Accepted",
      statusKind: "Accepted",
      relations: [],
      date: "2026-07-06",
    },
    {
      number: 94,
      filename: "0094-adr-relations-schema.md",
      title: "ADR relations and lifecycle schema",
      statusText: "Accepted",
      statusKind: "Accepted",
      relations: [],
      date: "2026-09-01",
    },
  ];

  test("emits a GFM table header row and divider", () => {
    const table = buildAdrIndexTable(entries);
    const lines = table.split("\n");
    expect(lines[0]).toMatch(/^\| ADR/);
    expect(lines[1]).toMatch(/^\|[\s-]+\|[\s-]+\|[\s-]+\|$/);
  });

  test("includes each entry's zero-padded number, title link, and status text", () => {
    const table = buildAdrIndexTable(entries);
    expect(table).toContain("0011");
    expect(table).toContain(
      "[Release and publishing workflow](./0011-release-and-publishing-workflow.md)",
    );
    expect(table).toContain(
      "Superseded by [ADR-0020](0020-drop-release-automation.md)",
    );
    expect(table).toContain("0020");
    expect(table).toContain(
      "[Drop release automation](./0020-drop-release-automation.md)",
    );
    expect(table).toContain("0094");
    expect(table).toContain(
      "[ADR relations and lifecycle schema](./0094-adr-relations-schema.md)",
    );
  });
});

// ---------------------------------------------------------------------------
// buildGeneratedBlock / findGeneratedBlockRange
// ---------------------------------------------------------------------------

describe("buildGeneratedBlock", () => {
  test("output starts with BEGIN_MARKER and ends with END_MARKER", () => {
    const entries = [
      {
        number: 20,
        filename: "0020-drop-release-automation.md",
        title: "Drop release automation",
        statusText: "Accepted",
        statusKind: "Accepted",
        relations: [],
        date: "2026-07-06",
      },
    ];
    const block = buildGeneratedBlock(entries);
    expect(block.startsWith(BEGIN_MARKER)).toBe(true);
    expect(block.endsWith(END_MARKER)).toBe(true);
  });
});

describe("findGeneratedBlockRange", () => {
  test("finds a real standalone marker pair and round-trips the sliced content", () => {
    const block = [BEGIN_MARKER, "some table content", END_MARKER].join("\n");
    const content = `# ADR index\n\n## Index\n\n${block}\n\nMore text after.\n`;
    const range = findGeneratedBlockRange(content);
    expect(range).not.toBeNull();
    expect(content.slice(range?.start, range?.end)).toBe(block);
  });

  test("returns null when the markers are absent entirely", () => {
    expect(findGeneratedBlockRange("# ADR index\n\nNo markers here.\n")).toBe(
      null,
    );
  });

  // Regression test: the markers must be matched as whole lines, not as a
  // bare substring search — an inline prose quotation of the marker text
  // (as docs/adr/README.md's own Conventions section does) must not match.
  test("[KNOWN FIX] does not match a marker's text quoted inline inside a prose sentence", () => {
    const content =
      "See the `<!-- BEGIN GENERATED ADR INDEX -->` marker for details.\n";
    expect(findGeneratedBlockRange(content)).toBe(null);
  });

  test("[KNOWN FIX] finds the real standalone pair, not an inline prose quotation elsewhere in the same content", () => {
    const block = [BEGIN_MARKER, "real table content", END_MARKER].join("\n");
    const content =
      "See the `<!-- BEGIN GENERATED ADR INDEX -->` marker for details.\n\n" +
      `${block}\n`;
    const range = findGeneratedBlockRange(content);
    expect(range).not.toBeNull();
    expect(content.slice(range?.start, range?.end)).toBe(block);
  });
});

// ---------------------------------------------------------------------------
// checkAdrIndex
// ---------------------------------------------------------------------------

describe("checkAdrIndex", () => {
  test("returns [] for a fully consistent, correctly reciprocated corpus", () => {
    const entries = [
      {
        number: 20,
        filename: "0020-drop-release-automation.md",
        title: "Drop release automation",
        statusText: "Accepted",
        statusKind: "Accepted",
        relations: [{ verb: "supersedes", number: 11, clauses: undefined }],
        date: "2026-07-06",
      },
      {
        number: 11,
        filename: "0011-release-and-publishing-workflow.md",
        title: "Release and publishing workflow",
        statusText: "Superseded",
        statusKind: "Superseded",
        relations: [{ verb: "superseded-by", number: 20, clauses: undefined }],
        date: "2026-06-29",
      },
    ];
    expect(checkAdrIndex(entries)).toEqual([]);
  });

  test("flags an Unknown statusKind as unknown-status", () => {
    const entries = [
      {
        number: 99,
        filename: "0099-mystery.md",
        title: "Mystery",
        statusText: "Some free-form text",
        statusKind: "Unknown",
        relations: [],
        date: undefined,
      },
    ];
    const findings = checkAdrIndex(entries);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("unknown-status");
  });

  test("flags a relation verb not in VALID_RELATION_VERBS as unknown-relation-verb", () => {
    expect(VALID_RELATION_VERBS.has("deprecates")).toBe(false);
    const entries = [
      {
        number: 20,
        filename: "0020-a.md",
        title: "A",
        statusText: "Accepted",
        statusKind: "Accepted",
        relations: [{ verb: "deprecates", number: 11, clauses: undefined }],
        date: undefined,
      },
      {
        number: 11,
        filename: "0011-b.md",
        title: "B",
        statusText: "Accepted",
        statusKind: "Accepted",
        relations: [],
        date: undefined,
      },
    ];
    const findings = checkAdrIndex(entries);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("unknown-relation-verb");
  });

  test("flags a relation pointing at a non-existent ADR number as dangling-relation-target", () => {
    const entries = [
      {
        number: 20,
        filename: "0020-a.md",
        title: "A",
        statusText: "Accepted",
        statusKind: "Accepted",
        relations: [{ verb: "amends", number: 9999, clauses: undefined }],
        date: undefined,
      },
    ];
    const findings = checkAdrIndex(entries);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("dangling-relation-target");
  });

  test("flags a missing back-reference as non-reciprocal-relation", () => {
    const entries = [
      {
        number: 20,
        filename: "0020-a.md",
        title: "A",
        statusText: "Accepted",
        statusKind: "Accepted",
        relations: [{ verb: "superseded-by", number: 11, clauses: undefined }],
        date: undefined,
      },
      {
        number: 11,
        filename: "0011-b.md",
        title: "B",
        statusText: "Superseded",
        statusKind: "Superseded",
        relations: [],
        date: undefined,
      },
    ];
    const findings = checkAdrIndex(entries);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("non-reciprocal-relation");
  });

  test("flags a partial-supersession relation with no clause list as missing-clause-list", () => {
    const entries = [
      {
        number: 20,
        filename: "0020-a.md",
        title: "A",
        statusText: "Partially-superseded",
        statusKind: "Partially-superseded",
        relations: [
          {
            verb: "partially-superseded-by",
            number: 11,
            clauses: undefined,
          },
        ],
        date: undefined,
      },
      {
        number: 11,
        filename: "0011-b.md",
        title: "B",
        statusText: "Accepted",
        statusKind: "Accepted",
        relations: [
          { verb: "partially-supersedes", number: 20, clauses: undefined },
        ],
        date: undefined,
      },
    ];
    const findings = checkAdrIndex(entries);
    expect(findings.map((f) => f.kind)).toContain("missing-clause-list");
  });

  test("flags two entries sharing the same number as duplicate-number", () => {
    const entries = [
      {
        number: 20,
        filename: "0020-a.md",
        title: "A",
        statusText: "Accepted",
        statusKind: "Accepted",
        relations: [],
        date: undefined,
      },
      {
        number: 20,
        filename: "0020-b.md",
        title: "B",
        statusText: "Accepted",
        statusKind: "Accepted",
        relations: [],
        date: undefined,
      },
    ];
    const findings = checkAdrIndex(entries);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("duplicate-number");
  });

  // Regression test: RECIPROCAL_VERB deliberately has no key for
  // "re-affirmed-by" — a re-affirmation is intentionally one-directional and
  // must never be flagged as non-reciprocal even when the target ADR has no
  // relation pointing back at all.
  test("[KNOWN FIX] does not flag a re-affirmed-by relation as non-reciprocal, even with no back-reference", () => {
    expect(Object.hasOwn(RECIPROCAL_VERB, "re-affirmed-by")).toBe(false);
    const entries = [
      {
        number: 23,
        filename: "0023-a.md",
        title: "A",
        statusText: "Accepted",
        statusKind: "Accepted",
        relations: [{ verb: "re-affirmed-by", number: 12, clauses: undefined }],
        date: undefined,
      },
      {
        number: 12,
        filename: "0012-b.md",
        title: "B",
        statusText: "Accepted",
        statusKind: "Accepted",
        relations: [],
        date: undefined,
      },
    ];
    expect(checkAdrIndex(entries)).toEqual([]);
  });
});
