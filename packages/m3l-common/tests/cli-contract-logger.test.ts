/**
 * `core/cli-contract` — the hosted-command logger factory slice (U7 PR1).
 *
 * ADR-0072 slice split: this file owns `createCommandLogger` and
 * `M3LCommandLoggerOptions` and nothing else, so `perFile` v8 coverage binds
 * it to `src/core/cli-contract/logger.ts` alone. The descriptor/context type
 * surface lives in `cli-contract.test.ts`, the mapper in
 * `cli-contract-exit-code.test.ts`.
 *
 * Why the factory exists at all: a host that runs a command in-process builds
 * the `M3LCommandContext.logger` itself, and a hand-built `new M3LLogger([h])`
 * carries NEITHER the `--log-level`/`M3L_LOG_LEVEL` floor
 * (`resolveLogLevelFloor` is internal and unexportable) NOR the script's own
 * schema-derived `secrets` — so a declared secret parameter's value would stop
 * being redacted the moment a run went hosted rather than spawned. That gap is
 * exactly what `docs/reference/core/cli-contract.md` names under "What U6
 * shipped"; this factory discharges it by applying byte-for-byte the same
 * policy `M3LScript`'s own default logger applies, over caller-supplied
 * handlers.
 *
 * Key behavioral contracts asserted here:
 *  - With no floor set and no secret parameter declared, the returned logger
 *    behaves like a plain `new M3LLogger(handlers)`.
 *  - An ambient `--log-level=warning` in `process.argv` becomes the logger's
 *    `minLevel` — the resolution is ambient, exactly as `M3LScript` does it,
 *    so the test stubs `process.argv` and restores it.
 *  - A `configParameters` entry with `secret: true` is redacted in an emitted
 *    event's `data`. This is the security-critical assertion, and it is
 *    asserted DIFFERENTIALLY (a plain `M3LLogger` over the same handler leaks
 *    the same value) so it cannot pass by accident against a heuristic match.
 *  - `correlationId` stamps every emitted event.
 *  - An empty `handlers` array is accepted.
 *  - A structurally malformed `configParameters` element — including one whose
 *    method access throws — is rejected with a typed `M3LError` naming the
 *    failing index and method, never a raw `TypeError` from inside
 *    `M3LConfigSchema` and never the hostile element's own error.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";

import { createCommandLogger } from "../src/core/cli-contract/index.js";
import type { M3LCommandLoggerOptions } from "../src/core/cli-contract/index.js";
import {
  M3LConfigParameter,
  M3LConfigParameterType,
} from "../src/core/config/index.js";
import { M3LError } from "../src/core/errors/index.js";
import { M3LLogEventCategory, M3LLogger } from "../src/core/logging/index.js";
import type {
  M3LLogEvent,
  M3LLoggerHandler,
} from "../src/core/logging/index.js";

// ---------------------------------------------------------------------------
// Local test doubles
// ---------------------------------------------------------------------------

/** A capturing `M3LLoggerHandler` — the doc's own named test sink. */
interface RecordingHandler {
  readonly handler: M3LLoggerHandler;
  readonly events: M3LLogEvent[];
}

function createRecordingHandler(): RecordingHandler {
  const events: M3LLogEvent[] = [];
  const handler: M3LLoggerHandler = {
    handle(event: M3LLogEvent): void {
      events.push(event);
    },
    reset(): void {
      events.length = 0;
    },
  };
  return { handler, events };
}

/** A parameter declared secret under a name the built-in heuristic misses. */
const SECRET_PARAMETER = new M3LConfigParameter({
  name: "tenantRef",
  type: M3LConfigParameterType.STRING,
  secret: true,
});

/** A plainly-named, non-secret parameter — the negative arm of the same check. */
const PLAIN_PARAMETER = new M3LConfigParameter({
  name: "bucket",
  type: M3LConfigParameterType.STRING,
});

// ---------------------------------------------------------------------------
// Ambient argv stubbing — `resolveLogLevelFloor()` is called with no
// arguments (exactly as `M3LScript` calls it), so the only way to drive the
// floor is the real `process.argv`. Mirrors `script.test.ts`'s own
// `stubArgv`/restore convention rather than inventing a second style.
// ---------------------------------------------------------------------------

const originalArgv = process.argv;

/** Replaces `process.argv.slice(2)` with `args`. */
function stubArgv(...args: string[]): void {
  process.argv = [
    originalArgv[0] ?? "node",
    originalArgv[1] ?? "script",
    ...args,
  ];
}

// The env tier is ambient too, and a developer machine may genuinely carry
// `M3L_LOG_LEVEL`/`M3L_DEBUG`. Clearing both per test makes "no floor" mean no
// floor rather than "whatever the shell happened to export".
beforeEach(() => {
  vi.stubEnv("M3L_LOG_LEVEL", undefined);
  vi.stubEnv("M3L_DEBUG", undefined);
});

afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The default: no floor, no secrets
// ---------------------------------------------------------------------------

describe("createCommandLogger — the default shape", () => {
  test("returns an M3LLogger that fans out to the supplied handlers", () => {
    const recording = createRecordingHandler();
    stubArgv();

    const logger = createCommandLogger({
      handlers: [recording.handler],
      configParameters: [],
    });

    expect(logger).toBeInstanceOf(M3LLogger);
    logger.info("hosted line");

    expect(recording.events).toHaveLength(1);
    expect(recording.events[0]?.message).toBe("hosted line");
    expect(recording.events[0]?.category).toBe(M3LLogEventCategory.INFO);
  });

  test("admits every category when nothing set a floor — no minLevel by default", () => {
    const recording = createRecordingHandler();
    stubArgv();

    const logger = createCommandLogger({
      handlers: [recording.handler],
      configParameters: [],
    });

    logger.info("an info line");
    logger.success("a success line");
    logger.warning("a warning line");

    // A plain `new M3LLogger(handlers)` admits all three; the factory must
    // not narrow anything the caller did not ask for.
    expect(recording.events.map((event) => event.message)).toEqual([
      "an info line",
      "a success line",
      "a warning line",
    ]);
  });

  test("fans out to every handler in the supplied array, in array order", () => {
    const first = createRecordingHandler();
    const second = createRecordingHandler();
    stubArgv();

    const logger = createCommandLogger({
      handlers: [first.handler, second.handler],
      configParameters: [],
    });
    logger.info("both");

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
  });

  test("accepts an empty handlers array — the message methods become no-ops", () => {
    stubArgv();
    const logger = createCommandLogger({ handlers: [], configParameters: [] });

    // `M3LLogger`'s own contract: a logger with no handlers still accepts
    // every message method, it simply dispatches to nobody.
    expect(() => {
      logger.info("nobody hears this");
      logger.error("nor this");
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The log-level floor — resolved ambiently, exactly as M3LScript resolves it
// ---------------------------------------------------------------------------

describe("createCommandLogger — the ambient log-level floor", () => {
  test("a --log-level=warning in process.argv becomes the logger's minLevel", () => {
    const recording = createRecordingHandler();
    stubArgv("--log-level=warning");

    const logger = createCommandLogger({
      handlers: [recording.handler],
      configParameters: [],
    });

    logger.info("below the floor");
    logger.warning("at the floor");
    logger.error("above the floor");

    expect(recording.events.map((event) => event.message)).toEqual([
      "at the floor",
      "above the floor",
    ]);
  });

  // The discriminating half of the pair: without the flag the SAME three calls
  // all land, so the assertion above cannot pass under an implementation that
  // ignores the floor entirely.
  test("without the flag the same three calls all land (the floor is what filters)", () => {
    const recording = createRecordingHandler();
    stubArgv();

    const logger = createCommandLogger({
      handlers: [recording.handler],
      configParameters: [],
    });

    logger.info("below the floor");
    logger.warning("at the floor");
    logger.error("above the floor");

    expect(recording.events).toHaveLength(3);
  });

  test("an M3L_LOG_LEVEL environment value becomes the floor when no flag is passed", () => {
    const recording = createRecordingHandler();
    stubArgv();
    vi.stubEnv("M3L_LOG_LEVEL", "error");

    const logger = createCommandLogger({
      handlers: [recording.handler],
      configParameters: [],
    });

    logger.warning("below the floor");
    logger.error("at the floor");

    expect(recording.events.map((event) => event.message)).toEqual([
      "at the floor",
    ]);
  });

  // Both arms are reachable in this test's own setup: the env tier IS set, so
  // an implementation that consulted env first would produce the `error` floor
  // and drop the warning line. The flag winning is therefore a real ordering
  // assertion, not a tautology.
  test("the CLI flag wins over the environment value", () => {
    const recording = createRecordingHandler();
    stubArgv("--log-level=warning");
    vi.stubEnv("M3L_LOG_LEVEL", "error");

    const logger = createCommandLogger({
      handlers: [recording.handler],
      configParameters: [],
    });

    logger.warning("admitted only under the CLI floor");
    logger.error("admitted under either floor");

    expect(recording.events.map((event) => event.message)).toEqual([
      "admitted only under the CLI floor",
      "admitted under either floor",
    ]);
  });

  test("an out-of-vocabulary --log-level value propagates the loader's error", () => {
    stubArgv("--log-level=nope");

    // `resolveLogLevelFloor` throws `ERR_INVALID_ARGUMENT` on a malformed
    // explicit request; the factory does not swallow it, so a host sees the
    // same failure the spawn path surfaces.
    expect(() =>
      createCommandLogger({ handlers: [], configParameters: [] }),
    ).toThrowError(/log-level/i);
  });
});

// ---------------------------------------------------------------------------
// Derived secrets — the security-critical assertion
// ---------------------------------------------------------------------------

describe("createCommandLogger — schema-derived secret redaction", () => {
  const secretPayload = { tenantRef: "secret-value", phase: "export" };

  // The differential baseline: a hand-built logger over the SAME handler leaks
  // the same value, so the redaction assertion below cannot pass by way of the
  // built-in key-name heuristic.
  test("a plain M3LLogger leaks a declared-but-unheuristic key (the pre-factory baseline)", () => {
    const recording = createRecordingHandler();
    const logger = new M3LLogger([recording.handler]);

    logger.info("exported", { ...secretPayload });

    expect(recording.events[0]?.data?.["tenantRef"]).toBe("secret-value");
  });

  test("a configParameters entry marked secret is redacted in an emitted event's data", () => {
    const recording = createRecordingHandler();
    stubArgv();

    const logger = createCommandLogger({
      handlers: [recording.handler],
      configParameters: [SECRET_PARAMETER, PLAIN_PARAMETER],
    });

    logger.info("exported", { ...secretPayload });

    const event = recording.events[0];
    expect(event?.data?.["tenantRef"]).toBe("[REDACTED]");
    expect(JSON.stringify(event?.data)).not.toContain("secret-value");
  });

  test("a declared NON-secret parameter's value is left alone", () => {
    const recording = createRecordingHandler();
    stubArgv();

    const logger = createCommandLogger({
      handlers: [recording.handler],
      configParameters: [SECRET_PARAMETER, PLAIN_PARAMETER],
    });

    logger.info("exported", { bucket: "reports", tenantRef: "secret-value" });

    const event = recording.events[0];
    expect(event?.data?.["bucket"]).toBe("reports");
    expect(event?.data?.["tenantRef"]).toBe("[REDACTED]");
  });

  test("a secret parameter's ALIAS is redacted too (deriveSecretsSpecifier's default)", () => {
    const recording = createRecordingHandler();
    stubArgv();

    const logger = createCommandLogger({
      handlers: [recording.handler],
      configParameters: [
        new M3LConfigParameter({
          name: "tenantRef",
          type: M3LConfigParameterType.STRING,
          secret: true,
          aliases: ["tenant-ref"],
        }),
      ],
    });

    logger.info("exported", { "tenant-ref": "secret-value" });

    expect(recording.events[0]?.data?.["tenant-ref"]).toBe("[REDACTED]");
  });

  test("an empty configParameters array declares no secrets and redacts nothing extra", () => {
    const recording = createRecordingHandler();
    stubArgv();

    const logger = createCommandLogger({
      handlers: [recording.handler],
      configParameters: [],
    });
    logger.info("exported", { ...secretPayload });

    expect(recording.events[0]?.data?.["tenantRef"]).toBe("secret-value");
  });
});

// ---------------------------------------------------------------------------
// correlationId
// ---------------------------------------------------------------------------

describe("createCommandLogger — correlationId", () => {
  test("stamps every emitted event with the supplied correlationId", () => {
    const recording = createRecordingHandler();
    stubArgv();

    const logger = createCommandLogger({
      handlers: [recording.handler],
      configParameters: [],
      correlationId: "corr-hosted-1",
    });

    logger.info("first");
    logger.warning("second");
    logger.error("third");

    expect(recording.events).toHaveLength(3);
    for (const event of recording.events) {
      expect(event.correlationId).toBe("corr-hosted-1");
    }
  });

  test("omitting correlationId leaves events unstamped", () => {
    const recording = createRecordingHandler();
    stubArgv();

    const logger = createCommandLogger({
      handlers: [recording.handler],
      configParameters: [],
    });
    logger.info("unstamped");

    expect(recording.events[0]?.correlationId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Structurally malformed configParameters elements
//
// `isM3LCommandModule` deliberately does NOT validate the elements of
// `configParameters`: a descriptor loaded from a foreign `dist/` build carries
// instances built by a different copy of this library, so an `instanceof` test
// would reject exactly the case the guard exists for. The array therefore
// arrives structurally unverified and this factory is the first place its
// elements are used — so it is the boundary that must convert a raw
// `TypeError` ("parameter.getName is not a function", thrown three frames down
// inside `M3LConfigSchema`) into a typed `M3LError` naming the failing index.
//
// These cases are discriminating rather than tautological: the existing suites
// above pass real `M3LConfigParameter` instances through the same call and get
// a working logger, so the rejection here is driven by the element's shape and
// not by the factory rejecting every input.
// ---------------------------------------------------------------------------

/**
 * Puts an off-contract object into the `M3LConfigParameter` slot. The cast is
 * the point of the test: the compiler cannot see a parameter array that
 * crossed a package boundary, which is precisely the case the runtime probe
 * defends.
 */
function asParameter(candidate: object): M3LConfigParameter {
  return candidate as unknown as M3LConfigParameter;
}

/** The three methods `M3LConfigSchema`/`deriveSecretsSpecifier` actually call. */
const WELL_SHAPED_PARAMETER_METHODS = {
  getName: () => "bucket",
  getAliases: () => [],
  isSecret: () => false,
};

describe("createCommandLogger — malformed configParameters elements", () => {
  test("rejects an element missing every required method with a typed M3LError", () => {
    stubArgv();

    let thrown: unknown;
    try {
      createCommandLogger({
        handlers: [],
        configParameters: [asParameter({})],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
    // The message must name both the failing index and the method that was
    // missing — that pair is what makes the failure debuggable without a stack.
    expect((thrown as M3LError).message).toMatch(/configParameters\[0\]/);
    expect((thrown as M3LError).message).toMatch(/getName/);
  });

  test("names the offending index, not just the first element", () => {
    stubArgv();

    let thrown: unknown;
    try {
      createCommandLogger({
        handlers: [],
        // Element 0 is a real parameter, so an implementation that only ever
        // probed the head of the array would build a logger and pass nothing.
        configParameters: [
          PLAIN_PARAMETER,
          asParameter({
            getName: WELL_SHAPED_PARAMETER_METHODS.getName,
            getAliases: WELL_SHAPED_PARAMETER_METHODS.getAliases,
          }),
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).message).toMatch(/configParameters\[1\]/);
    expect((thrown as M3LError).message).toMatch(/isSecret/);
  });

  test("rejects a required method that is present but not callable", () => {
    stubArgv();

    // The probe is `hasProperty(...) && isFunction(...)`: a present-but-
    // non-callable value must fail on the second half, not sneak past the
    // first.
    expect(() =>
      createCommandLogger({
        handlers: [],
        configParameters: [
          asParameter({
            ...WELL_SHAPED_PARAMETER_METHODS,
            getName: "not-a-function",
          }),
        ],
      }),
    ).toThrowError(M3LError);
  });

  test("a hostile throwing getter surfaces as the same typed error, not the getter's own", () => {
    stubArgv();

    const hostile = Object.defineProperty(
      { ...WELL_SHAPED_PARAMETER_METHODS },
      "isSecret",
      {
        get(): never {
          throw new Error("hostile getter ran");
        },
      },
    );

    let thrown: unknown;
    try {
      createCommandLogger({
        handlers: [],
        configParameters: [asParameter(hostile)],
      });
    } catch (error) {
      thrown = error;
    }

    // The read is wrapped, so the getter's error is treated as "missing" and
    // never escapes: a caller-controlled element cannot choose the failure a
    // host sees.
    expect(thrown).toBeInstanceOf(M3LError);
    expect((thrown as M3LError).code).toBe("ERR_INVALID_ARGUMENT");
    expect((thrown as M3LError).message).toMatch(/configParameters\[0\]/);
    expect((thrown as M3LError).message).toMatch(/isSecret/);
    expect((thrown as M3LError).message).not.toMatch(/hostile getter ran/);
  });

  test("real M3LConfigParameter instances pass the probe untouched", () => {
    stubArgv();

    // The negative arm of the whole block: the probe rejects shape, not
    // parameters in general.
    expect(() =>
      createCommandLogger({
        handlers: [],
        configParameters: [SECRET_PARAMETER, PLAIN_PARAMETER],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

describe("M3LCommandLoggerOptions — type-level contract", () => {
  test("the options shape is pinned to readonly handlers/configParameters plus an optional correlationId", () => {
    expectTypeOf<M3LCommandLoggerOptions["handlers"]>().toEqualTypeOf<
      readonly M3LLoggerHandler[]
    >();
    expectTypeOf<M3LCommandLoggerOptions["configParameters"]>().toEqualTypeOf<
      readonly M3LConfigParameter[]
    >();
    expectTypeOf<M3LCommandLoggerOptions["correlationId"]>().toEqualTypeOf<
      string | undefined
    >();
  });

  test("the factory returns an M3LLogger, not a structural look-alike", () => {
    expectTypeOf(createCommandLogger).returns.toEqualTypeOf<M3LLogger>();
    expectTypeOf(createCommandLogger)
      .parameter(0)
      .toEqualTypeOf<M3LCommandLoggerOptions>();
  });

  test("`handlers` and `configParameters` are both required", () => {
    // @ts-expect-error -- `configParameters` is required: a host that forgets
    // it would silently build a logger with no derived secrets, which is the
    // exact redaction gap this factory exists to close.
    const options: M3LCommandLoggerOptions = { handlers: [] };
    expect(options.handlers).toEqual([]);
  });
});
