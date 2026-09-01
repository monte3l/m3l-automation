import { afterEach, describe, expect, test, vi } from "vitest";

import { runNew } from "../src/commands/new.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { generateScript } from "../src/scaffold/generate.js";
import type { GenerateScriptResult } from "../src/scaffold/generate.js";

/**
 * Contract: `src/commands/new.ts` — `runNew` parses its OWN raw `rawArgs`
 * slice with `node:util` `parseArgs` (it must not rely on any pre-parsing by
 * `main.ts`'s shared static-command parser, which only recognizes
 * `--json`/`--help`), resolves a missing `<name>` positional as a usage
 * error without ever calling `generateScript`, otherwise delegates to
 * `generateScript` with the parsed values plus `context.workspaceRoot`, and
 * renders the result as JSON or human-readable text depending on
 * `context.jsonOutput` — propagating any `M3LCliError` `generateScript`
 * throws unchanged. See `docs/reference/cli.md` (U9, ADR-0053, issue #533).
 */

vi.mock("../src/scaffold/generate.js", () => ({
  generateScript: vi.fn(),
}));

const generateScriptMock = vi.mocked(generateScript);

afterEach(() => {
  generateScriptMock.mockReset();
});

/** The exact default purpose string, mirroring `bin/scaffold-script.mjs`. */
const DEFAULT_PURPOSE = "TODO: describe what this automation does.";

function createOutputCollector(): {
  readonly output: M3LCliCommandContext["output"];
  readonly infoLines: string[];
  readonly headingLines: string[];
  readonly errorLines: string[];
} {
  const infoLines: string[] = [];
  const headingLines: string[] = [];
  const errorLines: string[] = [];
  return {
    output: {
      colorEnabled: false,
      info: (text: string) => {
        infoLines.push(text);
      },
      error: (text: string) => {
        errorLines.push(text);
      },
      heading: (text: string) => {
        headingLines.push(text);
      },
    },
    infoLines,
    headingLines,
    errorLines,
  };
}

function buildContext(overrides: Partial<M3LCliCommandContext> = {}): {
  context: M3LCliCommandContext;
  infoLines: string[];
  headingLines: string[];
  errorLines: string[];
} {
  const { output, infoLines, headingLines, errorLines } =
    createOutputCollector();
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
  return { context, infoLines, headingLines, errorLines };
}

const fixtureResult: GenerateScriptResult = {
  scriptName: "data-sync",
  variant: "cli",
  dryRun: false,
  changes: [
    { action: "created", path: "scripts/data-sync/package.json" },
    { action: "updated", path: "tsconfig.json" },
  ],
};

describe("runNew — missing <name> positional", () => {
  test("prints a usage error and resolves exit code 2 without calling generateScript when rawArgs is empty", async () => {
    const { context, errorLines } = buildContext();

    const code = await runNew(context, []);

    expect(code).toBe(2);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain("new requires a <name> positional");
    expect(errorLines[0]).toContain("usage: m3l new <name>");
    expect(generateScriptMock).not.toHaveBeenCalled();
  });

  test("prints a usage error and resolves exit code 2 when rawArgs carries only flags, no positional", async () => {
    const { context, errorLines } = buildContext();

    const code = await runNew(context, ["--purpose", "x"]);

    expect(code).toBe(2);
    expect(errorLines).toHaveLength(1);
    expect(generateScriptMock).not.toHaveBeenCalled();
  });
});

describe("runNew — argument parsing and defaults", () => {
  test("defaults purpose/variant/dryRun/force when rawArgs is just the name", async () => {
    generateScriptMock.mockReturnValue(fixtureResult);
    const { context } = buildContext();

    await runNew(context, ["data-sync"]);

    expect(generateScriptMock).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      name: "data-sync",
      purpose: DEFAULT_PURPOSE,
      variant: "cli",
      dryRun: false,
      force: false,
    });
  });

  test("parses every flag correctly with the positional last", async () => {
    generateScriptMock.mockReturnValue(fixtureResult);
    const { context } = buildContext();

    await runNew(context, [
      "data-sync",
      "--purpose",
      "Sync S3 exports",
      "--variant",
      "lambda",
      "--dry-run",
      "--force",
    ]);

    expect(generateScriptMock).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      name: "data-sync",
      purpose: "Sync S3 exports",
      variant: "lambda",
      dryRun: true,
      force: true,
    });
  });

  test("resolves the same script name whether flags precede or follow the positional (no main.ts non-strict positional-corruption bug)", async () => {
    generateScriptMock.mockReturnValue(fixtureResult);
    const { context } = buildContext();

    await runNew(context, ["--purpose", "Sync it", "data-sync"]);

    expect(generateScriptMock).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      name: "data-sync",
      purpose: "Sync it",
      variant: "cli",
      dryRun: false,
      force: false,
    });
  });
});

describe("runNew — delegates to generateScript", () => {
  test("calls generateScript exactly once with the parsed options plus context.workspaceRoot", async () => {
    generateScriptMock.mockReturnValue(fixtureResult);
    const { context } = buildContext({ workspaceRoot: "/repo" });

    await runNew(context, ["data-sync"]);

    expect(generateScriptMock).toHaveBeenCalledTimes(1);
    expect(generateScriptMock).toHaveBeenCalledWith({
      workspaceRoot: "/repo",
      name: "data-sync",
      purpose: DEFAULT_PURPOSE,
      variant: "cli",
      dryRun: false,
      force: false,
    });
  });
});

describe("runNew — human-readable success output", () => {
  test("prints every changed path and returns exit code 0 for a non-dry-run result", async () => {
    generateScriptMock.mockReturnValue(fixtureResult);
    const { context, infoLines, headingLines } = buildContext({
      jsonOutput: false,
    });

    const code = await runNew(context, ["data-sync"]);

    expect(code).toBe(0);
    const rendered = [...headingLines, ...infoLines].join("\n");
    for (const change of fixtureResult.changes) {
      expect(rendered).toContain(change.path);
    }
    expect(rendered.toLowerCase()).not.toContain("dry");
  });

  test("signals nothing was written for a dry-run result", async () => {
    const dryRunResult: GenerateScriptResult = {
      ...fixtureResult,
      dryRun: true,
    };
    generateScriptMock.mockReturnValue(dryRunResult);
    const { context, infoLines, headingLines } = buildContext({
      jsonOutput: false,
    });

    const code = await runNew(context, ["data-sync", "--dry-run"]);

    expect(code).toBe(0);
    const rendered = [...headingLines, ...infoLines].join("\n");
    expect(rendered.toLowerCase()).toContain("dry");
    for (const change of dryRunResult.changes) {
      expect(rendered).toContain(change.path);
    }
  });
});

describe("runNew — JSON output", () => {
  test("emits exactly one info() call with JSON.stringify(result) and no heading lines", async () => {
    generateScriptMock.mockReturnValue(fixtureResult);
    const { context, infoLines, headingLines } = buildContext({
      jsonOutput: true,
    });

    const code = await runNew(context, ["data-sync"]);

    expect(code).toBe(0);
    expect(headingLines).toHaveLength(0);
    expect(infoLines).toHaveLength(1);
    expect(infoLines[0]).toBe(JSON.stringify(fixtureResult));
  });
});

describe("runNew — propagates generateScript failures", () => {
  test("propagates a thrown M3LCliError unchanged rather than catching/swallowing it", async () => {
    const scaffoldError = new M3LCliError(
      "ERR_CLI_SCAFFOLD_INVALID",
      "bad name",
    );
    generateScriptMock.mockImplementation(() => {
      throw scaffoldError;
    });
    const { context } = buildContext();

    await expect(runNew(context, ["data-sync"])).rejects.toBe(scaffoldError);
  });
});
