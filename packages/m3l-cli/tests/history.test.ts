/**
 * Tests for src/commands/history.ts — `runHistory` renders the recorded run
 * history (TIME / SCRIPT / PARAMETERS / EXIT / OUTCOME / ATTEMPTS, newest
 * last) or a raw JSON array; always resolves 0 (m3l-cli 8f addendum).
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { runHistory } from "../src/commands/history.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { readHistory } from "../src/history/store.js";
import type { M3LCliHistoryEntry } from "../src/history/store.js";

vi.mock("../src/history/store.js", () => ({
  readHistory: vi.fn(),
}));

const readHistoryMock = vi.mocked(readHistory);

afterEach(() => {
  readHistoryMock.mockReset();
});

/**
 * Splits a rendered `formatAlignedTable` line into its cells. Columns are
 * always separated by at least two spaces (padEnd to column width, then
 * joined with a two-space separator) regardless of how much padding any
 * individual column needed, so splitting on a run of 2+ whitespace
 * characters reliably recovers the per-column cell values — including the
 * final, never-padded column.
 */
function cellsOf(line: string): string[] {
  return line.trim().split(/\s{2,}/);
}

function createOutputCollector(): {
  readonly output: M3LCliCommandContext["output"];
  readonly infoLines: string[];
} {
  const infoLines: string[] = [];
  return {
    output: {
      colorEnabled: false,
      info: (text: string) => {
        infoLines.push(text);
      },
      error: () => {
        /* unused */
      },
      heading: () => {
        /* unused */
      },
    },
    infoLines,
  };
}

function buildContext(overrides: Partial<M3LCliCommandContext> = {}): {
  context: M3LCliCommandContext;
  infoLines: string[];
} {
  const { output, infoLines } = createOutputCollector();
  const context: M3LCliCommandContext = {
    workspaceRoot: "/workspace",
    output,
    jsonOutput: false,
    cacheFilePath: "/workspace/data/cache/m3l-cli/discovery.json",
    historyFilePath: "/workspace/data/cache/m3l-cli/history.json",
    outputDirPath: "/workspace/data/output",
    env: {},
    envFile: { kind: "auto" },
    ...overrides,
  };
  return { context, infoLines };
}

const olderEntry: M3LCliHistoryEntry = {
  timestamp: "2026-01-01T00:00:00.000Z",
  script: "importer",
  parameterNames: ["region"],
  exitCode: 1,
};

const newerEntry: M3LCliHistoryEntry = {
  timestamp: "2026-01-02T00:00:00.000Z",
  script: "exporter",
  parameterNames: [],
  exitCode: 0,
};

describe("runHistory — empty history", () => {
  test("prints 'no history recorded' and returns 0", async () => {
    readHistoryMock.mockReturnValue([]);

    const { context, infoLines } = buildContext();
    const code = await runHistory(context);

    expect(code).toBe(0);
    expect(infoLines.join("\n")).toContain("no history recorded");
  });
});

describe("runHistory — rendered rows", () => {
  test("renders TIME/SCRIPT/PARAMETERS/EXIT rows, newest last, comma-joining parameterNames", async () => {
    readHistoryMock.mockReturnValue([olderEntry, newerEntry]);

    const { context, infoLines } = buildContext();
    const code = await runHistory(context);

    expect(code).toBe(0);
    const rendered = infoLines.join("\n");
    expect(rendered).toContain("importer");
    expect(rendered).toContain("exporter");
    expect(rendered).toContain("region");
    const importerLine = infoLines.findIndex((line) =>
      line.includes("importer"),
    );
    const exporterLine = infoLines.findIndex((line) =>
      line.includes("exporter"),
    );
    expect(importerLine).toBeLessThan(exporterLine);
  });

  test("renders '-' for an entry with no parameterNames (checked on the PARAMETERS cell specifically)", async () => {
    readHistoryMock.mockReturnValue([newerEntry]);

    const { context, infoLines } = buildContext();
    await runHistory(context);

    // NOT `expect(infoLines.join("\n")).toContain("-")` — that already
    // passes on the ISO timestamp "2026-01-02T00:00:00.000Z" alone (which
    // contains "-"), proving nothing about the PARAMETERS cell. Indexing
    // into the split cells pins the exact column: TIME(0) SCRIPT(1)
    // PARAMETERS(2) EXIT(3) OUTCOME(4) ATTEMPTS(5). A mutation-test: if the
    // implementation rendered "none" instead of "-" for an empty
    // parameterNames list, this assertion would correctly fail — the
    // substring check it replaces would not.
    const dataLine = infoLines[1] ?? "";
    const cells = cellsOf(dataLine);
    expect(cells[2]).toBe("-");
  });
});

describe("runHistory — OUTCOME and ATTEMPTS columns", () => {
  test("header line lists TIME/SCRIPT/PARAMETERS/EXIT/OUTCOME/ATTEMPTS in order", async () => {
    readHistoryMock.mockReturnValue([olderEntry]);

    const { context, infoLines } = buildContext();
    await runHistory(context);

    const headerCells = cellsOf(infoLines[0] ?? "");
    expect(headerCells).toEqual([
      "TIME",
      "SCRIPT",
      "PARAMETERS",
      "EXIT",
      "OUTCOME",
      "ATTEMPTS",
    ]);
  });

  test("renders '-' for both OUTCOME and ATTEMPTS when both fields are absent", async () => {
    readHistoryMock.mockReturnValue([newerEntry]);

    const { context, infoLines } = buildContext();
    await runHistory(context);

    const cells = cellsOf(infoLines[1] ?? "");
    expect(cells[4]).toBe("-");
    expect(cells[5]).toBe("-");
  });

  test("renders the outcome literal when present, distinct from '-'", async () => {
    const entry: M3LCliHistoryEntry = {
      timestamp: "2026-01-03T00:00:00.000Z",
      script: "loader",
      parameterNames: [],
      exitCode: 1,
      outcome: "failure",
    };
    readHistoryMock.mockReturnValue([entry]);

    const { context, infoLines } = buildContext();
    await runHistory(context);

    const cells = cellsOf(infoLines[1] ?? "");
    expect(cells[4]).toBe("failure");
    expect(cells[5]).toBe("-");
  });

  test("renders '0' for retryAttempts: 0, NOT '-' — the case a `??`/falsy-based implementation gets wrong", async () => {
    const entry: M3LCliHistoryEntry = {
      timestamp: "2026-01-03T00:00:00.000Z",
      script: "loader",
      parameterNames: [],
      exitCode: 0,
      retryAttempts: 0,
    };
    readHistoryMock.mockReturnValue([entry]);

    const { context, infoLines } = buildContext();
    await runHistory(context);

    const cells = cellsOf(infoLines[1] ?? "");
    expect(cells[4]).toBe("-");
    expect(cells[5]).toBe("0");
  });

  test("keeps every rendered row at the same cell count as a mix of present/absent optional fields (no formatAlignedTable throw)", async () => {
    const entryWithBoth: M3LCliHistoryEntry = {
      ...newerEntry,
      script: "loader",
      outcome: "success",
      retryAttempts: 2,
    };
    readHistoryMock.mockReturnValue([olderEntry, entryWithBoth]);

    const { context, infoLines } = buildContext();
    await expect(runHistory(context)).resolves.toBe(0);

    const rows = infoLines.slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(cellsOf(row)).toHaveLength(6);
    }
  });
});

describe("runHistory — JSON rendering with optional fields", () => {
  test("round-trips an entry carrying outcome and retryAttempts verbatim through JSON.parse", async () => {
    const entry: M3LCliHistoryEntry = {
      ...newerEntry,
      outcome: "partial",
      retryAttempts: 4,
    };
    readHistoryMock.mockReturnValue([entry]);

    const { context, infoLines } = buildContext({ jsonOutput: true });
    const code = await runHistory(context);

    expect(code).toBe(0);
    const parsed = JSON.parse(infoLines[0] ?? "[]") as M3LCliHistoryEntry[];
    expect(parsed).toEqual([entry]);
  });
});

describe("runHistory — JSON rendering", () => {
  test("renders the raw entries array when jsonOutput is true", async () => {
    readHistoryMock.mockReturnValue([olderEntry, newerEntry]);

    const { context, infoLines } = buildContext({ jsonOutput: true });
    const code = await runHistory(context);

    expect(code).toBe(0);
    const parsed = JSON.parse(infoLines[0] ?? "[]") as M3LCliHistoryEntry[];
    expect(parsed).toEqual([olderEntry, newerEntry]);
  });
});

describe("runHistory — always returns 0", () => {
  test("returns 0 even for a failing-exit-code history entry", async () => {
    readHistoryMock.mockReturnValue([olderEntry]);

    const { context } = buildContext();
    const code = await runHistory(context);

    expect(code).toBe(0);
  });
});
