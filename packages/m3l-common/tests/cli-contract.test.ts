/**
 * `core/cli-contract` — the descriptor / context / output-port slice.
 *
 * ADR-0072 slice split: this file owns `M3LCommandModule`,
 * `M3LCommandContext`, `M3LCommandOutcome`, and `M3LCommandOutput` — all
 * type-only declarations that compile to nothing. The module's public
 * surface is five exports: those four plus the mapper. There is deliberately
 * NO `M3LCommandOutputStream`: the type had zero referents anywhere in the
 * library — nothing in `M3LCommandOutput` or the rest of the contract named
 * it — so its only consumer was U7's future stream binder, and one
 * speculative consumer is the same argument that defers `isM3LCommandModule`.
 * It lands with that binder as a second additive minor.
 * The mapper `mapCommandOutcomeToExitCode` has its own file,
 * `cli-contract-exit-code.test.ts`; it is imported here only for the single
 * end-to-end test that walks a realistic descriptor all the way to an exit
 * code, because an outcome that never reaches a code proves half a seam.
 *
 * Key behavioral contracts asserted here:
 *  - Structural parity with `core/script`: an `M3LCommandModule` IS an
 *    `M3LScriptMetadata`, and `M3LCommandContext["logger"]` is exactly what
 *    `M3LScriptOptions.logger` accepts. `cli-contract` cannot import
 *    `core/script` (the ADR-0009 layering zone globs `src/core/**`), but this
 *    test file is outside that zone, so it is where the parity guarantee is
 *    actually checkable.
 *  - The context shape locks: `signal` and `dryRun` are REQUIRED properties —
 *    `signal` holds `AbortSignal | undefined` rather than being optional, so
 *    a host cannot forget the field exists under
 *    `exactOptionalPropertyTypes`.
 *  - `execute` resolves an outcome; `Promise<void>` is not assignable.
 *  - `configParameters` is the existing nominal `M3LConfigParameter` seam.
 *  - The output port is satisfied by a collecting stub.
 *  - The bare `M3LCommandModule` defaults `TParameters` to
 *    `Record<string, never>`, so a host holding an arbitrary descriptor must
 *    write `M3LCommandModule<object>`.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { mapCommandOutcomeToExitCode } from "../src/core/cli-contract/index.js";
import type {
  M3LCommandContext,
  M3LCommandModule,
  M3LCommandOutcome,
  M3LCommandOutput,
} from "../src/core/cli-contract/index.js";
import {
  M3LConfigParameter,
  M3LConfigParameterType,
} from "../src/core/config/index.js";
import { M3L_EXIT_CODES } from "../src/core/diagnostics/index.js";
import { M3LLogger } from "../src/core/logging/index.js";
import type {
  M3LScriptMetadata,
  M3LScriptOptions,
} from "../src/core/script/index.js";

// ---------------------------------------------------------------------------
// Local test doubles
// ---------------------------------------------------------------------------

/** An array-collecting `M3LCommandOutput`: the doc's own named test sink. */
interface RecordingOutput {
  readonly port: M3LCommandOutput;
  readonly info: string[];
  readonly errors: string[];
  readonly headings: string[];
}

function createRecordingOutput(colorEnabled = false): RecordingOutput {
  const info: string[] = [];
  const errors: string[] = [];
  const headings: string[] = [];
  const port: M3LCommandOutput = {
    colorEnabled,
    info(text: string): void {
      info.push(text);
    },
    error(text: string): void {
      errors.push(text);
    },
    heading(text: string): void {
      headings.push(text);
    },
  };
  return { port, info, errors, headings };
}

function createContext(
  overrides: Partial<M3LCommandContext> = {},
): M3LCommandContext {
  return {
    output: createRecordingOutput().port,
    logger: new M3LLogger([]),
    signal: undefined,
    dryRun: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Structural parity with core/script
// ---------------------------------------------------------------------------

describe("structural parity with core/script", () => {
  test("an M3LCommandModule is usable directly as M3LScriptMetadata", () => {
    expectTypeOf<M3LCommandModule>().toExtend<M3LScriptMetadata>();

    const commandModule: M3LCommandModule = {
      name: "s3-export",
      version: "1.0.0",
      configParameters: [],
      execute(): Promise<M3LCommandOutcome> {
        return Promise.resolve({ status: "success" });
      },
    };

    // The runtime half of the same claim: the descriptor is handed to
    // `new M3LScript({ metadata })` with no adapter and no second source of
    // truth for the script's own name.
    const metadata: M3LScriptMetadata = commandModule;
    expect(metadata.name).toBe("s3-export");
    expect(metadata.version).toBe("1.0.0");
  });

  test("context.logger is exactly what M3LScriptOptions.logger accepts", () => {
    expectTypeOf<M3LCommandContext["logger"]>().toEqualTypeOf<
      NonNullable<M3LScriptOptions["logger"]>
    >();

    const context = createContext();
    const options: M3LScriptOptions = {
      metadata: { name: "s3-export", version: "1.0.0" },
      logger: context.logger,
    };
    expect(options.logger).toBe(context.logger);
  });

  test("the descriptor's name/version are flat, not nested under an identity object", () => {
    expectTypeOf<M3LCommandModule["name"]>().toEqualTypeOf<string>();
    expectTypeOf<M3LCommandModule["version"]>().toEqualTypeOf<string>();
    expectTypeOf<M3LCommandModule["description"]>().toEqualTypeOf<
      string | undefined
    >();
  });
});

// ---------------------------------------------------------------------------
// configParameters — the existing nominal seam
// ---------------------------------------------------------------------------

describe("configParameters", () => {
  test("accepts constructed M3LConfigParameter instances", () => {
    const configParameters: readonly M3LConfigParameter[] = [
      new M3LConfigParameter({
        name: "bucket",
        type: M3LConfigParameterType.STRING,
      }),
      new M3LConfigParameter({
        name: "limit",
        type: M3LConfigParameterType.INT,
        defaultValue: 10,
      }),
    ];

    const commandModule: M3LCommandModule = {
      name: "s3-export",
      version: "1.0.0",
      configParameters,
      execute(): Promise<M3LCommandOutcome> {
        return Promise.resolve({ status: "success" });
      },
    };

    expect(commandModule.configParameters).toHaveLength(2);
    expect(commandModule.configParameters[0]).toBeInstanceOf(
      M3LConfigParameter,
    );
    expect(commandModule.configParameters[0]?.getName()).toBe("bucket");
  });

  test("is typed as a readonly M3LConfigParameter array", () => {
    expectTypeOf<M3LCommandModule["configParameters"]>().toEqualTypeOf<
      readonly M3LConfigParameter[]
    >();
  });

  test("rejects a hand-rolled literal — M3LConfigParameter is nominal", () => {
    const configParameters: readonly M3LConfigParameter[] = [
      // @ts-expect-error -- M3LConfigParameter carries private fields, so only
      // a value that went through the constructor (with its eager
      // defaultValue validation) can appear here.
      { name: "bucket", type: "STRING" },
    ];
    expect(configParameters).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The execution context — the shape locks are the point of this module
// ---------------------------------------------------------------------------

describe("M3LCommandContext shape locks", () => {
  test("a context carrying signal: undefined is valid", () => {
    const context: M3LCommandContext = {
      output: createRecordingOutput().port,
      logger: new M3LLogger([]),
      signal: undefined,
      dryRun: false,
    };

    expect(context.signal).toBeUndefined();
    expect(context.dryRun).toBe(false);
  });

  test("a context carrying a real AbortSignal is valid", () => {
    const controller = new AbortController();
    const context: M3LCommandContext = createContext({
      signal: controller.signal,
    });

    expect(context.signal).toBe(controller.signal);
    expect(context.signal?.aborted).toBe(false);
  });

  // ADR-0070. `correlationId` breaks this interface's own
  // required-holding-`undefined` convention on purpose: `signal` and `dryRun`
  // are values a command must BRANCH on, so the required form is right;
  // this one is passed through and its absence has a safe fallback (the
  // script resolves its own id). Making it required would also be
  // source-breaking at 15+ construction sites, turning an additive minor
  // into a major.
  test("omitting `correlationId` entirely DOES compile — it is an optional key", () => {
    const context: M3LCommandContext = {
      output: createRecordingOutput().port,
      logger: new M3LLogger([]),
      signal: undefined,
      dryRun: false,
    };

    expect(context.correlationId).toBeUndefined();
  });

  test("a context carrying a correlationId exposes it verbatim", () => {
    const context: M3LCommandContext = createContext({
      correlationId: "trace-42",
    });

    expect(context.correlationId).toBe("trace-42");
  });

  test("writing `correlationId: undefined` does not compile — contrast `signal`", () => {
    // @ts-expect-error -- an OPTIONAL key under exactOptionalPropertyTypes
    // cannot be assigned `undefined`. The sibling case above writes
    // `signal: undefined` and compiles, precisely because `signal` is
    // REQUIRED-holding-`undefined`. That contrast is the whole point: the
    // two fields are shaped differently on purpose.
    const context: M3LCommandContext = {
      output: createRecordingOutput().port,
      logger: new M3LLogger([]),
      signal: undefined,
      dryRun: false,
      correlationId: undefined,
    };

    expect(context.dryRun).toBe(false);
  });

  test("omitting `signal` entirely does not compile — it is required, not optional", () => {
    // @ts-expect-error -- `signal` is a REQUIRED property holding
    // `AbortSignal | undefined` (the M3LProcedureContext convention), not an
    // optional key: under exactOptionalPropertyTypes an optional key lets a
    // host-side helper forget the field exists.
    const context: M3LCommandContext = {
      output: createRecordingOutput().port,
      logger: new M3LLogger([]),
      dryRun: false,
    };
    expect(context.dryRun).toBe(false);
  });

  test("omitting `dryRun` entirely does not compile — false is information, not absence", () => {
    // @ts-expect-error -- `dryRun` is required, mirroring
    // M3LScriptHookContext.dryRun: a command branches on it directly without
    // a `?? false` at every call site.
    const context: M3LCommandContext = {
      output: createRecordingOutput().port,
      logger: new M3LLogger([]),
      signal: undefined,
    };
    expect(context.signal).toBeUndefined();
  });

  test("the context's field types are pinned", () => {
    expectTypeOf<M3LCommandContext["signal"]>().toEqualTypeOf<
      AbortSignal | undefined
    >();
    expectTypeOf<M3LCommandContext["dryRun"]>().toEqualTypeOf<boolean>();
    expectTypeOf<M3LCommandContext["correlationId"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<
      M3LCommandContext["output"]
    >().toEqualTypeOf<M3LCommandOutput>();
  });
});

// ---------------------------------------------------------------------------
// execute — resolves an outcome, never `void`
// ---------------------------------------------------------------------------

describe("execute", () => {
  test("resolves Promise<M3LCommandOutcome>", async () => {
    const commandModule: M3LCommandModule = {
      name: "s3-export",
      version: "1.0.0",
      configParameters: [],
      execute(): Promise<M3LCommandOutcome> {
        return Promise.resolve({ status: "success" });
      },
    };

    const outcome = await commandModule.execute({}, createContext());
    expect(outcome).toEqual({ status: "success" });
    expectTypeOf(outcome).toEqualTypeOf<M3LCommandOutcome>();
  });

  test("the execute signature returns exactly Promise<M3LCommandOutcome>", () => {
    expectTypeOf<M3LCommandModule["execute"]>().returns.toEqualTypeOf<
      Promise<M3LCommandOutcome>
    >();
  });

  test("a Promise<void> execute does not compile — a command must declare an outcome", () => {
    const commandModule: M3LCommandModule = {
      name: "no-outcome",
      version: "1.0.0",
      configParameters: [],
      // @ts-expect-error -- `Promise<void>` is not assignable: a command
      // cannot finish without declaring what happened.
      async execute(): Promise<void> {
        await Promise.resolve();
      },
    };
    expect(commandModule.name).toBe("no-outcome");
  });

  test("TParameters is carried through to execute's first argument", async () => {
    interface ExportParameters {
      readonly bucket: string;
      readonly limit: number;
    }

    const commandModule: M3LCommandModule<ExportParameters> = {
      name: "s3-export",
      version: "1.0.0",
      configParameters: [],
      execute(parameters): Promise<M3LCommandOutcome> {
        expectTypeOf(parameters).toEqualTypeOf<ExportParameters>();
        return Promise.resolve({
          status: "partial",
          recovered: parameters.limit,
        });
      },
    };

    const outcome = await commandModule.execute(
      { bucket: "b", limit: 4 },
      createContext(),
    );
    expect(outcome).toEqual({ status: "partial", recovered: 4 });
  });
});

// ---------------------------------------------------------------------------
// The TParameters default — what a host that holds an arbitrary descriptor
// has to write
// ---------------------------------------------------------------------------

describe("the TParameters default", () => {
  interface ExportParameters {
    readonly bucket: string;
  }

  const concrete: M3LCommandModule<ExportParameters> = {
    name: "s3-export",
    version: "1.0.0",
    configParameters: [],
    execute(): Promise<M3LCommandOutcome> {
      return Promise.resolve({ status: "success" });
    },
  };

  test("a concrete descriptor is NOT assignable to the bare M3LCommandModule", () => {
    // @ts-expect-error -- the bare name defaults `TParameters` to
    // `Record<string, never>`, and a concrete parameters interface is not
    // assignable to it. A host that holds an arbitrary descriptor must
    // therefore write `M3LCommandModule<object>`, never the bare form.
    const held: M3LCommandModule = concrete;
    expect(held.name).toBe("s3-export");
  });

  test("the same descriptor IS assignable to M3LCommandModule<object>", () => {
    // `execute` is declared with method syntax, so its parameter position is
    // bivariant and the concrete descriptor widens cleanly.
    const held: M3LCommandModule<object> = concrete;

    expect(held.name).toBe("s3-export");
    expectTypeOf(concrete).toExtend<M3LCommandModule<object>>();
  });
});

// ---------------------------------------------------------------------------
// The output port
// ---------------------------------------------------------------------------

describe("M3LCommandOutput", () => {
  test("an array-collecting stub satisfies M3LCommandOutput", () => {
    const recording = createRecordingOutput(true);

    recording.port.heading("Export");
    recording.port.info("wrote 3 rows");
    recording.port.error("one row failed");

    expect(recording.headings).toEqual(["Export"]);
    expect(recording.info).toEqual(["wrote 3 rows"]);
    expect(recording.errors).toEqual(["one row failed"]);
    expect(recording.port.colorEnabled).toBe(true);
  });

  test("the output port's members are pinned", () => {
    const recording = createRecordingOutput();
    // `toExtend`, not `toEqualTypeOf`: the expected literal below carries no
    // `readonly` modifier on `colorEnabled`, and `toEqualTypeOf` is strict
    // about property modifiers.
    expectTypeOf(recording.port).toExtend<{
      colorEnabled: boolean;
      info(text: string): void;
      error(text: string): void;
      heading(text: string): void;
    }>();
    expectTypeOf<M3LCommandOutput["colorEnabled"]>().toEqualTypeOf<boolean>();
    expectTypeOf<M3LCommandOutput["info"]>().returns.toEqualTypeOf<void>();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a realistic descriptor driven to an exit code
// ---------------------------------------------------------------------------

describe("end to end: a realistic descriptor", () => {
  interface ExportParameters {
    readonly bucket: string;
    readonly limit: number;
  }

  /**
   * Mirrors the documented example: branches on `context.dryRun`, honours
   * `context.signal`, renders through `context.output`, and returns an
   * outcome rather than throwing or calling `process.exit`.
   */
  const commandModule: M3LCommandModule<ExportParameters> = {
    name: "s3-export",
    version: "1.0.0",
    description: "Exports a bucket listing to CSV.",
    configParameters: [
      new M3LConfigParameter({
        name: "bucket",
        type: M3LConfigParameterType.STRING,
      }),
    ],
    execute(
      parameters: ExportParameters,
      context: M3LCommandContext,
    ): Promise<M3LCommandOutcome> {
      if (context.dryRun) {
        context.output.info(`Would export ${parameters.bucket}.`);
        return Promise.resolve({ status: "dry-run" });
      }
      if (context.signal?.aborted === true) {
        context.output.error("Cancelled before any work started.");
        return Promise.resolve({ status: "interrupted" });
      }
      if (parameters.limit < 0) {
        return Promise.resolve({
          status: "failure",
          error: { origin: "caller", message: "limit must be >= 0" },
        });
      }
      context.output.heading(`Exporting ${parameters.bucket}`);
      return Promise.resolve(
        parameters.limit > 2
          ? { status: "partial", recovered: parameters.limit - 2 }
          : { status: "success" },
      );
    },
  };

  test("a dry run reports through the output port and exits 0", async () => {
    const recording = createRecordingOutput();
    const outcome = await commandModule.execute(
      { bucket: "reports", limit: 5 },
      createContext({ dryRun: true, output: recording.port }),
    );

    expect(outcome).toEqual({ status: "dry-run" });
    expect(recording.info).toEqual(["Would export reports."]);
    expect(mapCommandOutcomeToExitCode(outcome)).toBe(M3L_EXIT_CODES.SUCCESS);
  });

  test("an already-aborted signal yields interrupted and exits 5", async () => {
    const controller = new AbortController();
    controller.abort();
    const recording = createRecordingOutput();

    const outcome = await commandModule.execute(
      { bucket: "reports", limit: 5 },
      createContext({ signal: controller.signal, output: recording.port }),
    );

    expect(outcome).toEqual({ status: "interrupted" });
    expect(recording.errors).toEqual(["Cancelled before any work started."]);
    expect(mapCommandOutcomeToExitCode(outcome)).toBe(
      M3L_EXIT_CODES.INTERRUPTED,
    );
  });

  test("a live signal lets real work run, yielding partial and exit 6", async () => {
    const controller = new AbortController();
    const recording = createRecordingOutput();

    const outcome = await commandModule.execute(
      { bucket: "reports", limit: 5 },
      createContext({ signal: controller.signal, output: recording.port }),
    );

    expect(outcome).toEqual({ status: "partial", recovered: 3 });
    expect(recording.headings).toEqual(["Exporting reports"]);
    expect(mapCommandOutcomeToExitCode(outcome)).toBe(M3L_EXIT_CODES.PARTIAL);
  });

  test("a clean run yields success and exits 0", async () => {
    const outcome = await commandModule.execute(
      { bucket: "reports", limit: 1 },
      createContext(),
    );

    expect(outcome).toEqual({ status: "success" });
    expect(mapCommandOutcomeToExitCode(outcome)).toBe(M3L_EXIT_CODES.SUCCESS);
  });

  test("a declared failure is returned, not thrown, and maps by origin", async () => {
    const outcome = await commandModule.execute(
      { bucket: "reports", limit: -1 },
      createContext(),
    );

    expect(outcome).toMatchObject({ status: "failure" });
    expect(mapCommandOutcomeToExitCode(outcome)).toBe(
      M3L_EXIT_CODES.CONFIG_USAGE,
    );
  });
});
