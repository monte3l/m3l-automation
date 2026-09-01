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
import * as nodeModule from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Make 'node:fs' configurable so vi.spyOn can intercept individual functions
// (ESM namespace objects are non-writable) — mirrors cache.test.ts's pattern.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

// Same non-writable-ESM-namespace reason, so vi.spyOn can override
// createRequire's return value — used only by the "share one resolver"
// describe block below, to drive the REAL resolveScriptManifestDefault's
// non-MODULE_NOT_FOUND propagation path (mirrors discover.test.ts's own
// resolveScriptManifestDefault error-narrowing tests).
vi.mock("node:module", async () => {
  const actual = await vi.importActual<typeof nodeModule>("node:module");
  return { ...actual };
});

import { runDoctor } from "../src/commands/doctor.js";
import type {
  M3LCliDoctorCheck,
  M3LCliDoctorStatus,
} from "../src/commands/doctor.js";
import type { M3LCliCommandContext } from "../src/commands/context.js";
import {
  diagnoseDependencyGraph,
  discoverScripts,
} from "../src/discovery/discover.js";
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
  diagnoseDependencyGraph: vi.fn(),
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
const diagnoseDependencyGraphMock = vi.mocked(diagnoseDependencyGraph);
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
  diagnoseDependencyGraphMock.mockReturnValue({ resolved: [], unresolved: [] });
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
  diagnoseDependencyGraphMock.mockReset();
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
    env: {},
    envFile: { kind: "auto" },
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
    secret: false,
    operations: [],
  },
  {
    name: "verbose",
    aliases: [],
    type: "BOOL",
    required: false,
    defaultValue: undefined,
    description: "",
    secret: false,
    operations: [],
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

/**
 * U7 (ADR-0054, "discovery starts resolving over the dependency graph") —
 * a new `dependency-graph` row, built from `diagnoseDependencyGraph`
 * (imported from `../discovery/discover.js`, alongside `discoverScripts`).
 * Reports how many declared `@m3l-automation/*` script dependencies resolved
 * successfully vs. how many are declared-but-unresolvable. This check can
 * NEVER resolve `"fail"`: a script package failing to resolve is recoverable
 * via `pnpm install`, not a hard failure.
 */
describe("runDoctor — dependency-graph check (U7)", () => {
  test("resolves 'ok' when every declared dependency resolved", async () => {
    diagnoseDependencyGraphMock.mockReturnValue({
      resolved: ["json-etl", "s3-objects"],
      unresolved: [],
    });

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "dependency-graph");
    expect(row?.status).toBe("ok");
    expect(code).toBe(0);
  });

  test("resolves 'ok' when zero dependencies are declared (a legitimate near-term state before the manifest change lands)", async () => {
    diagnoseDependencyGraphMock.mockReturnValue({
      resolved: [],
      unresolved: [],
    });

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "dependency-graph");
    expect(row?.status).toBe("ok");
    expect(code).toBe(0);
  });

  test("resolves 'warn' (never 'fail'), naming the unresolvable dependency in detail, when at least one declared dependency fails to resolve", async () => {
    diagnoseDependencyGraphMock.mockReturnValue({
      resolved: ["json-etl"],
      unresolved: ["stale-symlink"],
    });

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "dependency-graph");
    expect(row?.status).toBe("warn");
    expect(row?.detail).toContain("stale-symlink");
    expect(code).toBe(0);
  });

  test("names every unresolvable dependency in detail when more than one fails to resolve", async () => {
    diagnoseDependencyGraphMock.mockReturnValue({
      resolved: [],
      unresolved: ["stale-symlink-one", "stale-symlink-two"],
    });

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const row = findCheck(parseChecks(infoLines), "dependency-graph");
    expect(row?.status).toBe("warn");
    expect(row?.detail).toContain("stale-symlink-one");
    expect(row?.detail).toContain("stale-symlink-two");
    expect(code).toBe(0);
  });

  test("a dependency-graph row alone (warn) never flips runDoctor's overall exit code to 1, even though every other check is ok", async () => {
    diagnoseDependencyGraphMock.mockReturnValue({
      resolved: [],
      unresolved: ["stale-symlink"],
    });

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const checks = parseChecks(infoLines);
    const nonDependencyGraphChecks = checks.filter(
      (check) => check.name !== "dependency-graph",
    );
    expect(
      nonDependencyGraphChecks.every((check) => check.status === "ok"),
    ).toBe(true);
    const dependencyGraphRow = findCheck(checks, "dependency-graph");
    expect(dependencyGraphRow?.status).toBe("warn");
    expect(code).toBe(0);
  });
});

/**
 * Should-fix (silent-failure-hunter review of #531): unlike its sibling
 * `checkCommandModule` (which wraps `loadCommandModule` in its own
 * try/catch so a broken script's command module only degrades ITS OWN row),
 * `checkDependencyGraph` currently calls `diagnoseDependencyGraph()` with no
 * try/catch of its own — an unexpected throw propagates all the way out of
 * `runDoctor`'s per-check loop, aborting EVERY other check, not just this
 * one row. The fix wraps `diagnoseDependencyGraph()` the same way, returning
 * a "warn" row (never "fail") on catch.
 *
 * NOTE — this test mocks `discoverScripts` and `diagnoseDependencyGraph` as
 * two INDEPENDENT `vi.fn()`s (leaving `discoverScriptsMock` succeeding while
 * only `diagnoseDependencyGraphMock` throws), so it does NOT cover the
 * separate doctor.ts-level call-order bug where `runDoctor`'s own unguarded
 * `discoverScripts(context.workspaceRoot)` call (line ~565, BEFORE
 * `checkDependencyGraph()` even runs) shares the exact same underlying
 * `resolveScriptManifestDefault` resolver with `diagnoseDependencyGraph` in
 * production. See the "share one resolver" describe block below for that.
 */
describe("runDoctor — dependency-graph check isolation from diagnoseDependencyGraph failing (Should-fix)", () => {
  test("an unexpected diagnoseDependencyGraph failure degrades only the dependency-graph row to warn and does not abort the rest of the run — mirrors checkCommandModule's isolation pattern", async () => {
    discoverScriptsMock.mockReturnValue([exporterCandidate]);
    configMtimesMock.mockReturnValue({ srcMtimeMs: 100, distMtimeMs: 200 });
    loadScriptParametersMock.mockResolvedValue(sampleParameters);
    loadCommandModuleMock.mockResolvedValue({
      name: "exporter",
      version: "1.0.0",
      configParameters: [],
      execute: () => Promise.resolve({ status: "success" }),
    });
    diagnoseDependencyGraphMock.mockImplementation(() => {
      throw new Error("unexpected dependency-graph blowup");
    });

    const { context, infoLines } = buildContext();
    const code = await runDoctor(context);

    const checks = parseChecks(infoLines);
    const dependencyGraphRow = findCheck(checks, "dependency-graph");
    expect(dependencyGraphRow?.status).toBe("warn");
    expect(dependencyGraphRow?.status).not.toBe("fail");

    // Isolation: every OTHER check still ran and shows up in the results —
    // the failure did not abort the whole run.
    expect(findCheck(checks, "node-version")).toBeDefined();
    expect(findCheck(checks, "workspace-root")).toBeDefined();
    expect(findCheck(checks, "script:exporter")).toBeDefined();
    expect(findCheck(checks, "command-module:exporter")).toBeDefined();
    expect(findCheck(checks, "reserved-names")).toBeDefined();
    expect(findCheck(checks, "cache")).toBeDefined();
    expect(findCheck(checks, "history")).toBeDefined();
    const otherChecks = checks.filter(
      (check) => check.name !== "dependency-graph",
    );
    expect(otherChecks.every((check) => check.status === "ok")).toBe(true);

    expect(code).toBe(0);
  });
});

/**
 * [KNOWN BUG] eed7dfb, three independent review passes — `runDoctor`'s OWN
 * unguarded call, `discoverScripts(context.workspaceRoot)` (doctor.ts around
 * line 565, BEFORE `checkDependencyGraph()` even runs), and
 * `checkDependencyGraph`'s guarded call to `diagnoseDependencyGraph()` share
 * the exact same underlying, module-private `resolveScriptManifestDefault`
 * resolver (discover.ts) — deliberately designed to swallow only
 * `MODULE_NOT_FOUND` and re-throw anything else (see discover.test.ts's own
 * "resolveScriptManifestDefault's error narrowing" tests). The isolation
 * test above cannot see this because it mocks `discoverScripts` and
 * `diagnoseDependencyGraph` as two INDEPENDENT `vi.fn()`s. These tests route
 * BOTH mocked seams through to the REAL discover.ts implementation (via
 * `vi.importActual`), so a non-MODULE_NOT_FOUND resolution error's actual,
 * shared propagation path is exercised: today it throws out of
 * `discoverScripts` before `checkDependencyGraph` ever runs, `runDoctor`'s
 * outer catch wraps it as `M3LCliError("ERR_CLI_DOCTOR_FAILED", ...)`, and
 * the ENTIRE run aborts with no rows rendered at all. The planned fix
 * retries `discoverScripts(context.workspaceRoot, { resolveScriptManifest:
 * () => undefined })` when the first, unguarded call throws — an override
 * that can never throw again, so the retry safely degrades to
 * filesystem-only candidates while `checkDependencyGraph`'s own
 * `dependency-graph` row still independently reports "warn" for the same
 * underlying problem.
 */
describe("runDoctor — discoverScripts and checkDependencyGraph share one resolver; a resolution blowup must not abort the whole run", () => {
  const OWN_MANIFEST_HREF = new URL("../package.json", import.meta.url).href;
  const SCRIPTS_DIR = join("/workspace-root", "scripts");
  const FS_ONLY_SCRIPT_DIR = join(SCRIPTS_DIR, "fs-only-script");
  const FS_ONLY_SCRIPT_MANIFEST = join(FS_ONLY_SCRIPT_DIR, "package.json");

  let actualDiscoverScripts: typeof discoverScripts;
  let actualDiagnoseDependencyGraph: typeof diagnoseDependencyGraph;

  beforeEach(async () => {
    const actual = await vi.importActual<{
      discoverScripts: typeof discoverScripts;
      diagnoseDependencyGraph: typeof diagnoseDependencyGraph;
    }>("../src/discovery/discover.js");
    actualDiscoverScripts = actual.discoverScripts;
    actualDiagnoseDependencyGraph = actual.diagnoseDependencyGraph;

    // Both mocked seams delegate to the REAL implementation — proving the
    // shared collaborator's actual behavior, not a hand-authored stand-in.
    discoverScriptsMock.mockImplementation((workspaceRoot, graphOptions) =>
      actualDiscoverScripts(workspaceRoot, graphOptions),
    );
    diagnoseDependencyGraphMock.mockImplementation((graphOptions) =>
      actualDiagnoseDependencyGraph(graphOptions),
    );

    // A non-MODULE_NOT_FOUND resolution failure from the real, shared
    // resolveScriptManifestDefault — e.g. a malformed subpath export or a
    // permissions fault, never the tolerated "not installed yet" case.
    vi.spyOn(nodeModule, "createRequire").mockReturnValue({
      resolve: () => {
        throw Object.assign(new Error("permission denied"), {
          code: "EACCES",
        });
      },
    } as unknown as ReturnType<typeof nodeModule.createRequire>);

    vi.spyOn(fs, "existsSync").mockImplementation((path) => {
      const value = String(path);
      return (
        value === OWN_MANIFEST_HREF ||
        value === SCRIPTS_DIR ||
        value === FS_ONLY_SCRIPT_MANIFEST
      );
    });
    vi.spyOn(fs, "readdirSync").mockImplementation(((path: unknown) =>
      String(path) === SCRIPTS_DIR
        ? [{ name: "fs-only-script", isDirectory: () => true }]
        : []) as unknown as typeof fs.readdirSync);
    vi.spyOn(fs, "readFileSync").mockImplementation((path) => {
      const value = String(path);
      if (value === OWN_MANIFEST_HREF) {
        return JSON.stringify({
          dependencies: {
            "@m3l-automation/graph-dep-that-blows-up": "workspace:*",
            "@m3l-automation/m3l-common": "workspace:*",
          },
        });
      }
      if (value === FS_ONLY_SCRIPT_MANIFEST) {
        return JSON.stringify({ description: "found via filesystem scan" });
      }
      return JSON.stringify({});
    });
  });

  test("runDoctor does not throw/reject and still renders a full row set (including dependency-graph, node-version, workspace-root) when the shared resolver blows up on discoverScripts's own unguarded call", async () => {
    const { context, infoLines } = buildContext();

    const exitCode = await runDoctor(context);

    const checks = parseChecks(infoLines);
    expect(findCheck(checks, "node-version")).toBeDefined();
    expect(findCheck(checks, "workspace-root")).toBeDefined();
    expect(findCheck(checks, "reserved-names")).toBeDefined();
    expect(findCheck(checks, "cache")).toBeDefined();
    expect(findCheck(checks, "history")).toBeDefined();
    const dependencyGraphRow = findCheck(checks, "dependency-graph");
    expect(dependencyGraphRow?.status).toBe("warn");

    // The shared resolver's blowup must never resolve "fail" anywhere.
    expect(checks.every((check) => check.status !== "fail")).toBe(true);
    expect(exitCode).toBe(0);
  });

  test("falls back to filesystem-only discovery: the script rows equal exactly what pure filesystem discovery alone would produce — the graph-resolved candidate is absent, not silently duplicated or partially included", async () => {
    const { context, infoLines } = buildContext();

    const exitCode = await runDoctor(context);

    const checks = parseChecks(infoLines);
    const scriptRowNames = checks
      .filter((check) => check.name.startsWith("script:"))
      .map((check) => check.name)
      .toSorted();

    // What pure filesystem-only discovery alone produces: the same real
    // discoverScripts, with zero declared graph dependencies, so this
    // expectation can never accidentally include a graph candidate itself.
    const filesystemOnlyCandidates = actualDiscoverScripts("/workspace-root", {
      readOwnManifest: () => ({ dependencies: {} }),
    });

    expect(scriptRowNames).toEqual(
      filesystemOnlyCandidates
        .map((candidate) => `script:${candidate.name}`)
        .toSorted(),
    );
    expect(scriptRowNames).not.toContain("script:graph-dep-that-blows-up");
    expect(scriptRowNames).toContain("script:fs-only-script");
    expect(exitCode).toBe(0);
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

describe("runDoctor — reserved-names drift guard across doctor/manifest/dynamic", () => {
  test("all three reserved-name literals stay set-equal", () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const doctorSource = fs.readFileSync(
      join(repoRoot, "packages/m3l-cli/src/commands/doctor.ts"),
      "utf8",
    );
    const scaffoldSource = fs.readFileSync(
      join(repoRoot, "packages/m3l-cli/src/scaffold/manifest.ts"),
      "utf8",
    );
    const dynamicSource = fs.readFileSync(
      join(repoRoot, "packages/m3l-cli/src/commands/dynamic.ts"),
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
    const dynamicNames = extractSetLiteral(
      dynamicSource,
      /STATIC_COMMAND_NAMES:\s*readonly string\[\]\s*=\s*\[([\s\S]*?)\]/,
    );

    // Every extraction must have found something real, or an equal-but-empty
    // trio of sets would pass this test for the wrong reason (a regex that
    // stopped matching one of the source files, e.g. after a rename).
    expect(doctorNames.size).toBeGreaterThan(0);
    expect(scaffoldNames.size).toBeGreaterThan(0);
    expect(dynamicNames.size).toBeGreaterThan(0);

    // `scaffold/manifest.ts`'s RESERVED_CLI_NAMES is the ADR-0042 source of
    // truth; the other two mirror it. Comparing sorted arrays (rather than a
    // pairwise membership diff) reports both directions of drift at once and
    // extends to a third literal without another block of filters —
    // `dynamic.ts`'s copy was previously unguarded and could silently
    // diverge, which is exactly what U12 (adding `completion`) would have hit.
    const sorted = (names: Set<string>): string[] => [...names].toSorted();

    expect(
      sorted(doctorNames),
      "doctor.ts's RESERVED_COMMAND_NAMES has drifted from scaffold/manifest.ts's RESERVED_CLI_NAMES",
    ).toEqual(sorted(scaffoldNames));
    expect(
      sorted(dynamicNames),
      "commands/dynamic.ts's STATIC_COMMAND_NAMES has drifted from scaffold/manifest.ts's RESERVED_CLI_NAMES",
    ).toEqual(sorted(scaffoldNames));
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
