/**
 * Tests for src/commands/history.ts — `runHistory` renders the recorded run
 * history (TIME / SCRIPT / PARAMETERS / EXIT, newest last) or a raw JSON
 * array; always resolves 0 (m3l-cli 8f addendum).
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

  test("renders '-' for an entry with no parameterNames", async () => {
    readHistoryMock.mockReturnValue([newerEntry]);

    const { context, infoLines } = buildContext();
    await runHistory(context);

    expect(infoLines.join("\n")).toContain("-");
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
