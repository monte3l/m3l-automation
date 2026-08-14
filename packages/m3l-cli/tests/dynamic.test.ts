import { afterEach, describe, expect, test, vi } from "vitest";

import { runDynamic } from "../src/commands/dynamic.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { loadParametersCached } from "../src/discovery/cached-load.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";
import { spawnScript } from "../src/run/spawn.js";
import { runInspect } from "../src/commands/inspect.js";

/**
 * Contract: `src/commands/dynamic.ts` — `runDynamic` resolves `scriptName`
 * against `discoverScripts` (unknown -> `ERR_CLI_UNKNOWN_SCRIPT` with
 * suggestions spanning static command names + script names); `--help`/`-h`
 * anywhere in `args` delegates to `runInspect` without spawning; otherwise it
 * loads descriptors via `loadParametersCached`, builds a `parseArgs` options
 * config keyed by every declared name/alias (BOOL -> boolean,
 * STRING_ARRAY -> multiple string, everything else -> string), translates
 * the parsed values back to canonical `--name[=value]` argv in descriptor
 * declaration order with `passthroughArgs` appended verbatim, and delegates
 * to `spawnScript`, propagating its resolved exit code. An unknown parseArgs
 * option throws `ERR_CLI_UNKNOWN_PARAMETER` with suggestions over the
 * script's declared parameter names. See the 8d addendum at the pinned
 * contract `docs/reference/cli.md`.
 */

vi.mock("../src/discovery/discover.js", () => ({
  discoverScripts: vi.fn(),
}));
vi.mock("../src/discovery/cached-load.js", () => ({
  loadParametersCached: vi.fn(),
}));
vi.mock("../src/run/spawn.js", () => ({
  spawnScript: vi.fn(),
}));
vi.mock("../src/commands/inspect.js", () => ({
  runInspect: vi.fn(),
}));

const discoverScriptsMock = vi.mocked(discoverScripts);
const loadParametersCachedMock = vi.mocked(loadParametersCached);
const spawnScriptMock = vi.mocked(spawnScript);
const runInspectMock = vi.mocked(runInspect);

afterEach(() => {
  discoverScriptsMock.mockReset();
  loadParametersCachedMock.mockReset();
  spawnScriptMock.mockReset();
  runInspectMock.mockReset();
});

function createOutputCollector(): {
  readonly output: M3LCliCommandContext["output"];
} {
  return {
    output: {
      colorEnabled: false,
      info: () => {
        /* unused */
      },
      error: () => {
        /* unused */
      },
      heading: () => {
        /* unused */
      },
    },
  };
}

function buildContext(
  overrides: Partial<M3LCliCommandContext> = {},
): M3LCliCommandContext {
  const { output } = createOutputCollector();
  return {
    workspaceRoot: "/workspace",
    output,
    jsonOutput: false,
    cacheFilePath: "/workspace/data/cache/m3l-cli/discovery.json",
    ...overrides,
  };
}

const jsonEtlCandidate: M3LCliScriptCandidate = {
  name: "json-etl",
  directory: "/workspace/scripts/json-etl",
  description: "Transforms JSON",
};

const exporterCandidate: M3LCliScriptCandidate = {
  name: "exporter",
  directory: "/workspace/scripts/exporter",
  description: "Exports data",
};

const knownCandidates = [jsonEtlCandidate, exporterCandidate];

const descriptors: readonly M3LCliParameterDescriptor[] = [
  {
    name: "region",
    aliases: ["r", "aws-region"],
    type: "STRING",
    required: true,
    defaultValue: undefined,
    description: "AWS region",
  },
  {
    name: "verbose",
    aliases: ["v"],
    type: "BOOL",
    required: false,
    defaultValue: undefined,
    description: "Verbose logging",
  },
  {
    name: "tags",
    aliases: [],
    type: "STRING_ARRAY",
    required: false,
    defaultValue: undefined,
    description: "Tags",
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

describe("runDynamic — unknown script", () => {
  test("throws ERR_CLI_UNKNOWN_SCRIPT with a suggestion over a near-miss discovered script name", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);

    const context = buildContext();

    await expect(runDynamic(context, "exportr", [], [])).rejects.toMatchObject({
      code: "ERR_CLI_UNKNOWN_SCRIPT",
      suggestions: expect.arrayContaining(["exporter"]) as unknown,
    });
    expect(loadParametersCachedMock).not.toHaveBeenCalled();
    expect(spawnScriptMock).not.toHaveBeenCalled();
  });

  test("throws ERR_CLI_UNKNOWN_SCRIPT with a suggestion over a near-miss static command name", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);

    const context = buildContext();

    await expect(runDynamic(context, "lst", [], [])).rejects.toMatchObject({
      code: "ERR_CLI_UNKNOWN_SCRIPT",
      suggestions: expect.arrayContaining(["list"]) as unknown,
    });
  });
});

describe("runDynamic — --help/-h delegation", () => {
  test("delegates to runInspect and never loads parameters or spawns, for --help", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    runInspectMock.mockResolvedValue(0);

    const context = buildContext();
    const code = await runDynamic(context, "json-etl", ["--help"], []);

    expect(code).toBe(0);
    expect(runInspectMock).toHaveBeenCalledWith(context, "json-etl");
    expect(loadParametersCachedMock).not.toHaveBeenCalled();
    expect(spawnScriptMock).not.toHaveBeenCalled();
  });

  test("delegates to runInspect for a bare -h mixed in with other args, propagating its return code", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    runInspectMock.mockResolvedValue(2);

    const context = buildContext();
    const code = await runDynamic(
      context,
      "json-etl",
      ["--limit", "5", "-h"],
      [],
    );

    expect(code).toBe(2);
    expect(runInspectMock).toHaveBeenCalledWith(context, "json-etl");
    expect(spawnScriptMock).not.toHaveBeenCalled();
  });

  test("does not delegate when --help only appears in passthroughArgs, not args", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue([]);
    spawnScriptMock.mockResolvedValue(0);

    const context = buildContext();
    await runDynamic(context, "json-etl", [], ["--help"]);

    expect(runInspectMock).not.toHaveBeenCalled();
    expect(spawnScriptMock).toHaveBeenCalledTimes(1);
  });
});

describe("runDynamic — parseArgs config building + argv translation", () => {
  test("builds string/boolean/multiple options per declared type, maps aliases to canonical names, and orders translated argv by descriptor declaration order with passthrough appended", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    spawnScriptMock.mockResolvedValue(0);

    const context = buildContext();
    const code = await runDynamic(
      context,
      "json-etl",
      [
        "--v",
        "--tags",
        "a",
        "--batchSize",
        "10",
        "--r",
        "us-east-1",
        "--tags",
        "b",
      ],
      ["--extra-passthrough"],
    );

    expect(code).toBe(0);
    expect(loadParametersCachedMock).toHaveBeenCalledWith(
      "json-etl",
      jsonEtlCandidate.directory,
      context.cacheFilePath,
    );
    expect(spawnScriptMock).toHaveBeenCalledWith(jsonEtlCandidate.directory, [
      "--region=us-east-1",
      "--verbose",
      "--tags=a",
      "--tags=b",
      "--batchSize=10",
      "--extra-passthrough",
    ]);
  });

  test("resolves a second alias for the same canonical name", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    spawnScriptMock.mockResolvedValue(0);

    const context = buildContext();
    await runDynamic(context, "json-etl", ["--aws-region", "eu-west-1"], []);

    expect(spawnScriptMock).toHaveBeenCalledWith(jsonEtlCandidate.directory, [
      "--region=eu-west-1",
    ]);
  });

  test("omits a boolean parameter from translated argv when it was not supplied", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    spawnScriptMock.mockResolvedValue(0);

    const context = buildContext();
    await runDynamic(context, "json-etl", ["--r", "us-east-1"], []);

    const [, translatedArgs] = spawnScriptMock.mock.calls[0] as [
      string,
      readonly string[],
    ];
    expect(translatedArgs).not.toContain("--verbose");
    expect(translatedArgs).toEqual(["--region=us-east-1"]);
  });

  test("appends passthroughArgs verbatim after every translated flag when no flags are supplied", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    spawnScriptMock.mockResolvedValue(0);

    const context = buildContext();
    await runDynamic(context, "json-etl", [], ["--limit", "5"]);

    expect(spawnScriptMock).toHaveBeenCalledWith(jsonEtlCandidate.directory, [
      "--limit",
      "5",
    ]);
  });
});

describe("runDynamic — invalid parameter value", () => {
  test("rejects ERR_CLI_INVALID_PARAMETER_VALUE naming the parameter when a BOOL flag is given a '=value' form", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);

    const context = buildContext();

    let thrown: unknown;
    try {
      await runDynamic(context, "json-etl", ["--verbose=true"], []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe(
      "ERR_CLI_INVALID_PARAMETER_VALUE",
    );
    expect((thrown as M3LCliError).message).toContain("verbose");
    expect(spawnScriptMock).not.toHaveBeenCalled();
  });
});

describe("runDynamic — config collision", () => {
  test("throws ERR_CLI_CONFIG_IMPORT naming both colliding parameters when two descriptors share a name/alias", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    const collidingDescriptors: readonly M3LCliParameterDescriptor[] = [
      {
        name: "foo",
        aliases: ["x"],
        type: "STRING",
        required: false,
        defaultValue: undefined,
        description: "Foo",
      },
      {
        name: "bar",
        aliases: ["x"],
        type: "STRING",
        required: false,
        defaultValue: undefined,
        description: "Bar",
      },
    ];
    loadParametersCachedMock.mockResolvedValue(collidingDescriptors);

    const context = buildContext();

    let thrown: unknown;
    try {
      await runDynamic(context, "json-etl", [], []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_CONFIG_IMPORT");
    expect((thrown as M3LCliError).message).toContain("foo");
    expect((thrown as M3LCliError).message).toContain("bar");
    expect(spawnScriptMock).not.toHaveBeenCalled();
  });
});

describe("runDynamic — unknown parameter", () => {
  test("throws ERR_CLI_UNKNOWN_PARAMETER with suggestions over the script's declared parameter names for an unrecognized flag", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);

    const context = buildContext();

    let thrown: unknown;
    try {
      await runDynamic(context, "json-etl", ["--regoin", "us-east-1"], []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_UNKNOWN_PARAMETER");
    expect((thrown as M3LCliError).suggestions).toEqual(
      expect.arrayContaining(["region"]) as unknown,
    );
    expect(spawnScriptMock).not.toHaveBeenCalled();
  });
});

describe("runDynamic — spawn code propagation", () => {
  test("resolves to spawnScript's returned exit code verbatim", async () => {
    discoverScriptsMock.mockReturnValue(knownCandidates);
    loadParametersCachedMock.mockResolvedValue(descriptors);
    spawnScriptMock.mockResolvedValue(7);

    const context = buildContext();
    const code = await runDynamic(context, "json-etl", [], []);

    expect(code).toBe(7);
  });
});
