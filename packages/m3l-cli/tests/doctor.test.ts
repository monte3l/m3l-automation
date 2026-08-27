import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Make 'node:fs' configurable so vi.spyOn can intercept individual functions
// (ESM namespace objects are non-writable) — mirrors cache.test.ts's pattern.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

import { runDoctor } from "../src/commands/doctor.js";
import type {
  M3LCliDoctorCheck,
  M3LCliDoctorStatus,
} from "../src/commands/doctor.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import { discoverScripts } from "../src/discovery/discover.js";
import type { M3LCliScriptCandidate } from "../src/discovery/discover.js";
import { loadScriptParameters } from "../src/discovery/load-config.js";
import type { M3LCliParameterDescriptor } from "../src/discovery/load-config.js";
import { configMtimes, readDiscoveryCache } from "../src/discovery/cache.js";
import type { M3LCliConfigMtimes } from "../src/discovery/cache.js";
import { readHistory } from "../src/history/store.js";
import { loadCommandModule } from "../src/run/in-process.js";
import { M3LCliError } from "../src/cli/errors.js";

/**
 * Contract: `src/commands/doctor.ts` (m3l-cli 8e addendum) — `runDoctor` runs
 * an ordered check suite (node-version, workspace-root, one `script:<name>`
 * row per discovered candidate, reserved-names, cache) and renders it via
 * `context.output`, JSON or aligned. Returns 0 unless any check is "fail"
 * ("warn" never affects the exit code). Never throws for an unhealthy check —
 * only for its own infrastructure failing; an unexpected collaborator
 * failure propagates rather than being swallowed into a fail row. See the 8e
 * addendum at the pinned contract `docs/reference/cli.md`.
 */

vi.mock("../src/discovery/discover.js", () => ({
  discoverScripts: vi.fn(),
}));
vi.mock("../src/discovery/load-config.js", () => ({
  loadScriptParameters: vi.fn(),
}));
vi.mock("../src/discovery/cache.js", () => ({
  configMtimes: vi.fn(),
  readDiscoveryCache: vi.fn(),
}));
vi.mock("../src/history/store.js", () => ({
  readHistory: vi.fn(),
}));
vi.mock("../src/run/in-process.js", () => ({
  loadCommandModule: vi.fn(),
}));

const discoverScriptsMock = vi.mocked(discoverScripts);
const loadScriptParametersMock = vi.mocked(loadScriptParameters);
const configMtimesMock = vi.mocked(configMtimes);
const readDiscoveryCacheMock = vi.mocked(readDiscoveryCache);
const readHistoryMock = vi.mocked(readHistory);
const loadCommandModuleMock = vi.mocked(loadCommandModule);

const ORIGINAL_NODE_VERSION = process.version;

function setNodeVersion(version: string): void {
  Object.defineProperty(process, "version", {
    value: version,
    configurable: true,
  });
}

beforeEach(() => {
  setNodeVersion("v24.0.0");
  discoverScriptsMock.mockReturnValue([]);
  configMtimesMock.mockReturnValue({ srcMtimeMs: 100, distMtimeMs: 200 });
  loadScriptParametersMock.mockResolvedValue([]);
  readDiscoveryCacheMock.mockReturnValue({});
  readHistoryMock.mockReturnValue([]);
  // Default: no adopted command module — the common case for a discovered
  // candidate (13 of 16 fleet scripts have not adopted the ADR-0054 seam).
  loadCommandModuleMock.mockResolvedValue(undefined);
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
  vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  discoverScriptsMock.mockReset();
  loadScriptParametersMock.mockReset();
  configMtimesMock.mockReset();
  readDiscoveryCacheMock.mockReset();
  readHistoryMock.mockReset();
  loadCommandModuleMock.mockReset();
  Object.defineProperty(process, "version", {
    value: ORIGINAL_NODE_VERSION,
    configurable: true,
  });
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
        /* not used by doctor */
      },
      heading: (text: string) => {
        headingLines.push(text);
      },
    },
    infoLines,
    headingLines,
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
): {
  context: M3LCliCommandContextWithHistory;
  infoLines: string[];
  headingLines: string[];
} {
  const { output, infoLines, headingLines } = createOutputCollector();
  const context: M3LCliCommandContextWithHistory = {
    workspaceRoot: "/workspace-root",
    output,
    jsonOutput: true,
    cacheFilePath: "/workspace-root/data/cache/m3l-cli/discovery.json",
    historyFilePath: "/workspace-root/data/cache/m3l-cli/history.json",
    outputDirPath: "/workspace-root/data/output",
    ...overrides,
  };
  return { context, infoLines, headingLines };
}

function parseChecks(infoLines: readonly string[]): M3LCliDoctorCheck[] {
  return JSON.parse(infoLines[0] ?? "[]") as M3LCliDoctorCheck[];
}

function findCheck(
  checks: readonly M3LCliDoctorCheck[],
  name: string,
): M3LCliDoctorCheck | undefined {
  return checks.find((check) => check.name === name);
}

const exporterCandidate: M3LCliScriptCandidate = {
  name: "exporter",
  directory: "/workspace-root/scripts/exporter",
  description: "Exports data",
};

const importerCandidate: M3LCliScriptCandidate = {
  name: "importer",
  directory: "/workspace-root/scripts/importer",
  description: "Imports data",
};

const sampleParameters: readonly M3LCliParameterDescriptor[] = [
  {
    name: "region",
    aliases: [],
    type: "STRING",
    required: true,
    defaultValue: undefined,
    description: "",
  },
  {
    name: "verbose",
    aliases: [],
    type: "BOOL",
    required: false,
    defaultValue: undefined,
    description: "",
  },
];

describe("runDoctor — node-version check", () => {
  test.each([
    ["v24.0.0", "ok"],
    ["v25.3.1", "ok"],
    ["v22.5.0", "fail"],
    ["v23.9.9", "fail"],
  ] as const)(
    "resolves node-version to %s for process.version %s",
    async (version, expectedStatus) => {
      setNodeVersion(version);
      const { context, infoLines } = buildContext();

      await runDoctor(context);

      const row = findCheck(parseChecks(infoLines), "node-version");
      expect(row?.status).toBe(expectedStatus);
    },
  );
});

describe("runDoctor — workspace-root check", () => {
  test("always ok, rendering the resolved workspaceRoot as detail", async () => {
    const { context, infoLines } = buildContext({
      workspaceRoot: "/some/resolved/root",
    });

    await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "workspace-root");
    expect(row?.status).toBe("ok");
    expect(row?.detail).toBe("/some/resolved/root");
  });
});

describe("runDoctor — per-script dir-shape check", () => {
  test("fails a script's row when neither src/config.ts nor dist/config.js is found", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: null, distMtimeMs: null });

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "script:exporter");
    expect(row?.status).toBe("fail");
    expect(code).toBe(1);
  });
});

describe("runDoctor — per-script dist-freshness check", () => {
  test.each<[string, M3LCliConfigMtimes]>([
    ["dist missing", { srcMtimeMs: 500, distMtimeMs: null }],
    ["dist older than src", { srcMtimeMs: 500, distMtimeMs: 100 }],
  ])("warns naming 'pnpm build' when %s", async (_label, mtimes) => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue(mtimes);
    loadScriptParametersMock.mockResolvedValue(sampleParameters);

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "script:exporter");
    expect(row?.status).toBe("warn");
    expect(row?.detail).toContain("pnpm build");
    expect(code).toBe(0);
  });

  test("renders ok with the parameter count when dist is at least as fresh as src and import succeeds", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: 100, distMtimeMs: 200 });
    loadScriptParametersMock.mockResolvedValue(sampleParameters);

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "script:exporter");
    expect(row?.status).toBe("ok");
    expect(row?.detail).toContain(String(sampleParameters.length));
    expect(code).toBe(0);
  });
});

describe("runDoctor — per-script config-importability check", () => {
  test("fails a script's row with the load-error message as detail when loadScriptParameters (the real loader) rejects", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: 100, distMtimeMs: 200 });
    loadScriptParametersMock.mockRejectedValue(
      new Error("cannot import config module"),
    );

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    expect(loadScriptParametersMock).toHaveBeenCalledWith(
      exporterCandidate.directory,
    );
    const row = findCheck(parseChecks(infoLines), "script:exporter");
    expect(row?.status).toBe("fail");
    expect(row?.detail).toContain("cannot import config module");
    expect(code).toBe(1);
  });

  test("a stale dist AND a failing import together resolve to fail, not warn", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: 500, distMtimeMs: 100 });
    loadScriptParametersMock.mockRejectedValue(new Error("boom"));

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "script:exporter");
    expect(row?.status).toBe("fail");
    expect(code).toBe(1);
  });
});

describe("runDoctor — multiple scripts render one row each", () => {
  test("renders a script:<name> row per discovered candidate, in discovery order", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate, importerCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: 100, distMtimeMs: 200 });
    loadScriptParametersMock.mockResolvedValue(sampleParameters);

    const { context, infoLines } = buildContext();
    await runDoctor(context);

    const checks = parseChecks(infoLines);
    expect(findCheck(checks, "script:exporter")?.status).toBe("ok");
    expect(findCheck(checks, "script:importer")?.status).toBe("ok");
  });
});

describe("runDoctor — reserved-names check", () => {
  test.each(["list", "inspect", "run", "doctor", "new", "help"])(
    "fails naming the collision when a discovered script is named '%s'",
    async (reservedName) => {
      discoverScriptsMock.mockReturnValue([
        {
          name: reservedName,
          directory: `/workspace-root/scripts/${reservedName}`,
          description: "",
        },
      ]);
      configMtimesMock.mockReturnValue({ srcMtimeMs: 100, distMtimeMs: 200 });
      loadScriptParametersMock.mockResolvedValue([]);

      const { context, infoLines } = buildContext();
      const code = await runDoctor(context);

      const row = findCheck(parseChecks(infoLines), "reserved-names");
      expect(row?.status).toBe("fail");
      expect(row?.detail).toContain(reservedName);
      expect(code).toBe(1);
    },
  );

  test("ok when no discovered script name collides with a reserved command name", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: 100, distMtimeMs: 200 });
    loadScriptParametersMock.mockResolvedValue([]);

    const { context, infoLines } = buildContext();
    await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "reserved-names");
    expect(row?.status).toBe("ok");
  });
});

describe("runDoctor — cache check", () => {
  test("warns naming the path when the cache file's parent directory is not writable (EACCES)", async () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), {
        code: "EACCES",
      });
    });

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "cache");
    expect(row?.status).toBe("warn");
    expect(row?.detail).toContain(context.cacheFilePath);
    expect(code).toBe(0);
  });

  test("warns naming the path when the cache file's parent directory is not writable (EPERM)", async () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), {
        code: "EPERM",
      });
    });

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "cache");
    expect(row?.status).toBe("warn");
    expect(row?.detail).toContain(context.cacheFilePath);
    expect(code).toBe(0);
  });

  test("rejects with M3LCliError ERR_CLI_DOCTOR_FAILED, cause chained, when accessSync fails for a non-permission reason", async () => {
    const originalError = Object.assign(new Error("input/output error"), {
      code: "EIO",
    });
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw originalError;
    });

    const { context } = buildContext();

    let thrown: unknown;
    try {
      await runDoctor(context);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_DOCTOR_FAILED");
    expect((thrown as M3LCliError).cause).toBe(originalError);
  });

  test("warns 'unreadable/invalid — will be rebuilt' when the cache file exists but its content is invalid JSON", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("not json{");

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "cache");
    expect(row?.status).toBe("warn");
    expect(row?.detail).toMatch(/rebuil|invalid|unreadable/i);
    expect(code).toBe(0);
  });

  test("warns 'unreadable/invalid — will be rebuilt' when the cache file exists but parses to a non-object payload", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("[]");

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "cache");
    expect(row?.status).toBe("warn");
    expect(row?.detail).toMatch(/rebuil|invalid|unreadable/i);
    expect(code).toBe(0);
  });

  test("ok ('will be created') when the cache file does not exist and the parent directory is writable", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "cache");
    expect(row?.status).toBe("ok");
    expect(code).toBe(0);
  });

  test("ok naming 0 entries when the cache file exists and parses to a legitimately empty object", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("{}");
    readDiscoveryCacheMock.mockReturnValue({});

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "cache");
    expect(row?.status).toBe("ok");
    expect(row?.detail).toContain("0 entries");
    expect(code).toBe(0);
  });

  test("ok with the entry count when the cache file exists and parses to a populated object", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        exporter: { srcMtimeMs: 1, distMtimeMs: 2, parameters: [] },
      }),
    );
    readDiscoveryCacheMock.mockReturnValue({
      exporter: { srcMtimeMs: 1, distMtimeMs: 2, parameters: [] },
    });

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "cache");
    expect(row?.status).toBe("ok");
    expect(row?.detail).toContain("1 entry");
    expect(code).toBe(0);
  });
});

/**
 * m3l-cli 8f addendum — the "history" check mirrors the "cache" check's
 * absent/valid/invalid arms, reading `context.historyFilePath`.
 */
describe("runDoctor — history check (8f)", () => {
  test("ok ('will be created') when the history file does not exist", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    readHistoryMock.mockReturnValue([]);

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "history");
    expect(row?.status).toBe("ok");
    expect(row?.detail).toMatch(/will be created/i);
    expect(code).toBe(0);
  });

  test("ok naming the entry count when the history file exists and parses to a valid entry array", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          script: "exporter",
          parameterNames: [],
          exitCode: 0,
        },
      ]),
    );
    readHistoryMock.mockReturnValue([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        script: "exporter",
        parameterNames: [],
        exitCode: 0,
      },
    ]);

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "history");
    expect(row?.status).toBe("ok");
    expect(row?.detail).toMatch(/1 entr/);
    expect(code).toBe(0);
  });

  test("warns 'will be rebuilt' when the history file exists but is invalid/unreadable", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("not json{");
    readHistoryMock.mockReturnValue([]);

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "history");
    expect(row?.status).toBe("warn");
    expect(row?.detail).toMatch(/rebuil|invalid|unreadable/i);
    expect(code).toBe(0);
  });
});

describe("runDoctor — exit code semantics", () => {
  test("returns 1 when any check is fail, even alongside warns", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: null, distMtimeMs: null });
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), {
        code: "EACCES",
      });
    });

    const { context } = buildContext();
    const code = await runDoctor(context);

    expect(code).toBe(1);
  });

  test("returns 0 when every check is ok or warn (no fail)", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: 500, distMtimeMs: null });
    loadScriptParametersMock.mockResolvedValue(sampleParameters);
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), {
        code: "EACCES",
      });
    });

    const { context } = buildContext();
    const code = await runDoctor(context);

    expect(code).toBe(0);
  });

  test("returns 0 when every check is ok", async () => {
    const { context } = buildContext();
    const code = await runDoctor(context);

    expect(code).toBe(0);
  });
});

/**
 * U7 (ADR-0054 in-process host) — each discovered candidate also gets a
 * `command-module:<name>` row, built from `loadCommandModule` (imported
 * from `../run/in-process.js`). This check can NEVER resolve `"fail"`:
 * absence of an adopted command module is the expected/optional state for
 * every fleet script that hasn't opted in yet.
 */
describe("runDoctor — command-module check (U7)", () => {
  test("resolves 'ok' when the candidate has a valid command module", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: 100, distMtimeMs: 200 });
    loadScriptParametersMock.mockResolvedValue(sampleParameters);
    loadCommandModuleMock.mockResolvedValue({
      name: "exporter",
      version: "1.0.0",
      configParameters: [],
      execute: () => Promise.resolve({ status: "success" }),
    });

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "command-module:exporter");
    expect(row?.status).toBe("ok");
    expect(code).toBe(0);
  });

  test("resolves 'warn' (never 'fail') when the candidate has no dist/command.js (loadCommandModule resolves undefined)", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: 100, distMtimeMs: 200 });
    loadScriptParametersMock.mockResolvedValue(sampleParameters);
    loadCommandModuleMock.mockResolvedValue(undefined);

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "command-module:exporter");
    expect(row?.status).toBe("warn");
    expect(code).toBe(0);
  });

  test("resolves 'warn' (never 'fail') with a fixed safe detail message when dist/command.js exists but fails to import — the underlying import error's own message/content must never leak into the rendered detail", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: 100, distMtimeMs: 200 });
    loadScriptParametersMock.mockResolvedValue(sampleParameters);
    // A deliberately distinctive, secret-shaped planted string: this test
    // fails if a regression reintroduces raw error.message interpolation
    // (security-reviewer finding — checkCommandModule's underlying loader,
    // loadCommandModule, deliberately propagates import failures UNWRAPPED,
    // so whatever the script's own dist/command.js threw at import time
    // would otherwise render verbatim in `m3l doctor`'s plain-text table AND
    // its --json output).
    loadCommandModuleMock.mockRejectedValue(
      new Error("boom: AWS_SECRET_ACCESS_KEY=fake-leaked-value-xyz"),
    );

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "command-module:exporter");
    expect(row?.status).toBe("warn");
    expect(row?.detail).not.toContain("fake-leaked-value-xyz");
    expect(row?.detail).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(row?.detail).toContain("dist/command.js failed to import");
    expect(code).toBe(0);
  });

  test("a command-module row alone (warn) never flips runDoctor's overall exit code to 1, even though every other check is ok", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: 100, distMtimeMs: 200 });
    loadScriptParametersMock.mockResolvedValue(sampleParameters);
    loadCommandModuleMock.mockResolvedValue(undefined);

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const checks = parseChecks(infoLines);
    // End-to-end confirmation: every OTHER check is ok/passing, and the
    // command-module row is the only warn present — the overall exit code
    // must still be 0, proving this check category cannot by itself flip
    // runDoctor's exit code (it structurally never emits "fail").
    const nonCommandModuleChecks = checks.filter(
      (check) => !check.name.startsWith("command-module:"),
    );
    expect(nonCommandModuleChecks.every((check) => check.status === "ok")).toBe(
      true,
    );
    const commandModuleRow = findCheck(checks, "command-module:exporter");
    expect(commandModuleRow?.status).toBe("warn");
    expect(code).toBe(0);
  });

  test("renders one command-module:<name> row per discovered candidate, alongside its script:<name> row", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate, importerCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: 100, distMtimeMs: 200 });
    loadScriptParametersMock.mockResolvedValue(sampleParameters);
    loadCommandModuleMock.mockResolvedValue(undefined);

    const { context, infoLines } = buildContext();
    await runDoctor(context);

    const checks = parseChecks(infoLines);
    expect(findCheck(checks, "script:exporter")).toBeDefined();
    expect(findCheck(checks, "command-module:exporter")).toBeDefined();
    expect(findCheck(checks, "script:importer")).toBeDefined();
    expect(findCheck(checks, "command-module:importer")).toBeDefined();
  });
});

describe("runDoctor — rendering modes", () => {
  test("renders a JSON array of checks to stdout when jsonOutput is true", async () => {
    const { context, infoLines } = buildContext({ jsonOutput: true });

    await runDoctor(context);

    const checks = parseChecks(infoLines);
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) {
      expect(check).toHaveProperty("name");
      expect(check).toHaveProperty("status");
      expect(check).toHaveProperty("detail");
    }
  });

  test("renders an aligned CHECK/STATUS/DETAIL table via heading+info when jsonOutput is false", async () => {
    const { context, infoLines, headingLines } = buildContext({
      jsonOutput: false,
    });

    const code = await runDoctor(context);

    expect(code).toBe(0);
    expect(headingLines.length).toBeGreaterThan(0);
    const rendered = infoLines.join("\n");
    expect(rendered).toContain("CHECK");
    expect(rendered).toContain("STATUS");
    expect(rendered).toContain("DETAIL");
    expect(rendered).toContain("node-version");
  });
});

describe("runDoctor — unexpected check-executor failure", () => {
  test("propagates rather than swallowing an unexpected collaborator failure into a fail row", async () => {
    discoverScriptsMock.mockImplementation(() => {
      throw new Error("unexpected discovery blowup");
    });

    const { context } = buildContext();

    await expect(runDoctor(context)).rejects.toThrow();
  });

  test("wraps a plain Error from discoverScripts as M3LCliError ERR_CLI_DOCTOR_FAILED with the original chained as cause", async () => {
    const originalError = new Error("unexpected discovery blowup");
    discoverScriptsMock.mockImplementation(() => {
      throw originalError;
    });

    const { context } = buildContext();

    let thrown: unknown;
    try {
      await runDoctor(context);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_DOCTOR_FAILED");
    expect((thrown as M3LCliError).cause).toBe(originalError);
  });
});

/**
 * Extracts the double-quoted string members of a `[...]` / `new Set([...])`
 * array literal captured by `pattern`'s first capture group. Used only by the
 * drift-guard test below, which reads both source files as plain text for
 * symmetry with `doctor.ts`'s own regex-extraction, and because a plain-text
 * diff between the two sources is the actual thing being guarded against.
 * The manifest source is `packages/m3l-cli/src/scaffold/manifest.ts` (inside
 * this package, ADR-0053 U9).
 */
function extractSetLiteral(source: string, pattern: RegExp): Set<string> {
  const match = pattern.exec(source);
  if (!match?.[1]) {
    throw new Error(`pattern ${pattern.source} did not match the source text`);
  }
  const members = [...match[1].matchAll(/"([^"]+)"/g)]
    .map((quotedMatch) => quotedMatch[1])
    .filter((value): value is string => value !== undefined);
  return new Set(members);
}

describe("runDoctor — reserved-names drift guard vs packages/m3l-cli/src/scaffold/manifest.ts", () => {
  test("RESERVED_COMMAND_NAMES stays set-equal to scaffold/manifest.ts's RESERVED_CLI_NAMES", () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const doctorSource = fs.readFileSync(
      join(repoRoot, "packages/m3l-cli/src/commands/doctor.ts"),
      "utf8",
    );
    const scaffoldSource = fs.readFileSync(
      join(repoRoot, "packages/m3l-cli/src/scaffold/manifest.ts"),
      "utf8",
    );

    const doctorNames = extractSetLiteral(
      doctorSource,
      /RESERVED_COMMAND_NAMES:\s*readonly string\[\]\s*=\s*\[([\s\S]*?)\]/,
    );
    const scaffoldNames = extractSetLiteral(
      scaffoldSource,
      /RESERVED_CLI_NAMES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/,
    );

    // Both extractions must have found something real, or an equal-but-empty
    // pair of sets would pass this test for the wrong reason (a regex that
    // stopped matching either source file, e.g. after a rename).
    expect(doctorNames.size).toBeGreaterThan(0);
    expect(scaffoldNames.size).toBeGreaterThan(0);

    const missingFromDoctor = [...scaffoldNames].filter(
      (name) => !doctorNames.has(name),
    );
    const extraInDoctor = [...doctorNames].filter(
      (name) => !scaffoldNames.has(name),
    );

    expect(
      missingFromDoctor,
      `doctor.ts's RESERVED_COMMAND_NAMES is missing name(s) present in scaffold/manifest.ts's RESERVED_CLI_NAMES: ${missingFromDoctor.join(", ")}`,
    ).toEqual([]);
    expect(
      extraInDoctor,
      `doctor.ts's RESERVED_COMMAND_NAMES has name(s) not present in scaffold/manifest.ts's RESERVED_CLI_NAMES: ${extraInDoctor.join(", ")}`,
    ).toEqual([]);
  });
});

describe("runDoctor — type contract", () => {
  test("M3LCliDoctorStatus is the three-member ok|warn|fail union", () => {
    expectTypeOf<M3LCliDoctorStatus>().toEqualTypeOf<"ok" | "warn" | "fail">();
  });

  test("M3LCliDoctorCheck is a readonly name/status/detail record", () => {
    expectTypeOf<M3LCliDoctorCheck>().toEqualTypeOf<{
      readonly name: string;
      readonly status: M3LCliDoctorStatus;
      readonly detail: string;
    }>();
  });
});
