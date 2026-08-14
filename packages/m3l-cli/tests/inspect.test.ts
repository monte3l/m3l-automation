import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { runInspect } from "../src/commands/inspect.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { loadParametersCached } from "../src/discovery/cached-load.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";

/**
 * Contract: `src/commands/inspect.ts` — `runInspect` resolves the script name
 * against `discoverScripts`; an unknown name throws an
 * `ERR_CLI_UNKNOWN_SCRIPT` error carrying Damerau-Levenshtein `suggestions`
 * over the known names (via `Core.M3LUnknownParameterDetector`); a known
 * script loads its parameters through the shared `loadParametersCached`
 * helper (8d dedup refactor, 8b review CR#4) — propagating its failure
 * unchanged rather than annotating a row — and renders the parameter table
 * through the shared `formatAlignedTable` helper (8d dedup refactor, 8b
 * review CR#5), so its human-readable rendering is now column-aligned rather
 * than a flat `.join("  ")`. See the pinned contract at
 * `docs/reference/cli.md`.
 */

vi.mock("../src/discovery/discover.js", () => ({
  discoverScripts: vi.fn(),
}));
vi.mock("../src/discovery/cached-load.js", () => ({
  loadParametersCached: vi.fn(),
}));

const discoverScriptsMock = vi.mocked(discoverScripts);
const loadParametersCachedMock = vi.mocked(loadParametersCached);

afterEach(() => {
  discoverScriptsMock.mockReset();
  loadParametersCachedMock.mockReset();
});

function createOutputCollector(): {
  readonly output: M3LCliCommandContext["output"];
  readonly infoLines: string[];
  readonly headingLines: string[];
} {
  const infoLines: string[] = [];
  const headingLines: string[] = [];
  return {
    output: {
      colorEnabled: false,
      info: (text: string) => {
        infoLines.push(text);
      },
      error: () => {
        /* not used by inspect */
      },
      heading: (text: string) => {
        headingLines.push(text);
      },
    },
    infoLines,
    headingLines,
  };
}

function buildContext(overrides: Partial<M3LCliCommandContext> = {}): {
  context: M3LCliCommandContext;
  infoLines: string[];
  headingLines: string[];
} {
  const { output, infoLines, headingLines } = createOutputCollector();
  const context: M3LCliCommandContext = {
    workspaceRoot: "/workspace",
    output,
    jsonOutput: false,
    cacheFilePath: "/workspace/data/cache/m3l-cli/discovery.json",
    ...overrides,
  };
  return { context, infoLines, headingLines };
}

const exporterCandidate: M3LCliScriptCandidate = {
  name: "exporter",
  directory: "/workspace/scripts/exporter",
  description: "Exports data",
};

const importerCandidate: M3LCliScriptCandidate = {
  name: "importer",
  directory: "/workspace/scripts/importer",
  description: "Imports data",
};

const knownCandidates = [exporterCandidate, importerCandidate];

const exporterParameters: readonly M3LCliParameterDescriptor[] = [
  {
    name: "region",
    aliases: ["aws-region"],
    type: "STRING",
    required: true,
    defaultValue: undefined,
    description: "AWS region",
  },
  {
    name: "batchSize",
    aliases: [],
    type: "INT",
    required: false,
    defaultValue: "10",
    description: "Rows per batch",
  },
];

describe("runInspect — known script", () => {
  test("loads parameters through loadParametersCached and renders the JSON descriptor array", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(exporterParameters);

    const { context, infoLines } = buildContext({ jsonOutput: true });
    const code = await runInspect(context, "exporter");

    expect(code).toBe(0);
    expect(loadParametersCachedMock).toHaveBeenCalledWith(
      "exporter",
      exporterCandidate.directory,
      context.cacheFilePath,
    );
    const descriptor = JSON.parse(
      infoLines[0] ?? "null",
    ) as readonly M3LCliParameterDescriptor[];
    expect(descriptor).toEqual(exporterParameters);
  });
});

describe("runInspect — aligned table rendering (8d: via shared formatAlignedTable)", () => {
  test("prints a heading, then a header line and one column-aligned row per parameter with no trailing whitespace", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(exporterParameters);

    const { context, infoLines, headingLines } = buildContext({
      jsonOutput: false,
    });
    const code = await runInspect(context, "exporter");

    expect(code).toBe(0);
    expect(headingLines.length).toBeGreaterThan(0);
    // header + one row per parameter
    expect(infoLines).toHaveLength(1 + exporterParameters.length);
    for (const line of infoLines) {
      expect(line).not.toMatch(/\s$/);
    }
    const [header, regionRow, batchSizeRow] = infoLines;
    expect(header).toContain("NAME");
    expect(header).toContain("ALIASES");
    expect(header).toContain("TYPE");
    expect(header).toContain("REQUIRED");
    expect(header).toContain("DEFAULT");
    expect(header).toContain("DESCRIPTION");
    // the NAME column is padded to the width of the longest name
    // ("batchSize", 9 chars) so both rows' second column starts at the
    // same offset — the observable effect of column alignment.
    const regionNameField = regionRow?.slice(0, "batchSize".length) ?? "";
    const batchSizeNameField = batchSizeRow?.slice(0, "batchSize".length) ?? "";
    expect(regionNameField.trimEnd()).toBe("region");
    expect(batchSizeNameField.trimEnd()).toBe("batchSize");
    expect(regionRow?.indexOf("STRING")).toBe(batchSizeRow?.indexOf("INT"));
  });
});

describe("runInspect — unknown script", () => {
  test("throws ERR_CLI_UNKNOWN_SCRIPT with a Damerau-Levenshtein suggestion for a near-miss name", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);

    const { context } = buildContext();

    await expect(runInspect(context, "exportr")).rejects.toMatchObject({
      code: "ERR_CLI_UNKNOWN_SCRIPT",
      suggestions: expect.arrayContaining(["exporter"]) as unknown,
    });
    expect(loadParametersCachedMock).not.toHaveBeenCalled();
  });

  test("throws ERR_CLI_UNKNOWN_SCRIPT with an empty suggestions array when nothing is close", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);

    const { context } = buildContext();

    await expect(
      runInspect(context, "zzzzzzzzzzzzzzzzzzzz"),
    ).rejects.toMatchObject({
      code: "ERR_CLI_UNKNOWN_SCRIPT",
      suggestions: [],
    });
  });
});

describe("runInspect — config load failure", () => {
  test("propagates a loadParametersCached rejection unchanged (not re-wrapped)", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    const loadError = new M3LCliError(
      "ERR_CLI_CONFIG_IMPORT",
      "cannot import config",
    );
    loadParametersCachedMock.mockRejectedValue(loadError);

    const { context } = buildContext();

    await expect(runInspect(context, "exporter")).rejects.toBe(loadError);
  });
});

describe("runInspect — type contract", () => {
  test("M3LCliParameterDescriptor is a readonly descriptor of name/aliases/type/required/defaultValue/description", () => {
    expectTypeOf<M3LCliParameterDescriptor>().toEqualTypeOf<{
      readonly name: string;
      readonly aliases: readonly string[];
      readonly type: string;
      readonly required: boolean;
      readonly defaultValue: string | undefined;
      readonly description: string;
    }>();
  });
});
