import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { runList } from "../src/commands/list.js";
import type { M3LCliListRow } from "../src/commands/list.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { loadParametersCached } from "../src/discovery/cached-load.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";

/**
 * Contract: `src/commands/list.ts` — `runList` composes `discoverScripts` and
 * the shared `loadParametersCached` helper (8d dedup refactor, 8b review
 * CR#4) to render one row per discovered script
 * (name/description/parameterCount/loadError), catching and annotating a
 * single script's load failure on its own row rather than aborting the
 * listing. See the pinned contract at `docs/reference/cli.md`.
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

/** Minimal structural stand-in for `M3LCliOutput` — a simple call collector. */
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
        /* not used by list */
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

const exporterParameters: readonly M3LCliParameterDescriptor[] = [
  {
    name: "region",
    aliases: [],
    type: "STRING",
    required: true,
    defaultValue: undefined,
    description: "AWS region",
  },
];

describe("runList — happy path", () => {
  test("resolves each script's row through loadParametersCached, keyed by name/directory/cacheFilePath", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    loadParametersCachedMock.mockResolvedValue(exporterParameters);

    const { context, infoLines } = buildContext({ jsonOutput: true });
    const code = await runList(context);

    expect(code).toBe(0);
    expect(loadParametersCachedMock).toHaveBeenCalledWith(
      "exporter",
      exporterCandidate.directory,
      context.cacheFilePath,
    );
    const rows = JSON.parse(infoLines[0] ?? "[]") as M3LCliListRow[];
    expect(rows).toEqual([
      {
        name: "exporter",
        description: "Exports data",
        parameterCount: 1,
        loadError: null,
      },
    ]);
  });
});

describe("runList — partial load failure", () => {
  test("annotates the failing row with loadError and parameterCount null while other rows still render, returning 0", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate, importerCandidate]);
    loadParametersCachedMock.mockImplementation((scriptName: string) => {
      if (scriptName === "importer") {
        return Promise.reject(new Error("cannot import config"));
      }
      return Promise.resolve(exporterParameters);
    });

    const { context, infoLines } = buildContext({ jsonOutput: true });
    const code = await runList(context);

    expect(code).toBe(0);
    const rows = JSON.parse(infoLines[0] ?? "[]") as M3LCliListRow[];
    expect(rows).toEqual([
      {
        name: "exporter",
        description: "Exports data",
        parameterCount: 1,
        loadError: null,
      },
      {
        name: "importer",
        description: "Imports data",
        parameterCount: null,
        loadError: "cannot import config",
      },
    ]);
  });
});

describe("runList — rendering modes", () => {
  test("prints a heading and human-readable rows when jsonOutput is false", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    loadParametersCachedMock.mockResolvedValue(exporterParameters);

    const { context, infoLines, headingLines } = buildContext({
      jsonOutput: false,
    });
    const code = await runList(context);

    expect(code).toBe(0);
    expect(headingLines.length).toBeGreaterThan(0);
    expect(infoLines.join("\n")).toContain("exporter");
    expect(infoLines.join("\n")).toContain("Exports data");
  });

  test("returns 0 with an empty JSON array when no scripts are discovered", async () => {
    discoverScriptsMock.mockReturnValue([]);

    const { context, infoLines } = buildContext({ jsonOutput: true });
    const code = await runList(context);

    expect(code).toBe(0);
    expect(JSON.parse(infoLines[0] ?? "null")).toEqual([]);
    expect(loadParametersCachedMock).not.toHaveBeenCalled();
  });

  test("renders 'ERROR: <loadError>' as the parameters cell for a failing row in human-readable mode", async () => {
    discoverScriptsMock.mockReturnValue([importerCandidate]);
    loadParametersCachedMock.mockRejectedValue(
      new Error("cannot import config"),
    );

    const { context, infoLines } = buildContext({ jsonOutput: false });
    const code = await runList(context);

    expect(code).toBe(0);
    expect(infoLines.join("\n")).toContain("ERROR: cannot import config");
  });

  test("annotates the row via String(error) when loadParametersCached rejects with a non-Error value", async () => {
    discoverScriptsMock.mockReturnValue([importerCandidate]);
    loadParametersCachedMock.mockImplementation(() =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentional non-Error rejection to verify the String(error) fallback
      Promise.reject("not an Error instance"),
    );

    const { context, infoLines } = buildContext({ jsonOutput: true });
    const code = await runList(context);

    expect(code).toBe(0);
    const rows = JSON.parse(infoLines[0] ?? "[]") as M3LCliListRow[];
    expect(rows).toEqual([
      {
        name: "importer",
        description: "Imports data",
        parameterCount: null,
        loadError: "not an Error instance",
      },
    ]);
  });
});

describe("runList — workspace discovery failure", () => {
  test("propagates a thrown error from discoverScripts instead of mapping it to an exit code", async () => {
    const discoveryError = new Error("workspace root not found");
    discoverScriptsMock.mockImplementation(() => {
      throw discoveryError;
    });

    const { context } = buildContext();

    await expect(runList(context)).rejects.toBe(discoveryError);
  });
});

describe("runList — type contract", () => {
  test("M3LCliListRow is a readonly discriminated union on parameterCount/loadError", () => {
    expectTypeOf<M3LCliListRow>().toEqualTypeOf<
      {
        readonly name: string;
        readonly description: string;
      } & (
        | { readonly parameterCount: number; readonly loadError: null }
        | { readonly parameterCount: null; readonly loadError: string }
      )
    >();
  });

  test("M3LCliCommandContext is a readonly record of workspaceRoot/output/jsonOutput/cacheFilePath", () => {
    expectTypeOf<M3LCliCommandContext>().toEqualTypeOf<{
      readonly workspaceRoot: string;
      readonly output: {
        readonly colorEnabled: boolean;
        info(text: string): void;
        error(text: string): void;
        heading(text: string): void;
      };
      readonly jsonOutput: boolean;
      readonly cacheFilePath: string;
    }>();
  });
});
