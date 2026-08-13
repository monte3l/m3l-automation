/**
 * Tests for src/commands/run.ts — `runRun` resolves a script name via
 * `discoverScripts`, throwing `ERR_CLI_UNKNOWN_SCRIPT` (with suggestions) for
 * an unknown name, otherwise spawning it via `spawnScript` and propagating
 * its resolved exit code verbatim. `runRun` never loads config or touches
 * the discovery cache (m3l-cli 8c addendum).
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { runRun } from "../src/commands/run.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { spawnScript } from "../src/run/spawn.js";
import { loadScriptParameters } from "../src/discovery/load-config.js";
import {
  configMtimes,
  isCacheEntryFresh,
  readDiscoveryCache,
  writeDiscoveryCache,
} from "../src/discovery/cache.js";

vi.mock("../src/discovery/discover.js", () => ({
  discoverScripts: vi.fn(),
}));
vi.mock("../src/run/spawn.js", () => ({ spawnScript: vi.fn() }));
// runRun must never touch config-load or the discovery cache — these mocks
// throw the moment they're invoked, so any accidental call surfaces loudly
// as a failing assertion rather than silently passing.
vi.mock("../src/discovery/load-config.js", () => ({
  loadScriptParameters: vi.fn(() => {
    throw new Error(
      "runRun must never call loadScriptParameters — run has no config-load involvement",
    );
  }),
}));
vi.mock("../src/discovery/cache.js", () => ({
  readDiscoveryCache: vi.fn(() => {
    throw new Error("runRun must never call readDiscoveryCache");
  }),
  writeDiscoveryCache: vi.fn(() => {
    throw new Error("runRun must never call writeDiscoveryCache");
  }),
  configMtimes: vi.fn(() => {
    throw new Error("runRun must never call configMtimes");
  }),
  isCacheEntryFresh: vi.fn(() => {
    throw new Error("runRun must never call isCacheEntryFresh");
  }),
}));

const discoverScriptsMock = vi.mocked(discoverScripts);
const spawnScriptMock = vi.mocked(spawnScript);
const loadScriptParametersMock = vi.mocked(loadScriptParameters);
const readDiscoveryCacheMock = vi.mocked(readDiscoveryCache);
const writeDiscoveryCacheMock = vi.mocked(writeDiscoveryCache);
const configMtimesMock = vi.mocked(configMtimes);
const isCacheEntryFreshMock = vi.mocked(isCacheEntryFresh);

afterEach(() => {
  discoverScriptsMock.mockReset();
  spawnScriptMock.mockReset();
  loadScriptParametersMock.mockReset();
  readDiscoveryCacheMock.mockReset();
  writeDiscoveryCacheMock.mockReset();
  configMtimesMock.mockReset();
  isCacheEntryFreshMock.mockReset();
});

function createOutputCollector(): M3LCliCommandContext["output"] {
  return {
    colorEnabled: false,
    info: () => {
      /* not used by run */
    },
    error: () => {
      /* not used by run */
    },
    heading: () => {
      /* not used by run */
    },
  };
}

function buildContext(
  overrides: Partial<M3LCliCommandContext> = {},
): M3LCliCommandContext {
  return {
    workspaceRoot: "/workspace",
    output: createOutputCollector(),
    jsonOutput: false,
    cacheFilePath: "/workspace/data/cache/m3l-cli/discovery.json",
    ...overrides,
  };
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

describe("runRun — known script", () => {
  test("spawns via spawnScript with the candidate's directory and passthrough args, propagating its exit code", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    spawnScriptMock.mockResolvedValue(7);

    const code = await runRun(buildContext(), "exporter", ["--limit", "5"]);

    expect(code).toBe(7);
    expect(spawnScriptMock).toHaveBeenCalledWith(exporterCandidate.directory, [
      "--limit",
      "5",
    ]);
    expect(loadScriptParametersMock).not.toHaveBeenCalled();
    expect(readDiscoveryCacheMock).not.toHaveBeenCalled();
    expect(writeDiscoveryCacheMock).not.toHaveBeenCalled();
    expect(configMtimesMock).not.toHaveBeenCalled();
    expect(isCacheEntryFreshMock).not.toHaveBeenCalled();
  });

  test("propagates spawnScript's resolved exit code of 0 unchanged", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    spawnScriptMock.mockResolvedValue(0);

    const code = await runRun(buildContext(), "importer", []);

    expect(code).toBe(0);
    expect(spawnScriptMock).toHaveBeenCalledWith(
      importerCandidate.directory,
      [],
    );
  });

  test("propagates a spawnScript rejection (e.g. ERR_CLI_SCRIPT_NOT_BUILT) unchanged", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    const spawnError = new Error("not built");
    spawnScriptMock.mockRejectedValue(spawnError);

    await expect(runRun(buildContext(), "exporter", [])).rejects.toBe(
      spawnError,
    );
  });
});

describe("runRun — unknown script", () => {
  test("throws ERR_CLI_UNKNOWN_SCRIPT with a Damerau-Levenshtein suggestion for a near-miss name", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);

    let thrown: unknown;
    try {
      await runRun(buildContext(), "exportr", []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_UNKNOWN_SCRIPT");
    expect((thrown as M3LCliError).suggestions).toEqual(
      expect.arrayContaining(["exporter"]),
    );
    expect(spawnScriptMock).not.toHaveBeenCalled();
  });

  test("throws ERR_CLI_UNKNOWN_SCRIPT with an empty suggestions array when nothing is close", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);

    await expect(
      runRun(buildContext(), "zzzzzzzzzzzzzzzzzzzz", []),
    ).rejects.toMatchObject({
      code: "ERR_CLI_UNKNOWN_SCRIPT",
      suggestions: [],
    });
    expect(spawnScriptMock).not.toHaveBeenCalled();
  });
});
