import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { runInspect } from "../src/commands/inspect.js";
import { M3LCliError } from "../src/cli/errors.js";
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
 * Contract: `src/commands/inspect.ts` — `runInspect` resolves the script
 * name against `discoverScripts`; an unknown name throws an
 * `ERR_CLI_UNKNOWN_SCRIPT` error carrying Damerau-Levenshtein `suggestions`
 * over the known names (via `Core.M3LUnknownParameterDetector`); a known
 * script loads its parameters (cache-aware, same as `runList`) and renders
 * the parameter table; a non-`M3LCliError` config-load failure (or freshness
 * probe failure) is wrapped into `ERR_CLI_CONFIG_IMPORT` with `cause`
 * chained, while an already-typed `M3LCliError` propagates unchanged. See
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

const freshMtimes = { srcMtimeMs: 100, distMtimeMs: 200 };

describe("runInspect — known script, cache-fresh path", () => {
  test("uses the cached descriptors and never calls loadScriptParameters", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    configMtimesMock.mockReturnValue(freshMtimes);
    const cachedEntry: M3LCliDiscoveryCacheEntry = {
      ...freshMtimes,
      parameters: exporterParameters,
    };
    readDiscoveryCacheMock.mockReturnValue({ exporter: cachedEntry });
    isCacheEntryFreshMock.mockReturnValue(true);

    const { context, infoLines } = buildContext({ jsonOutput: true });
    const code = await runInspect(context, "exporter");

    expect(code).toBe(0);
    expect(loadScriptParametersMock).not.toHaveBeenCalled();
    expect(infoLines).toHaveLength(1);
    const descriptor = JSON.parse(
      infoLines[0] ?? "null",
    ) as readonly M3LCliParameterDescriptor[];
    expect(descriptor).toEqual(exporterParameters);
  });
});

describe("runInspect — known script, cache-stale path", () => {
  test("loads and persists parameters when no fresh cache entry exists", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    configMtimesMock.mockReturnValue(freshMtimes);
    readDiscoveryCacheMock.mockReturnValue({});
    loadScriptParametersMock.mockResolvedValue(exporterParameters);

    const { context } = buildContext();
    const code = await runInspect(context, "exporter");

    expect(code).toBe(0);
    expect(loadScriptParametersMock).toHaveBeenCalledWith(
      exporterCandidate.directory,
    );
    expect(writeDiscoveryCacheMock).toHaveBeenCalledWith(
      context.cacheFilePath,
      expect.objectContaining({
        exporter: { ...freshMtimes, parameters: exporterParameters },
      }),
    );
  });
});

describe("runInspect — rendering", () => {
  test("prints a heading and human-readable parameter rows when jsonOutput is false", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    configMtimesMock.mockReturnValue(freshMtimes);
    readDiscoveryCacheMock.mockReturnValue({
      exporter: { ...freshMtimes, parameters: exporterParameters },
    });
    isCacheEntryFreshMock.mockReturnValue(true);

    const { context, infoLines, headingLines } = buildContext({
      jsonOutput: false,
    });
    const code = await runInspect(context, "exporter");

    expect(code).toBe(0);
    expect(headingLines.length).toBeGreaterThan(0);
    const rendered = infoLines.join("\n");
    expect(rendered).toContain("region");
    expect(rendered).toContain("batchSize");
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
    expect(loadScriptParametersMock).not.toHaveBeenCalled();
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
  test("wraps a non-M3LCliError loadScriptParameters rejection into ERR_CLI_CONFIG_IMPORT with cause chained", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    configMtimesMock.mockReturnValue(freshMtimes);
    readDiscoveryCacheMock.mockReturnValue({});
    const loadError = new Error("cannot import config");
    loadScriptParametersMock.mockRejectedValue(loadError);

    const { context } = buildContext();

    let thrown: unknown;
    try {
      await runInspect(context, "exporter");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_CONFIG_IMPORT");
    expect((thrown as M3LCliError).cause).toBe(loadError);
  });

  test("propagates an M3LCliError from loadScriptParameters unchanged, not double-wrapped", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    configMtimesMock.mockReturnValue(freshMtimes);
    readDiscoveryCacheMock.mockReturnValue({});
    const loadError = new M3LCliError(
      "ERR_CLI_CONFIG_IMPORT",
      "cannot import config",
    );
    loadScriptParametersMock.mockRejectedValue(loadError);

    const { context } = buildContext();

    await expect(runInspect(context, "exporter")).rejects.toBe(loadError);
  });
});

describe("runInspect — freshness probe failure", () => {
  test("wraps a configMtimes throw into ERR_CLI_CONFIG_IMPORT with cause chained", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    readDiscoveryCacheMock.mockReturnValue({});
    const probeError = new Error("EACCES: permission denied");
    configMtimesMock.mockImplementation(() => {
      throw probeError;
    });

    const { context } = buildContext();

    let thrown: unknown;
    try {
      await runInspect(context, "exporter");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_CONFIG_IMPORT");
    expect((thrown as M3LCliError).cause).toBe(probeError);
    expect(loadScriptParametersMock).not.toHaveBeenCalled();
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
