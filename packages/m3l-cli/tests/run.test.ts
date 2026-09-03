/**
 * Tests for src/commands/run.ts — `runRun` resolves a script name via
 * `discoverScripts`, throwing `ERR_CLI_UNKNOWN_SCRIPT` (with suggestions) for
 * an unknown name, otherwise delegating to `executeScript` (V2 slice 2, #539
 * / ADR-0063 — replaces the direct `spawnScript` call so the whole context
 * threads through for envelope/report handling) and propagating its
 * resolved exit code verbatim. `runRun` never loads config or touches
 * the discovery cache (m3l-cli 8c addendum).
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { runRun } from "../src/commands/run.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { executeScript } from "../src/run/execute.js";
import { loadScriptParameters } from "../src/discovery/load-config.js";
import {
  configMtimes,
  isCacheEntryFresh,
  readDiscoveryCache,
  writeDiscoveryCache,
} from "../src/discovery/cache.js";
import { recordHistoryEntry } from "../src/history/store.js";

vi.mock("../src/discovery/discover.js", () => ({
  discoverScripts: vi.fn(),
}));
vi.mock("../src/run/execute.js", () => ({ executeScript: vi.fn() }));
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
vi.mock("../src/history/store.js", () => ({
  recordHistoryEntry: vi.fn(),
}));

const discoverScriptsMock = vi.mocked(discoverScripts);
const executeScriptMock = vi.mocked(executeScript);
const loadScriptParametersMock = vi.mocked(loadScriptParameters);
const readDiscoveryCacheMock = vi.mocked(readDiscoveryCache);
const writeDiscoveryCacheMock = vi.mocked(writeDiscoveryCache);
const configMtimesMock = vi.mocked(configMtimes);
const isCacheEntryFreshMock = vi.mocked(isCacheEntryFresh);
const recordHistoryEntryMock = vi.mocked(recordHistoryEntry);

afterEach(() => {
  discoverScriptsMock.mockReset();
  executeScriptMock.mockReset();
  loadScriptParametersMock.mockReset();
  readDiscoveryCacheMock.mockReset();
  writeDiscoveryCacheMock.mockReset();
  configMtimesMock.mockReset();
  isCacheEntryFreshMock.mockReset();
  recordHistoryEntryMock.mockReset();
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

/**
 * `M3LCliCommandContext` gains `historyFilePath` per the 8f contract — not
 * yet present on the type until `commands/context.ts` is extended. A local
 * extension (rather than an `as` cast) keeps the object literal type-checked
 * against a real declared shape in RED, and becomes an identical (harmless)
 * extension of the real field once GREEN lands.
 */
interface M3LCliCommandContextWithHistory extends M3LCliCommandContext {
  readonly historyFilePath: string;
}

function buildContext(
  overrides: Partial<M3LCliCommandContextWithHistory> = {},
): M3LCliCommandContextWithHistory {
  return {
    workspaceRoot: "/workspace",
    output: createOutputCollector(),
    jsonOutput: false,
    cacheFilePath: "/workspace/data/cache/m3l-cli/discovery.json",
    historyFilePath: "/workspace/data/cache/m3l-cli/history.json",
    outputDirPath: "/workspace/data/output",
    env: {},
    envFile: { kind: "auto" },
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
  test("delegates to executeScript with the context, script name, candidate directory, and passthrough args, propagating its exit code", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    executeScriptMock.mockResolvedValue({ exitCode: 7 });

    const context = buildContext();
    const code = await runRun(context, "exporter", ["--limit", "5"]);

    expect(code).toBe(7);
    expect(executeScriptMock).toHaveBeenCalledWith(
      context,
      "exporter",
      exporterCandidate.directory,
      ["--limit", "5"],
    );
    expect(loadScriptParametersMock).not.toHaveBeenCalled();
    expect(readDiscoveryCacheMock).not.toHaveBeenCalled();
    expect(writeDiscoveryCacheMock).not.toHaveBeenCalled();
    expect(configMtimesMock).not.toHaveBeenCalled();
    expect(isCacheEntryFreshMock).not.toHaveBeenCalled();
  });

  test("propagates executeScript's resolved exit code of 0 unchanged", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    executeScriptMock.mockResolvedValue({ exitCode: 0 });

    const context = buildContext();
    const code = await runRun(context, "importer", []);

    expect(code).toBe(0);
    expect(executeScriptMock).toHaveBeenCalledWith(
      context,
      "importer",
      importerCandidate.directory,
      [],
    );
  });

  test("propagates an executeScript rejection (e.g. ERR_CLI_SCRIPT_NOT_BUILT) unchanged", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    const executeError = new Error("not built");
    executeScriptMock.mockRejectedValue(executeError);

    await expect(runRun(buildContext(), "exporter", [])).rejects.toBe(
      executeError,
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
    expect(executeScriptMock).not.toHaveBeenCalled();
  });

  test("throws ERR_CLI_UNKNOWN_SCRIPT with an empty suggestions array when nothing is close", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);

    await expect(
      runRun(buildContext(), "zzzzzzzzzzzzzzzzzzzz", []),
    ).rejects.toMatchObject({
      code: "ERR_CLI_UNKNOWN_SCRIPT",
      suggestions: [],
    });
    expect(executeScriptMock).not.toHaveBeenCalled();
  });
});

/**
 * m3l-cli 8f addendum — after `executeScript` resolves, `runRun` best-effort
 * records a history entry with an empty `parameterNames` (it never parses
 * flags); a recording failure never surfaces and never changes the resolved
 * exit code.
 */
describe("runRun — best-effort history recording (8f)", () => {
  test("records a history entry with empty parameterNames and the spawned exit code after a successful run", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    executeScriptMock.mockResolvedValue({ exitCode: 3 });
    recordHistoryEntryMock.mockReturnValue(true);

    const context = buildContext();
    const code = await runRun(context, "exporter", ["--limit", "5"]);

    expect(code).toBe(3);
    expect(recordHistoryEntryMock).toHaveBeenCalledTimes(1);
    const [historyFilePath, entry] = recordHistoryEntryMock.mock.calls[0] ?? [
      "",
      undefined,
    ];
    expect(historyFilePath).toBe(context.historyFilePath);
    expect(entry).toMatchObject({
      script: "exporter",
      parameterNames: [],
      exitCode: 3,
    });
    expect(
      typeof (entry as { timestamp?: unknown } | undefined)?.timestamp,
    ).toBe("string");
  });

  test("does not record history when executeScript rejects", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    executeScriptMock.mockRejectedValue(new Error("not built"));

    await expect(runRun(buildContext(), "exporter", [])).rejects.toThrow();
    expect(recordHistoryEntryMock).not.toHaveBeenCalled();
  });

  test("a history-recording failure never affects the resolved exit code", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    executeScriptMock.mockResolvedValue({ exitCode: 0 });
    recordHistoryEntryMock.mockImplementation(() => {
      throw new Error("disk full");
    });

    const code = await runRun(buildContext(), "exporter", []);

    expect(code).toBe(0);
  });

  test("a history-recording that returns false never affects the resolved exit code", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    executeScriptMock.mockResolvedValue({ exitCode: 5 });
    recordHistoryEntryMock.mockReturnValue(false);

    const code = await runRun(buildContext(), "exporter", []);

    expect(code).toBe(5);
  });
});

/**
 * V2 slice 2 (#539 / ADR-0063) — `runRun` is a thin pass-through to
 * `executeScript`: any JSON-envelope/report-derived rendering belongs
 * entirely inside `executeScript` (mocked here), never duplicated by
 * `runRun` itself.
 */
describe("runRun — never renders output directly (V2 slice 2)", () => {
  test("never calls context.output.info itself; envelope emission belongs to executeScript", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    executeScriptMock.mockResolvedValue({ exitCode: 0 });
    const infoSpy = vi.fn();
    const context = buildContext({
      output: {
        colorEnabled: false,
        info: infoSpy,
        error: () => {
          /* unused */
        },
        heading: () => {
          /* unused */
        },
      },
    });

    await runRun(context, "exporter", ["--limit", "5"]);

    expect(infoSpy).not.toHaveBeenCalled();
  });
});
