/**
 * Tests for src/commands/presets.ts — `runPresets` resolves a script,
 * discovers its preset files, and renders one row per preset: NAME / FORMAT
 * / PARAMETERS (key names only — values are never rendered) / STATUS ("ok"
 * or the load-error summary for an invalid preset, which is a row, not a
 * crash). See the m3l-cli 8f addendum.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { runPresets } from "../src/commands/presets.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { loadParametersCached } from "../src/discovery/cached-load.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";
import { listPresetFiles, readPresetRecord } from "../src/presets/store.js";
import type { M3LCliPresetFile } from "../src/presets/store.js";

vi.mock("../src/discovery/discover.js", () => ({
  discoverScripts: vi.fn(),
}));
vi.mock("../src/discovery/cached-load.js", () => ({
  loadParametersCached: vi.fn(),
}));
vi.mock("../src/presets/store.js", () => ({
  listPresetFiles: vi.fn(),
  readPresetRecord: vi.fn(),
}));

const discoverScriptsMock = vi.mocked(discoverScripts);
const loadParametersCachedMock = vi.mocked(loadParametersCached);
const listPresetFilesMock = vi.mocked(listPresetFiles);
const readPresetRecordMock = vi.mocked(readPresetRecord);

afterEach(() => {
  discoverScriptsMock.mockReset();
  loadParametersCachedMock.mockReset();
  listPresetFilesMock.mockReset();
  readPresetRecordMock.mockReset();
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
        /* unused */
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
    historyFilePath: "/workspace/data/cache/m3l-cli/history.json",
    outputDirPath: "/workspace/data/output",
    env: {},
    envFile: { kind: "auto" },
    ...overrides,
  };
  return { context, infoLines, headingLines };
}

const exporterCandidate: M3LCliScriptCandidate = {
  name: "exporter",
  directory: "/workspace/scripts/exporter",
  description: "Exports data",
};

const regionDescriptor: M3LCliParameterDescriptor = {
  name: "region",
  aliases: [],
  type: "STRING",
  required: false,
  defaultValue: undefined,
  description: "",
  secret: false,
  operations: [],
};

const prodPresetFile: M3LCliPresetFile = {
  name: "prod",
  filePath: "/workspace/data/config/presets/prod.json",
  format: "json",
};

const devPresetFile: M3LCliPresetFile = {
  name: "dev",
  filePath: "/workspace/data/config/presets/dev.yaml",
  format: "yaml",
};

describe("runPresets — unknown script", () => {
  test("throws ERR_CLI_UNKNOWN_SCRIPT with suggestions and never lists presets", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);

    let thrown: unknown;
    try {
      await runPresets(buildContext().context, "exportr");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_UNKNOWN_SCRIPT");
    expect((thrown as M3LCliError).suggestions).toEqual(
      expect.arrayContaining(["exporter"]),
    );
    expect(listPresetFilesMock).not.toHaveBeenCalled();
  });
});

describe("runPresets — empty listing", () => {
  test("renders 'no presets found' and returns 0 when the script has no preset files", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    loadParametersCachedMock.mockResolvedValue([regionDescriptor]);
    listPresetFilesMock.mockReturnValue([]);

    const { context, infoLines } = buildContext();
    const code = await runPresets(context, "exporter");

    expect(code).toBe(0);
    expect(infoLines.join("\n")).toContain("no presets found");
  });
});

describe("runPresets — rendered rows", () => {
  test("renders NAME/FORMAT/PARAMETERS(key names)/STATUS ok for a valid preset, never the value", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    loadParametersCachedMock.mockResolvedValue([regionDescriptor]);
    listPresetFilesMock.mockReturnValue([prodPresetFile]);
    readPresetRecordMock.mockReturnValue({ region: "super-secret-region-42" });

    const { context, infoLines } = buildContext();
    const code = await runPresets(context, "exporter");

    expect(code).toBe(0);
    const rendered = infoLines.join("\n");
    expect(rendered).toContain("prod");
    expect(rendered).toContain("json");
    expect(rendered).toContain("region");
    expect(rendered).toContain("ok");
    expect(rendered).not.toContain("super-secret-region-42");
  });

  test("renders an invalid preset as a STATUS row (the load-error summary), not a crash — good presets still render", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    loadParametersCachedMock.mockResolvedValue([regionDescriptor]);
    listPresetFilesMock.mockReturnValue([prodPresetFile, devPresetFile]);
    readPresetRecordMock.mockImplementation((filePath: string) => {
      if (filePath === prodPresetFile.filePath) {
        throw new M3LCliError(
          "ERR_CLI_PRESET_INVALID",
          "unrecognized preset key 'bogus'",
        );
      }
      return { region: "eu-west-1" };
    });

    const { context, infoLines } = buildContext();
    const code = await runPresets(context, "exporter");

    expect(code).toBe(0);
    const rendered = infoLines.join("\n");
    expect(rendered).toContain("prod");
    expect(rendered).toContain("unrecognized preset key");
    expect(rendered).toContain("dev");
    expect(rendered).toContain("region");
  });
});

describe("runPresets — JSON rendering", () => {
  test("renders {name, filePath, format, keys} for a valid preset — keys only, never values", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    loadParametersCachedMock.mockResolvedValue([regionDescriptor]);
    listPresetFilesMock.mockReturnValue([prodPresetFile]);
    readPresetRecordMock.mockReturnValue({ region: "super-secret-region-42" });

    const { context, infoLines } = buildContext({ jsonOutput: true });
    await runPresets(context, "exporter");

    const rendered = infoLines.join("\n");
    expect(rendered).not.toContain("super-secret-region-42");
    const parsed = JSON.parse(infoLines[0] ?? "[]") as Record<
      string,
      unknown
    >[];
    expect(parsed[0]).toMatchObject({
      name: "prod",
      filePath: prodPresetFile.filePath,
      format: "json",
      keys: ["region"],
    });
  });

  test("renders {name, filePath, format, error} for an invalid preset", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    loadParametersCachedMock.mockResolvedValue([regionDescriptor]);
    listPresetFilesMock.mockReturnValue([prodPresetFile]);
    readPresetRecordMock.mockImplementation(() => {
      throw new M3LCliError("ERR_CLI_PRESET_INVALID", "bad preset");
    });

    const { context, infoLines } = buildContext({ jsonOutput: true });
    await runPresets(context, "exporter");

    const parsed = JSON.parse(infoLines[0] ?? "[]") as Record<
      string,
      unknown
    >[];
    expect(parsed[0]).toMatchObject({
      name: "prod",
      filePath: prodPresetFile.filePath,
      format: "json",
      error: "bad preset",
    });
    expect(parsed[0]).not.toHaveProperty("keys");
  });
});
