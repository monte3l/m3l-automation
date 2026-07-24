import { describe, expect, test } from "vitest";
import {
  REPO_BLOB_BASE,
  blobUrl,
  buildCorpusSections,
  classifyStatus,
  columnIndex,
  escapeHtml,
  extractImplementation,
  extractImplementationStatus,
  extractRoadmap,
  parseAdr,
  parseDatedDoc,
  parseMarkdownTable,
  renderCellMarkdown,
  renderHubPage,
  renderStatusBadge,
  renderTrackerTable,
} from "../lib/project-hub.mjs";

// ---------------------------------------------------------------------------
// Trimmed fixtures, copied verbatim (headers/shapes) from the real docs so
// tests exercise realistic markdown, but read at write time only — never at
// test runtime.
// ---------------------------------------------------------------------------

const ROADMAP_FIXTURE = `# Roadmap — m3l-automation

## Priority 0 — Library hardening (do before more scripts)

| Item   | What                                                                                            | Status | Why now / Notes                             |
| ------ | ----------------------------------------------------------------------------------------------- | ------ | -------------------------------------------- |
| **F8** | \`M3LScript\` preset seam — presets can't drive a run's config (config loader wires only CLI+env) | Done   | **PR:** #106. wired at precedence level 6    |
| **F6** | Importer surfaces its skip count                                                                | Done   | **PR:** #103. now returns \`{ processed, skipped }\` |
| **F4** | \`M3LScript.paths\` getter (paths seam)                                                           | Done   | **PR:** #104. json-etl now consumes it       |

## Priority 1 — Consumer fleet

| Wave   | Scripts             | Status  | Depends on           |
| ------ | -------------------- | ------- | ---------------------- |
| **W1** | \`json-etl\`          | Done    | **PR:** #99. W0        |
| **W2** | \`dynamodb-crud\`     | Done    | **PR:** #128. W0       |
| **W3** | \`ecs-ops\`           | Blocked | getter reality: raw    |

## Priority 2 — Gated / deferred

| Item                                            | Status   | Unblock condition                                                   |
| ------------------------------------------------ | -------- | ---------------------------------------------------------------------- |
| **D4** SSM config provider                        | Deferred | a 2nd script hand-rolling SSM config fetch                             |
| **F7 / \`onUnknownFormat\`** tolerant per-record   | Deferred | a consumer needing per-record tolerance on irregular non-JSONL input   |

## Governance follow-ups (ADR-0028 / ADR-0029)

| Item   | What                                | Status   | Notes                                                          |
| ------ | ------------------------------------ | -------- | ------------------------------------------------------------- |
| **T1** | Rename script \`dynamo-crud\`         | Done     | **PR:** #135. landed on \`refactor/rename-dynamo-crud\`          |
| **T8** | Getter-reality pre-flight check       | Deferred | backlog only                                                   |
`;

const ROADMAP_MISSING_PRIORITY1_FIXTURE = `# Roadmap — m3l-automation

## Priority 0 — Library hardening (do before more scripts)

| Item   | What          | Status | Why now / Notes |
| ------ | -------------- | ------ | ------------------ |
| **F8** | preset seam    | done   | wired               |

## Priority 2 — Gated / deferred

| Item             | Unblock condition                           |
| ----------------- | ---------------------------------------------- |
| **D4** SSM config | a 2nd script hand-rolling SSM config fetch      |

## Governance follow-ups (ADR-0028 / ADR-0029)

| Item   | What        | Notes         |
| ------ | ------------ | -------------- |
| **T1** | Rename       | **done**       |
`;

const IMPLEMENTATION_FIXTURE = `# Implementation backlog — m3l-automation

## Library friction (F-series)

| ID     | Priority | Status   | Title & change                                                                                                    | Source / call-site |
| ------ | -------- | -------- | -------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **F8** | P0       | Done     | Preset seam: \`M3LScriptOptions.preset\` is wired at precedence level 6                                            | **PR:** #106. json-etl log F8 |
| **F7** | P2       | Deferred | Opt-in \`onUnknownFormat: "throw" \\| "skip"\` tolerant per-record import on \`M3LJSONListImporter\`                  | json-etl log F7       |

## AWS getter reality

| Provider getter | AWS service (ADR-0028 name) | Status | Wrapper submodule       | Consuming script(s)  | ADR / precedent                 |
| ----------------- | ------------------------------ | ------ | -------------------------- | ----------------------- | ---------------------------------- |
| \`s3\`             | S3                             | Done   | \`aws/s3\`                  | \`s3-objects\` (done)     | ADR-0033                           |
| \`ecs\`            | ECS                             | To Do  | — (raw, no wrapper yet)    | pending: \`ecs-ops\`      | ADR-0027 boundary rule applies     |

## Gated library modules & deferred decisions (P2)

| ID                                                            | Status   | Unblock condition                                                       |
| ----------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| **D4** SSM config provider                                        | Deferred | a 2nd script hand-rolling SSM config fetch                                  |
| **F7 / \`onUnknownFormat\`** tolerant per-record array import      | Deferred | a consumer needing per-record tolerance on irregular non-JSONL input        |
`;

const IMPLEMENTATION_STATUS_FIXTURE = `# Implementation status — m3l-common vs. documented spec

<!-- BEGIN GENERATED IMPLEMENTED-LIST -->

The barrels are wired; \`errors\`, \`events\`, \`security\` are implemented and reviewed (30 of 31 submodules). See the table below for per-submodule status.

<!-- END GENERATED IMPLEMENTED-LIST -->

## Barrels & infrastructure

| Item                                       | Status | Notes                                        |
| -------------------------------------------- | ------ | ----------------------------------------------- |
| \`src/index.ts\` (re-exports Core + AWS)      | ✅     | wired; re-exports the Core + AWS namespaces     |
| \`src/core/index.ts\`                         | ✅     | wired; all 19 Core submodules surfaced here     |

## Core submodules (\`docs/reference/core/\`)

| Submodule | Spec               | Planned | Symbols (≈) | Status | Tests | Reviewed | Notes |
| ---------- | -------------------- | ------- | ------------- | ------ | ----- | -------- | ------ |
| errors     | \`core/errors.md\`   | ✅      | 24            | ✅     | ✅    | ✅       | done   |
| events     | \`core/events.md\`   | ✅      | 3             | ✅     | ✅    | ✅       | none   |

## AWS submodules (\`docs/reference/aws/\`)

| Submodule | Spec                 | Planned | Symbols (≈) | Status | Tests | Reviewed | Notes |
| ---------- | ---------------------- | ------- | ------------- | ------ | ----- | -------- | ------ |
| models     | \`aws/models.md\`     | ✅      | 13            | ✅     | ✅    | ✅       | done   |
| dynamodb   | \`aws/dynamodb.md\`   | ❌      | 10            | ✅     | ✅    | ✅       | done   |
`;

const ADR_ACCEPTED_PLAIN_NAME = "0020-drop-release-automation.md";
const ADR_ACCEPTED_PLAIN_CONTENT = `# 0020. Drop release automation

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Enrico Lionello

## Context and problem statement

The package is internal and not published to npm.
`;

const ADR_ACCEPTED_ANNOTATED_NAME = "0032-project-management-visibility-hub.md";
const ADR_ACCEPTED_ANNOTATED_CONTENT = `# 0032. Centralized project-state and roadmap visibility hub

- **Status:** Accepted (2026-07-18) — resolves the earlier undecided stance in favour of a comprehensive GitHub-native hub
- **Date:** 2026-07-17
- **Deciders:** Enrico Lionello (maintainer); Claude (research)

## Context and problem statement

\`m3l-automation\` tracks project state across a markdown-driven, git-native system.
`;

const ADR_SUPERSEDED_NAME = "0011-release-and-publishing-workflow.md";
const ADR_SUPERSEDED_CONTENT = `# 0011. Release and publishing workflow

- **Status:** Superseded by [ADR-0020](0020-drop-release-automation.md)
- **Date:** 2026-06-29
- **Deciders:** Enrico Lionello

## Context

Publishing workflow superseded.
`;

const ADR_PROPOSED_NAME = "0031-relational-and-document-data-engine-access.md";
const ADR_PROPOSED_CONTENT = `# 0031. Relational and document data engine access

- **Status:** Proposed
- **Date:** 2026-07-09
- **Deciders:** Enrico Lionello

## Context

Aurora PostgreSQL / DocumentDB access.
`;

const ADR_MISSING_STATUS_NAME = "0099-test-adr-no-status.md";
const ADR_MISSING_STATUS_CONTENT = `# 0099. Test ADR with no status line

- **Date:** 2026-01-01
- **Deciders:** Enrico Lionello

## Context

No status line here.
`;

const DATED_DOC_NAME = "2026-07-15-fleet-governance-reconciliation.md";
const DATED_DOC_CONTENT = `# Fleet governance reconciliation

Filed by the 2026-07-15 fleet-governance audit.
`;

const UNDATED_DOC_NAME = "m3l-common-implementation.md";
const UNDATED_DOC_CONTENT = `# m3l-common implementation status

Single source of truth.
`;

const MISSING_HEADING_DOC_NAME = "2026-07-20-no-heading-doc.md";
const MISSING_HEADING_DOC_CONTENT = `Some content without a top-level heading.
`;

// ---------------------------------------------------------------------------
// REPO_BLOB_BASE / blobUrl
// ---------------------------------------------------------------------------

describe("REPO_BLOB_BASE", () => {
  test("is the fixed repo blob root", () => {
    expect(REPO_BLOB_BASE).toBe(
      "https://github.com/monte3l/m3l-automation/blob/main/",
    );
  });
});

describe("blobUrl", () => {
  test("prefixes a plain path with the repo blob base, unchanged apart from the base", () => {
    expect(blobUrl("docs/ROADMAP.md")).toBe(
      "https://github.com/monte3l/m3l-automation/blob/main/docs/ROADMAP.md",
    );
  });

  test("encodes a segment containing a space", () => {
    expect(blobUrl("docs/plans/archive/fleet governance.md")).toBe(
      "https://github.com/monte3l/m3l-automation/blob/main/docs/plans/archive/fleet%20governance.md",
    );
  });

  test("preserves the '/' path separators while encoding each segment", () => {
    const url = blobUrl("docs/adr/0032-project-management-visibility-hub.md");
    expect(url.split("/main/")[1]).toBe(
      "docs/adr/0032-project-management-visibility-hub.md",
    );
  });
});

// ---------------------------------------------------------------------------
// parseMarkdownTable
// ---------------------------------------------------------------------------

describe("parseMarkdownTable", () => {
  test("parses a prettier-padded table, trimming every cell", () => {
    const result = parseMarkdownTable(
      ROADMAP_FIXTURE,
      /^## Priority 0 — Library hardening/m,
    );
    expect(result).not.toBeNull();
    expect(result?.header).toEqual([
      "Item",
      "What",
      "Status",
      "Why now / Notes",
    ]);
    expect(result?.rows).toHaveLength(3);
    expect(result?.rows[0]?.[0]).toBe("**F8**");
  });

  test("keeps a literal pipe from an escaped-pipe cell (F7 row shape)", () => {
    const result = parseMarkdownTable(
      IMPLEMENTATION_FIXTURE,
      /^## Library friction \(F-series\)/m,
    );
    expect(result).not.toBeNull();
    const f7Row = result?.rows.find((row) => row[0] === "**F7**");
    expect(f7Row).toBeDefined();
    expect(f7Row?.[3]).toContain("|");
    expect(f7Row?.[3]).toContain('"throw" | "skip"');
  });

  test("skips the divider row", () => {
    const result = parseMarkdownTable(
      ROADMAP_FIXTURE,
      /^## Priority 0 — Library hardening/m,
    );
    for (const row of result?.rows ?? []) {
      expect(row.every((cell) => /^:?-+:?$/.test(cell))).toBe(false);
    }
  });

  test("returns null when the heading is absent", () => {
    const result = parseMarkdownTable(ROADMAP_FIXTURE, /^## Nonexistent$/m);
    expect(result).toBeNull();
  });

  test("stops at the next heading, parsing only the first table", () => {
    const result = parseMarkdownTable(
      ROADMAP_FIXTURE,
      /^## Priority 0 — Library hardening/m,
    );
    // The Priority 0 table has exactly 3 data rows; the Priority 1 table's
    // rows must not have leaked in.
    expect(result?.rows).toHaveLength(3);
    expect(result?.rows.some((row) => row[0] === "**W1**")).toBe(false);
  });

  test("returns null when no table follows the heading before the next heading", () => {
    const content = `## Some Heading

No table here, just prose.

## Next Heading

| A | B |
| - | - |
| 1 | 2 |
`;
    const result = parseMarkdownTable(content, /^## Some Heading$/m);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// columnIndex
// ---------------------------------------------------------------------------

describe("columnIndex", () => {
  const header = ["ID", "Priority", "Status", "Title & change"];

  test("finds the exact match", () => {
    expect(columnIndex(header, "Status")).toBe(2);
  });

  test("matches case-insensitively", () => {
    expect(columnIndex(header, "status")).toBe(2);
    expect(columnIndex(header, "PRIORITY")).toBe(1);
  });

  test("returns -1 when the header name is absent", () => {
    expect(columnIndex(header, "Owner")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// classifyStatus
// ---------------------------------------------------------------------------

describe("classifyStatus", () => {
  test.each([
    ["Done", "done"],
    ["done", "done"],
    ["**Done**", "done"],
    ["To Do", "todo"],
    ["todo", "todo"],
    ["In Progress", "in-progress"],
    ["in-progress", "in-progress"],
    ["Deferred", "deferred"],
    ["deferred — backlog only", "deferred"],
    ["Blocked", "blocked"],
    ["Rejected", "rejected"],
    ["✅", "done"],
    ["❌", "todo"],
    ["🧪", "in-progress"],
    ["🟢", "in-progress"],
    ["something else entirely", "todo"],
    ["", "todo"],
  ])("classifies %j as %s", (cell, expected) => {
    expect(classifyStatus(cell)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// parseAdr
// ---------------------------------------------------------------------------

describe("parseAdr", () => {
  test("parses a plain Accepted ADR", () => {
    const result = parseAdr(
      ADR_ACCEPTED_PLAIN_NAME,
      ADR_ACCEPTED_PLAIN_CONTENT,
    );
    expect(result).not.toBeNull();
    expect(result?.number).toBe(20);
    expect(result?.title).toBe("Drop release automation");
    expect(result?.statusKind).toBe("Accepted");
    expect(result?.statusText).toBe("Accepted");
    expect(result?.date).toBe("2026-07-06");
  });

  test("parses an annotated Accepted ADR, keeping the annotation in statusText", () => {
    const result = parseAdr(
      ADR_ACCEPTED_ANNOTATED_NAME,
      ADR_ACCEPTED_ANNOTATED_CONTENT,
    );
    expect(result).not.toBeNull();
    expect(result?.number).toBe(32);
    expect(result?.title).toBe(
      "Centralized project-state and roadmap visibility hub",
    );
    expect(result?.statusKind).toBe("Accepted");
    expect(result?.statusText).toContain(
      "resolves the earlier undecided stance",
    );
    expect(result?.date).toBe("2026-07-17");
  });

  test("parses a Superseded-with-link ADR, keeping the link text in statusText", () => {
    const result = parseAdr(ADR_SUPERSEDED_NAME, ADR_SUPERSEDED_CONTENT);
    expect(result).not.toBeNull();
    expect(result?.number).toBe(11);
    expect(result?.statusKind).toBe("Superseded");
    expect(result?.statusText).toBe(
      "Superseded by [ADR-0020](0020-drop-release-automation.md)",
    );
  });

  test("parses a Proposed ADR", () => {
    const result = parseAdr(ADR_PROPOSED_NAME, ADR_PROPOSED_CONTENT);
    expect(result).not.toBeNull();
    expect(result?.number).toBe(31);
    expect(result?.statusKind).toBe("Proposed");
  });

  test("degrades to Unknown when the Status line is missing, without throwing", () => {
    let result;
    expect(() => {
      result = parseAdr(ADR_MISSING_STATUS_NAME, ADR_MISSING_STATUS_CONTENT);
    }).not.toThrow();
    expect(result).not.toBeNull();
    expect(result?.statusKind).toBe("Unknown");
  });

  test("returns null for a filename that doesn't match the NNNN-slug.md pattern", () => {
    expect(parseAdr("README.md", "# ADR index\n")).toBeNull();
    expect(parseAdr("template.md", "# Template\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseDatedDoc
// ---------------------------------------------------------------------------

describe("parseDatedDoc", () => {
  test("extracts date, slug, and title from a dated filename", () => {
    const result = parseDatedDoc(DATED_DOC_NAME, DATED_DOC_CONTENT);
    expect(result.date).toBe("2026-07-15");
    expect(result.slug).toBe("fleet-governance-reconciliation");
    expect(result.title).toBe("Fleet governance reconciliation");
  });

  test("leaves date undefined for an undated filename, slug is the basename", () => {
    const result = parseDatedDoc(UNDATED_DOC_NAME, UNDATED_DOC_CONTENT);
    expect(result.date).toBeUndefined();
    expect(result.slug).toBe("m3l-common-implementation");
    expect(result.title).toBe("m3l-common implementation status");
  });

  test("falls back the title to the slug when there is no top-level heading", () => {
    const result = parseDatedDoc(
      MISSING_HEADING_DOC_NAME,
      MISSING_HEADING_DOC_CONTENT,
    );
    expect(result.date).toBe("2026-07-20");
    expect(result.slug).toBe("no-heading-doc");
    expect(result.title).toBe("no-heading-doc");
  });
});

// ---------------------------------------------------------------------------
// extractRoadmap
// ---------------------------------------------------------------------------

describe("extractRoadmap", () => {
  test("parses all four sections with correct row counts", () => {
    const result = extractRoadmap(ROADMAP_FIXTURE);
    expect(result.priority0?.rows).toHaveLength(3);
    expect(result.priority1?.rows).toHaveLength(3);
    expect(result.priority2?.rows).toHaveLength(2);
    expect(result.governance?.rows).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  test("priority2 carries a Status column (3 columns)", () => {
    const result = extractRoadmap(ROADMAP_FIXTURE);
    expect(result.priority2?.header).toEqual([
      "Item",
      "Status",
      "Unblock condition",
    ]);
  });

  test("governance rows are present with their 4 columns", () => {
    const result = extractRoadmap(ROADMAP_FIXTURE);
    expect(result.governance?.header).toEqual([
      "Item",
      "What",
      "Status",
      "Notes",
    ]);
    expect(result.governance?.rows.some((row) => row[0] === "**T1**")).toBe(
      true,
    );
  });

  test("a missing '## Priority 1' section yields a descriptive error, no throw", () => {
    let result;
    expect(() => {
      result = extractRoadmap(ROADMAP_MISSING_PRIORITY1_FIXTURE);
    }).not.toThrow();
    expect(result?.errors.some((error) => /Priority 1/i.test(error))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// extractImplementation
// ---------------------------------------------------------------------------

describe("extractImplementation", () => {
  test("friction rows are accessible by columnIndex", () => {
    const result = extractImplementation(IMPLEMENTATION_FIXTURE);
    expect(result.friction).not.toBeNull();
    const header = result.friction?.header ?? [];
    const idIndex = columnIndex(header, "ID");
    const statusIndex = columnIndex(header, "Status");
    const titleIndex = columnIndex(header, "Title & change");
    const f7Row = result.friction?.rows.find(
      (row) => row[idIndex] === "**F7**",
    );
    expect(f7Row).toBeDefined();
    expect(f7Row?.[statusIndex]).toBe("Deferred");
    expect(f7Row?.[titleIndex]).toContain("|");
  });

  test("getterReality and gated row counts match the fixture", () => {
    const result = extractImplementation(IMPLEMENTATION_FIXTURE);
    expect(result.getterReality?.rows).toHaveLength(2);
    expect(result.gated?.rows).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractImplementationStatus
// ---------------------------------------------------------------------------

describe("extractImplementationStatus", () => {
  test("parses implemented/total from the '(30 of 31 submodules)' sentence", () => {
    const result = extractImplementationStatus(IMPLEMENTATION_STATUS_FIXTURE);
    expect(result.implemented).toBe(30);
    expect(result.total).toBe(31);
  });

  test("a core-table row's Status cell is accessible via columnIndex", () => {
    const result = extractImplementationStatus(IMPLEMENTATION_STATUS_FIXTURE);
    const header = result.core?.header ?? [];
    const statusIndex = columnIndex(header, "Status");
    const errorsRow = result.core?.rows.find((row) => row[0] === "errors");
    expect(errorsRow?.[statusIndex]).toBe("✅");
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  test("escapes all five special characters", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  test("escapes a compound string in order without double-escaping", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });
});

// ---------------------------------------------------------------------------
// renderCellMarkdown
// ---------------------------------------------------------------------------

describe("renderCellMarkdown", () => {
  test("escapes first, then converts markdown styling (real <strong>, escaped raw tags)", () => {
    const html = renderCellMarkdown("<b>**x**</b>", "docs");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&lt;/b&gt;");
    expect(html).toContain("<strong>x</strong>");
    expect(html).not.toContain("<b>");
  });

  test("converts bold and inline code", () => {
    expect(renderCellMarkdown("**bold**", "docs")).toContain(
      "<strong>bold</strong>",
    );
    expect(renderCellMarkdown("`code`", "docs")).toContain("<code>code</code>");
  });

  test("resolves a relative .md link against sourceDir into a blob URL", () => {
    const html = renderCellMarkdown("[roadmap](../ROADMAP.md)", "docs/plans");
    expect(html).toContain(
      'href="https://github.com/monte3l/m3l-automation/blob/main/docs/ROADMAP.md"',
    );
  });

  test("keeps the anchor on a resolved relative link", () => {
    const html = renderCellMarkdown(
      "[getter table](./IMPLEMENTATION.md#aws-getter-reality)",
      "docs/plans",
    );
    expect(html).toContain(
      'href="https://github.com/monte3l/m3l-automation/blob/main/docs/plans/IMPLEMENTATION.md#aws-getter-reality"',
    );
  });

  test("passes an absolute http(s) link target through unchanged", () => {
    const html = renderCellMarkdown(
      "[docs](https://example.com/path)",
      "docs/plans",
    );
    expect(html).toContain('href="https://example.com/path"');
  });
});

// ---------------------------------------------------------------------------
// renderStatusBadge
// ---------------------------------------------------------------------------

describe("renderStatusBadge", () => {
  test.each([
    ["done", "badge-done", "Done"],
    ["todo", "badge-todo", "To Do"],
    ["in-progress", "badge-in-progress", "In Progress"],
    ["deferred", "badge-deferred", "Deferred"],
    ["blocked", "badge-blocked", "Blocked"],
    ["rejected", "badge-rejected", "Rejected"],
  ])(
    "renders a <span> with a badge-%s class",
    (kind, expectedClass, expectedLabel) => {
      const html = renderStatusBadge(kind);
      expect(html).toMatch(/<span[^>]*class="[^"]*"/);
      expect(html).toContain(expectedClass);
      expect(html).toContain(expectedLabel);
    },
  );
});

// ---------------------------------------------------------------------------
// renderTrackerTable
// ---------------------------------------------------------------------------

describe("renderTrackerTable", () => {
  test("renders an id, caption, one badge per status row, and every cell", () => {
    const html = renderTrackerTable({
      id: "priority0",
      caption: "Priority 0",
      header: ["Item", "What", "Status"],
      rows: [
        ["F8", "preset seam", "Done"],
        ["F6", "skip count", "Deferred"],
      ],
      statusColumn: 2,
      sourceDir: "docs",
    });
    expect(html).toContain('id="priority0"');
    expect(html).toContain("Priority 0");
    expect(html).toContain("<table");
    expect(html).toContain("badge-done");
    expect(html).toContain("badge-deferred");
    expect(html).toContain("F8");
    expect(html).toContain("preset seam");
    expect(html).toContain("F6");
    expect(html).toContain("skip count");
  });

  test("renders the status cell as ONLY the badge — the raw cell text is dropped", () => {
    const html = renderTrackerTable({
      id: "priority0",
      caption: "Priority 0",
      header: ["Item", "Status"],
      rows: [["F8", "Done (#106) — extra detail"]],
      statusColumn: 1,
      sourceDir: "docs",
    });
    expect(html).toContain("badge-done");
    expect(html).not.toContain("#106");
    expect(html).not.toContain("extra detail");
  });
});

// ---------------------------------------------------------------------------
// renderHubPage
// ---------------------------------------------------------------------------

describe("renderHubPage", () => {
  const model = {
    generatedAt: "2026-07-22T00:00:00.000Z",
    commitSha: "abc1234",
    summary: { implemented: 30, total: 31 },
    roadmap: {
      priority0: {
        header: ["Item", "What", "Status"],
        rows: [["F8", "preset seam", "Done"]],
      },
      priority1: { header: ["Wave", "Scripts", "Status"], rows: [] },
      priority2: {
        header: ["Item", "Status", "Unblock condition"],
        rows: [],
      },
      governance: { header: ["Item", "What", "Status", "Notes"], rows: [] },
      errors: [],
    },
    backlog: {
      friction: {
        header: [
          "ID",
          "Priority",
          "Status",
          "Title & change",
          "Source / call-site",
        ],
        rows: [
          [
            "F7",
            "P2",
            "Deferred",
            "<script>alert(1)</script>",
            "json-etl log F7",
          ],
        ],
      },
      getterReality: { header: [], rows: [] },
      gated: { header: [], rows: [] },
      errors: [],
    },
    ledger: {
      implemented: 30,
      total: 31,
      barrels: { header: [], rows: [] },
      core: { header: [], rows: [] },
      aws: { header: [], rows: [] },
      errors: [],
    },
    corpus: {
      adrs: [],
      logs: [],
      archive: [],
      plans: [],
      reference: { core: [], aws: [], scripts: [] },
      readmes: [],
    },
  };

  test("emits an HTML document containing the injected commitSha and generatedAt", () => {
    const html = renderHubPage(model);
    expect(html).toMatch(/<!doctype html>|<html/i);
    expect(html).toContain(model.commitSha);
    expect(html).toContain(model.generatedAt);
  });

  test("contains the four top-level section ids", () => {
    const html = renderHubPage(model);
    expect(html).toContain('id="roadmap"');
    expect(html).toContain('id="backlog"');
    expect(html).toContain('id="ledger"');
    expect(html).toContain('id="corpus"');
  });

  test("shows a badge-done class when a done row exists", () => {
    const html = renderHubPage(model);
    expect(html).toContain("badge-done");
  });

  test("never emits a raw <script> tag sourced from cell text", () => {
    const html = renderHubPage(model);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("is idempotent: calling twice with the same model yields identical output", () => {
    const first = renderHubPage(model);
    const second = renderHubPage(model);
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// buildCorpusSections
// ---------------------------------------------------------------------------

describe("buildCorpusSections", () => {
  const adrFiles = [
    {
      name: ADR_ACCEPTED_ANNOTATED_NAME,
      content: ADR_ACCEPTED_ANNOTATED_CONTENT,
    },
    { name: ADR_ACCEPTED_PLAIN_NAME, content: ADR_ACCEPTED_PLAIN_CONTENT },
    { name: ADR_SUPERSEDED_NAME, content: ADR_SUPERSEDED_CONTENT },
  ];

  const logFiles = [
    { name: "2026-07-10-core-json.md", content: "# Core json work log\n" },
    {
      name: "2026-07-18-eventbridge-schedules.md",
      content: "# EventBridge schedules work log\n",
    },
    { name: "misc-untitled-notes.md", content: "# Misc notes\n" },
  ];

  const archiveFiles = [
    {
      name: "2026-07-06-post-1.0-deepen-first-roadmap.md",
      content: "# Deepen-first roadmap\n",
    },
    {
      name: "2026-07-15-fleet-governance-reconciliation.md",
      content: "# Fleet governance reconciliation\n",
    },
  ];

  const planFiles = [
    { name: "IMPLEMENTATION.md", content: "# Implementation backlog\n" },
  ];

  const catalog = [
    {
      namespace: "core",
      name: "analysis",
      status: "✅",
      docPath: "docs/reference/core/analysis.md",
      symbols: ["M3LThresholdEvaluator"],
    },
    {
      namespace: "core",
      name: "config",
      status: "✅",
      docPath: "docs/reference/core/config.md",
      symbols: ["M3LConfig"],
    },
    {
      namespace: "aws",
      name: "s3",
      status: "✅",
      docPath: "docs/reference/aws/s3.md",
      symbols: ["listObjects"],
    },
  ];

  const scriptPages = ["docs/reference/scripts/json-etl.md"];
  const readmePaths = ["README.md", "packages/m3l-common/README.md"];

  test("sorts ADRs by number descending", () => {
    const result = buildCorpusSections({
      adrFiles,
      logFiles: [],
      archiveFiles: [],
      planFiles: [],
      catalog: [],
      scriptPages: [],
      readmePaths: [],
    });
    expect(result.adrs.map((adr) => adr.number)).toEqual([32, 20, 11]);
  });

  test("sorts logs/archive by date descending, with undated entries last", () => {
    const result = buildCorpusSections({
      adrFiles: [],
      logFiles,
      archiveFiles,
      planFiles: [],
      catalog: [],
      scriptPages: [],
      readmePaths: [],
    });
    expect(result.logs.map((log) => log.date)).toEqual([
      "2026-07-18",
      "2026-07-10",
      undefined,
    ]);
    expect(result.archive.map((entry) => entry.date)).toEqual([
      "2026-07-15",
      "2026-07-06",
    ]);
  });

  test("groups reference entries by namespace (core vs aws)", () => {
    const result = buildCorpusSections({
      adrFiles: [],
      logFiles: [],
      archiveFiles: [],
      planFiles: [],
      catalog,
      scriptPages: [],
      readmePaths: [],
    });
    const core = result.reference.core as { name: string }[];
    const aws = result.reference.aws as { name: string }[];
    expect(core.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["analysis", "config"]),
    );
    expect(aws.map((entry) => entry.name)).toEqual(["s3"]);
  });

  test("every ADR/reference/readme entry carries an href built via blobUrl", () => {
    const result = buildCorpusSections({
      adrFiles,
      logFiles,
      archiveFiles,
      planFiles,
      catalog,
      scriptPages,
      readmePaths,
    });
    // ADRs are sorted number DESC (32, 20, 11); each href must be rooted at
    // REPO_BLOB_BASE and end with that ADR's own source filename.
    const expectedAdrNames = [
      ADR_ACCEPTED_ANNOTATED_NAME,
      ADR_ACCEPTED_PLAIN_NAME,
      ADR_SUPERSEDED_NAME,
    ];
    result.adrs.forEach((adr, index) => {
      expect(adr.href.startsWith(REPO_BLOB_BASE)).toBe(true);
      expect(adr.href.endsWith(expectedAdrNames[index] ?? "")).toBe(true);
    });
    for (const entry of [...result.reference.core, ...result.reference.aws]) {
      expect(entry.href.startsWith(REPO_BLOB_BASE)).toBe(true);
      expect(entry.href).toBe(blobUrl(entry.docPath));
    }
    for (const readme of result.readmes) {
      expect(readme.href.startsWith(REPO_BLOB_BASE)).toBe(true);
    }
  });
});
