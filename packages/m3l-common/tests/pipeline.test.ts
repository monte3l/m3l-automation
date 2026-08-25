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
import { M3L_ERROR_CODES, M3LError } from "../src/core/errors/index.js";
import { M3LLogger } from "../src/core/logging/M3LLogger.js";
import { M3LPrompt } from "../src/core/prompt/M3LPrompt.js";
import type { M3LPromptAdapter } from "../src/core/prompt/types.js";
// Namespace import used ONLY by TG-9 to `vi.spyOn` the real `confirmDestructive`
// collaborator M3LOperationPipeline imports directly (a collaborator-seam spy,
// not a library-barrel mock) — every other gate test exercises it for real.
import * as M3LDestructiveGateModule from "../src/core/prompt/M3LDestructiveGate.js";
import type {
  M3LDestructiveTarget,
  M3LDestructiveTargetPredicate,
} from "../src/core/prompt/M3LDestructiveGate.js";
import type {
  M3LBreadcrumbScalar,
  M3LRunRecoveryEntry,
} from "../src/core/diagnostics/index.js";
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
  M3LPipelinePhase,
  M3LPipelineTraceOptions,
  M3LPipelineTraceSnapshot,
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

    // -----------------------------------------------------------------------
    // Aggregate construction-time validation (VAL-1–VAL-6)
    //
    // The doc (docs/reference/core/pipeline.md § Construction-time validation)
    // says every problem is collected before throwing, rather than the
    // first-failure short-circuit `internal/pipeline/validate.ts` implements
    // today. The three problem codes are individually achievable in
    // combination — EXCEPT all three at once: ERR_PIPELINE_EMPTY_OPERATIONS
    // requires `operations.length === 0`, while ERR_PIPELINE_DUPLICATE_OPERATION
    // requires a repeated entry in that same array (length >= 2). Those two
    // preconditions are mutually exclusive, so "three simultaneous problems,
    // one of each code" is not constructible. VAL-1 and VAL-2 below instead
    // cover all three codes across two achievable two-problem combinations
    // (duplicate+unknown-destructive, and the doc's own empty+unknown-destructive
    // example) — see the RED report for this discrepancy against the fuller
    // "three simultaneous problems" framing.
    // -----------------------------------------------------------------------
    describe("aggregate construction-time validation", () => {
      interface Problem {
        readonly code: string;
        readonly message: string;
        readonly operation?: string;
      }

      function constructAndCapture(options: unknown): {
        readonly error: M3LError;
        readonly problems: readonly Problem[];
      } {
        let thrown: unknown;
        try {
          new M3LOperationPipeline(
            options as M3LOperationPipelineOptions<
              TestOp,
              TestSettings,
              TestDeps,
              TestResult,
              TestContext
            >,
          );
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(M3LError);
        const error = thrown as M3LError;
        expect(error.code).toBe("ERR_PIPELINE_INVALID_OPTION");
        const problems = (error.context as { problems?: unknown }).problems;
        expect(Array.isArray(problems)).toBe(true);
        return { error, problems: problems as readonly Problem[] };
      }

      test("VAL-1 duplicate operations + unknown destructive operation are BOTH reported in one throw", () => {
        const { problems } = constructAndCapture({
          operations: ["read", "read", "write"],
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => ({ yes: false }),
          destructive: {
            operations: new Set(["bogus"]),
            describe: () => "desc",
            yes: () => false,
            abortCode: "ERR_TEST_ABORTED",
            onDecline: { kind: "throw" },
          },
          handlers: NOOP_HANDLERS,
        });

        expect(problems).toHaveLength(2);
        const codes = problems.map((problem) => problem.code).sort();
        expect(codes).toEqual([
          "ERR_PIPELINE_DUPLICATE_OPERATION",
          "ERR_PIPELINE_UNKNOWN_DESTRUCTIVE_OPERATION",
        ]);
      });

      test("VAL-2 an empty operations list no longer hides the destructive check — both are reported, one entry per unknown name", () => {
        const { problems } = constructAndCapture({
          operations: [] as readonly string[],
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => ({ yes: false }),
          destructive: {
            operations: new Set(["read", "write"]),
            describe: () => "desc",
            yes: () => false,
            abortCode: "ERR_TEST_ABORTED",
            onDecline: { kind: "throw" },
          },
          handlers: NOOP_HANDLERS,
        });

        // 1 empty-operations problem + 2 unknown-destructive problems (one
        // per name) = 3 entries total, covering all three problem codes
        // across VAL-1 and VAL-2 together.
        expect(problems).toHaveLength(3);
        const codes = problems.map((problem) => problem.code).sort();
        expect(codes).toEqual([
          "ERR_PIPELINE_EMPTY_OPERATIONS",
          "ERR_PIPELINE_UNKNOWN_DESTRUCTIVE_OPERATION",
          "ERR_PIPELINE_UNKNOWN_DESTRUCTIVE_OPERATION",
        ]);
      });

      test("VAL-3a exactly one problem (empty operations): message is byte-identical to today's message", () => {
        const { error, problems } = constructAndCapture({
          operations: [] as readonly string[],
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => ({ yes: false }),
          handlers: NOOP_HANDLERS,
        });
        expect(problems).toHaveLength(1);
        const expectedMessage =
          "M3LOperationPipeline: 'operations' must not be empty";
        expect(problems[0]?.message).toBe(expectedMessage);
        // With exactly one problem, the thrown error's own message equals it.
        expect(error.message).toBe(expectedMessage);
      });

      test("VAL-3b exactly one problem (duplicate operation): message is byte-identical to today's message", () => {
        const { error, problems } = constructAndCapture({
          operations: ["read", "read", "write"],
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => ({ yes: false }),
          handlers: NOOP_HANDLERS,
        });
        expect(problems).toHaveLength(1);
        const expectedMessage =
          "M3LOperationPipeline: 'operations' contains a duplicate entry: 'read'";
        expect(problems[0]?.message).toBe(expectedMessage);
        expect(error.message).toBe(expectedMessage);
      });

      test("VAL-3c exactly one problem (unknown destructive operation): message is byte-identical to today's message", () => {
        const { error, problems } = constructAndCapture({
          operations: TEST_OPS,
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => ({ yes: false }),
          destructive: {
            operations: new Set(["write", "delete"]),
            describe: () => "desc",
            yes: () => false,
            abortCode: "ERR_TEST_ABORTED",
            onDecline: { kind: "throw" },
          },
          handlers: NOOP_HANDLERS,
        });
        expect(problems).toHaveLength(1);
        const expectedMessage =
          "M3LOperationPipeline: destructive.operations names an operation absent from 'operations': 'delete'";
        expect(problems[0]?.message).toBe(expectedMessage);
        expect(error.message).toBe(expectedMessage);
      });

      test("VAL-4 each duplicated name is reported exactly once, regardless of how many times it repeats", () => {
        const { problems } = constructAndCapture({
          operations: ["read", "read", "write", "write", "write"],
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => ({ yes: false }),
          handlers: NOOP_HANDLERS,
        });
        const duplicateProblems = problems.filter(
          (problem) => problem.code === "ERR_PIPELINE_DUPLICATE_OPERATION",
        );
        // "write" repeats twice as many times as "read" but must still yield
        // exactly one problem entry per distinct name, not one per repeat.
        expect(duplicateProblems).toHaveLength(2);
        expect(
          duplicateProblems.map((problem) => problem.operation).sort(),
        ).toEqual(["read", "write"]);
      });

      test("VAL-5 each unknown destructive name is reported exactly once", () => {
        const { problems } = constructAndCapture({
          operations: TEST_OPS,
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => ({ yes: false }),
          destructive: {
            operations: new Set(["bogus-a", "bogus-b"]),
            describe: () => "desc",
            yes: () => false,
            abortCode: "ERR_TEST_ABORTED",
            onDecline: { kind: "throw" },
          },
          handlers: NOOP_HANDLERS,
        });
        const unknownProblems = problems.filter(
          (problem) =>
            problem.code === "ERR_PIPELINE_UNKNOWN_DESTRUCTIVE_OPERATION",
        );
        expect(unknownProblems).toHaveLength(2);
        expect(
          unknownProblems.map((problem) => problem.operation).sort(),
        ).toEqual(["bogus-a", "bogus-b"]);
      });

      test("VAL-6 several problems: the summary message is not byte-identical to any single problem's message", () => {
        // With several problems the doc specifies a summary line followed by
        // each problem's message — distinct from the single-problem case
        // (VAL-3a/b/c) where the error's own message IS the problem's message.
        const { error, problems } = constructAndCapture({
          operations: ["read", "read", "write"],
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => ({ yes: false }),
          destructive: {
            operations: new Set(["bogus"]),
            describe: () => "desc",
            yes: () => false,
            abortCode: "ERR_TEST_ABORTED",
            onDecline: { kind: "throw" },
          },
          handlers: NOOP_HANDLERS,
        });
        expect(problems.length).toBeGreaterThan(1);
        for (const problem of problems) {
          expect(error.message).not.toBe(problem.message);
        }
        // But the summary still surfaces each individual message somewhere
        // in the aggregate text, per "a summary line followed by each
        // problem's message".
        for (const problem of problems) {
          expect(error.message).toContain(problem.message);
        }
      });
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
  // Gate — target-graded confirmation (ADR-0048 forwarding) (TG-1–TG-9)
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

    test("TG-9 target configured + isSensitiveTarget omitted + yesSensitive configured — #buildGateOptions forwards target and yesSensitive but omits isSensitiveTarget", async () => {
      const { deps, config, confirmMock, inputMock } = makeTargetHarness({});
      config.set("operation", "write");
      const confirmDestructiveSpy = vi.spyOn(
        M3LDestructiveGateModule,
        "confirmDestructive",
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
        resolveSettings: () => ({ yes: true }),
        requiredFields: { read: [], write: [] },
        destructive: {
          operations: new Set(["write"]),
          describe: () => "destroy",
          yes: (settings) => settings.yes,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
          target: () => PROD_TARGET,
          // isSensitiveTarget deliberately omitted — TG-9 exercises this
          // exact combination.
          yesSensitive: () => true,
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 0 }),
        },
      });

      try {
        await expect(pipeline.run(deps)).resolves.toMatchObject({
          status: "completed",
        });

        expect(confirmDestructiveSpy).toHaveBeenCalledTimes(1);
        const optionsArg = confirmDestructiveSpy.mock.calls[0]?.[0];
        expect(optionsArg).toHaveProperty("target", PROD_TARGET);
        expect(optionsArg).toHaveProperty("yesSensitive", true);
        expect(optionsArg).not.toHaveProperty("isSensitiveTarget");

        // With isSensitiveTarget absent, confirmDestructive treats the
        // target as ungraded (states 1/2) regardless of yesSensitive —
        // the normal yes-bypass fires, never the escalated echo prompt.
        expect(confirmMock).not.toHaveBeenCalled();
        expect(inputMock).not.toHaveBeenCalled();
      } finally {
        confirmDestructiveSpy.mockRestore();
      }
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

    // -----------------------------------------------------------------------
    // P1 regression: unguarded .length emits a bare TypeError instead of an
    // M3LError when the recovery callback returns a non-array value.
    // Fix: guard with Array.isArray at M3LOperationPipeline.ts:183 and throw
    // an M3LError (ERR_INVALID_ARGUMENT or the pipeline's existing invalid-
    // option code) instead of letting .length blow up as a plain TypeError.
    // -----------------------------------------------------------------------
    test.each<[string, unknown]>([
      ["undefined", undefined],
      ["null", null],
      ["a string", "oops"],
      ["a number", 42],
      ["a plain object", { length: 0 }],
    ])(
      "REC-P1 [REGRESSION P1] recovery returning %s rejects with M3LError, not a bare TypeError",
      async (_label, badReturn) => {
        // Simulate a JavaScript caller (or a TypeScript caller using `as`)
        // returning a non-array from the recovery callback. Before the fix,
        // `recoveryEntries.length` throws a bare TypeError that escapes
        // pipeline.run() — violating the one-hierarchy rule that every throw
        // from library code must be an M3LError subclass.
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
          // Force a bad return value through a type assertion — the same path
          // a JavaScript caller would take at runtime.
          recovery: () => badReturn as readonly M3LRunRecoveryEntry[],
        });

        let thrown: unknown;
        try {
          await pipeline.run(deps);
        } catch (error) {
          thrown = error;
        }

        // The engine must wrap the guard failure in an M3LError — not propagate
        // a raw TypeError from .length on a non-array.
        expect(thrown).toBeInstanceOf(M3LError);
        // The discriminating assertion: checking only "it throws" would silently
        // pass even with the defect present (TypeError IS thrown, just the wrong
        // class). This assertion is what makes the test actually catch P1.
        expect(thrown).not.toBeInstanceOf(TypeError);
      },
    );

    describe("type-level", () => {
      test("REC-T1 status union on M3LOperationPipelineOutcome is exactly 'completed' | 'declined' | 'partial'", () => {
        expectTypeOf<
          M3LOperationPipelineOutcome<TestOp, TestResult>["status"]
        >().toEqualTypeOf<"completed" | "declined" | "partial">();
      });

      test("REC-T2a narrowing to status === 'partial' makes recovery a required non-empty tuple", () => {
        type PartialArm = Extract<
          M3LOperationPipelineOutcome<TestOp, TestResult>,
          { status: "partial" }
        >;
        // Required and non-empty — not `readonly M3LRunRecoveryEntry[] | undefined`,
        // and not the broad array (which would re-admit [] and reopen the P2 hole
        // that REC-T2g exists to close). toEqualTypeOf keeps the pin exact.
        expectTypeOf<PartialArm["recovery"]>().toEqualTypeOf<
          readonly [M3LRunRecoveryEntry, ...M3LRunRecoveryEntry[]]
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
        expectTypeOf<CompletedWithRecovery>().not.toExtend<
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
        expectTypeOf<CompletedNoRecovery>().toExtend<
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
        expectTypeOf<DeclinedWithRecovery>().not.toExtend<
          M3LOperationPipelineOutcome<TestOp, TestResult>
        >();
        // Non-vacuous control: declined without recovery IS assignable.
        type DeclinedNoRecovery = {
          readonly operation: TestOp;
          readonly result: TestResult;
          readonly status: "declined";
        };
        expectTypeOf<DeclinedNoRecovery>().toExtend<
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
        expectTypeOf<BadOutcome>().not.toExtend<
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

      test("REC-T2g [REGRESSION P2] empty array is not assignable to the partial arm's recovery (must be a non-empty tuple)", () => {
        // The doc at types.ts:566 says "at least one recovery entry". The fix
        // tightens `readonly recovery: readonly M3LRunRecoveryEntry[]` to
        // `readonly recovery: readonly [M3LRunRecoveryEntry, ...M3LRunRecoveryEntry[]]`.
        //
        // Before the fix this test FAILS at tsc: [] IS assignable to
        // `readonly M3LRunRecoveryEntry[]`, so the `.not` constraint fires a
        // compile-time type error. After the fix [] is no longer assignable to
        // the non-empty tuple and the assertion passes.
        type PartialArm = Extract<
          M3LOperationPipelineOutcome<TestOp, TestResult>,
          { status: "partial" }
        >;
        // An empty array must NOT satisfy the partial arm's recovery type.
        expectTypeOf<[]>().not.toExtend<PartialArm["recovery"]>();
        // Non-vacuous control: a single-entry tuple IS assignable (ensures the
        // assertion above fails only on the empty case, not on some unrelated
        // structural mismatch in PartialArm["recovery"]).
        expectTypeOf<readonly [M3LRunRecoveryEntry]>().toExtend<
          PartialArm["recovery"]
        >();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Tracing (TR-1–TR-28, TR-T1–TR-T4)
  //
  // Contract: docs/reference/core/pipeline.md § Tracing (RED — `trace` does
  // not exist on M3LOperationPipelineOptions yet; these tests must fail
  // because the sink is never called, not because of a typo).
  //
  // Contract correction folded in mid-authoring: the describe SNAPSHOT
  // (entry-time) omits `operation` for BOTH "accessor" and "operation"
  // itself, but the recorded PAYLOAD (exit-time) for the "operation" phase
  // DOES carry `operation` — only the "accessor" payload omits it. TR-5
  // asserts this asymmetry directly; do not assume snapshot and payload
  // agree at the "operation" phase.
  //
  // A6 regression round (2026-08-20, execution-based trace review): TR-22
  // through TR-28 lock in five defects found by execution-based review of
  // `internal/pipeline/trace.ts` — a hostile `describe` return value (a
  // throwing getter) must never change a run's outcome on either the
  // success or failure path (TR-22/23), must never abort a phase whose
  // work already ran (TR-24), the tracing-failure warning must never leak
  // a caller-controlled `name`/`code` and must gate the echoed `code` on
  // the `M3L_ERROR_CODES` allowlist rather than echoing any `M3LError`
  // code verbatim (TR-25–TR-27, plus TR-19/TR-21 updated below), and a
  // `describe` return is scalar-enforced at runtime, not only at the type
  // level (TR-28). TR-18–TR-21's expected warning text is updated in place
  // to the new pinned shape (`(<code>)` for an allowlisted `M3LError` code,
  // `(unclassified)` otherwise) — TR-15/TR-16 needed no change since they
  // never asserted the classification text itself, only that the phase
  // name is present and the secret is absent.
  // ---------------------------------------------------------------------------
  describe("tracing", () => {
    function makeSink(): { readonly record: Mock } {
      return { record: vi.fn() };
    }

    function callsOf(sink: {
      readonly record: Mock;
    }): readonly [string, string, unknown][] {
      return sink.record.mock.calls as unknown as readonly [
        string,
        string,
        unknown,
      ][];
    }

    /**
     * Named (non-index-signature) shape for a recorded `pipeline:phase`
     * payload, so call sites can use plain dot access under
     * `noPropertyAccessFromIndexSignature` instead of bracket notation.
     */
    interface TracePhasePayload {
      readonly phase?: string;
      readonly durationMs?: number;
      readonly operation?: string;
      readonly failed?: boolean;
    }

    function payloadOf(
      call: readonly [string, string, unknown],
    ): TracePhasePayload {
      return call[2] as TracePhasePayload;
    }

    test("TR-1 every phase that runs emits exactly one 'pipeline:phase' entry, in execution order, defaulting source to 'M3LOperationPipeline'", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "write");
      const sink = makeSink();

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: true }),
        requiredFields: { read: [], write: [] },
        prepare: () => Promise.resolve({ note: "n" }),
        destructive: {
          operations: new Set(["write"]),
          describe: () => "desc",
          yes: (settings) => settings.yes,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: {
          read: () => Promise.resolve({ processed: 1 }),
          write: () => Promise.resolve({ processed: 1 }),
        },
        persist: () => Promise.resolve(undefined),
        finalize: () => undefined,
        recovery: () => [],
        trace: { sink },
      });

      const outcome = await pipeline.run(deps);
      expect(outcome.status).toBe("completed");

      const calls = callsOf(sink);
      expect(calls).toHaveLength(11);
      for (const call of calls) {
        expect(call[0]).toBe("M3LOperationPipeline");
        expect(call[1]).toBe("pipeline:phase");
      }
      expect(calls.map((call) => payloadOf(call).phase)).toEqual([
        "accessor",
        "operation",
        "settings",
        "guards",
        "prepare",
        "gate",
        "dispatch",
        "persist",
        "finalize",
        "recovery",
        "outcome",
      ]);
    });

    test("TR-2 trace.source overrides the default sink source label", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();

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
        trace: { sink, source: "custom-source" },
      });

      await pipeline.run(deps);
      const calls = callsOf(sink);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call[0]).toBe("custom-source");
      }
    });

    test("TR-3 an optional phase with no callback configured (prepare/persist/finalize/recovery) emits nothing", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();

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
        trace: { sink },
      });

      const outcome = await pipeline.run(deps);
      expect(outcome.status).toBe("completed");
      const phases = callsOf(sink).map((call) => payloadOf(call).phase);
      expect(phases).toEqual([
        "accessor",
        "operation",
        "settings",
        "guards",
        "gate",
        "dispatch",
        "outcome",
      ]);
      for (const skipped of ["prepare", "persist", "finalize", "recovery"]) {
        expect(phases).not.toContain(skipped);
      }
    });

    test("TR-4 payload keys: 'phase', a finite non-negative 'durationMs', 'operation' present except for 'accessor', and no 'failed' key on success", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();

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
        trace: { sink },
      });

      await pipeline.run(deps);
      const calls = callsOf(sink);
      for (const call of calls) {
        const payload = payloadOf(call);
        expect(typeof payload.phase).toBe("string");
        expect(typeof payload.durationMs).toBe("number");
        expect(Number.isFinite(payload.durationMs as number)).toBe(true);
        expect((payload.durationMs as number) >= 0).toBe(true);
        expect(Object.hasOwn(payload, "failed")).toBe(false);
      }
      const firstCall = calls[0];
      expect(firstCall).toBeDefined();
      const accessorPayload = payloadOf(firstCall as [string, string, unknown]);
      expect(accessorPayload.phase).toBe("accessor");
      expect(Object.hasOwn(accessorPayload, "operation")).toBe(false);

      const dispatchPayload = calls
        .map(payloadOf)
        .find((payload) => payload.phase === "dispatch");
      expect(dispatchPayload?.operation).toBe("read");
    });

    test("TR-5 [contract asymmetry] the 'operation' phase's recorded payload carries 'operation' (written at exit) even though describe's own entry-time snapshot for that phase does not", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "write");
      const sink = makeSink();
      const snapshotHasOperationByPhase: Record<string, boolean> = {};

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
        trace: {
          sink,
          describe: (
            phase: M3LPipelinePhase,
            snapshot: M3LPipelineTraceSnapshot<TestOp, TestSettings, undefined>,
          ) => {
            snapshotHasOperationByPhase[phase] = Object.hasOwn(
              snapshot,
              "operation",
            );
            return {};
          },
        },
      });

      await pipeline.run(deps);

      // Entry-time snapshot for "accessor" AND "operation" itself: neither
      // has resolved `operation` yet.
      expect(snapshotHasOperationByPhase["accessor"]).toBe(false);
      expect(snapshotHasOperationByPhase["operation"]).toBe(false);
      // Snapshot from "settings" onward DOES carry the resolved operation.
      expect(snapshotHasOperationByPhase["settings"]).toBe(true);

      // But the payload RECORDED for the "operation" phase (written at its
      // own exit) already carries it — unlike its own entry-time snapshot.
      const operationPayload = callsOf(sink)
        .map(payloadOf)
        .find((payload) => payload.phase === "operation");
      expect(operationPayload?.operation).toBe("write");
      // And the "accessor" payload still omits it (payload-level rule is
      // unchanged: only "accessor" is omitted at the payload layer).
      const accessorPayload = callsOf(sink)
        .map(payloadOf)
        .find((payload) => payload.phase === "accessor");
      expect(Object.hasOwn(accessorPayload ?? {}, "operation")).toBe(false);
    });

    test("TR-6 describe's snapshot.settings is absent until the settings phase completes (absent for accessor, operation, settings itself; present from guards onward)", async () => {
      const settings: TestSettings = { yes: false, bucket: "b" };
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();
      const hasSettingsByPhase: Record<string, boolean> = {};

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
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 0 }),
        },
        trace: {
          sink,
          describe: (
            phase: M3LPipelinePhase,
            snapshot: M3LPipelineTraceSnapshot<TestOp, TestSettings, undefined>,
          ) => {
            hasSettingsByPhase[phase] = Object.hasOwn(snapshot, "settings");
            return {};
          },
        },
      });

      await pipeline.run(deps);

      expect(hasSettingsByPhase["accessor"]).toBe(false);
      expect(hasSettingsByPhase["operation"]).toBe(false);
      expect(hasSettingsByPhase["settings"]).toBe(false);
      expect(hasSettingsByPhase["guards"]).toBe(true);
      expect(hasSettingsByPhase["gate"]).toBe(true);
      expect(hasSettingsByPhase["dispatch"]).toBe(true);
      expect(hasSettingsByPhase["outcome"]).toBe(true);
    });

    test("TR-7a describe's snapshot.context is absent through 'prepare' itself, present from 'gate' onward, and equals prepare's resolved return value", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "write");
      const sink = makeSink();
      const hasContextByPhase: Record<string, boolean> = {};
      let contextAtDispatch: unknown;

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        TestContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: true }),
        requiredFields: { read: [], write: [] },
        prepare: () => Promise.resolve({ note: "prepared" }),
        destructive: {
          operations: new Set(["write"]),
          describe: () => "desc",
          yes: (settings) => settings.yes,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: { kind: "throw" },
        },
        handlers: {
          read: () => Promise.resolve({ processed: 0 }),
          write: () => Promise.resolve({ processed: 0 }),
        },
        trace: {
          sink,
          describe: (
            phase: M3LPipelinePhase,
            snapshot: M3LPipelineTraceSnapshot<
              TestOp,
              TestSettings,
              TestContext
            >,
          ) => {
            hasContextByPhase[phase] = Object.hasOwn(snapshot, "context");
            if (phase === "dispatch") contextAtDispatch = snapshot.context;
            return {};
          },
        },
      });

      await pipeline.run(deps);

      expect(hasContextByPhase["prepare"]).toBe(false);
      expect(hasContextByPhase["gate"]).toBe(true);
      expect(hasContextByPhase["dispatch"]).toBe(true);
      expect(contextAtDispatch).toEqual({ note: "prepared" });
    });

    test("TR-7b context is always absent when no 'prepare' is configured (TContext is undefined)", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();
      const hasContextByPhase: Record<string, boolean> = {};

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
        trace: {
          sink,
          describe: (
            phase: M3LPipelinePhase,
            snapshot: M3LPipelineTraceSnapshot<TestOp, TestSettings, undefined>,
          ) => {
            hasContextByPhase[phase] = Object.hasOwn(snapshot, "context");
            return {};
          },
        },
      });

      await pipeline.run(deps);
      const phasesSeen = Object.keys(hasContextByPhase);
      expect(phasesSeen.length).toBeGreaterThan(0);
      for (const phase of phasesSeen) {
        expect(hasContextByPhase[phase]).toBe(false);
      }
    });

    test("TR-8 describe runs at phase ENTRY, not exit: the handler's in-flight mutation is invisible to describe's own dispatch-phase call", async () => {
      interface MutableContext {
        readonly log: string[];
      }
      const { deps, config } = makeHarness();
      config.set("operation", "write");
      const sink = makeSink();
      let capturedLogAtDispatchEntry: readonly string[] | undefined;

      const pipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        MutableContext
      >({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        prepare: () => Promise.resolve({ log: [] }),
        handlers: {
          read: (_op, _settings, context) => {
            context.log.push("should-not-run");
            return Promise.resolve({ processed: 0 });
          },
          write: (_op, _settings, context) => {
            // The sentinel mutation dispatch's own `describe` call must NOT
            // observe — proves entry, not exit.
            context.log.push("handler-ran");
            return Promise.resolve({ processed: 0 });
          },
        },
        trace: {
          sink,
          describe: (
            phase: M3LPipelinePhase,
            snapshot: M3LPipelineTraceSnapshot<
              TestOp,
              TestSettings,
              MutableContext
            >,
          ) => {
            if (phase === "dispatch" && snapshot.context) {
              // Clone synchronously, at call time — before the handler body
              // (which runs after this synchronous callback returns) can
              // mutate `log`.
              capturedLogAtDispatchEntry = [...snapshot.context.log];
            }
            return {};
          },
        },
      });

      await pipeline.run(deps);

      expect(capturedLogAtDispatchEntry).toEqual([]);
    });

    test("TR-9 the engine's own phase/durationMs/operation/failed keys win a name collision with describe's return", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();

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
        trace: {
          sink,
          describe: () => ({
            durationMs: -999,
            phase: "bogus",
            operation: "x",
            failed: true,
          }),
        },
      });

      await pipeline.run(deps);

      const guardsPayload = callsOf(sink)
        .map(payloadOf)
        .find((payload) => payload.phase === "guards");
      expect(guardsPayload).toBeDefined();
      expect(guardsPayload?.phase).toBe("guards");
      expect(guardsPayload?.operation).toBe("read");
      expect(guardsPayload?.durationMs).not.toBe(-999);
      expect((guardsPayload?.durationMs as number) >= 0).toBe(true);
      // "guards" did not itself throw, so the engine's own omission of
      // `failed` must win over describe's forged `failed: true`.
      expect(Object.hasOwn(guardsPayload ?? {}, "failed")).toBe(false);
    });

    test("TR-10 a phase that throws records its own entry with failed:true, then the original error propagates unmodified (identity, code, message)", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "write");
      const sink = makeSink();

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
        requiredFields: { read: [], write: ["bucket"] },
        // Not exercised here (the guard rejects before prepare runs);
        // trivial, kept only to satisfy the pinned TestContext generic —
        // mirrors B9's pattern.
        prepare: () => Promise.resolve({ note: "n" }),
        handlers: NOOP_HANDLERS,
        trace: { sink },
      });

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LError).code).toBe("ERR_TEST_CONFIG");
      expect((thrown as M3LError).message).toBe(
        "'bucket' is required for operation 'write'",
      );

      const phases = callsOf(sink).map(payloadOf);
      const guardsPayload = phases.find(
        (payload) => payload["phase"] === "guards",
      );
      expect(guardsPayload?.["failed"]).toBe(true);
      expect(phases.map((payload) => payload["phase"])).not.toContain(
        "prepare",
      );
      expect(phases.map((payload) => payload["phase"])).not.toContain(
        "dispatch",
      );
    });

    test("TR-11 dispatch throwing records failed:true for 'dispatch' and no later phase runs; the handler's error propagates unmodified", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();
      const handlerError = new Error("handler blew up");

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
          read: () => Promise.reject(handlerError),
          write: () => Promise.resolve({ processed: 0 }),
        },
        persist: () => Promise.resolve(undefined),
        trace: { sink },
      });

      let thrown: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(handlerError);

      const phases = callsOf(sink).map(payloadOf);
      const dispatchPayload = phases.find(
        (payload) => payload.phase === "dispatch",
      );
      expect(dispatchPayload?.failed).toBe(true);
      expect(phases.map((payload) => payload.phase)).not.toContain("persist");
    });

    test("TR-12 a soft-landed decline records phases 1-6 plus 'outcome', never 'dispatch'/'persist'/'finalize'/'recovery'", async () => {
      const { deps, config } = makeHarness(() => Promise.resolve(false));
      config.set("operation", "write");
      const sink = makeSink();
      const persist = vi.fn(() => Promise.resolve(undefined));
      const finalize = vi.fn(() => undefined);
      const recovery = vi.fn((): readonly M3LRunRecoveryEntry[] => []);

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
        prepare: () => Promise.resolve({ note: "n" }),
        destructive: {
          operations: new Set(["write"]),
          describe: () => "desc",
          yes: () => false,
          abortCode: "ERR_TEST_ABORTED",
          onDecline: {
            kind: "soft-land",
            result: () => ({ processed: -1 }),
          },
        },
        handlers: NOOP_HANDLERS,
        persist,
        finalize,
        recovery,
        trace: { sink },
      });

      const outcome = await pipeline.run(deps);
      expect(outcome.status).toBe("declined");
      expect(persist).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
      expect(recovery).not.toHaveBeenCalled();

      const phases = callsOf(sink).map((call) => payloadOf(call).phase);
      expect(phases).toEqual([
        "accessor",
        "operation",
        "settings",
        "guards",
        "prepare",
        "gate",
        "outcome",
      ]);
    });

    test("TR-13 a 'partial' run (non-empty recovery) still records an 'outcome' entry, last in the sequence", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();
      const recoveryEntry: M3LRunRecoveryEntry = {
        item: "item-a",
        error: [{ name: "Error", message: "failed" }],
        recordedAt: "2026-08-19T00:00:00.000Z",
      };

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
        recovery: () => [recoveryEntry],
        trace: { sink },
      });

      const outcome = await pipeline.run(deps);
      expect(outcome.status).toBe("partial");
      const phases = callsOf(sink).map((call) => payloadOf(call).phase);
      expect(phases[phases.length - 1]).toBe("outcome");
      expect(phases).toContain("recovery");
    });

    test("TR-14 absent 'trace': zero sink interaction, and the outcome deep-equals the same pipeline run WITH trace configured", async () => {
      const buildOptions = (
        trace?: M3LPipelineTraceOptions<TestOp, TestSettings, undefined>,
      ): M3LOperationPipelineOptions<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      > => ({
        operations: TEST_OPS,
        configCode: "ERR_TEST_CONFIG",
        resolveSettings: () => ({ yes: false, bucket: "b" }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 42 }),
          write: () => Promise.resolve({ processed: 42 }),
        },
        ...(trace ? { trace } : {}),
      });

      const sink = makeSink();

      const { deps: depsA, config: configA } = makeHarness();
      configA.set("operation", "read");
      const untracedOutcome = await new M3LOperationPipeline(
        buildOptions(),
      ).run(depsA);
      // No pipeline built so far has ever referenced `sink` — omitting
      // `trace` cannot possibly have interacted with it.
      expect(sink.record).not.toHaveBeenCalled();

      const { deps: depsB, config: configB } = makeHarness();
      configB.set("operation", "read");
      const tracedOutcome = await new M3LOperationPipeline(
        buildOptions({ sink }),
      ).run(depsB);
      expect(sink.record).toHaveBeenCalled();

      expect(untracedOutcome).toEqual(tracedOutcome);
    });

    test("TR-15 a throwing describe cannot change the outcome; the engine logs a warning naming the phase but never the thrown message", async () => {
      const SECRET = "SECRET_TOKEN_never_should_leak_9f3a";
      const { deps, config, warningSpy } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();

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
        trace: {
          sink,
          describe: (phase: M3LPipelinePhase) => {
            if (phase === "guards") {
              throw new Error(SECRET);
            }
            return {};
          },
        },
      });

      const outcome = await pipeline.run(deps);
      expect(outcome).toEqual({
        status: "completed",
        operation: "read",
        result: { processed: 7 },
      });

      expect(warningSpy).toHaveBeenCalledTimes(1);
      const warningCall = (warningSpy.mock.calls[0] ??
        []) as unknown as readonly [string];
      const [warningMessage] = warningCall;
      expect(String(warningMessage)).toContain("guards");
      expect(String(warningMessage)).not.toContain(SECRET);

      // The "guards" entry is still recorded using the engine's own base
      // keys, just without describe's (unavailable) extra keys.
      const guardsPayload = callsOf(sink)
        .map(payloadOf)
        .find((payload) => payload.phase === "guards");
      expect(guardsPayload).toMatchObject({
        phase: "guards",
        operation: "read",
      });
    });

    test("TR-16 a throwing sink.record cannot change the outcome; the engine logs a warning naming the phase but never the thrown message", async () => {
      const SECRET = "SECRET_TOKEN_never_should_leak_2b7c";
      const { deps, config, warningSpy } = makeHarness();
      config.set("operation", "read");
      const record = vi.fn(
        (_source: string, _event: string, payload?: unknown) => {
          if (
            (payload as { phase?: string } | undefined)?.phase === "dispatch"
          ) {
            throw new Error(SECRET);
          }
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
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 9 }),
          write: () => Promise.resolve({ processed: 9 }),
        },
        trace: { sink: { record } },
      });

      const outcome = await pipeline.run(deps);
      expect(outcome).toEqual({
        status: "completed",
        operation: "read",
        result: { processed: 9 },
      });

      expect(warningSpy).toHaveBeenCalledTimes(1);
      const warningCall = (warningSpy.mock.calls[0] ??
        []) as unknown as readonly [string];
      const [warningMessage] = warningCall;
      expect(String(warningMessage)).toContain("dispatch");
      expect(String(warningMessage)).not.toContain(SECRET);

      // Other phases' record calls were attempted normally — the guard is
      // per-call, not a kill switch for the whole sink. This minimal
      // pipeline (no prepare/persist/finalize/recovery/destructive) runs
      // exactly 7 phases: accessor, operation, settings, guards, gate,
      // dispatch, outcome.
      expect(record).toHaveBeenCalledTimes(7);
    });

    test("TR-17 two concurrent run() calls on the same instance/sink do not cross-contaminate: each operation's phase sequence stays complete and correctly ordered", async () => {
      const sink = makeSink();
      const gate = makeDeferred();

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
        handlers: {
          read: async () => {
            await gate.promise;
            return { processed: 1 };
          },
          write: () => Promise.resolve({ processed: 2 }),
        },
        trace: { sink },
      });

      const { deps: depsRead, config: configRead } = makeHarness();
      configRead.set("operation", "read");
      const { deps: depsWrite, config: configWrite } = makeHarness();
      configWrite.set("operation", "write");

      const runRead = pipeline.run(depsRead);
      const runWrite = pipeline.run(depsWrite);
      // "write" has no pending gate and settles fully while "read" is still
      // parked on its deferred, forcing genuine interleaving.
      await runWrite;
      gate.resolve();
      await runRead;

      function phasesFor(op: TestOp): string[] {
        return callsOf(sink)
          .map(payloadOf)
          .filter((payload) => payload.operation === op)
          .map((payload) => payload.phase as string);
      }

      const expectedSequence = [
        "operation",
        "settings",
        "guards",
        "gate",
        "dispatch",
        "outcome",
      ];
      expect(phasesFor("read")).toEqual(expectedSequence);
      expect(phasesFor("write")).toEqual(expectedSequence);

      const allPhases = callsOf(sink).map((call) => payloadOf(call).phase);
      // 2 runs x 7 phases each (accessor is un-attributable to an operation
      // but still counted once per run).
      expect(allPhases).toHaveLength(14);
      expect(allPhases.filter((phase) => phase === "accessor")).toHaveLength(2);
    });

    test("TR-18 a throwing describe with a non-Error thrown value warns '(unclassified)' and never leaks the thrown value's contents", async () => {
      const SECRET = "SECRET_TOKEN_never_should_leak_non_error_describe";
      const { deps, config, warningSpy } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();

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
        trace: {
          sink,
          describe: (phase: M3LPipelinePhase) => {
            if (phase === "guards") {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error throw to prove warnTracingFailure's UnknownError fallback and that no thrown-value contents leak
              throw { message: SECRET, toString: () => SECRET };
            }
            return {};
          },
        },
      });

      const outcome = await pipeline.run(deps);
      expect(outcome).toEqual({
        status: "completed",
        operation: "read",
        result: { processed: 3 },
      });

      expect(warningSpy).toHaveBeenCalledTimes(1);
      const warningCall = (warningSpy.mock.calls[0] ??
        []) as unknown as readonly [string];
      const [warningMessage] = warningCall;
      expect(String(warningMessage)).toContain("guards");
      expect(String(warningMessage)).toContain("(unclassified)");
      expect(String(warningMessage)).not.toContain(SECRET);
    });

    test("TR-19 [R4b] a throwing describe with an M3LError subclass carrying an unregistered code warns '(unclassified)' and does not echo the code (allowlist gate, not a blanket M3LError pass-through)", async () => {
      const SECRET = "SECRET_TOKEN_never_should_leak_m3lerror_describe";
      const FAKE_CODE = "ERR_TEST_TRACE_DESCRIBE";
      expect(M3L_ERROR_CODES as readonly string[]).not.toContain(FAKE_CODE);
      const { deps, config, warningSpy } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();

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
          read: () => Promise.resolve({ processed: 4 }),
          write: () => Promise.resolve({ processed: 4 }),
        },
        trace: {
          sink,
          describe: (phase: M3LPipelinePhase) => {
            if (phase === "guards") {
              throw new M3LError(SECRET, { code: FAKE_CODE });
            }
            return {};
          },
        },
      });

      const outcome = await pipeline.run(deps);
      expect(outcome).toEqual({
        status: "completed",
        operation: "read",
        result: { processed: 4 },
      });

      expect(warningSpy).toHaveBeenCalledTimes(1);
      const warningCall = (warningSpy.mock.calls[0] ??
        []) as unknown as readonly [string];
      const [warningMessage] = warningCall;
      expect(String(warningMessage)).toContain("guards");
      expect(String(warningMessage)).toContain("(unclassified)");
      expect(String(warningMessage)).not.toContain(FAKE_CODE);
      expect(String(warningMessage)).not.toContain(SECRET);
    });

    test("TR-20 a throwing sink.record with a non-Error thrown value warns '(unclassified)' and never leaks the thrown value's contents", async () => {
      const SECRET = "SECRET_TOKEN_never_should_leak_non_error_sink";
      const { deps, config, warningSpy } = makeHarness();
      config.set("operation", "read");
      const record = vi.fn(
        (_source: string, _event: string, payload?: unknown) => {
          if (
            (payload as { phase?: string } | undefined)?.phase === "dispatch"
          ) {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error throw to prove warnTracingFailure's UnknownError fallback and that no thrown-value contents leak
            throw SECRET;
          }
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
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 5 }),
          write: () => Promise.resolve({ processed: 5 }),
        },
        trace: { sink: { record } },
      });

      const outcome = await pipeline.run(deps);
      expect(outcome).toEqual({
        status: "completed",
        operation: "read",
        result: { processed: 5 },
      });

      expect(warningSpy).toHaveBeenCalledTimes(1);
      const warningCall = (warningSpy.mock.calls[0] ??
        []) as unknown as readonly [string];
      const [warningMessage] = warningCall;
      expect(String(warningMessage)).toContain("dispatch");
      expect(String(warningMessage)).toContain("(unclassified)");
      expect(String(warningMessage)).not.toContain(SECRET);
    });

    test("TR-21 [R4b] a throwing sink.record with an M3LError subclass carrying an unregistered code warns '(unclassified)' and does not echo the code", async () => {
      const SECRET = "SECRET_TOKEN_never_should_leak_m3lerror_sink";
      const FAKE_CODE = "ERR_TEST_TRACE_SINK";
      expect(M3L_ERROR_CODES as readonly string[]).not.toContain(FAKE_CODE);
      const { deps, config, warningSpy } = makeHarness();
      config.set("operation", "read");
      const record = vi.fn(
        (_source: string, _event: string, payload?: unknown) => {
          if (
            (payload as { phase?: string } | undefined)?.phase === "dispatch"
          ) {
            throw new M3LError(SECRET, { code: FAKE_CODE });
          }
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
        resolveSettings: () => ({ yes: false }),
        requiredFields: { read: [], write: [] },
        handlers: {
          read: () => Promise.resolve({ processed: 6 }),
          write: () => Promise.resolve({ processed: 6 }),
        },
        trace: { sink: { record } },
      });

      const outcome = await pipeline.run(deps);
      expect(outcome).toEqual({
        status: "completed",
        operation: "read",
        result: { processed: 6 },
      });

      expect(warningSpy).toHaveBeenCalledTimes(1);
      const warningCall = (warningSpy.mock.calls[0] ??
        []) as unknown as readonly [string];
      const [warningMessage] = warningCall;
      expect(String(warningMessage)).toContain("dispatch");
      expect(String(warningMessage)).toContain("(unclassified)");
      expect(String(warningMessage)).not.toContain(FAKE_CODE);
      expect(String(warningMessage)).not.toContain(SECRET);
    });

    test("TR-22 [R1] a describe return with a throwing getter cannot change a successful run's outcome", async () => {
      // No cast: `bucket` is declared `get bucket(): string`, and `string`
      // is already a member of `M3LBreadcrumbScalar`, so this literal is
      // assignable as-is — a hostile getter reachable from fully type-legal
      // code with no cast at all.
      const hostileDescribe = () => ({
        get bucket(): string {
          throw new Error("hostile getter boom — must never propagate");
        },
      });

      function buildOptions(
        trace?: M3LPipelineTraceOptions<TestOp, TestSettings, undefined>,
      ): M3LOperationPipelineOptions<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      > {
        return {
          operations: TEST_OPS,
          configCode: "ERR_TEST_CONFIG",
          resolveSettings: () => ({ yes: false }),
          requiredFields: { read: [], write: [] },
          handlers: {
            read: () => Promise.resolve({ processed: 21 }),
            write: () => Promise.resolve({ processed: 21 }),
          },
          ...(trace !== undefined ? { trace } : {}),
        };
      }

      const sink = makeSink();
      const tracedPipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >(buildOptions({ sink, describe: hostileDescribe }));
      const untracedPipeline = new M3LOperationPipeline<
        TestOp,
        TestSettings,
        TestDeps,
        TestResult,
        undefined
      >(buildOptions());

      const { deps: tracedDeps, config: tracedConfig } = makeHarness();
      tracedConfig.set("operation", "read");
      const { deps: untracedDeps, config: untracedConfig } = makeHarness();
      untracedConfig.set("operation", "read");

      const [tracedOutcome, untracedOutcome] = await Promise.all([
        tracedPipeline.run(tracedDeps),
        untracedPipeline.run(untracedDeps),
      ]);

      expect(tracedOutcome).toEqual(untracedOutcome);
      expect(tracedOutcome).toEqual({
        status: "completed",
        operation: "read",
        result: { processed: 21 },
      });
    });

    test("TR-23 [R2] a describe return with a throwing getter does not replace a handler's rejection — the caller receives the original error by identity", async () => {
      const sentinel = new M3LError(
        "sentinel handler failure — must reach the caller unmodified",
        { code: "ERR_TEST_SENTINEL" },
      );

      // No cast: `bucket` is declared `get bucket(): string`, and `string`
      // is already a member of `M3LBreadcrumbScalar`, so this literal is
      // assignable as-is — a hostile getter reachable from fully type-legal
      // code with no cast at all.
      const hostileDescribe = () => ({
        get bucket(): string {
          throw new Error("hostile getter boom — must never propagate");
        },
      });

      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();

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
          read: () => Promise.reject(sentinel),
          write: () => Promise.reject(sentinel),
        },
        trace: { sink, describe: hostileDescribe },
      });

      let caught: unknown;
      try {
        await pipeline.run(deps);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(sentinel);
      expect((caught as M3LError).code).toBe("ERR_TEST_SENTINEL");
      expect((caught as M3LError).message).toBe(
        "sentinel handler failure — must reach the caller unmodified",
      );
      expect((caught as M3LError).cause).toBeUndefined();
    });

    test("TR-24 [R3] a describe return that only misbehaves at 'dispatch' does not abort persist/finalize — the run still completes", async () => {
      const hostileDescribe = (
        phase: M3LPipelinePhase,
      ): Readonly<Record<string, M3LBreadcrumbScalar>> => {
        if (phase !== "dispatch") return {};
        // No cast: `poison` is declared `get poison(): string`, and `string`
        // is already a member of `M3LBreadcrumbScalar`, so this literal is
        // assignable as-is. That is the point — a hostile getter is
        // reachable from fully type-legal code with no cast at all, which is
        // exactly what makes this defect realistic rather than contrived.
        // Don't "helpfully" re-add a cast here.
        return {
          get poison(): string {
            throw new Error(
              "dispatch-phase getter boom — must never propagate",
            );
          },
        };
      };

      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();
      let handlerRan = false;
      const persistCalls: unknown[] = [];
      const finalizeCalls: unknown[] = [];

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
            handlerRan = true;
            return Promise.resolve({ processed: 22 });
          },
          write: () => Promise.resolve({ processed: 22 }),
        },
        persist: (result) => {
          persistCalls.push(result);
          return Promise.resolve();
        },
        finalize: (result) => {
          finalizeCalls.push(result);
        },
        trace: { sink, describe: hostileDescribe },
      });

      const outcome = await pipeline.run(deps);

      expect(handlerRan).toBe(true);
      expect(persistCalls).toEqual([{ processed: 22 }]);
      expect(finalizeCalls).toEqual([{ processed: 22 }]);
      expect(outcome).toEqual({
        status: "completed",
        operation: "read",
        result: { processed: 22 },
      });
    });

    test("TR-25 [R4a] a plain Error whose distinctive 'name' is never echoed in the tracing-failure warning (unclassified — not an M3LError)", async () => {
      const SECRET_NAME = "SECRET_NAME_9f3a_never_leak";
      const SECRET_MESSAGE = "SECRET_MESSAGE_9f3a_never_leak";
      const { deps, config, warningSpy } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();

      const secretError = new Error(SECRET_MESSAGE);
      secretError.name = SECRET_NAME;

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
          read: () => Promise.resolve({ processed: 23 }),
          write: () => Promise.resolve({ processed: 23 }),
        },
        trace: {
          sink,
          describe: (phase: M3LPipelinePhase) => {
            if (phase === "guards") throw secretError;
            return {};
          },
        },
      });

      const outcome = await pipeline.run(deps);
      expect(outcome).toEqual({
        status: "completed",
        operation: "read",
        result: { processed: 23 },
      });

      expect(warningSpy).toHaveBeenCalledTimes(1);
      const warningCall = (warningSpy.mock.calls[0] ??
        []) as unknown as readonly [string];
      const [warningMessage] = warningCall;
      expect(String(warningMessage)).toContain("guards");
      expect(String(warningMessage)).toContain("(unclassified)");
      expect(String(warningMessage)).not.toContain(SECRET_NAME);
      expect(String(warningMessage)).not.toContain(SECRET_MESSAGE);
    });

    test("TR-26 [R4c] an M3LError carrying a genuine registered code IS included in the tracing-failure warning (non-vacuous control for the unclassified cases)", async () => {
      const SECRET_MESSAGE = "SECRET_MESSAGE_registered_code_never_leak";
      const REGISTERED_CODE = "ERR_INVALID_ARGUMENT";
      expect(M3L_ERROR_CODES as readonly string[]).toContain(REGISTERED_CODE);

      const { deps, config, warningSpy } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();

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
          read: () => Promise.resolve({ processed: 24 }),
          write: () => Promise.resolve({ processed: 24 }),
        },
        trace: {
          sink,
          describe: (phase: M3LPipelinePhase) => {
            if (phase === "guards") {
              throw new M3LError(SECRET_MESSAGE, { code: REGISTERED_CODE });
            }
            return {};
          },
        },
      });

      const outcome = await pipeline.run(deps);
      expect(outcome).toEqual({
        status: "completed",
        operation: "read",
        result: { processed: 24 },
      });

      expect(warningSpy).toHaveBeenCalledTimes(1);
      const warningCall = (warningSpy.mock.calls[0] ??
        []) as unknown as readonly [string];
      const [warningMessage] = warningCall;
      expect(String(warningMessage)).toContain("guards");
      expect(String(warningMessage)).toContain(REGISTERED_CODE);
      expect(String(warningMessage)).not.toContain("(unclassified)");
      expect(String(warningMessage)).not.toContain(SECRET_MESSAGE);
    });

    test("TR-27 [R4e] an error whose 'name' getter itself throws does not abort the phase — the run still completes and the phase body still ran", async () => {
      class HostileNameError extends Error {
        override get name(): string {
          throw new Error("name getter boom — must never propagate");
        }
      }

      const { deps, config, warningSpy } = makeHarness();
      config.set("operation", "read");
      const sink = makeSink();
      let handlerRan = false;

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
            handlerRan = true;
            return Promise.resolve({ processed: 25 });
          },
          write: () => Promise.resolve({ processed: 25 }),
        },
        trace: {
          sink,
          describe: (phase: M3LPipelinePhase) => {
            if (phase === "guards") throw new HostileNameError("boom");
            return {};
          },
        },
      });

      const outcome = await pipeline.run(deps);

      expect(handlerRan).toBe(true);
      expect(outcome).toEqual({
        status: "completed",
        operation: "read",
        result: { processed: 25 },
      });
      expect(warningSpy).toHaveBeenCalledTimes(1);
    });

    test("TR-28 [R5] describe's return is scalar-enforced at runtime for a bare record()-shaped sink — non-scalar keys are dropped while string/number/boolean/null (including null) survive", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const record = vi.fn();

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
          read: () => Promise.resolve({ processed: 26 }),
          write: () => Promise.resolve({ processed: 26 }),
        },
        trace: {
          sink: { record },
          describe: (phase: M3LPipelinePhase) => {
            if (phase !== "guards") return {};
            return {
              str: "ok",
              num: 42,
              bool: true,
              nil: null,
              nested: { a: 1 },
              arr: [1, 2, 3],
              fn: () => "boom",
              date: new Date(0),
            } as unknown as Readonly<Record<string, M3LBreadcrumbScalar>>;
          },
        },
      });

      await pipeline.run(deps);

      const guardsCall = (
        record.mock.calls as unknown as readonly [string, string, unknown][]
      ).find(
        (call) =>
          (call[2] as { phase?: string } | undefined)?.phase === "guards",
      );
      const guardsPayload = guardsCall?.[2] as
        Record<string, unknown> | undefined;

      expect(guardsPayload).toMatchObject({
        str: "ok",
        num: 42,
        bool: true,
        nil: null,
      });
      // Non-vacuous control: a nested object dropped entirely (not
      // stringified to "[object Object]" nor shallow-copied under the same
      // key) — the key itself must be absent, not merely non-object-typed.
      expect(Object.hasOwn(guardsPayload ?? {}, "nested")).toBe(false);
      expect(Object.hasOwn(guardsPayload ?? {}, "arr")).toBe(false);
      expect(Object.hasOwn(guardsPayload ?? {}, "fn")).toBe(false);
      expect(Object.hasOwn(guardsPayload ?? {}, "date")).toBe(false);
    });

    test("TR-29 [R6] describe's return carrying prototype-pollution vectors (__proto__/constructor/prototype) is dropped from a bare record()-shaped sink while an ordinary sibling key survives (non-vacuous control)", async () => {
      const { deps, config } = makeHarness();
      config.set("operation", "read");
      const record = vi.fn();

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
          read: () => Promise.resolve({ processed: 27 }),
          write: () => Promise.resolve({ processed: 27 }),
        },
        trace: {
          sink: { record },
          describe: (phase: M3LPipelinePhase) => {
            if (phase !== "guards") return {};
            // Computed keys, not the `__proto__: value` literal form — the
            // latter sets the created object's own prototype rather than an
            // enumerable own property, which would make `Object.keys(extra)`
            // never see "__proto__" at all and the guard's `continue` branch
            // would go unexercised for the wrong reason.
            return {
              ["__proto__"]: "polluted-proto",
              ["constructor"]: "polluted-ctor",
              ["prototype"]: "polluted-proto-prop",
              bucket: "ok",
            };
          },
        },
      });

      await pipeline.run(deps);

      const guardsCall = (
        record.mock.calls as unknown as readonly [string, string, unknown][]
      ).find(
        (call) =>
          (call[2] as { phase?: string } | undefined)?.phase === "guards",
      );
      const guardsPayload = guardsCall?.[2] as
        Record<string, unknown> | undefined;

      // Non-vacuous control: an ordinary sibling key survives, so this test
      // cannot pass merely because the whole payload was dropped.
      expect(guardsPayload).toMatchObject({ bucket: "ok" });
      expect(Object.hasOwn(guardsPayload ?? {}, "__proto__")).toBe(false);
      expect(Object.hasOwn(guardsPayload ?? {}, "constructor")).toBe(false);
      expect(Object.hasOwn(guardsPayload ?? {}, "prototype")).toBe(false);

      // No prototype pollution actually occurred: the global `Object.prototype`
      // carries none of the poisoned values, and the recorded payload itself
      // still has the normal, unpolluted `Object.prototype` in its chain.
      expect(
        (Object.prototype as Record<string, unknown>)["polluted-proto"],
      ).toBeUndefined();
      expect(({} as Record<string, unknown>)["polluted-ctor"]).toBeUndefined();
      expect(Object.getPrototypeOf(guardsPayload ?? {})).toBe(Object.prototype);
    });

    describe("type-level", () => {
      test("TR-T1 M3LPipelinePhase is exactly the 11 phase-name literals", () => {
        expectTypeOf<M3LPipelinePhase>().toEqualTypeOf<
          | "accessor"
          | "operation"
          | "settings"
          | "guards"
          | "prepare"
          | "gate"
          | "dispatch"
          | "persist"
          | "finalize"
          | "recovery"
          | "outcome"
        >();
      });

      test("TR-T2 M3LPipelineTraceSnapshot's three fields (operation, settings, context) are all optional", () => {
        type Snapshot = M3LPipelineTraceSnapshot<
          TestOp,
          TestSettings,
          TestContext
        >;
        const empty: Snapshot = {};
        void empty;
        expectTypeOf<Snapshot["operation"]>().toEqualTypeOf<
          TestOp | undefined
        >();
        expectTypeOf<Snapshot["settings"]>().toEqualTypeOf<
          TestSettings | undefined
        >();
        expectTypeOf<Snapshot["context"]>().toEqualTypeOf<
          TestContext | undefined
        >();
        // Non-vacuous control: a fully-populated snapshot is ALSO assignable
        // — proves "optional" (both {} and the full shape satisfy it), not
        // that the type collapsed to `any`/`never`.
        const full: Snapshot = {
          operation: "read",
          settings: { yes: false },
          context: { note: "n" },
        };
        void full;
      });

      // TR-T3a/b use structural `expectTypeOf(...).not.toExtend<...>()`
      // assertions rather than `@ts-expect-error` on the object literal: the
      // latter is unstable during RED (with `M3LPipelineTraceOptions`
      // unresolved, TS treats the field as `any` and the expected error never
      // fires, tripping "Unused '@ts-expect-error' directive" — a test-file
      // defect, not a proof). This form fails RED for the correct reason
      // (the type is missing, so `DescribeReturn` collapses towards `any`/
      // `unknown` and the `.not` assertion has nothing to reject) and keeps
      // proving the real constraint once `M3LPipelineTraceOptions` exists.
      type DescribeReturn = ReturnType<
        NonNullable<
          M3LPipelineTraceOptions<TestOp, TestSettings, undefined>["describe"]
        >
      >;

      test("TR-T3a describe's return type rejects an object-valued member", () => {
        type BadWithObject = { readonly bad: { readonly nested: number } };
        expectTypeOf<BadWithObject>().not.toExtend<DescribeReturn>();
        // Non-vacuous control: a scalar-only shape IS assignable.
        expectTypeOf<{ readonly ok: string }>().toExtend<DescribeReturn>();
      });

      test("TR-T3b describe's return type rejects an array-valued member", () => {
        type BadWithArray = { readonly bad: readonly [1, 2, 3] };
        expectTypeOf<BadWithArray>().not.toExtend<DescribeReturn>();
        // Non-vacuous control: a scalar-only shape IS assignable.
        expectTypeOf<{ readonly ok: number }>().toExtend<DescribeReturn>();
      });

      test("TR-T3c a describe returning only scalar values compiles (non-vacuous control for TR-T3a/b)", () => {
        const values: Readonly<Record<string, M3LBreadcrumbScalar>> = {
          str: "ok",
          num: 1,
          bool: true,
          nil: null,
        };
        const trace: M3LPipelineTraceOptions<TestOp, TestSettings, undefined> =
          {
            sink: { record: () => undefined },
            describe: () => values,
          };
        void trace;
      });

      test("TR-T4 'trace' is optional on M3LOperationPipelineOptions", () => {
        type Options = M3LOperationPipelineOptions<
          TestOp,
          TestSettings,
          TestDeps,
          TestResult,
          undefined
        >;
        expectTypeOf<undefined>().toExtend<Options["trace"]>();
        // Non-vacuous control: the real trace-options shape is ALSO
        // assignable — proves the field's type is
        // `M3LPipelineTraceOptions<...> | undefined`, not that it collapsed
        // to `any`/`unknown`.
        expectTypeOf<
          M3LPipelineTraceOptions<TestOp, TestSettings, undefined>
        >().toExtend<Options["trace"]>();
        // Non-vacuous negative control: an unrelated shape must NOT match.
        expectTypeOf<{ readonly nope: true }>().not.toExtend<
          Options["trace"]
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
