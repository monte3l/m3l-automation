/**
 * Tests for core/pipeline submodule (RED phase — `M3LOperationPipeline.run`
 * is a placeholder that rejects with `ERR_PIPELINE_INVALID_OPTION`; the
 * constructor currently performs no validation).
 *
 * Contract source: docs/reference/core/pipeline.md plus the hub rulings
 * folded into the RED contract (scratchpad `pipeline-red-contract.md`):
 *   R1: soft-land decline skips persist and finalize; run resolves right
 *       after the warning.
 *   R2: guards check each row's keys in array order; first missing field
 *       throws.
 *   R3: the engine forwards deps.prompt + deps.logger to confirmDestructive;
 *       the yes:true bypass warning is gate-owned text, not engine-authored.
 *   R4: a pipeline instance is stateless across runs — sequential reuse with
 *       different config values shows no cross-run leakage.
 *   R5: inference is proven to work — no curried builder; type tests use
 *       `new M3LOperationPipeline({...})` directly.
 *
 * No error class is exported from `core/pipeline` — construction-time
 * validation failures are asserted via `instanceof M3LError` plus the
 * `ERR_PIPELINE_INVALID_OPTION` code, never a whitebox subclass import.
 */

import {
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";

import { M3LConfig } from "../src/core/config/M3LConfig.js";
import type { M3LConfigAccessor } from "../src/core/config/M3LConfigAccessor.js";
import { M3LError } from "../src/core/errors/index.js";
import { M3LLogger } from "../src/core/logging/M3LLogger.js";
import { M3LPrompt } from "../src/core/prompt/M3LPrompt.js";
import type { M3LPromptAdapter } from "../src/core/prompt/types.js";
import type {
  M3LDestructiveTarget,
  M3LDestructiveTargetPredicate,
} from "../src/core/prompt/M3LDestructiveGate.js";
import type { M3LRunRecoveryEntry } from "../src/core/diagnostics/index.js";
import { M3LOperationPipeline } from "../src/core/pipeline/index.js";
import type {
  M3LGuardableKey,
  M3LOperationHandlers,
  M3LOperationPipelineBaseDeps,
  M3LOperationPipelineOptions,
  M3LOperationPipelineOutcome,
  M3LOperationPipelineOutcomeBase,
  M3LPipelineDeclinePolicy,
  M3LPipelineDestructiveOptions,
} from "../src/core/pipeline/index.js";

// ---------------------------------------------------------------------------
// Shared behavioral fixture
// ---------------------------------------------------------------------------

const TEST_OPS = ["read", "write"] as const;
type TestOp = (typeof TEST_OPS)[number];

interface TestSettings {
  readonly bucket?: string | undefined;
  readonly key?: string | undefined;
  readonly yes: boolean;
}

interface TestContext {
  readonly note: string;
}

interface TestResult {
  readonly processed: number;
}

type TestDeps = M3LOperationPipelineBaseDeps;

/** A resolvable/rejectable "gate" a test can hold open to prove ordering. */
function makeDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Builds a fresh prompt/logger/config harness. `confirmImpl` backs the
 * adapter's `confirm` method (the only adapter method the gate exercises);
 * every other method is an unused `vi.fn()`.
 */
function makeHarness(confirmImpl?: M3LPromptAdapter["confirm"]): {
  readonly deps: TestDeps;
  readonly config: M3LConfig;
  readonly logger: M3LLogger;
  readonly warningSpy: MockInstance;
  readonly confirmMock: Mock;
} {
  const config = new M3LConfig();
  const logger = new M3LLogger([]);
  const warningSpy = vi.spyOn(logger, "warning");
  const confirmMock = vi.fn(confirmImpl ?? (() => Promise.resolve(true)));
  const adapter = {
    input: vi.fn(),
    password: vi.fn(),
    number: vi.fn(),
    confirm: confirmMock,
    select: vi.fn(),
    checkbox: vi.fn(),
    search: vi.fn(),
  } as unknown as M3LPromptAdapter;
  const prompt = new M3LPrompt({ adapter });
  const deps: TestDeps = { config, logger, prompt };
  return { deps, config, logger, warningSpy, confirmMock };
}

/** Never-invoked handler stubs, reused wherever a test doesn't exercise dispatch. */
const NOOP_HANDLERS: M3LOperationHandlers<
  TestOp,
  TestSettings,
  TestDeps,
  TestResult,
  TestContext
> = {
  read: () => Promise.reject(new Error("read handler should not run")),
  write: () => Promise.reject(new Error("write handler should not run")),
};

describe("core/pipeline", () => {
  // -------------------------------------------------------------------------
  // Construction-time validation (B40-B47)
  // -------------------------------------------------------------------------
  describe("construction-time validation", () => {
    const baseOptions: M3LOperationPipelineOptions<
      TestOp,
      TestSettings,
      TestDeps,
      TestResult,
      TestContext
    > = {
      operations: TEST_OPS,
      configCode: "ERR_TEST_CONFIG",
      resolveSettings: () => ({ yes: false }),
      // Pinned TestContext is not exercised by any construction-time case
      // below; a trivial prepare keeps this literal well-typed once
      // `prepare` becomes required whenever TContext !== undefined.
      prepare: () => Promise.resolve({ note: "n" }),
      handlers: NOOP_HANDLERS,
    };

    // Exactly three invalid-option cases (B47) — do not add a fourth.
    const invalidCases: readonly [
      string,
      () => M3LOperationPipelineOptions<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >,
    ][] = [
      [
        "B40 empty operations",
        () =>
          ({
            ...baseOptions,
            operations: [] as readonly string[],
          }) as unknown as M3LOperationPipelineOptions<
            TestOp,
            TestSettings,
            TestDeps,
            TestResult,
            TestContext
          >,
      ],
      [
        "B41 duplicate operations",
        () =>
          ({
            ...baseOptions,
            operations: ["read", "read", "write"],
          }) as unknown as M3LOperationPipelineOptions<
            TestOp,
            TestSettings,
            TestDeps,
            TestResult,
            TestContext
          >,
      ],
      [
        "B42 destructive.operations not a subset of operations",
        () => ({
          ...baseOptions,
          destructive: {
            operations: new Set(["write", "delete"]),
            describe: () => "desc",
            yes: (settings: TestSettings) => settings.yes,
            abortCode: "ERR_TEST_ABORTED",
            onDecline: { kind: "throw" },
          } as unknown as M3LPipelineDestructiveOptions<
            TestOp,
            TestSettings,
            TestDeps,
            TestResult,
            TestContext
          >,
        }),
      ],
    ];

    test.each(invalidCases)(
      "%s throws ERR_PIPELINE_INVALID_OPTION eagerly at construction",
      (_name, makeOptions) => {
        expect(() => new M3LOperationPipeline(makeOptions())).toThrow();
        let thrown: unknown;
        try {
          new M3LOperationPipeline(makeOptions());
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LError).code).toBe("ERR_PIPELINE_INVALID_OPTION");
      },
    );

    test("B43 the thrown error is a fully-formed M3LError (origin, retryable, toJSON round trip) — message text is not asserted", () => {
      let thrown: unknown;
      try {
        new M3LOperationPipeline({
          ...baseOptions,
          operations: [] as readonly string[],
        } as unknown as M3LOperationPipelineOptions<
          TestOp,
          TestSettings,
          TestDeps,
          TestResult,
          TestContext
        >);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      const error = thrown as M3LError;
      expect(error.code).toBe("ERR_PIPELINE_INVALID_OPTION");
      expect(error.origin).toBe("caller");
      expect(error.retryable).toBe(false);

      const json = error.toJSON();
      expect(json.code).toBe(error.code);
      expect(json.message).toBe(error.message);
      const roundTripped: unknown = JSON.parse(JSON.stringify(json));
      expect(roundTripped).toMatchObject({
        code: "ERR_PIPELINE_INVALID_OPTION",
        message: error.message,
      });
    });

    test("B44 the construction error is not a specifically-exported subclass — narrows only via M3LError + code", () => {
      let thrown: unknown;
      try {
        new M3LOperationPipeline({
          ...baseOptions,
          operations: [] as readonly string[],
        } as unknown as M3LOperationPipelineOptions<
          TestOp,
          TestSettings,
          TestDeps,
          TestResult,
          TestContext
        >);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_PIPELINE_INVALID_OPTION");
    });

    test("B45 valid construction throws nothing and invokes no callback eagerly", () => {
      const resolveSettings = vi.fn(() => ({ yes: false }));
      const handlers = {
        read: vi.fn(() => Promise.resolve({ processed: 0 })),
        write: vi.fn(() => Promise.resolve({ processed: 0 })),
      };
      const prepare = vi.fn(() => Promise.resolve({ note: "n" }));
      const persist = vi.fn(() => Promise.resolve(undefined));
      const finalize = vi.fn(() => undefined);

      expect(
        () =>
          new M3LOperationPipeline<
            TestOp,
            TestSettings,
            TestDeps,
            TestResult,
            TestContext
          >({
            operations: TEST_OPS,
            configCode: "ERR_TEST_CONFIG",
            resolveSettings,
            requiredFields: { read: [], write: [] },
            prepare,
            handlers,
            persist,
            finalize,
          }),
      ).not.toThrow();

      expect(resolveSettings).not.toHaveBeenCalled();
      expect(handlers.read).not.toHaveBeenCalled();
      expect(handlers.write).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
    });

    // B46: the invalid cases above already require `as unknown as
    // M3LOperationPipelineOptions<...>` casts to construct — a well-typed
    // caller cannot reach these branches, only a dynamic/JS caller can.
  });

  // -------------------------------------------------------------------------
  // Operation resolution (B4-B6)
  // -------------------------------------------------------------------------
  describe("operation resolution", () => {
    function buildAccessorPipeline() {
      return new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        // Not exercised here (operation resolution fails before prepare);
        // trivial, kept only to satisfy the pinned TestContext generic.
        prepare: () => Promise.resolve({ note: "n" }),
        handlers: NOOP_HANDLERS,
      });
    }

    test("B4 an off-union operation value rejects with configCode and the accessor-owned message", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "bogus");
      const pipeline = buildAccessorPipeline();

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_TEST_CONFIG");
      expect((thrown as M3LError).message).toBe(
        "'operation' must be one of: read, write",
      );
    });

    test("B5 an unset operation rejects the same way as an off-union value", async () => {
      const { deps } = makeHarness();
      const pipeline = buildAccessorPipeline();

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_TEST_CONFIG");
      expect((thrown as M3LError).message).toBe(
        "'operation' must be one of: read, write",
      );
    });

    test("B6 the config parameter name is fixed to 'operation' — a value stored under another key is never read", async () => {
      const { deps, config } = makeHarness();
      config.set("op", "read");
      const pipeline = buildAccessorPipeline();

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).message).toBe(
        "'operation' must be one of: read, write",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Settings resolution (B7-B10)
  // -------------------------------------------------------------------------
  describe("settings resolution", () => {
    test("B7 resolveSettings is called exactly once with (accessor, resolved operation)", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const resolveSettings = vi.fn(
        (_accessor: M3LConfigAccessor, _operation: TestOp): TestSettings => ({
          yes: false,
        }),
      );
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings,
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 1 }),
          write: () => Promise.resolve({ processed: 1 }),
        },
      });

      await expect(pipeline.run(deps)).resolves.toMatchObject({
        status: "completed",
      });

      expect(resolveSettings).toHaveBeenCalledTimes(1);
      const [accessorArg, operationArg] = resolveSettings.mock.calls[0] ?? [];
      expect(operationArg).toBe("read");
      expect(accessorArg).toBeDefined();
      expect(typeof (accessorArg as M3LConfigAccessor).oneOf).toBe("function");
    });

    test("B8 a synchronous resolver is supported", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 7 }),
          write: () => Promise.resolve({ processed: 7 }),
        },
      });

      await expect(pipeline.run(deps)).resolves.toMatchObject({
        result: { processed: 7 },
      });
    });

    test("B9 an asynchronous resolver is awaited before the guard phase runs", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "write");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: async () => {
          await Promise.resolve();
          // Deliberately omits `bucket`, the guarded field for "write" — if
          // the engine failed to await this resolver, the guard would run
          // against a still-pending Promise instead of this resolved value.
          return { yes: false };
        },
        requiredFields: { read: [], write: ["bucket"] },
        // Not exercised here (the guard rejects before prepare runs);
        // trivial, kept only to satisfy the pinned TestContext generic.
        prepare: () => Promise.resolve({ note: "n" }),
        handlers: NOOP_HANDLERS,
      });

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).message).toBe(
        "'bucket' is required for operation 'write'",
      );
    });

    test("B10 the resolved settings object (same reference) reaches every downstream phase", async () => {
      const settings: TestSettings = { bucket: "b", key: "k", yes: true };
      const seen: TestSettings[] = [];
      const { deps, config } = makeHarness(() => Promise.resolve(false));
      config.set("operation", "write");

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => settings,
        requiredFields: { read: [], write: [] },
        prepare: (_operation, s) => {
          seen.push(s);
          return Promise.resolve({ note: "n" });
        },
        destructive: {
          operations: new Set(["write"]),
          describe: (_operation, s) => {
            seen.push(s);
            return "destroy";
          },
          yes: (s) => {
            seen.push(s);
            return s.yes;
          },
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: (_operation, s) => {
              seen.push(s);
              return { processed: 0 };
            },
            warning: (_operation, s) => {
              seen.push(s);
              return "declined";
            },
          },
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: (_operation, s) => {
            seen.push(s);
            return Promise.resolve({ processed: 0 });
          },
        },
      });

      await pipeline.run(deps);

      // yes(settings) reports true, so `yes` bypasses the prompt and the run
      // dispatches — every phase in `seen` should carry the same reference.
      for (const value of seen) {
        expect(value).toBe(settings);
      }
      expect(seen.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Guards (B11-B15)
  // -------------------------------------------------------------------------
  describe("guards", () => {
    type ProbeOp = "probe";
    interface GuardSettings {
      readonly flag?: string | number | boolean | null | undefined;
    }

    function buildProbePipeline(
      flag: string | number | boolean | null | undefined,
      requiredFields: {
        readonly probe: readonly M3LGuardableKey<GuardSettings>[];
      },
      spies: {
        readonly prepare: (
          operation: ProbeOp,
          settings: GuardSettings,
          deps: TestDeps,
        ) => Promise<undefined>;
        readonly handler: (
          operation: ProbeOp,
          settings: GuardSettings,
          context: undefined,
          deps: TestDeps,
        ) => Promise<TestResult>;
      },
    ) {
      return new M3LOperationPipeline<
        ProbeOp,
        GuardSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: ["probe"],
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ flag }),
        requiredFields,
        prepare: spies.prepare,
        handlers: { probe: spies.handler },
      });
    }

    test("B11 a missing guarded field rejects with the exact hand-rolled message", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "probe");
      const pipeline = buildProbePipeline(
        undefined,
        { probe: ["flag"] },
        { prepare: vi.fn(), handler: vi.fn() },
      );

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_TEST_CONFIG");
      expect((thrown as M3LError).message).toBe(
        "'flag' is required for operation 'probe'",
      );
    });

    test.each([null, "", 0, false])(
      "B12 a guarded field set to %p (not undefined) passes the guard",
      async (value) => {
        const { deps, config } = makeHarness();
        config.set("operation", "probe");
        const handler = vi.fn(() => Promise.resolve({ processed: 1 }));
        const pipeline = buildProbePipeline(
          value,
          { probe: ["flag"] },
          { prepare: vi.fn(), handler },
        );

        await expect(pipeline.run(deps)).resolves.toMatchObject({
          status: "completed",
        });
        expect(handler).toHaveBeenCalledTimes(1);
      },
    );

    test("B13 an empty required-fields row for the operation performs no guard", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "probe");
      const handler = vi.fn(() => Promise.resolve({ processed: 1 }));
      const pipeline = buildProbePipeline(
        undefined,
        { probe: [] },
        { prepare: vi.fn(), handler },
      );

      await expect(pipeline.run(deps)).resolves.toMatchObject({
        status: "completed",
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test("B14 omitting requiredFields entirely is a no-op guard phase", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const handler = vi.fn(() => Promise.resolve({ processed: 1 }));
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        handlers: { read: handler, write: handler },
      });

      await expect(pipeline.run(deps)).resolves.toMatchObject({
        status: "completed",
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test("B15 a guard failure precedes prepare/gate/dispatch — none of them run", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "probe");
      const prepare = vi.fn(() => Promise.resolve(undefined));
      const handler = vi.fn(() => Promise.resolve({ processed: 1 }));
      const pipeline = buildProbePipeline(
        undefined,
        { probe: ["flag"] },
        { prepare, handler },
      );

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect(prepare).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    test("SC-A a requiredFields row with multiple missing keys names the FIRST missing key in array order", async () => {
      interface MultiGuardSettings {
        readonly first?: string | undefined;
        readonly second?: string | undefined;
        readonly third?: string | undefined;
      }
      type MultiGuardOp = "multi";
      const { deps, config } = makeHarness();
      config.set("operation", "multi");

      const pipeline = new M3LOperationPipeline<
        MultiGuardOp,
        MultiGuardSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: ["multi"],
        configCode: "ERR_TEST_CONFIG",
        // "second" and "third" are both missing; "first" is present. The
        // row lists "second" ahead of "third", so the guard must name
        // "second" — not "third", and not alphabetical/declaration order.
        resolveSettings: () => ({ first: "present" }),
        requiredFields: { multi: ["first", "second", "third"] },
        handlers: {
          multi: () => Promise.reject(new Error("handler should not run")),
        },
      });

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).message).toBe(
        "'second' is required for operation 'multi'",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Prepare (B16-B20)
  // -------------------------------------------------------------------------
  describe("prepare", () => {
    test("B16 prepare is called exactly once with (operation, settings, deps), before the gate", async () => {
      const settings: TestSettings = { bucket: "b", yes: true };
      const { deps, config, confirmMock } = makeHarness();
      config.set("operation", "write");
      const prepare = vi.fn(() => Promise.resolve({ note: "n" }));

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => settings,
        requiredFields: { read: [], write: [] },
        prepare,
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: (s) => s.yes,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 0 }),
        },
      });

      await pipeline.run(deps);

      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare).toHaveBeenCalledWith("write", settings, deps);
      // yes(settings)===true bypasses the interactive prompt, so this test
      // does not directly order prepare-before-confirm, but confirmMock
      // being untouched (bypass path) keeps this test focused on the call
      // shape; ordering across prepare/gate/dispatch is covered by B2.
      expect(confirmMock).not.toHaveBeenCalled();
    });

    test("B17 the prepared context reaches both destructive.describe (3rd arg) and the handler (3rd arg) by reference", async () => {
      const context: TestContext = { note: "shared" };
      const { deps, config } = makeHarness(() => Promise.resolve(true));
      config.set("operation", "write");
      let describeContext: TestContext | undefined;
      let handlerContext: TestContext | undefined;

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        prepare: () => Promise.resolve(context),
        destructive: {
          operations: new Set(["write"]),
          describe: (_operation, _settings, ctx) => {
            describeContext = ctx;
            return "destroy";
          },
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: (_operation, _settings, ctx) => {
            handlerContext = ctx;
            return Promise.resolve({ processed: 0 });
          },
        },
      });

      await pipeline.run(deps);

      expect(describeContext).toBe(context);
      expect(handlerContext).toBe(context);
    });

    test("B18 prepare runs for non-destructive operations too", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const prepare = vi.fn(() => Promise.resolve({ note: "n" }));
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        prepare,
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 0 }),
        },
      });

      await pipeline.run(deps);
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    test("B19 prepare runs even when the run later declines", async () => {
      const { deps, config } = makeHarness(() => Promise.resolve(false));
      config.set("operation", "write");
      const prepare = vi.fn(() => Promise.resolve({ note: "n" }));
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        prepare,
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: () => ({ processed: 0 }),
          },
        },
        handlers: NOOP_HANDLERS,
      });

      await pipeline.run(deps);
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    test("B20 without prepare configured, handler and describe receive undefined context", async () => {
      const { deps, config } = makeHarness(() => Promise.resolve(true));
      config.set("operation", "write");
      let describeContext: unknown = "unset";
      let handlerContext: unknown = "unset";

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: (_operation, _settings, ctx) => {
            describeContext = ctx;
            return "destroy";
          },
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: (_operation, _settings, ctx) => {
            handlerContext = ctx;
            return Promise.resolve({ processed: 0 });
          },
        },
      });

      await pipeline.run(deps);
      expect(describeContext).toBeUndefined();
      expect(handlerContext).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Gate (B21-B26)
  // -------------------------------------------------------------------------
  describe("gate", () => {
    test("B21 with no destructive option configured, prompt.confirm is never called", async () => {
      const { deps, config, confirmMock } = makeHarness();
      config.set("operation", "write");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 0 }),
        },
      });

      await pipeline.run(deps);
      expect(confirmMock).not.toHaveBeenCalled();
    });

    test("B22 a non-member operation skips the gate entirely — describe is not called, dispatch proceeds", async () => {
      const { deps, config, confirmMock } = makeHarness();
      config.set("operation", "read");
      const describe = vi.fn(() => "destroy");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe,
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: {
          read: () => Promise.resolve({ processed: 1 }),
          write: () => Promise.resolve({ processed: 1 }),
        },
      });

      await expect(pipeline.run(deps)).resolves.toMatchObject({
        status: "completed",
      });
      expect(describe).not.toHaveBeenCalled();
      expect(confirmMock).not.toHaveBeenCalled();
    });

    test("B23 a member operation invokes the gate — prompt.confirm receives 'Confirm: <description>?'", async () => {
      const { deps, config, confirmMock } = makeHarness(() =>
        Promise.resolve(true),
      );
      config.set("operation", "write");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "delete bucket my-bucket",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 0 }),
        },
      });

      await pipeline.run(deps);
      expect(confirmMock).toHaveBeenCalledTimes(1);
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Confirm: delete bucket my-bucket?",
        }),
      );
    });

    test("B24 yes(settings)===true bypasses the prompt and logs the gate-owned warning", async () => {
      const { deps, config, confirmMock, warningSpy } = makeHarness();
      config.set("operation", "write");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: true }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "delete bucket my-bucket",
          yes: (settings) => settings.yes,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 5 }),
        },
      });

      await expect(pipeline.run(deps)).resolves.toMatchObject({
        status: "completed",
        result: { processed: 5 },
      });
      expect(confirmMock).not.toHaveBeenCalled();
      expect(warningSpy).toHaveBeenCalledTimes(1);
      expect(warningSpy).toHaveBeenCalledWith(
        "destructive confirmation bypassed (yes=true): delete bucket my-bucket",
      );
    });

    test("B25 a gate M3LError with a DIFFERENT code than abortCode propagates unmodified even under soft-land", async () => {
      const gateError = new M3LError("gate exploded", {
        code: "ERR_TEST_GATE_UNRELATED",
      });
      const { deps, config } = makeHarness(() => Promise.reject(gateError));
      config.set("operation", "write");
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: () => ({ processed: 0 }),
          },
        },
        handlers: { read: handler, write: handler },
      });

      await expect(pipeline.run(deps)).rejects.toBe(gateError);
      expect(handler).not.toHaveBeenCalled();
    });

    test("B26 a non-M3LError thrown by the prompt adapter propagates, even carrying .code === abortCode", async () => {
      const foreignError = Object.assign(new Error("cancelled"), {
        code: "ERR_TEST_ABORTED",
      });
      const { deps, config } = makeHarness(() => Promise.reject(foreignError));
      config.set("operation", "write");
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: { read: handler, write: handler },
      });

      await expect(pipeline.run(deps)).rejects.toBe(foreignError);
      expect(handler).not.toHaveBeenCalled();
    });

    test("SF-A a synchronous throw from destructive.describe propagates reference-identically; confirm and handler are skipped", async () => {
      const describeError = new Error("describe blew up");
      const { deps, config, confirmMock } = makeHarness();
      config.set("operation", "write");
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => {
            throw describeError;
          },
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: { read: handler, write: handler },
      });

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(describeError);
      expect(confirmMock).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    test("SF-A a synchronous throw from destructive.yes propagates reference-identically; confirm and handler are skipped", async () => {
      const yesError = new Error("yes blew up");
      const { deps, config, confirmMock } = makeHarness();
      config.set("operation", "write");
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => {
            throw yesError;
          },
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: { read: handler, write: handler },
      });

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(yesError);
      expect(confirmMock).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    test.each([
      ["a string rejection", "cancelled"],
      ["a null rejection", null],
    ])(
      "SF-C %s from the prompt adapter propagates as-is under soft-land — never treated as a decline",
      async (_label, rejectionValue) => {
        const { deps, config } = makeHarness(() =>
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentional primitive rejection to prove it propagates un-normalized, not treated as a decline
          Promise.reject(rejectionValue),
        );
        config.set("operation", "write");
        const handler = vi.fn(() => Promise.resolve({ processed: 0 }));

        const pipeline = new M3LOperationPipeline<
          TestOp,
          TestSettings,
          TestDeps,
          TestResult,
          undefined
        >({
          operations: TEST_OPS,
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => ({ yes: false }),
          requiredFields: { read: [], write: [] },
          destructive: {
            operations: new Set(["write"]),
            describe: () => "destroy",
            yes: () => false,
            abortCode: "ERR_TEST_ABORTED",
            onDecline: {
              kind: "soft-land",
              result: () => ({ processed: -1 }),
            },
          },
          handlers: { read: handler, write: handler },
        });

        let thrown: unknown;
        try {
          await pipeline.run(deps);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBe(rejectionValue);
        expect(handler).not.toHaveBeenCalled();
      },
    );
  });

  // -------------------------------------------------------------------------
  // Decline policy (B27-B32)
  // -------------------------------------------------------------------------
  describe("decline policy", () => {
    test("B27 {kind:'throw'} propagates the decline error reference-identically; handler not called", async () => {
      const { deps, config } = makeHarness(() => Promise.resolve(false));
      config.set("operation", "write");
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "delete bucket my-bucket",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: { read: handler, write: handler },
      });

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_TEST_ABORTED");
      expect((thrown as M3LError).message).toBe(
        "aborted: delete bucket my-bucket",
      );
      expect(handler).not.toHaveBeenCalled();
    });

    test("B28/B31 soft-land logs the configured warning once, resolves a declined outcome, and never dispatches", async () => {
      const { deps, config, warningSpy } = makeHarness(() =>
        Promise.resolve(false),
      );
      config.set("operation", "write");
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));
      const softResult: TestResult = { processed: -1 };
      const warning = vi.fn(() => "declined message");
      const resultFn = vi.fn(() => softResult);

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: resultFn,
            warning,
          },
        },
        handlers: { read: handler, write: handler },
      });

      const outcome = await pipeline.run(deps);

      expect(warningSpy).toHaveBeenCalledTimes(1);
      expect(warningSpy).toHaveBeenCalledWith("declined message");
      expect(outcome).toEqual({
        status: "declined",
        operation: "write",
        result: softResult,
      });
      expect(handler).not.toHaveBeenCalled();
    });

    test("B29 soft-land without a warning function logs nothing but still produces a declined outcome", async () => {
      const { deps, config, warningSpy } = makeHarness(() =>
        Promise.resolve(false),
      );
      config.set("operation", "write");
      const softResult: TestResult = { processed: -1 };

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        // Not exercised (decline always fires); trivial, kept only to
        // satisfy the pinned TestContext generic.
        prepare: () => Promise.resolve({ note: "n" }),
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: () => softResult,
          },
        },
        handlers: NOOP_HANDLERS,
      });

      const outcome = await pipeline.run(deps);
      expect(warningSpy).not.toHaveBeenCalled();
      expect(outcome.status).toBe("declined");
    });

    test("B30 the soft-land result callback receives (operation, settings, deps) — no context argument", async () => {
      const settings: TestSettings = { bucket: "b", yes: false };
      const { deps, config } = makeHarness(() => Promise.resolve(false));
      config.set("operation", "write");
      const resultFn = vi.fn(() => ({ processed: 0 }));

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => settings,
        requiredFields: { read: [], write: [] },
        prepare: () => Promise.resolve({ note: "n" }),
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "soft-land", result: resultFn },
        },
        handlers: NOOP_HANDLERS,
      });

      await pipeline.run(deps);
      expect(resultFn).toHaveBeenCalledTimes(1);
      expect(resultFn).toHaveBeenCalledWith("write", settings, deps);
    });

    test("B32 (R1) on soft-land decline, persist and finalize are NOT called", async () => {
      const { deps, config } = makeHarness(() => Promise.resolve(false));
      config.set("operation", "write");
      const persist = vi.fn(() => Promise.resolve(undefined));
      const finalize = vi.fn(() => undefined);

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        // Not exercised (decline always fires); trivial, kept only to
        // satisfy the pinned TestContext generic.
        prepare: () => Promise.resolve({ note: "n" }),
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: () => ({ processed: 0 }),
          },
        },
        handlers: NOOP_HANDLERS,
        persist,
        finalize,
      });

      await pipeline.run(deps);
      expect(persist).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
    });

    test("SF-B a throw from onDecline.warning propagates; handler/persist/finalize are not called", async () => {
      const warningError = new Error("warning blew up");
      const { deps, config } = makeHarness(() => Promise.resolve(false));
      config.set("operation", "write");
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));
      const persist = vi.fn(() => Promise.resolve(undefined));
      const finalize = vi.fn(() => undefined);
      const resultFn = vi.fn(() => ({ processed: 0 }));

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: resultFn,
            warning: () => {
              throw warningError;
            },
          },
        },
        handlers: { read: handler, write: handler },
        persist,
        finalize,
      });

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(warningError);
      expect(resultFn).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
    });

    test("SF-B a throw from onDecline.result propagates; handler/persist/finalize are not called", async () => {
      const resultError = new Error("result blew up");
      const { deps, config } = makeHarness(() => Promise.resolve(false));
      config.set("operation", "write");
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));
      const persist = vi.fn(() => Promise.resolve(undefined));
      const finalize = vi.fn(() => undefined);

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: () => {
              throw resultError;
            },
          },
        },
        handlers: { read: handler, write: handler },
        persist,
        finalize,
      });

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(resultError);
      expect(handler).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Dispatch / persist / finalize (B33-B39)
  // -------------------------------------------------------------------------
  describe("dispatch, persist, finalize", () => {
    test("B33 handlers[operation] is called exactly once with (operation, settings, context, deps)", async () => {
      const settings: TestSettings = { bucket: "b", yes: false };
      const context: TestContext = { note: "n" };
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const handler = vi.fn(() => Promise.resolve({ processed: 3 }));

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => settings,
        requiredFields: { read: [], write: [] },
        prepare: () => Promise.resolve(context),
        handlers: { read: handler, write: handler },
      });

      await pipeline.run(deps);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith("read", settings, context, deps);
    });

    test("B34 a handler error propagates unmodified; persist/finalize not called", async () => {
      const original = new M3LError("handler blew up", { code: "ERR_X" });
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const persist = vi.fn(() => Promise.resolve(undefined));
      const finalize = vi.fn(() => undefined);

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.reject(original),
          write: () => Promise.reject(original),
        },
        persist,
        finalize,
      });

      await expect(pipeline.run(deps)).rejects.toBe(original);
      expect(persist).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
    });

    test("B35a persist is called once with (result, settings, deps, operation), awaited", async () => {
      const settings: TestSettings = { bucket: "b", yes: false };
      const result: TestResult = { processed: 9 };
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const persist = vi.fn(() => Promise.resolve(undefined));
      const finalize = vi.fn(() => undefined);

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => settings,
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve(result),
          write: () => Promise.resolve(result),
        },
        persist,
        finalize,
      });

      await pipeline.run(deps);
      expect(persist).toHaveBeenCalledTimes(1);
      // F12: persist receives operation as 4th argument
      expect(persist).toHaveBeenCalledWith(result, settings, deps, "read");
      // F12: finalize receives operation as 4th argument
      expect(finalize).toHaveBeenCalledWith(result, settings, deps, "read");
    });

    test("B35b persist is skipped when omitted — the run still completes", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 1 }),
          write: () => Promise.resolve({ processed: 1 }),
        },
      });

      await expect(pipeline.run(deps)).resolves.toMatchObject({
        status: "completed",
        result: { processed: 1 },
      });
    });

    test("B36 a persist throw propagates; finalize is not called", async () => {
      const persistError = new Error("disk full");
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const finalize = vi.fn(() => undefined);

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 1 }),
          write: () => Promise.resolve({ processed: 1 }),
        },
        persist: () => Promise.reject(persistError),
        finalize,
      });

      await expect(pipeline.run(deps)).rejects.toBe(persistError);
      expect(finalize).not.toHaveBeenCalled();
    });

    test("B37 finalize runs only after persist's own promise resolves", async () => {
      const order: string[] = [];
      const gate = makeDeferred();
      const { deps, config } = makeHarness();
      config.set("operation", "read");

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 1 }),
          write: () => Promise.resolve({ processed: 1 }),
        },
        persist: async () => {
          await gate.promise;
          order.push("persist");
        },
        finalize: () => {
          order.push("finalize");
        },
      });

      const runPromise = pipeline.run(deps);
      void runPromise.catch(() => undefined);

      // While the gate stays closed, persist cannot have resolved, so
      // finalize cannot have run either — no matter how many microtasks
      // elapse.
      for (let i = 0; i < 25; i++) {
        await Promise.resolve();
      }
      expect(order).not.toContain("finalize");

      gate.resolve();
      await expect(runPromise).resolves.toMatchObject({
        status: "completed",
      });
      expect(order).toEqual(["persist", "finalize"]);
    });

    test("B38 LOAD-BEARING: when finalize throws, persist has already completed; the rejection is the finalize error, unmodified", async () => {
      let persisted = false;
      const finalizeError = new Error("post-dispatch assertion failed");
      const { deps, config } = makeHarness();
      config.set("operation", "read");

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 1 }),
          write: () => Promise.resolve({ processed: 1 }),
        },
        persist: () => {
          persisted = true;
          return Promise.resolve(undefined);
        },
        finalize: () => {
          throw finalizeError;
        },
      });

      const runPromise = pipeline.run(deps);
      void runPromise.catch(() => undefined);

      let thrown: unknown;
      try {
        await runPromise;
      } catch (error) {
        thrown = error;
      }
      expect(persisted).toBe(true);
      expect(thrown).toBe(finalizeError);
    });

    test("B39a a synchronous finalize is supported", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const finalize = vi.fn(() => undefined);
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 1 }),
          write: () => Promise.resolve({ processed: 1 }),
        },
        finalize,
      });

      await expect(pipeline.run(deps)).resolves.toMatchObject({
        status: "completed",
      });
      expect(finalize).toHaveBeenCalledTimes(1);
    });

    test("B39b a rejecting asynchronous finalize propagates", async () => {
      const finalizeError = new Error("async finalize failed");
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 1 }),
          write: () => Promise.resolve({ processed: 1 }),
        },
        finalize: () => Promise.reject(finalizeError),
      });

      await expect(pipeline.run(deps)).rejects.toBe(finalizeError);
    });
  });

  // -------------------------------------------------------------------------
  // Ordering (B1-B3)
  // -------------------------------------------------------------------------
  describe("ordering", () => {
    test("B1 the happy path resolves { status: 'completed', operation, result } with result reference-identical to the handler's value", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const handlerResult: TestResult = { processed: 42 };

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve(handlerResult),
          write: () => Promise.resolve(handlerResult),
        },
      });

      const outcome = await pipeline.run(deps);
      expect(outcome.status).toBe("completed");
      expect(outcome.operation).toBe("read");
      expect(outcome.result).toBe(handlerResult);
    });

    function buildOrderedPipeline(order: string[]) {
      const { deps, config, confirmMock } = makeHarness((config_) => {
        order.push("confirm");
        void config_;
        return Promise.resolve(true);
      });
      config.set("operation", "write");

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => {
          order.push("resolveSettings");
          return { yes: false };
        },
        requiredFields: { read: [], write: [] },
        prepare: () => {
          order.push("prepare");
          return Promise.resolve({ note: "n" });
        },
        destructive: {
          operations: new Set(["write"]),
          describe: () => {
            order.push("describe");
            return "destroy";
          },
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: {
          read: () => {
            order.push("handler");
            return Promise.resolve({ processed: 0 });
          },
          write: () => {
            order.push("handler");
            return Promise.resolve({ processed: 0 });
          },
        },
        persist: () => {
          order.push("persist");
          return Promise.resolve(undefined);
        },
        finalize: () => {
          order.push("finalize");
        },
      });

      return { pipeline, deps, confirmMock };
    }

    test("B2 a destructive op with every optional phase configured runs in the documented order", async () => {
      const order: string[] = [];
      const { pipeline, deps } = buildOrderedPipeline(order);

      await pipeline.run(deps);

      expect(order).toEqual([
        "resolveSettings",
        "prepare",
        "describe",
        "confirm",
        "handler",
        "persist",
        "finalize",
      ]);
    });

    test("B3 a throw during any phase stops the run there; no later phase runs", async () => {
      const { config } = makeHarness();
      config.set("operation", "write");

      // resolveSettings throws
      {
        const localOrder: string[] = [];
        const { deps, config: cfg } = makeHarness();
        cfg.set("operation", "write");
        const pipeline = new M3LOperationPipeline<
          TestOp,
          TestSettings,
          TestDeps,
          TestResult,
          TestContext
        >({
          operations: TEST_OPS,
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => {
            localOrder.push("resolveSettings");
            throw new Error("resolveSettings boom");
          },
          requiredFields: { read: [], write: [] },
          prepare: () => {
            localOrder.push("prepare");
            return Promise.resolve({ note: "n" });
          },
          handlers: {
            read: () => {
              localOrder.push("handler");
              return Promise.resolve({ processed: 0 });
            },
            write: () => {
              localOrder.push("handler");
              return Promise.resolve({ processed: 0 });
            },
          },
        });
        await expect(pipeline.run(deps)).rejects.toThrow(
          "resolveSettings boom",
        );
        expect(localOrder).toEqual(["resolveSettings"]);
      }

      // prepare throws
      {
        const localOrder: string[] = [];
        const { deps, config: cfg } = makeHarness();
        cfg.set("operation", "write");
        const pipeline = new M3LOperationPipeline<
          TestOp,
          TestSettings,
          TestDeps,
          TestResult,
          TestContext
        >({
          operations: TEST_OPS,
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => {
            localOrder.push("resolveSettings");
            return { yes: false };
          },
          requiredFields: { read: [], write: [] },
          prepare: () => {
            localOrder.push("prepare");
            throw new Error("prepare boom");
          },
          destructive: {
            operations: new Set(["write"]),
            describe: () => {
              localOrder.push("describe");
              return "destroy";
            },
            yes: () => false,
            abortCode: "ERR_TEST_ABORTED",
            onDecline: { kind: "throw" },
          },
          handlers: {
            read: () => {
              localOrder.push("handler");
              return Promise.resolve({ processed: 0 });
            },
            write: () => {
              localOrder.push("handler");
              return Promise.resolve({ processed: 0 });
            },
          },
        });
        await expect(pipeline.run(deps)).rejects.toThrow("prepare boom");
        expect(localOrder).toEqual(["resolveSettings", "prepare"]);
      }

      // handler throws
      {
        const localOrder: string[] = [];
        const { deps, config: cfg } = makeHarness();
        cfg.set("operation", "read");
        const pipeline = new M3LOperationPipeline<
          TestOp,
          TestSettings,
          TestDeps,
          TestResult,
          undefined
        >({
          operations: TEST_OPS,
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => {
            localOrder.push("resolveSettings");
            return { yes: false };
          },
          requiredFields: { read: [], write: [] },
          handlers: {
            read: () => {
              localOrder.push("handler");
              throw new Error("handler boom");
            },
            write: () => {
              localOrder.push("handler");
              throw new Error("handler boom");
            },
          },
          persist: () => {
            localOrder.push("persist");
            return Promise.resolve(undefined);
          },
          finalize: () => {
            localOrder.push("finalize");
          },
        });
        await expect(pipeline.run(deps)).rejects.toThrow("handler boom");
        expect(localOrder).toEqual(["resolveSettings", "handler"]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Statelessness (B49)
  // -------------------------------------------------------------------------
  describe("statelessness across runs", () => {
    test("B49 (R4) two sequential run() calls on one instance show no cross-run leakage of config-derived values", async () => {
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: (accessor) => ({
          bucket: accessor.optionalString("bucket"),
          yes: false,
        }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: (_operation, settings) =>
            Promise.resolve({
              processed: settings.bucket === "first" ? 1 : 2,
            }),
          write: (_operation, settings) =>
            Promise.resolve({
              processed: settings.bucket === "first" ? 1 : 2,
            }),
        },
      });

      const { deps: depsA, config: configA } = makeHarness();
      configA.set("operation", "read");
      configA.set("bucket", "first");
      const outcomeA = await pipeline.run(depsA);
      expect(outcomeA.result).toEqual({ processed: 1 });

      const { deps: depsB, config: configB } = makeHarness();
      configB.set("operation", "read");
      configB.set("bucket", "second");
      const outcomeB = await pipeline.run(depsB);
      expect(outcomeB.result).toEqual({ processed: 2 });
    });

    test("SC-B two concurrent run() calls on one instance via Promise.all show no cross-talk", async () => {
      const seen: { read?: TestSettings; write?: TestSettings } = {};

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        // The `await Promise.resolve()` yields to the microtask queue so the
        // two concurrent run() calls below genuinely interleave through this
        // phase instead of resolving sequentially before the other starts.
        resolveSettings: async (accessor) => {
          await Promise.resolve();
          return { bucket: accessor.optionalString("bucket"), yes: false };
        },
        requiredFields: { read: [], write: [] },
        handlers: {
          read: (_operation, settings) => {
            seen.read = settings;
            return Promise.resolve({
              processed: settings.bucket === "first" ? 1 : -1,
            });
          },
          write: (_operation, settings) => {
            seen.write = settings;
            return Promise.resolve({
              processed: settings.bucket === "second" ? 2 : -1,
            });
          },
        },
      });

      const { deps: depsA, config: configA } = makeHarness();
      configA.set("operation", "read");
      configA.set("bucket", "first");

      const { deps: depsB, config: configB } = makeHarness();
      configB.set("operation", "write");
      configB.set("bucket", "second");

      const [outcomeA, outcomeB] = await Promise.all([
        pipeline.run(depsA),
        pipeline.run(depsB),
      ]);

      expect(outcomeA.result).toEqual({ processed: 1 });
      expect(outcomeB.result).toEqual({ processed: 2 });
      expect(seen.read).not.toBe(seen.write);
      expect(seen.read?.bucket).toBe("first");
      expect(seen.write?.bucket).toBe("second");
    });
  });

  // -------------------------------------------------------------------------
  // Type-level contract (T1-T13)
  // -------------------------------------------------------------------------
  describe("type-level contract", () => {
    const T1_OPS = ["list", "describe", "get", "put", "delete-batch"] as const;
    type T1Op = (typeof T1_OPS)[number];

    interface T1Settings {
      readonly bucket: string;
      readonly key?: string | undefined;
      readonly yes: boolean;
    }

    interface T1Result {
      readonly processed: number;
      readonly failed: number;
    }

    const T1_REQUIRED_FIELDS = {
      list: [],
      describe: ["key"],
      get: ["key"],
      put: ["key"],
      "delete-batch": [],
    } as const;

    function t1ResolveSettings(
      accessor: M3LConfigAccessor,
      operation: T1Op,
    ): T1Settings {
      return {
        bucket: accessor.requiredString("bucket", operation),
        key: accessor.optionalString("key"),
        yes: accessor.booleanWithDefault("yes", false),
      };
    }

    function t1DescribeOrGet(
      operation: "describe" | "get",
      _settings: T1Settings,
    ): Promise<T1Result> {
      return Promise.resolve({
        processed: operation === "get" ? 1 : 0,
        failed: 0,
      });
    }

    function t1PutOrDeleteBatch(
      _operation: "put" | "delete-batch",
      _settings: T1Settings,
    ): Promise<T1Result> {
      return Promise.resolve({ processed: 1, failed: 0 });
    }

    test("T1 five generics infer from a single options literal (s3-objects shape)", () => {
      const pipeline = new M3LOperationPipeline({
        operations: T1_OPS,
        configCode: "ERR_S3_OBJECTS_CONFIG",
        resolveSettings: t1ResolveSettings,
        requiredFields: T1_REQUIRED_FIELDS,
        destructive: {
          operations: new Set(["put", "delete-batch"] as const),
          describe: (op, settings) => `${op} ${settings.bucket}`,
          yes: (settings) => settings.yes,
          abortCode: "ERR_S3_OBJECTS_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: () => ({ processed: 0, failed: 0 }),
          },
        },
        handlers: {
          list: () => Promise.resolve({ processed: 0, failed: 0 }),
          describe: t1DescribeOrGet,
          get: t1DescribeOrGet,
          put: t1PutOrDeleteBatch,
          "delete-batch": t1PutOrDeleteBatch,
        },
      });

      expectTypeOf(pipeline).toEqualTypeOf<
        M3LOperationPipeline<
          T1Op,
          T1Settings,
          M3LOperationPipelineBaseDeps,
          T1Result,
          undefined
        >
      >();

      const runResult = pipeline.run({
        config: new M3LConfig(),
        logger: new M3LLogger([]),
        prompt: new M3LPrompt(),
      });
      expectTypeOf(runResult).resolves.toEqualTypeOf<
        M3LOperationPipelineOutcome<T1Op, T1Result>
      >();
      void runResult.catch(() => undefined);
    });

    test("T2 a handler declared over a literal sub-union is assignable to each of its slots", () => {
      type Handlers = M3LOperationHandlers<
        T1Op,
        T1Settings,
        M3LOperationPipelineBaseDeps,
        T1Result,
        undefined
      >;
      expectTypeOf(t1DescribeOrGet).toExtend<Handlers["describe"]>();
      expectTypeOf(t1DescribeOrGet).toExtend<Handlers["get"]>();
      expectTypeOf(t1PutOrDeleteBatch).toExtend<Handlers["put"]>();
      expectTypeOf(t1PutOrDeleteBatch).toExtend<Handlers["delete-batch"]>();
    });

    test("T3 @ts-expect-error a missing handler key is a compile error", () => {
      new M3LOperationPipeline({
        operations: T1_OPS,
        configCode: "ERR_S3_OBJECTS_CONFIG",
        resolveSettings: t1ResolveSettings,
        requiredFields: T1_REQUIRED_FIELDS,
        // @ts-expect-error — `handlers` omits "delete-batch" (TS2741).
        handlers: {
          list: () => Promise.resolve({ processed: 0, failed: 0 }),
          describe: t1DescribeOrGet,
          get: t1DescribeOrGet,
          put: t1PutOrDeleteBatch,
        },
      });
    });

    test("T4 @ts-expect-error a missing requiredFields row is a compile error", () => {
      new M3LOperationPipeline({
        operations: T1_OPS,
        configCode: "ERR_S3_OBJECTS_CONFIG",
        resolveSettings: t1ResolveSettings,
        // @ts-expect-error — `requiredFields` omits the "list" row.
        requiredFields: {
          describe: ["key"],
          get: ["key"],
          put: ["key"],
          "delete-batch": [],
        },
        handlers: {
          list: () => Promise.resolve({ processed: 0, failed: 0 }),
          describe: t1DescribeOrGet,
          get: t1DescribeOrGet,
          put: t1PutOrDeleteBatch,
          "delete-batch": t1PutOrDeleteBatch,
        },
      });
    });

    test("T5 @ts-expect-error requiredFields cannot name a non-optional key; M3LGuardableKey admits only optional fields", () => {
      interface Probe {
        readonly bucket: string;
        readonly key?: string;
        readonly yes: boolean;
      }
      expectTypeOf<M3LGuardableKey<Probe>>().toEqualTypeOf<"key">();

      type ListRow = { readonly list: readonly M3LGuardableKey<T1Settings>[] };
      // @ts-expect-error — "bucket" is not optional, so it is not a
      // M3LGuardableKey<T1Settings> and cannot appear in a requiredFields row.
      const badRequiredFields: ListRow = { list: ["bucket"] };
      void badRequiredFields;
    });

    test("T6 @ts-expect-error destructive.operations cannot contain an off-union operation", () => {
      const destructive: M3LPipelineDestructiveOptions<
        T1Op,
        T1Settings,
        M3LOperationPipelineBaseDeps,
        T1Result,
        undefined
      > = {
        // @ts-expect-error — "archive" is not a member of T1Op.
        operations: new Set(["put", "archive"]),
        describe: (op, settings) => `${op} ${settings.bucket}`,
        yes: (settings) => settings.yes,
        abortCode: "ERR_S3_OBJECTS_ABORTED",
        onDecline: { kind: "throw" },
      };
      void destructive;
    });

    test("T7 prepare pins TContext; describe's unannotated 3rd param types as the context type", () => {
      interface Ctx {
        readonly plan: string;
      }
      const options: M3LOperationPipelineOptions<
        "delete",
        { readonly key: string },
        M3LOperationPipelineBaseDeps,
        { readonly processed: number },
        Ctx
      > = {
        operations: ["delete"],
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ key: "k" }),
        requiredFields: { delete: [] },
        prepare: () => Promise.resolve({ plan: "p" }),
        destructive: {
          operations: new Set(["delete"]),
          describe: (_op, _settings, ctx) => {
            expectTypeOf(ctx).toEqualTypeOf<Ctx>();
            return ctx.plan;
          },
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: {
          delete: (_op, _settings, ctx) => {
            expectTypeOf(ctx).toEqualTypeOf<Ctx>();
            return Promise.resolve({ processed: ctx.plan.length });
          },
        },
      };
      void options;
    });

    test("T8 no prepare configured defaults TContext to undefined; handlers declaring context: undefined compile", () => {
      const options: M3LOperationPipelineOptions<
        "list",
        { readonly key?: string },
        M3LOperationPipelineBaseDeps,
        { readonly processed: number }
      > = {
        operations: ["list"],
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({}),
        requiredFields: { list: [] },
        handlers: {
          list: (_op, _settings, context: undefined) => {
            expectTypeOf(context).toEqualTypeOf<undefined>();
            return Promise.resolve({ processed: 0 });
          },
        },
      };
      void options;
    });

    test("T9 run() resolves M3LOperationPipelineOutcome<Op, Result>; status stays the full union regardless of decline policy", () => {
      const _pipeline = new M3LOperationPipeline({
        operations: ["list", "delete"] as const,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { list: [], delete: [] },
        destructive: {
          operations: new Set(["delete"] as const),
          describe: () => "delete",
          yes: (settings: { readonly yes: boolean }) => settings.yes,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "throw" as const,
          },
        },
        handlers: {
          list: () => Promise.resolve({ processed: 0 }),
          delete: () => Promise.resolve({ processed: 1 }),
        },
      });

      type Outcome = Awaited<ReturnType<typeof _pipeline.run>>;
      expectTypeOf<Outcome>().toEqualTypeOf<
        M3LOperationPipelineOutcome<"list" | "delete", { processed: number }>
      >();
      expectTypeOf<Outcome["status"]>().toEqualTypeOf<
        "completed" | "declined" | "partial"
      >();
    });

    test("T10 an async resolveSettings compiles identically to a sync one", () => {
      const options: M3LOperationPipelineOptions<
        "list",
        { readonly key?: string | undefined },
        M3LOperationPipelineBaseDeps,
        { readonly processed: number }
      > = {
        operations: ["list"],
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: async (accessor) => {
          await Promise.resolve();
          return { key: accessor.optionalString("key") };
        },
        requiredFields: { list: [] },
        handlers: {
          list: () => Promise.resolve({ processed: 0 }),
        },
      };
      void options;
    });

    test("T11 TDeps infers from an annotated callback parameter, not just the base deps default", () => {
      interface ExtendedDeps extends M3LOperationPipelineBaseDeps {
        readonly correlationId: string;
      }

      const _pipeline = new M3LOperationPipeline({
        operations: ["list"] as const,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: (): { readonly yes: boolean } => ({ yes: false }),
        requiredFields: { list: [] },
        handlers: {
          list: (
            _op: "list",
            _settings: { readonly yes: boolean },
            _context: undefined,
            deps: ExtendedDeps,
          ) => {
            expectTypeOf(deps).toEqualTypeOf<ExtendedDeps>();
            return Promise.resolve({ processed: 0 });
          },
        },
      });

      // The essence of T11: TDeps infers as the wider ExtendedDeps (picked up
      // from the handler's annotated 4th parameter), not the narrower base
      // deps default — checked directly against `run`'s parameter type.
      expectTypeOf<
        Parameters<typeof _pipeline.run>[0]
      >().toEqualTypeOf<ExtendedDeps>();
    });

    test("T12 @ts-expect-error a soft-land result vs. handler TResult mismatch is a compile error surfaced on handlers", () => {
      new M3LOperationPipeline({
        operations: ["list"] as const,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { list: [] },
        destructive: {
          operations: new Set([] as const),
          describe: () => "n/a",
          yes: (settings: { readonly yes: boolean }) => settings.yes,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: () => ({ processed: 0 }),
          },
        },
        handlers: {
          // @ts-expect-error — the soft-land `result` callback above returns
          // `{ processed: number }` while this "list" handler resolves
          // `{ count: number }`; TResult cannot unify. The diagnostic's exact
          // location/code is not asserted — only that construction errors.
          list: () => Promise.resolve({ count: 0 }),
        },
      });
    });

    test("T13 @ts-expect-error prepare is required whenever TContext is pinned to a non-undefined type", () => {
      interface Ctx {
        readonly plan: string;
      }
      new M3LOperationPipeline<
        "delete",
        { readonly key: string },
        M3LOperationPipelineBaseDeps,
        { readonly processed: number },
        Ctx
      >(
        // @ts-expect-error — TContext is pinned to `Ctx` (not `undefined`) via
        // the explicit type args above, so `prepare` becomes a required
        // member of the conditional intersection (see
        // M3LOperationPipelineOptions); omitting it here must fail to
        // compile.
        {
          operations: ["delete"],
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => ({ key: "k" }),
          requiredFields: { delete: [] },
          handlers: {
            delete: (
              _op: "delete",
              _settings: { readonly key: string },
              ctx: Ctx,
            ) => {
              expectTypeOf(ctx).toEqualTypeOf<Ctx>();
              return Promise.resolve({ processed: ctx.plan.length });
            },
          },
        },
      );
    });

    test("T14 @ts-expect-error a widened operations array is rejected", () => {
      const widened: readonly string[] = ["read", "write"];
      new M3LOperationPipeline({
        // @ts-expect-error — `operations` requires the non-empty readonly
        // tuple `readonly [TOp, ...(readonly TOp[])]`, not a widened
        // `readonly string[]`; a widened array would infer TOp = string
        // and dissolve handler-table exhaustiveness.
        operations: widened,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ key: "k" }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ count: 0 }),
          write: () => Promise.resolve({ count: 0 }),
        },
      });
    });

    test("T15 persist and finalize 4th parameter is TOp (F12)", () => {
      // F12: persist and finalize receive operation as 4th argument.
      // These type-level assertions verify the callback signatures include
      // `operation: TOp` as parameter index [3].
      type Opts = M3LOperationPipelineOptions<
        "list" | "get",
        T1Settings,
        M3LOperationPipelineBaseDeps,
        T1Result,
        undefined
      >;

      expectTypeOf<Parameters<NonNullable<Opts["persist"]>>[3]>().toEqualTypeOf<
        "list" | "get"
      >();

      expectTypeOf<
        Parameters<NonNullable<Opts["finalize"]>>[3]
      >().toEqualTypeOf<"list" | "get">();
    });
  });

  // ---------------------------------------------------------------------------
  // Gate — target-graded confirmation (ADR-0048 forwarding) (TG-1–TG-8)
  // ---------------------------------------------------------------------------
  describe("gate — target-graded confirmation (ADR-0048 forwarding)", () => {
    /**
     * A fixture AWS target used by every target-grading test. The profile is
     * "prod" so TG-6's matching echo can return the profile literally.
     */
    const PROD_TARGET: M3LDestructiveTarget = {
      profile: "prod",
      region: "us-east-1",
      accountId: "111122223333",
    };

    /** A predicate that always classifies the target as sensitive (state 4/5). */
    const alwaysSensitive: M3LDestructiveTargetPredicate = () => true;

    /** A predicate that always classifies the target as non-sensitive (state 2). */
    const neverSensitive: M3LDestructiveTargetPredicate = () => false;

    /**
     * Extends makeHarness to also expose an `inputMock` that backs
     * `prompt.text` (routed through `adapter.input` inside M3LPrompt).
     */
    function makeTargetHarness(opts: {
      readonly confirmImpl?: () => Promise<boolean>;
      readonly inputImpl?: () => Promise<string>;
    }): {
      readonly deps: TestDeps;
      readonly config: M3LConfig;
      readonly logger: M3LLogger;
      readonly warningSpy: MockInstance;
      readonly confirmMock: Mock;
      readonly inputMock: Mock;
    } {
      const config = new M3LConfig();
      const logger = new M3LLogger([]);
      const warningSpy = vi.spyOn(logger, "warning");
      const confirmMock = vi.fn(
        opts.confirmImpl ?? (() => Promise.resolve(true)),
      );
      const inputMock = vi.fn(opts.inputImpl ?? (() => Promise.resolve("")));
      const adapter = {
        input: inputMock,
        password: vi.fn(),
        number: vi.fn(),
        confirm: confirmMock,
        select: vi.fn(),
        checkbox: vi.fn(),
        search: vi.fn(),
      } as unknown as M3LPromptAdapter;
      const prompt = new M3LPrompt({ adapter });
      const deps: TestDeps = { config, logger, prompt };
      return { deps, config, logger, warningSpy, confirmMock, inputMock };
    }

    test("TG-1 no target in destructive config — prompt.confirm used, adapter.input (prompt.text) never called", async () => {
      const { deps, config, confirmMock, inputMock } = makeTargetHarness({});
      config.set("operation", "write");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "delete bucket my-bucket",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
          // no target / isSensitiveTarget / yesSensitive
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 0 }),
        },
      });

      await pipeline.run(deps);
      expect(confirmMock).toHaveBeenCalledTimes(1);
      expect(inputMock).not.toHaveBeenCalled();
    });

    test("TG-2 target callback receives all four args (operation, settings, context, deps) — context by reference", async () => {
      const context: TestContext = { note: "shared-target-ctx" };
      const { deps, config } = makeTargetHarness({
        // Return matching profile so the escalated echo succeeds.
        inputImpl: () => Promise.resolve(PROD_TARGET.profile),
      });
      config.set("operation", "write");

      let capturedOperation: string | undefined;
      let capturedSettings: TestSettings | undefined;
      let capturedContext: TestContext | undefined;
      let capturedDeps: TestDeps | undefined;

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        prepare: () => Promise.resolve(context),
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
          target: (op, settings, ctx, d) => {
            capturedOperation = op;
            capturedSettings = settings;
            capturedContext = ctx;
            capturedDeps = d;
            return PROD_TARGET;
          },
          isSensitiveTarget: alwaysSensitive,
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 0 }),
        },
      });

      await pipeline.run(deps);

      expect(capturedOperation).toBe("write");
      expect(capturedSettings).toMatchObject({ yes: false });
      expect(capturedContext).toBe(context);
      expect(capturedDeps).toBe(deps);
    });

    test("TG-3 non-sensitive target + yes=true → normal yes-bypass (prompt.confirm bypassed, prompt.text not called)", async () => {
      const { deps, config, confirmMock, inputMock, warningSpy } =
        makeTargetHarness({});
      config.set("operation", "write");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: true }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "delete bucket my-bucket",
          yes: (settings) => settings.yes,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
          target: () => PROD_TARGET,
          isSensitiveTarget: neverSensitive,
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 5 }),
        },
      });

      await expect(pipeline.run(deps)).resolves.toMatchObject({
        status: "completed",
        result: { processed: 5 },
      });
      expect(confirmMock).not.toHaveBeenCalled();
      expect(inputMock).not.toHaveBeenCalled();
      // The normal yes-bypass warning is still emitted by confirmDestructive.
      expect(warningSpy).toHaveBeenCalledTimes(1);
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining("yes=true"),
      );
    });

    test("TG-4 sensitive target + yes=true only → still prompts via prompt.text (load-bearing ADR-0048 clause reaching the pipeline)", async () => {
      // yesSensitive is absent: the routine --yes flag must NOT bypass a
      // sensitive-target prompt.  The escalated typed-echo (adapter.input)
      // must be called instead of the normal confirm.
      const { deps, config, confirmMock, inputMock } = makeTargetHarness({
        inputImpl: () => Promise.resolve(PROD_TARGET.profile),
      });
      config.set("operation", "write");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: true }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "delete bucket my-bucket",
          yes: (settings) => settings.yes,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
          target: () => PROD_TARGET,
          isSensitiveTarget: alwaysSensitive,
          // yesSensitive intentionally absent — yes alone must not bypass
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 0 }),
        },
      });

      await pipeline.run(deps);

      expect(inputMock).toHaveBeenCalledTimes(1);
      expect(confirmMock).not.toHaveBeenCalled();
    });

    test("TG-5 sensitive + yes=true + yesSensitive=true → bypassed, one warning naming the target, no prompt call", async () => {
      const { deps, config, confirmMock, inputMock, warningSpy } =
        makeTargetHarness({});
      config.set("operation", "write");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: true }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "delete bucket my-bucket",
          yes: (settings) => settings.yes,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
          target: () => PROD_TARGET,
          isSensitiveTarget: alwaysSensitive,
          yesSensitive: () => true,
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 3 }),
        },
      });

      await expect(pipeline.run(deps)).resolves.toMatchObject({
        status: "completed",
        result: { processed: 3 },
      });
      expect(confirmMock).not.toHaveBeenCalled();
      expect(inputMock).not.toHaveBeenCalled();
      // Exactly one warning; it must name both the bypass mode and the target profile.
      expect(warningSpy).toHaveBeenCalledTimes(1);
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining("yesSensitive=true"),
      );
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining(PROD_TARGET.profile),
      );
    });

    test("TG-6 sensitive + typed echo matching profile → handler runs (inputMock called, confirmMock not called)", async () => {
      const handler = vi.fn(() => Promise.resolve({ processed: 7 }));
      const { deps, config, confirmMock, inputMock } = makeTargetHarness({
        inputImpl: () => Promise.resolve(PROD_TARGET.profile),
      });
      config.set("operation", "write");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "delete bucket my-bucket",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
          target: () => PROD_TARGET,
          isSensitiveTarget: alwaysSensitive,
        },
        handlers: {
          read: handler,
          write: handler,
        },
      });

      await expect(pipeline.run(deps)).resolves.toMatchObject({
        status: "completed",
        result: { processed: 7 },
      });
      // The escalated typed-echo path must be used, not the normal yes/no confirm.
      expect(inputMock).toHaveBeenCalledTimes(1);
      expect(confirmMock).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test("TG-7a sensitive + mismatched echo + onDecline throw → throws with abortCode (must classify as a decline)", async () => {
      // This is the most important integration assertion: a failed typed-echo
      // carries abortCode and must be treated as a decline, exactly like a
      // confirm-false decline.
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));
      const { deps, config } = makeTargetHarness({
        inputImpl: () => Promise.resolve("wrong-profile"),
      });
      config.set("operation", "write");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "delete bucket my-bucket",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
          target: () => PROD_TARGET,
          isSensitiveTarget: alwaysSensitive,
        },
        handlers: { read: handler, write: handler },
      });

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_TEST_ABORTED");
      expect(handler).not.toHaveBeenCalled();
    });

    test("TG-7b sensitive + mismatched echo + soft-land → resolves status:declined, persist/finalize and handler skipped", async () => {
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));
      const persist = vi.fn(() => Promise.resolve());
      const finalize = vi.fn(() => Promise.resolve());
      const { deps, config } = makeTargetHarness({
        inputImpl: () => Promise.resolve("wrong-profile"),
      });
      config.set("operation", "write");
      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        persist,
        finalize,
        destructive: {
          operations: new Set(["write"]),
          describe: () => "delete bucket my-bucket",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: () => ({ processed: 0 }),
          },
          target: () => PROD_TARGET,
          isSensitiveTarget: alwaysSensitive,
        },
        handlers: { read: handler, write: handler },
      });

      await expect(pipeline.run(deps)).resolves.toMatchObject({
        status: "declined",
        operation: "write",
      });
      expect(handler).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
    });

    test("TG-8 target callback that throws propagates reference-identically; prompt and handler are skipped", async () => {
      const targetError = new Error("target callback blew up");
      const { deps, config, confirmMock, inputMock } = makeTargetHarness({});
      config.set("operation", "write");
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
          target: () => {
            throw targetError;
          },
          isSensitiveTarget: alwaysSensitive,
        },
        handlers: { read: handler, write: handler },
      });

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(targetError);
      expect(confirmMock).not.toHaveBeenCalled();
      expect(inputMock).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Finding 2 — throwing isSensitiveTarget misclassified as a decline
    //
    // isSensitiveTarget is called INSIDE confirmDestructive which is inside
    // #runGate's try/catch.  The catch absorbs any M3LError whose code
    // matches abortCode.  Under soft-land, such an error is returned as
    // { status: "declined" } instead of propagating — the real cause is lost
    // and the operator is never prompted.
    //
    // Under onDecline:throw the error also hits the catch, but is re-thrown,
    // so that branch is already correct.  Both branches are tested here for
    // documentation and regression protection.
    //
    // RED: TG-SF-P2 (soft-land) FAILS — run resolves with "declined".
    // GREEN: error propagates reference-identically in both branches.
    // -----------------------------------------------------------------------
    test("TG-SF-P1 isSensitiveTarget throwing M3LError with abortCode under onDecline:throw — propagates reference-identically (control, passes in RED)", async () => {
      const predicateError = new M3LError("predicate blew up", {
        code: "ERR_TEST_ABORTED",
      });
      const { deps, config, confirmMock, inputMock } = makeTargetHarness({});
      config.set("operation", "write");
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
          target: () => PROD_TARGET,
          isSensitiveTarget: () => {
            throw predicateError;
          },
        },
        handlers: { read: handler, write: handler },
      });

      await expect(pipeline.run(deps)).rejects.toBe(predicateError);
      expect(confirmMock).not.toHaveBeenCalled();
      expect(inputMock).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    test("TG-SF-P2 isSensitiveTarget throwing M3LError with abortCode under soft-land — propagates, NOT returned as declined [FINDING 2 — RED]", async () => {
      // RED: the catch in #runGate absorbs the M3LError (code matches abortCode),
      // soft-land policy fires, and run resolves with { status: "declined" }.
      // The .rejects.toBe(...) assertion therefore fails in RED.
      // GREEN: the error is re-thrown before the soft-land branch is reached.
      const predicateError = new M3LError("predicate blew up", {
        code: "ERR_TEST_ABORTED",
      });
      const { deps, config, confirmMock, inputMock } = makeTargetHarness({});
      config.set("operation", "write");
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: () => ({ processed: 0 }),
          },
          target: () => PROD_TARGET,
          isSensitiveTarget: () => {
            throw predicateError;
          },
        },
        handlers: { read: handler, write: handler },
      });

      await expect(pipeline.run(deps)).rejects.toBe(predicateError);
      expect(confirmMock).not.toHaveBeenCalled();
      expect(inputMock).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    test("TG-SF-P3 isSensitiveTarget throwing a plain Error propagates reference-identically (control — plain Error is never absorbed)", async () => {
      const predicateError = new Error("plain predicate error");
      const { deps, config, confirmMock, inputMock } = makeTargetHarness({});
      config.set("operation", "write");
      const handler = vi.fn(() => Promise.resolve({ processed: 0 }));

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: () => ({ processed: 0 }),
          },
          target: () => PROD_TARGET,
          isSensitiveTarget: () => {
            throw predicateError;
          },
        },
        handlers: { read: handler, write: handler },
      });

      await expect(pipeline.run(deps)).rejects.toBe(predicateError);
      expect(confirmMock).not.toHaveBeenCalled();
      expect(inputMock).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    describe("type-level", () => {
      test("TG-T1 existing destructive config without target/isSensitiveTarget/yesSensitive is still well-typed (backwards compat)", () => {
        const destructive: M3LPipelineDestructiveOptions<
          TestOp,
          TestSettings,
          TestDeps,
          TestResult,
          TestContext
        > = {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
          // target, isSensitiveTarget, yesSensitive all absent — must type-check
        };
        void destructive;
      });

      test("TG-T2 target return type is M3LDestructiveTarget", () => {
        type TargetCallback = NonNullable<
          M3LPipelineDestructiveOptions<
            TestOp,
            TestSettings,
            TestDeps,
            TestResult,
            TestContext
          >["target"]
        >;
        expectTypeOf<
          ReturnType<TargetCallback>
        >().toEqualTypeOf<M3LDestructiveTarget>();
      });

      test("TG-T3 isSensitiveTarget is typed as M3LDestructiveTargetPredicate", () => {
        type IsSensitive = NonNullable<
          M3LPipelineDestructiveOptions<
            TestOp,
            TestSettings,
            TestDeps,
            TestResult,
            TestContext
          >["isSensitiveTarget"]
        >;
        expectTypeOf<IsSensitive>().toEqualTypeOf<M3LDestructiveTargetPredicate>();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Recovery phase (A3: issue #470)
  // -------------------------------------------------------------------------
  describe("recovery", () => {
    // Minimal recovery entry fixtures — the error array uses M3LSerializedError
    // structure (name + message required; all other fields optional per the
    // format-error contract).
    const RECOVERY_ENTRY_1: M3LRunRecoveryEntry = {
      item: "item-a",
      error: [{ name: "Error", message: "item-a failed" }],
      recordedAt: "2026-08-19T00:00:00.000Z",
    };
    const RECOVERY_ENTRY_2: M3LRunRecoveryEntry = {
      item: "item-b",
      error: [{ name: "Error", message: "item-b failed" }],
      recordedAt: "2026-08-19T00:00:01.000Z",
    };

    test("REC-1 no recovery callback: outcome status is 'completed', recovery field absent", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 3 }),
          write: () => Promise.resolve({ processed: 3 }),
        },
        // No recovery callback — behavior must be byte-identical to pre-A3.
      });

      const outcome = await pipeline.run(deps);
      expect(outcome.status).toBe("completed");
      expect(outcome.operation).toBe("read");
      // The recovery field must be absent (not an empty array, not undefined-but-present).
      expect(Object.hasOwn(outcome, "recovery")).toBe(false);
    });

    test("REC-2 recovery returning empty array → status 'completed', outcome.recovery absent", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const recovery = vi.fn((): readonly M3LRunRecoveryEntry[] => []);

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 5 }),
          write: () => Promise.resolve({ processed: 5 }),
        },
        recovery,
      });

      const outcome = await pipeline.run(deps);
      expect(recovery).toHaveBeenCalledTimes(1);
      // Empty array → engine classifies as clean; status must be "completed".
      expect(outcome.status).toBe("completed");
      // The field must be absent — not an empty array sitting under the key.
      expect(Object.hasOwn(outcome, "recovery")).toBe(false);
      expect(outcome.recovery).toBeUndefined();
    });

    test("REC-3 recovery returning non-empty array → status 'partial', entries present reference-identically", async () => {
      const entries: readonly M3LRunRecoveryEntry[] = [
        RECOVERY_ENTRY_1,
        RECOVERY_ENTRY_2,
      ];
      const { deps, config } = makeHarness();
      config.set("operation", "read");

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 10 }),
          write: () => Promise.resolve({ processed: 10 }),
        },
        recovery: () => entries,
      });

      const outcome = await pipeline.run(deps);
      expect(outcome.status).toBe("partial");
      // The engine passes the returned array through reference-identically.
      expect(outcome.recovery).toBe(entries);
      expect(outcome.recovery).toHaveLength(2);
    });

    test("REC-4 a partial run still ran persist and finalize", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const persist = vi.fn(() => Promise.resolve(undefined));
      const finalize = vi.fn(() => undefined);

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 7 }),
          write: () => Promise.resolve({ processed: 7 }),
        },
        persist,
        finalize,
        recovery: () => [RECOVERY_ENTRY_1],
      });

      const outcome = await pipeline.run(deps);
      expect(outcome.status).toBe("partial");
      // A partial run dispatched and produced a result — persist and finalize
      // both ran.
      expect(persist).toHaveBeenCalledTimes(1);
      expect(finalize).toHaveBeenCalledTimes(1);
    });

    test("REC-5 recovery is called exactly once with (result, settings, deps, operation), and runs after finalize", async () => {
      const handlerResult: TestResult = { processed: 2 };
      const settings: TestSettings = { yes: false };
      const { deps, config } = makeHarness();
      config.set("operation", "write");
      const order: string[] = [];

      const finalize = vi.fn(() => {
        order.push("finalize");
      });
      const recovery = vi.fn(
        (
          _result: TestResult,
          _settings: TestSettings,
          _deps: TestDeps,
          _op: TestOp,
        ): readonly M3LRunRecoveryEntry[] => {
          order.push("recovery");
          return [RECOVERY_ENTRY_1];
        },
      );

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => settings,
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve(handlerResult),
          write: () => Promise.resolve(handlerResult),
        },
        finalize,
        recovery,
      });

      await pipeline.run(deps);

      expect(recovery).toHaveBeenCalledTimes(1);
      // Phase 10 receives exactly the same four arguments as persist/finalize.
      expect(recovery).toHaveBeenCalledWith(
        handlerResult,
        settings,
        deps,
        "write",
      );
      // Recovery runs AFTER finalize — order is load-bearing per the contract.
      expect(order).toEqual(["finalize", "recovery"]);
    });

    test("REC-6 a soft-landed declined run never invokes the recovery callback", async () => {
      // The gate fires, user declines (confirm returns false) → soft-land.
      // Phases 8–10 are all skipped (persist, finalize, recovery).
      const { deps, config } = makeHarness(() => Promise.resolve(false));
      config.set("operation", "write");
      const recovery = vi.fn((): readonly M3LRunRecoveryEntry[] => [
        RECOVERY_ENTRY_1,
      ]);

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "delete all",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: () => ({ processed: 0 }),
          },
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 0 }),
        },
        recovery,
      });

      const outcome = await pipeline.run(deps);
      expect(outcome.status).toBe("declined");
      expect(recovery).not.toHaveBeenCalled();
    });

    test("REC-7 a throwing recovery callback propagates the original error unmodified", async () => {
      const recoveryError = new Error("recovery exploded");
      const { deps, config } = makeHarness();
      config.set("operation", "read");

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 1 }),
          write: () => Promise.resolve({ processed: 1 }),
        },
        recovery: (): readonly M3LRunRecoveryEntry[] => {
          throw recoveryError;
        },
      });

      // The engine never swallows, wraps, or re-codes errors from any phase.
      await expect(pipeline.run(deps)).rejects.toBe(recoveryError);
    });

    test("REC-ORD full phase order when recovery is configured: handler → persist → finalize → recovery", async () => {
      const order: string[] = [];
      const { deps, config } = makeHarness();
      config.set("operation", "read");

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => {
            order.push("handler");
            return Promise.resolve({ processed: 0 });
          },
          write: () => {
            order.push("handler");
            return Promise.resolve({ processed: 0 });
          },
        },
        persist: () => {
          order.push("persist");
          return Promise.resolve(undefined);
        },
        finalize: () => {
          order.push("finalize");
        },
        recovery: () => {
          order.push("recovery");
          return [RECOVERY_ENTRY_1];
        },
      });

      await pipeline.run(deps);

      expect(order).toEqual(["handler", "persist", "finalize", "recovery"]);
    });

    describe("type-level", () => {
      test("REC-T1 status union on M3LOperationPipelineOutcome is exactly 'completed' | 'declined' | 'partial'", () => {
        expectTypeOf<
          M3LOperationPipelineOutcome<TestOp, TestResult>["status"]
        >().toEqualTypeOf<"completed" | "declined" | "partial">();
      });

      test("REC-T2a narrowing to status === 'partial' makes recovery a required non-optional array", () => {
        type PartialArm = Extract<
          M3LOperationPipelineOutcome<TestOp, TestResult>,
          { status: "partial" }
        >;
        // Required — not `readonly M3LRunRecoveryEntry[] | undefined`.
        expectTypeOf<PartialArm["recovery"]>().toEqualTypeOf<
          readonly M3LRunRecoveryEntry[]
        >();
      });

      test("REC-T2b a completed outcome cannot carry recovery entries", () => {
        // Extract<Base & (A | B), {status:"completed"}> resolves to `never`
        // under an intersection-of-union shape, so indexing ["recovery"] on it
        // is vacuously `never` — not a useful assertion. Instead use the same
        // structural form as REC-T2d: a shape that IS the bad combination must
        // not match the outcome type.
        type CompletedWithRecovery = {
          readonly operation: TestOp;
          readonly result: TestResult;
          readonly status: "completed";
          readonly recovery: readonly M3LRunRecoveryEntry[];
        };
        expectTypeOf<CompletedWithRecovery>().not.toMatchTypeOf<
          M3LOperationPipelineOutcome<TestOp, TestResult>
        >();
        // And the non-vacuous control: a completed outcome WITHOUT recovery
        // IS assignable (ensures the assertion above fails only on the presence
        // of recovery, not on some unrelated field mismatch).
        type CompletedNoRecovery = {
          readonly operation: TestOp;
          readonly result: TestResult;
          readonly status: "completed";
        };
        expectTypeOf<CompletedNoRecovery>().toMatchTypeOf<
          M3LOperationPipelineOutcome<TestOp, TestResult>
        >();
      });

      test("REC-T2c a declined outcome cannot carry recovery entries", () => {
        type DeclinedWithRecovery = {
          readonly operation: TestOp;
          readonly result: TestResult;
          readonly status: "declined";
          readonly recovery: readonly M3LRunRecoveryEntry[];
        };
        expectTypeOf<DeclinedWithRecovery>().not.toMatchTypeOf<
          M3LOperationPipelineOutcome<TestOp, TestResult>
        >();
        // Non-vacuous control: declined without recovery IS assignable.
        type DeclinedNoRecovery = {
          readonly operation: TestOp;
          readonly result: TestResult;
          readonly status: "declined";
        };
        expectTypeOf<DeclinedNoRecovery>().toMatchTypeOf<
          M3LOperationPipelineOutcome<TestOp, TestResult>
        >();
      });

      test("REC-T2d { status: 'completed', recovery: [...] } is not assignable to M3LOperationPipelineOutcome", () => {
        // The discriminated union makes this combination unrepresentable.
        // Construct the bad shape directly (no M3LOperationPipelineOutcomeBase
        // intersection — that would resolve to `any` in RED and trip
        // no-redundant-type-constituents before the type lands).
        type BadOutcome = {
          readonly operation: TestOp;
          readonly result: TestResult;
          readonly status: "completed";
          readonly recovery: readonly M3LRunRecoveryEntry[];
        };
        expectTypeOf<BadOutcome>().not.toMatchTypeOf<
          M3LOperationPipelineOutcome<TestOp, TestResult>
        >();
      });

      test("REC-T2e result and operation are reachable on every arm without narrowing (base-type guarantee)", () => {
        // A thin wrapper must be able to return `outcome.result` unconditionally
        // regardless of status — moving these fields to the base type is what
        // preserves that guarantee across the discriminated union.
        expectTypeOf<
          M3LOperationPipelineOutcome<TestOp, TestResult>["result"]
        >().toEqualTypeOf<TestResult>();
        expectTypeOf<
          M3LOperationPipelineOutcome<TestOp, TestResult>["operation"]
        >().toEqualTypeOf<TestOp>();
      });

      test("REC-T2f M3LOperationPipelineOutcomeBase is importable from the pipeline barrel", () => {
        // The barrel uses explicit named exports; a missing entry makes this a
        // compile error (TS2724) rather than a silent undefined. The assignment
        // itself is the structural assertion — no member access needed.
        const base: M3LOperationPipelineOutcomeBase<TestOp, TestResult> = {
          operation: "read",
          result: { processed: 0 },
        };
        void base;
      });

      test("REC-T3 recovery callback on options has signature (result, settings, deps, operation) => readonly M3LRunRecoveryEntry[]", () => {
        type RecoveryFn = NonNullable<
          M3LOperationPipelineOptions<
            TestOp,
            TestSettings,
            TestDeps,
            TestResult,
            undefined
          >["recovery"]
        >;
        expectTypeOf<Parameters<RecoveryFn>>().toEqualTypeOf<
          [TestResult, TestSettings, TestDeps, TestOp]
        >();
        expectTypeOf<ReturnType<RecoveryFn>>().toEqualTypeOf<
          readonly M3LRunRecoveryEntry[]
        >();
      });
    });
  });
});

// Re-export the imported types so an unused-import lint rule never flags a
// type-only import that is exercised solely inside `expectTypeOf`/annotation
// positions above.
export type {
  M3LGuardableKey as _M3LGuardableKey,
  M3LOperationPipelineOutcomeBase as _M3LOperationPipelineOutcomeBase,
  M3LPipelineDeclinePolicy as _M3LPipelineDeclinePolicy,
  M3LRunRecoveryEntry as _M3LRunRecoveryEntry,
};
