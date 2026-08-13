import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { runList } from "../src/commands/list.js";
import type { M3LCliListRow } from "../src/commands/list.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { loadScriptParameters } from "../src/discovery/load-config.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";
import {
  configMtimes,
  isCacheEntryFresh,
  readDiscoveryCache,
  writeDiscoveryCache,
} from "../src/discovery/cache.js";
import type { M3LCliDiscoveryCacheEntry } from "../src/discovery/cache.js";

/**
 * Contract: `src/commands/list.ts` — `runList` composes
 * `discoverScripts`/`loadScriptParameters`/the discovery-cache module to
 * render one row per discovered script (name/description/parameterCount/
 * loadError), preferring a fresh cache entry over a fresh import, and
 * continuing the listing when a single script's config fails to load. See
 * the pinned contract at
 * `docs/reference/cli.md`.
 */

vi.mock("../src/discovery/discover.js", () => ({
  discoverScripts: vi.fn(),
}));
vi.mock("../src/discovery/load-config.js", () => ({
  loadScriptParameters: vi.fn(),
}));
vi.mock("../src/discovery/cache.js", () => ({
  readDiscoveryCache: vi.fn(),
  writeDiscoveryCache: vi.fn(),
  configMtimes: vi.fn(),
  isCacheEntryFresh: vi.fn(),
}));

const discoverScriptsMock = vi.mocked(discoverScripts);
const loadScriptParametersMock = vi.mocked(loadScriptParameters);
const readDiscoveryCacheMock = vi.mocked(readDiscoveryCache);
const writeDiscoveryCacheMock = vi.mocked(writeDiscoveryCache);
const configMtimesMock = vi.mocked(configMtimes);
const isCacheEntryFreshMock = vi.mocked(isCacheEntryFresh);

afterEach(() => {
  discoverScriptsMock.mockReset();
  loadScriptParametersMock.mockReset();
  readDiscoveryCacheMock.mockReset();
  writeDiscoveryCacheMock.mockReset();
  configMtimesMock.mockReset();
  isCacheEntryFreshMock.mockReset();
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

const freshMtimes = { srcMtimeMs: 100, distMtimeMs: 200 };

describe("runList — cache-fresh path", () => {
  test("uses the cached parameter count and never calls loadScriptParameters", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue(freshMtimes);
    const cachedEntry: M3LCliDiscoveryCacheEntry = {
      ...freshMtimes,
      parameters: exporterParameters,
    };
    readDiscoveryCacheMock.mockReturnValue({ exporter: cachedEntry });
    isCacheEntryFreshMock.mockReturnValue(true);

    const { context, infoLines } = buildContext({ jsonOutput: true });
    const code = await runList(context);

    expect(code).toBe(0);
    expect(loadScriptParametersMock).not.toHaveBeenCalled();
    expect(infoLines).toHaveLength(1);
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

describe("runList — cache-stale/missing path", () => {
  test("loads and persists parameters when no cache entry exists for a script", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue(freshMtimes);
    readDiscoveryCacheMock.mockReturnValue({});
    loadScriptParametersMock.mockResolvedValue(exporterParameters);

    const { context } = buildContext();
    const code = await runList(context);

    expect(code).toBe(0);
    expect(loadScriptParametersMock).toHaveBeenCalledWith(
      exporterCandidate.directory,
    );
    expect(writeDiscoveryCacheMock).toHaveBeenCalledWith(
      context.cacheFilePath,
      expect.objectContaining({
        exporter: {
          ...freshMtimes,
          parameters: exporterParameters,
        },
      }),
    );
  });

  test("reloads parameters when the cached entry is stale (isCacheEntryFresh returns false)", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue(freshMtimes);
    const staleEntry: M3LCliDiscoveryCacheEntry = {
      srcMtimeMs: 1,
      distMtimeMs: 2,
      parameters: [],
    };
    readDiscoveryCacheMock.mockReturnValue({ exporter: staleEntry });
    isCacheEntryFreshMock.mockReturnValue(false);
    loadScriptParametersMock.mockResolvedValue(exporterParameters);

    const { context } = buildContext();
    const code = await runList(context);

    expect(code).toBe(0);
    expect(isCacheEntryFreshMock).toHaveBeenCalledWith(staleEntry, freshMtimes);
    expect(loadScriptParametersMock).toHaveBeenCalledWith(
      exporterCandidate.directory,
    );
  });
});

describe("runList — partial load failure", () => {
  test("annotates the failing row with loadError and parameterCount null while other rows still render, returning 0", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate, importerCandidate]);
    configMtimesMock.mockReturnValue(freshMtimes);
    const cachedEntry: M3LCliDiscoveryCacheEntry = {
      ...freshMtimes,
      parameters: exporterParameters,
    };
    readDiscoveryCacheMock.mockReturnValue({ exporter: cachedEntry });
    isCacheEntryFreshMock.mockReturnValue(true);
    loadScriptParametersMock.mockRejectedValue(
      new Error("cannot import config"),
    );

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

describe("runList — freshness probe failure", () => {
  test("annotates the row with a wrapped loadError when configMtimes throws, and listing continues at exit 0", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    readDiscoveryCacheMock.mockReturnValue({});
    configMtimesMock.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const { context, infoLines } = buildContext({ jsonOutput: true });
    const code = await runList(context);

    expect(code).toBe(0);
    const rows = JSON.parse(infoLines[0] ?? "[]") as M3LCliListRow[];
    expect(rows).toEqual([
      {
        name: "exporter",
        description: "Exports data",
        parameterCount: null,
        loadError: "EACCES: permission denied",
      },
    ]);
    expect(loadScriptParametersMock).not.toHaveBeenCalled();
  });
});

describe("runList — rendering modes", () => {
  test("prints a heading and human-readable rows when jsonOutput is false", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue(freshMtimes);
    readDiscoveryCacheMock.mockReturnValue({
      exporter: { ...freshMtimes, parameters: exporterParameters },
    });
    isCacheEntryFreshMock.mockReturnValue(true);

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
    readDiscoveryCacheMock.mockReturnValue({});

    const { context, infoLines } = buildContext({ jsonOutput: true });
    const code = await runList(context);

    expect(code).toBe(0);
    expect(JSON.parse(infoLines[0] ?? "null")).toEqual([]);
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
