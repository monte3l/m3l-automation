/**
 * Tests for src/run/in-process.ts — the ADR-0054/U7 in-process command host.
 * `loadCommandModule` resolves `<scriptDirectory>/dist/command.js`, imports
 * it (an injectable `importModule` seam mirrors `run/spawn.ts`'s
 * `spawnImpl`), and returns its `commandModule` export only when it exists
 * and passes `Core.isM3LCommandModule` — `undefined` (never throwing) when
 * absent/invalid, but PROPAGATING a genuine import failure. `runInProcess`
 * loads the module, builds a `Core.M3LCommandContext` (output passed
 * straight through, logger via `Core.createCommandLogger`, `signal:
 * undefined`, `dryRun` forwarded), calls `execute`, and maps the resolved
 * outcome to an exit code via `Core.mapCommandOutcomeToExitCode` — raising
 * `M3LCliError` coded `ERR_CLI_COMMAND_MODULE_INVALID` (no adopted seam, or a
 * propagated import failure) or `ERR_CLI_IN_PROCESS_FAILED` (execute itself
 * throws, or resolves a malformed outcome).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";

import type * as M3LCommon from "@m3l-automation/m3l-common";

// Make 'node:fs' configurable so vi.spyOn can intercept individual functions
// (ESM namespace objects are non-writable) — mirrors run/spawn.ts's own test.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return { ...actual };
});

/**
 * `Core.createCommandLogger` is mocked at the package level (the fleet's
 * established `vi.mock("@m3l-automation/m3l-common", ...)` factory pattern)
 * so the exact options `runInProcess` builds can be asserted without
 * depending on the real factory's ambient `--log-level`/`M3L_LOG_LEVEL`
 * resolution or `M3LConfigSchema` construction — neither of which is under
 * test here. Every other `Core` export passes through unchanged.
 */
const runMocks = vi.hoisted(() => ({
  /** Captures every `M3LCommandLoggerOptions` bag `runInProcess` builds. */
  createCommandLoggerCalls: [] as unknown[],
}));

vi.mock("@m3l-automation/m3l-common", async (importOriginal) => {
  const actual = await importOriginal<typeof M3LCommon>();
  return {
    ...actual,
    Core: {
      ...actual.Core,
      createCommandLogger: vi.fn((options: unknown) => {
        runMocks.createCommandLoggerCalls.push(options);
        return {};
      }),
    },
  };
});

import { Core } from "@m3l-automation/m3l-common";

import { loadCommandModule, runInProcess } from "../src/run/in-process.js";
import type {
  M3LCliInProcessImportOptions,
  M3LCliInProcessOptions,
} from "../src/run/in-process.js";
import { M3LCliError } from "../src/cli/errors.js";
import type { M3LCliOutput } from "../src/cli/output.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(Core.createCommandLogger).mockReset();
  runMocks.createCommandLoggerCalls.length = 0;
});

const scriptDirectory = join("/workspace", "scripts", "foo");

/** A minimal fake `M3LCliOutput` — an inert call collector, never asserted on content by default. */
function createOutput(): M3LCliOutput {
  return {
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
  };
}

/**
 * Builds a fake command-module export shaped to pass `Core.isM3LCommandModule`
 * structurally — a plain object, not a real `M3LCommandModule<object>`
 * instance, since the guard only checks shape.
 */
function createFakeModuleExport(
  executeImpl: (
    parameters: unknown,
    context: unknown,
  ) => Promise<unknown> = () => Promise.resolve({ status: "success" }),
): {
  readonly commandModule: {
    readonly name: string;
    readonly version: string;
    readonly configParameters: readonly unknown[];
    readonly execute: typeof executeImpl;
  };
} {
  return {
    commandModule: {
      name: "foo",
      version: "1.0.0",
      configParameters: [],
      execute: executeImpl,
    },
  };
}

/**
 * Builds a `commandModule`-shaped object wrapped in a real `Proxy` whose
 * `defineProperty` trap unconditionally returns `true` (reporting success to
 * `Object.defineProperty`, which trusts a non-throwing trap's return value)
 * without ever calling `Reflect.defineProperty` — the write is silently
 * dropped. `freezeConfigParametersSnapshot`'s best-effort `try/catch` never
 * observes this: no exception is thrown, so every subsequent read of
 * `configParameters` keeps invoking the live, non-idempotent getter below —
 * defeating the whole point of the TOCTOU pin.
 */
function hostileProxyModule(): Core.M3LCommandModule<object> {
  let getterCallCount = 0;
  const target = {
    name: "hostile",
    version: "0.0.0",
    get configParameters(): readonly unknown[] {
      getterCallCount += 1;
      return getterCallCount === 1 ? [{ name: "apiKey", secret: true }] : [];
    },
    execute: () => Promise.resolve({ status: "success" }),
  };
  return new Proxy(target, {
    defineProperty() {
      return true; // lies: reports success, never actually stores anything
    },
  }) as unknown as Core.M3LCommandModule<object>;
}

describe("loadCommandModule — happy path", () => {
  test("resolves the real commandModule export when dist/command.js exists and is valid", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeExport = createFakeModuleExport();
    const importModule = vi.fn((_url: string) => Promise.resolve(fakeExport));

    const result = await loadCommandModule(scriptDirectory, { importModule });

    expect(result).toBe(fakeExport.commandModule);
    expect(importModule).toHaveBeenCalledTimes(1);
    const call = importModule.mock.calls[0];
    // A `pathToFileURL`-resolved URL for the joined `dist/command.js` path —
    // asserted by substring rather than an exact string, since the file://
    // prefix and path-separator rendering are platform-dependent.
    expect(call?.[0]).toContain("command.js");
  });
});

describe("loadCommandModule — absent dist/command.js", () => {
  test("resolves undefined without ever invoking importModule", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const importModule = vi.fn(() => Promise.resolve(createFakeModuleExport()));

    const result = await loadCommandModule(scriptDirectory, { importModule });

    expect(result).toBeUndefined();
    expect(importModule).not.toHaveBeenCalled();
  });
});

describe("loadCommandModule — invalid commandModule export", () => {
  test("resolves undefined when the exported commandModule fails Core.isM3LCommandModule (missing execute)", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const importModule = vi.fn(() =>
      Promise.resolve({
        commandModule: { name: "foo", version: "1.0.0", configParameters: [] },
      }),
    );

    const result = await loadCommandModule(scriptDirectory, { importModule });

    expect(result).toBeUndefined();
  });

  test("resolves undefined when the imported module has no commandModule property at all", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const importModule = vi.fn(() => Promise.resolve({}));

    const result = await loadCommandModule(scriptDirectory, { importModule });

    expect(result).toBeUndefined();
  });
});

describe("loadCommandModule — propagated import failure", () => {
  test("propagates the exact error importModule rejects with, unwrapped", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const importError = new Error("SyntaxError: unexpected token");
    const importModule = vi.fn(() => Promise.reject(importError));

    let thrown: unknown;
    try {
      await loadCommandModule(scriptDirectory, { importModule });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(importError);
  });
});

describe("loadCommandModule — M3LCliInProcessImportOptions contract", () => {
  test("importModule is optional — an empty options object satisfies the type", () => {
    const options: M3LCliInProcessImportOptions = {};
    expect(options.importModule).toBeUndefined();
  });
});

/** Builds `M3LCliInProcessOptions` from an output and parameter/dryRun overrides. */
function buildOptions(
  overrides: Partial<M3LCliInProcessOptions> = {},
): M3LCliInProcessOptions {
  return {
    output: createOutput(),
    parameterValues: {},
    dryRun: false,
    ...overrides,
  };
}

describe("runInProcess — happy path", () => {
  test("resolves the exit code Core.mapCommandOutcomeToExitCode produces for a successful outcome", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeExport = createFakeModuleExport(() =>
      Promise.resolve({ status: "success" }),
    );
    const importModule = vi.fn(() => Promise.resolve(fakeExport));

    const code = await runInProcess(scriptDirectory, buildOptions(), {
      importModule,
    });

    expect(code).toBe(Core.mapCommandOutcomeToExitCode({ status: "success" }));
    expect(code).toBe(Core.M3L_EXIT_CODES.SUCCESS);
  });
});

describe("runInProcess — parameterValues forwarding", () => {
  test("forwards parameterValues verbatim as execute's first argument", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const executeCalls: unknown[][] = [];
    const fakeExport = createFakeModuleExport((...args: unknown[]) => {
      executeCalls.push(args);
      return Promise.resolve({ status: "success" });
    });
    const importModule = vi.fn(() => Promise.resolve(fakeExport));
    const parameterValues = { region: "us-east-1", verbose: true };

    await runInProcess(scriptDirectory, buildOptions({ parameterValues }), {
      importModule,
    });

    expect(executeCalls[0]?.[0]).toBe(parameterValues);
  });
});

describe("runInProcess — context construction", () => {
  test("builds context.logger via Core.createCommandLogger using the loaded module's own configParameters", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeExport = createFakeModuleExport();
    const importModule = vi.fn(() => Promise.resolve(fakeExport));

    await runInProcess(scriptDirectory, buildOptions(), { importModule });

    expect(Core.createCommandLogger).toHaveBeenCalledTimes(1);
    expect(runMocks.createCommandLoggerCalls[0]).toMatchObject({
      configParameters: fakeExport.commandModule.configParameters,
      handlers: expect.any(Array) as unknown,
    });
  });

  test("passes output straight through unchanged (identity, not a copy)", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const contextCalls: unknown[] = [];
    const fakeExport = createFakeModuleExport((_parameters, context) => {
      contextCalls.push(context);
      return Promise.resolve({ status: "success" });
    });
    const importModule = vi.fn(() => Promise.resolve(fakeExport));
    const output = createOutput();

    await runInProcess(scriptDirectory, buildOptions({ output }), {
      importModule,
    });

    expect((contextCalls[0] as { readonly output: unknown }).output).toBe(
      output,
    );
  });

  test("passes signal: undefined in the built context", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const contextCalls: unknown[] = [];
    const fakeExport = createFakeModuleExport((_parameters, context) => {
      contextCalls.push(context);
      return Promise.resolve({ status: "success" });
    });
    const importModule = vi.fn(() => Promise.resolve(fakeExport));

    await runInProcess(scriptDirectory, buildOptions(), { importModule });

    expect(
      (contextCalls[0] as { readonly signal: unknown }).signal,
    ).toBeUndefined();
  });

  test.each([true, false])(
    "forwards dryRun=%s verbatim as context.dryRun",
    async (dryRun) => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const contextCalls: unknown[] = [];
      const fakeExport = createFakeModuleExport((_parameters, context) => {
        contextCalls.push(context);
        return Promise.resolve({ status: "success" });
      });
      const importModule = vi.fn(() => Promise.resolve(fakeExport));

      await runInProcess(scriptDirectory, buildOptions({ dryRun }), {
        importModule,
      });

      expect((contextCalls[0] as { readonly dryRun: unknown }).dryRun).toBe(
        dryRun,
      );
    },
  );
});

describe("runInProcess — configParameters TOCTOU (security fix)", () => {
  test("reads commandModule.configParameters exactly once and reuses that snapshot for the logger, even when the property is a non-idempotent getter that answers differently on a second read", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    // The real declared params (what Core.isM3LCommandModule's own guard
    // snapshot legitimately observed on its single read) vs. a dishonest
    // empty array on any subsequent access — a non-idempotent getter proves
    // runInProcess never re-reads the live property a second time.
    const firstReadConfigParameters = [{ name: "apiKey", secret: true }];
    let readCount = 0;
    const commandModule = {
      name: "foo",
      version: "1.0.0",
      get configParameters() {
        readCount += 1;
        return readCount === 1 ? firstReadConfigParameters : [];
      },
      execute: () => Promise.resolve({ status: "success" }),
    };
    const importModule = vi.fn(() => Promise.resolve({ commandModule }));

    await runInProcess(scriptDirectory, buildOptions(), { importModule });

    expect(Core.createCommandLogger).toHaveBeenCalledTimes(1);
    const call = runMocks.createCommandLoggerCalls[0] as {
      readonly configParameters: unknown;
    };
    expect(call.configParameters).toEqual(firstReadConfigParameters);
  });
});

describe("loadCommandModule — hostile Proxy defeats the TOCTOU pin (security fix)", () => {
  test("resolves undefined when the exported commandModule is a Proxy whose defineProperty trap lies (reports success without storing) — the fix rejects an unpinnable candidate outright, same as 'no command module found'", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const importModule = vi.fn(() =>
      Promise.resolve({ commandModule: hostileProxyModule() }),
    );

    const result = await loadCommandModule(scriptDirectory, { importModule });

    expect(result).toBeUndefined();
  });
});

describe("runInProcess — hostile Proxy defeats the TOCTOU pin (security fix)", () => {
  test("throws M3LCliError ERR_CLI_COMMAND_MODULE_INVALID when the command module is a Proxy whose defineProperty trap lies — indistinguishable from the ordinary absent case, so the same code applies", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const importModule = vi.fn(() =>
      Promise.resolve({ commandModule: hostileProxyModule() }),
    );

    let thrown: unknown;
    try {
      await runInProcess(scriptDirectory, buildOptions(), { importModule });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_COMMAND_MODULE_INVALID");
  });
});

describe("runInProcess — no adopted command module", () => {
  test("throws M3LCliError ERR_CLI_COMMAND_MODULE_INVALID naming the script and 'pnpm build'/'--in-process', with no cause, when dist/command.js is absent", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    let thrown: unknown;
    try {
      await runInProcess(scriptDirectory, buildOptions());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_COMMAND_MODULE_INVALID");
    expect((thrown as M3LCliError).message).toContain(scriptDirectory);
    expect((thrown as M3LCliError).message).toMatch(/pnpm build|--in-process/);
    expect((thrown as M3LCliError).cause).toBeUndefined();
  });

  test("throws M3LCliError ERR_CLI_COMMAND_MODULE_INVALID when the exported commandModule is invalid", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const importModule = vi.fn(() =>
      Promise.resolve({ commandModule: { name: "foo" } }),
    );

    let thrown: unknown;
    try {
      await runInProcess(scriptDirectory, buildOptions(), { importModule });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_COMMAND_MODULE_INVALID");
  });
});

describe("runInProcess — propagated import failure", () => {
  test("throws M3LCliError ERR_CLI_COMMAND_MODULE_IMPORT_FAILED (distinct from ERR_CLI_COMMAND_MODULE_INVALID's 'no adopted seam' case) with the import failure chained as cause", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const importError = new Error("boom: cannot import dist/command.js");
    const importModule = vi.fn(() => Promise.reject(importError));

    let thrown: unknown;
    try {
      await runInProcess(scriptDirectory, buildOptions(), { importModule });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe(
      "ERR_CLI_COMMAND_MODULE_IMPORT_FAILED",
    );
    expect((thrown as M3LCliError).cause).toBe(importError);
  });
});

describe("runInProcess — execute itself throws (defensive)", () => {
  test("throws M3LCliError ERR_CLI_IN_PROCESS_FAILED with the thrown value chained as cause", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const executeError = new Error("execute violated its own contract");
    const fakeExport = createFakeModuleExport(() =>
      Promise.reject(executeError),
    );
    const importModule = vi.fn(() => Promise.resolve(fakeExport));

    let thrown: unknown;
    try {
      await runInProcess(scriptDirectory, buildOptions(), { importModule });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_IN_PROCESS_FAILED");
    expect((thrown as M3LCliError).cause).toBe(executeError);
  });
});

describe("runInProcess — malformed outcome", () => {
  test("throws M3LCliError ERR_CLI_IN_PROCESS_FAILED when execute resolves a value that fails Core.isM3LCommandOutcome (bogus status)", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeExport = createFakeModuleExport(() =>
      Promise.resolve({ status: "not-a-real-status" }),
    );
    const importModule = vi.fn(() => Promise.resolve(fakeExport));

    let thrown: unknown;
    try {
      await runInProcess(scriptDirectory, buildOptions(), { importModule });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_IN_PROCESS_FAILED");
  });

  test("throws M3LCliError ERR_CLI_IN_PROCESS_FAILED when execute resolves null", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const fakeExport = createFakeModuleExport(() => Promise.resolve(null));
    const importModule = vi.fn(() => Promise.resolve(fakeExport));

    let thrown: unknown;
    try {
      await runInProcess(scriptDirectory, buildOptions(), { importModule });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LCliError);
    expect((thrown as M3LCliError).code).toBe("ERR_CLI_IN_PROCESS_FAILED");
  });
});

describe("runInProcess — outcome-to-exit-code parity", () => {
  const outcomes: readonly Core.M3LCommandOutcome[] = [
    { status: "success" },
    { status: "dry-run" },
    { status: "interrupted" },
    { status: "partial", recovered: 3 },
    {
      status: "failure",
      error: new Core.M3LError("boom", { code: "ERR_CONFIG_MISSING" }),
    },
  ];

  test.each(outcomes)(
    "maps outcome %j to the same exit code Core.mapCommandOutcomeToExitCode would produce directly",
    async (outcome) => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const fakeExport = createFakeModuleExport(() => Promise.resolve(outcome));
      const importModule = vi.fn(() => Promise.resolve(fakeExport));

      const code = await runInProcess(scriptDirectory, buildOptions(), {
        importModule,
      });

      expect(code).toBe(Core.mapCommandOutcomeToExitCode(outcome));
    },
  );
});
