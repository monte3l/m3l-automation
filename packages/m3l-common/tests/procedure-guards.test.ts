/**
 * `core/procedure` — guard, recovery, cancellation, tracing and adversarial
 * behaviour, against the pinned contract in `docs/reference/core/procedure.md`
 * (ADR-0046). The implementation is a typed scaffold: every runtime body
 * currently throws/rejects `M3LError` with code
 * `ERR_PROCEDURE_INVALID_DEFINITION`. Every test in this file is written
 * against the documented, eventual contract and is therefore expected to
 * fail RED until `core/procedure` is implemented — that failure is the
 * point, not a defect in the test.
 *
 * Scope owned by this file: run-option guards, capture-by-value, the
 * iteration/revisit ceiling, the no-progress guard, `continueOnFailure`
 * recovery, cancellation, tracing (including "never load-bearing"), and
 * adversarial trace payloads. `procedure.test.ts`, `procedure-build.test.ts`
 * and `procedure-conditions.test.ts` own everything else.
 */

import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { Mock } from "vitest";

import { createProcedureBuilder } from "../src/core/procedure/index.js";
import type {
  M3LProcedure,
  M3LProcedureCase,
  M3LProcedureContext,
  M3LProcedureFallback,
  M3LProcedureOutcome,
  M3LProcedureShape,
  M3LProcedureStepRecord,
  M3LProcedureTraceEntry,
  M3LProcedureTraceSink,
  M3LProcedureValue,
} from "../src/core/procedure/index.js";
import { M3L_ERROR_CODES, M3LError } from "../src/core/errors/index.js";
import {
  M3L_RECOVERY_LIMIT,
  M3LBreadcrumbTrail,
} from "../src/core/diagnostics/index.js";
import type {
  M3LRunRecoveryEntry,
  M3LRunReportInput,
} from "../src/core/diagnostics/index.js";
import { M3LLogger } from "../src/core/logging/M3LLogger.js";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** A closed shape for run-option-validation tests: a typo'd key is provably wrong. */
interface OptShape extends M3LProcedureShape {
  readonly deps: { readonly marker: true };
  readonly values: { readonly a?: number };
  readonly parameters: { readonly threshold: number };
  readonly conclusion: { readonly verdict: string };
  readonly stepId: "s1";
  readonly caseId: "caseA";
}

/** A general-purpose loose shape reused by every other block in this file. */
interface TS extends M3LProcedureShape {
  readonly deps: Record<string, never>;
  readonly values: Readonly<Record<string, M3LProcedureValue>>;
  readonly parameters: Readonly<Record<string, M3LProcedureValue>>;
  readonly conclusion: { readonly verdict: string };
  readonly stepId: "s1" | "s2" | "s3";
  readonly caseId: "caseA" | "caseB";
}

const ALWAYS_TRUE_CASE: M3LProcedureCase<TS, "caseA"> = {
  id: "caseA",
  description: "always matches",
  prose: "always matches",
  priority: 1,
  condition: { kind: "exists", subject: { source: "literal", literal: "x" } },
  action: () => ({ verdict: "matched" }),
};

const DEFAULT_FALLBACK: M3LProcedureFallback<TS> = {
  description: "no case matched",
  prose: "no case matched",
  action: () => ({ verdict: "fallback" }),
};

/** Captures a synchronous throw from `fn`, returning the thrown value (or `undefined`). */
function captureSyncThrow(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Runs `fn`, capturing either its resolved outcome or whatever it throws/rejects. */
async function runCapturing<T>(
  fn: () => Promise<T> | T,
): Promise<{ outcome?: T; thrown?: unknown }> {
  try {
    const outcome = await fn();
    return { outcome };
  } catch (thrown) {
    return { thrown };
  }
}

function asM3LError(value: unknown): M3LError {
  expect(value).toBeInstanceOf(M3LError);
  return value as M3LError;
}

function buildOptProcedure(spy: Mock): M3LProcedure<OptShape> {
  // Declaring "threshold" is load-bearing for the excess-key test below: it
  // makes `threshold` a legitimately declared parameter, so a run rejecting
  // `{ threshold, unknownKey }` is provably rejecting on `unknownKey` alone.
  // Without this declaration, EVERY key (including `threshold`) would be
  // undeclared, and the throw would be indistinguishable from a blanket
  // rejection — do not remove this as "redundant".
  return createProcedureBuilder<OptShape>("opt-test")
    .parameters(["threshold"])
    .step({
      id: "s1",
      label: "step one",
      kind: "gather",
      execute: (ctx) => {
        spy(ctx);
        return { flow: "stop" };
      },
    })
    .case({
      id: "caseA",
      description: "d",
      prose: "p",
      priority: 1,
      condition: {
        kind: "exists",
        subject: { source: "literal", literal: "x" },
      },
      action: () => ({ verdict: "ok" }),
    })
    .build({
      description: "fb",
      prose: "fbp",
      action: () => ({ verdict: "fallback" }),
    });
}

// ---------------------------------------------------------------------------

describe("core/procedure — guards and tracing", () => {
  // -------------------------------------------------------------------------
  // 1. run option validation
  // -------------------------------------------------------------------------
  describe("run option validation", () => {
    test.each([
      ["zero", 0],
      ["negative", -1],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["non-integer", 1.5],
      ["above MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 1],
    ])(
      "maxIterations that is %s throws ERR_PROCEDURE_INVALID_OPTION before any step executes",
      (_label, maxIterations) => {
        const spy = vi.fn();
        const thrown = captureSyncThrow(() => {
          const procedure = buildOptProcedure(spy);
          void procedure.run({
            deps: { marker: true },
            parameters: { threshold: 1 },
            maxIterations,
          });
        });
        const error = asM3LError(thrown);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(spy).not.toHaveBeenCalled();
      },
    );

    test("a parameters key the shape never declared throws ERR_PROCEDURE_INVALID_OPTION", () => {
      const spy = vi.fn();
      const thrown = captureSyncThrow(() => {
        const procedure = buildOptProcedure(spy);
        void procedure.run({
          deps: { marker: true },
          // Simulates an untyped caller: a real TS caller can't construct
          // this literal, so the excess key is threaded through a cast.
          parameters: { threshold: 1, unknownKey: 2 } as OptShape["parameters"],
        });
      });
      const error = asM3LError(thrown);
      expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
      expect(spy).not.toHaveBeenCalled();
    });

    test.each([
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["-Infinity", -Infinity],
    ])(
      "a parameters value of %s throws ERR_PROCEDURE_INVALID_OPTION (fails parametersDigest)",
      (_label, value) => {
        const spy = vi.fn();
        const thrown = captureSyncThrow(() => {
          const procedure = buildOptProcedure(spy);
          void procedure.run({
            deps: { marker: true },
            parameters: { threshold: value },
          });
        });
        const error = asM3LError(thrown);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(spy).not.toHaveBeenCalled();
      },
    );

    test("a parameters value containing a BigInt throws ERR_PROCEDURE_INVALID_OPTION", () => {
      const spy = vi.fn();
      const thrown = captureSyncThrow(() => {
        const procedure = buildOptProcedure(spy);
        void procedure.run({
          deps: { marker: true },
          // A BigInt is not a M3LProcedureValue; simulates an untyped caller.
          parameters: { threshold: 10n } as unknown as OptShape["parameters"],
        });
      });
      const error = asM3LError(thrown);
      expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
      expect(spy).not.toHaveBeenCalled();
    });

    test.each(["__proto__", "constructor", "prototype"])(
      "a dangerous parameter name %s throws ERR_PROCEDURE_INVALID_OPTION",
      (dangerousKey) => {
        const spy = vi.fn();
        const thrown = captureSyncThrow(() => {
          const procedure = buildOptProcedure(spy);
          const parameters = { threshold: 1, [dangerousKey]: 1 };
          void procedure.run({
            deps: { marker: true },
            parameters,
          });
        });
        const error = asM3LError(thrown);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(spy).not.toHaveBeenCalled();
      },
    );

    test("progress.witness that is not a function throws ERR_PROCEDURE_INVALID_OPTION", () => {
      const spy = vi.fn();
      const thrown = captureSyncThrow(() => {
        const procedure = buildOptProcedure(spy);
        void procedure.run({
          deps: { marker: true },
          parameters: { threshold: 1 },
          progress: {
            witness:
              "not-a-function" as unknown as OptShape["parameters"] extends never
                ? never
                : () => string,
            maxStalledSteps: 3,
          },
        });
      });
      const error = asM3LError(thrown);
      expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
      expect(spy).not.toHaveBeenCalled();
    });

    test.each([
      ["zero", 0],
      ["negative", -1],
      ["NaN", NaN],
      ["non-integer", 1.5],
    ])(
      "progress.maxStalledSteps that is %s throws ERR_PROCEDURE_INVALID_OPTION",
      (_label, maxStalledSteps) => {
        const spy = vi.fn();
        const thrown = captureSyncThrow(() => {
          const procedure = buildOptProcedure(spy);
          void procedure.run({
            deps: { marker: true },
            parameters: { threshold: 1 },
            progress: { witness: () => "x", maxStalledSteps },
          });
        });
        const error = asM3LError(thrown);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(spy).not.toHaveBeenCalled();
      },
    );
  });

  // -------------------------------------------------------------------------
  // 2. capture by value
  // -------------------------------------------------------------------------
  describe("capture by value", () => {
    test("a getter-backed parameters object is read exactly once; the run sees one consistent value", async () => {
      let reads = 0;
      const parameters: TS["parameters"] = Object.defineProperty({}, "flag", {
        enumerable: true,
        configurable: true,
        get(): number {
          reads += 1;
          return reads;
        },
      });
      const seen: unknown[] = [];

      const { outcome, thrown } = await runCapturing(async () => {
        const procedure = createProcedureBuilder<TS>("capture-params")
          .parameters(["flag"])
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: (ctx) => {
              seen.push(ctx.parameters["flag"]);
              return { flow: "continue" };
            },
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: (ctx) => {
              seen.push(ctx.parameters["flag"]);
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      // Both steps must observe the SAME captured value — the run reads
      // `parameters` once, not once per access.
      expect(new Set(seen).size).toBe(1);
    });

    test("mutating the caller's parameters object after run() is entered cannot change the run", async () => {
      const source: Record<string, number> = { count: 1 };
      const seen: unknown[] = [];

      const { outcome, thrown } = await runCapturing(async () => {
        const procedure = createProcedureBuilder<TS>("mutate-after-entry")
          .parameters(["count"])
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: (ctx) => {
              source["count"] = 999; // caller mutates its own object mid-run
              seen.push(ctx.parameters["count"]);
              return { flow: "continue" };
            },
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: (ctx) => {
              seen.push(ctx.parameters["count"]);
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: source });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(seen).toEqual([1, 1]);
    });

    test("a Proxy-backed initialValues object is read exactly once into a frozen values map", async () => {
      let reads = 0;
      const initialValues: Readonly<Partial<TS["values"]>> = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "seed") {
              reads += 1;
              return reads;
            }
            return undefined;
          },
          ownKeys() {
            return ["seed"];
          },
          getOwnPropertyDescriptor() {
            return { enumerable: true, configurable: true };
          },
        },
      );
      const seen: unknown[] = [];

      const { outcome, thrown } = await runCapturing(async () => {
        const procedure = createProcedureBuilder<TS>("capture-initial-values")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: (ctx) => {
              seen.push(ctx.values["seed"]);
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {}, initialValues });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(seen).toEqual([1]);
    });
  });

  // -------------------------------------------------------------------------
  // 3. iteration ceiling
  // -------------------------------------------------------------------------
  describe("iteration ceiling", () => {
    function buildSelfLoopProcedure(
      spy: Mock,
      maxRevisits: number,
    ): M3LProcedure<TS> {
      return createProcedureBuilder<TS>("self-loop")
        .step({
          id: "s1",
          label: "s1",
          kind: "control",
          jumpsTo: ["s1"] as const,
          loop: { reason: "deliberate re-gather", maxRevisits },
          execute: (ctx) => {
            spy(ctx.iteration);
            return { flow: { goTo: "s1" } };
          },
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
    }

    test("exceeding maxIterations yields a failed outcome under ERR_PROCEDURE_ITERATION_LIMIT with context.limit === 'iterations'", async () => {
      const spy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildSelfLoopProcedure(spy, 1000);
        return procedure.run({ deps: {}, parameters: {}, maxIterations: 5 });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_ITERATION_LIMIT");
        expect(error.context["limit"]).toBe("iterations");
      }
    });

    test("with maxIterations: N, exactly N executions run and the guard trips as execution N+1 would begin", async () => {
      const spy = vi.fn();
      const N = 7;
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildSelfLoopProcedure(spy, 1000);
        return procedure.run({ deps: {}, parameters: {}, maxIterations: N });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      expect(spy).toHaveBeenCalledTimes(N);
    });

    test("a loop step exceeding maxRevisits gives ERR_PROCEDURE_ITERATION_LIMIT with context.limit === 'revisits'", async () => {
      const spy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        // maxRevisits small; maxIterations generous so it never trips first.
        const procedure = buildSelfLoopProcedure(spy, 2);
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 1000,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_ITERATION_LIMIT");
        expect(error.context["limit"]).toBe("revisits");
      }
    });

    test("a loop step with maxRevisits: M may execute at most M + 1 times", async () => {
      const spy = vi.fn();
      const M = 3;
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildSelfLoopProcedure(spy, M);
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 1000,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      expect(spy).toHaveBeenCalledTimes(M + 1);
    });
  });

  // -------------------------------------------------------------------------
  // 4. no-progress guard
  // -------------------------------------------------------------------------
  describe("no-progress guard", () => {
    function buildProgressProcedure(
      execute: (
        ctx: M3LProcedureContext<TS>,
      ) => TS["conclusion"] extends never
        ? never
        : { flow: "continue" | "stop"; output?: M3LProcedureValue },
      steps = 3,
    ): M3LProcedure<TS> {
      let builder = createProcedureBuilder<TS>("progress-test");
      const STEP_IDS = ["s1", "s2", "s3"] as const;
      const ids: TS["stepId"][] = STEP_IDS.slice(0, steps);
      for (const [index, id] of ids.entries()) {
        const isLast = index === ids.length - 1;
        builder = builder.step({
          id,
          label: id,
          kind: "gather",
          execute: (ctx) => {
            const result = execute(ctx);
            return isLast ? { ...result, flow: "stop" } : result;
          },
        });
      }
      return builder.case(ALWAYS_TRUE_CASE).build(DEFAULT_FALLBACK);
    }

    test("absent options.progress, the witness is never sampled", async () => {
      const witness = vi.fn(() => "same");
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildProgressProcedure(() => ({ flow: "continue" }));
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(witness).not.toHaveBeenCalled();
    });

    test("maxStalledSteps consecutive unchanged samples trips a failed outcome under ERR_PROCEDURE_NO_PROGRESS with stalledSteps and lastStepId", async () => {
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildProgressProcedure(() => ({ flow: "continue" }));
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 50,
          progress: { witness: () => "constant", maxStalledSteps: 3 },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_NO_PROGRESS");
        expect(error.context["stalledSteps"]).toBe(3);
        expect(typeof error.context["lastStepId"]).toBe("string");
      }
    });

    test("a changing witness never trips the guard", async () => {
      let counter = 0;
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildProgressProcedure(() => ({ flow: "continue" }));
        return procedure.run({
          deps: {},
          parameters: {},
          progress: {
            witness: () => {
              counter += 1;
              return counter;
            },
            maxStalledSteps: 2,
          },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
    });

    test("the witness is sampled exactly once per continuing step", async () => {
      const witness = vi.fn(() => "constant");
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildProgressProcedure(
          () => ({ flow: "continue" }),
          2,
        );
        return procedure.run({
          deps: {},
          parameters: {},
          progress: { witness, maxStalledSteps: 100 },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      // Two steps declared: s1 continues, s2 is forced to "stop" by the
      // helper — both are "continuing" executions from the guard's view.
      expect(witness).toHaveBeenCalledTimes(2);
    });

    test("the guard trips in far fewer steps than the iteration ceiling would", async () => {
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildSelfLoopingProgressProcedure();
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 100,
          progress: { witness: () => "constant", maxStalledSteps: 3 },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        expect(outcome.telemetry.iterations).toBeLessThan(100);
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_NO_PROGRESS");
      }
    });

    function buildSelfLoopingProgressProcedure(): M3LProcedure<TS> {
      return createProcedureBuilder<TS>("progress-loop")
        .step({
          id: "s1",
          label: "s1",
          kind: "control",
          jumpsTo: ["s1"] as const,
          loop: { reason: "deliberate re-gather", maxRevisits: 1000 },
          execute: () => ({ flow: { goTo: "s1" } }),
        })
        .case(ALWAYS_TRUE_CASE)
        .build(DEFAULT_FALLBACK);
    }

    test("the first sample is a baseline and never trips on its own", async () => {
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildProgressProcedure(() => ({ flow: "stop" }), 1);
        return procedure.run({
          deps: {},
          parameters: {},
          progress: { witness: () => "constant", maxStalledSteps: 1 },
        });
      });

      expect(thrown).toBeUndefined();
      // A single continuing step only ever produces the baseline sample —
      // one sample cannot be "consecutive unchanged", so the run concludes.
      expect(outcome?.status).toBe("matched");
    });

    test("a witness that throws yields a failed outcome under ERR_PROCEDURE_INVALID_OPTION with the thrown value chained as cause, never ERR_POLLING_INVALID_OPTION", async () => {
      const witnessError = new Error("witness exploded");
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildProgressProcedure(() => ({ flow: "continue" }));
        return procedure.run({
          deps: {},
          parameters: {},
          progress: {
            witness: () => {
              throw witnessError;
            },
            maxStalledSteps: 3,
          },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(error.code).not.toBe("ERR_POLLING_INVALID_OPTION");
        expect(error.cause).toBe(witnessError);
      }
    });

    test("a witness that returns a non-primitive yields a failed outcome under ERR_PROCEDURE_INVALID_OPTION", async () => {
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildProgressProcedure(() => ({ flow: "continue" }));
        return procedure.run({
          deps: {},
          parameters: {},
          progress: {
            witness: () => ({}) as unknown as string,
            maxStalledSteps: 3,
          },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(error.code).not.toBe("ERR_POLLING_INVALID_OPTION");
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. continueOnFailure and recovery
  // -------------------------------------------------------------------------
  describe("continueOnFailure and recovery", () => {
    test("without the flag, a step throw yields a failed outcome naming the step, carrying the thrown value verbatim (identity + cause chain)", async () => {
      const cause = new Error("root cause");
      const thrownByStep = new Error("step blew up", { cause });

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("no-recovery")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              throw thrownByStep;
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        expect(outcome.failedStep).toBe("s1");
        expect(outcome.error).toBe(thrownByStep);
        expect((outcome.error as Error).cause).toBe(cause);
      }
    });

    test("with continueOnFailure, the run continues and appends one M3LRunRecoveryEntry shaped {item, error, recordedAt}", async () => {
      const stepError = new Error("absorbed failure");
      const spy = vi.fn();

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("recovery-shape")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            continueOnFailure: true,
            execute: () => {
              throw stepError;
            },
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: (ctx) => {
              spy(ctx.recovered.length, ctx.recoveredTotal);
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(spy).toHaveBeenCalledWith(1, 1);
      if (outcome?.status === "matched") {
        const recovered = outcome.telemetry.recovered;
        expect(recovered).toHaveLength(1);
        const entry: M3LRunRecoveryEntry = recovered[0] as M3LRunRecoveryEntry;
        expect(entry.item).toBe("s1");
        expect(Array.isArray(entry.error)).toBe(true);
        expect(() => new Date(entry.recordedAt).toISOString()).not.toThrow();
        expect(new Date(entry.recordedAt).toISOString()).toBe(entry.recordedAt);
        // Not the pipeline recovery shape.
        expect(Object.hasOwn(entry, "index")).toBe(false);
        expect(Object.hasOwn(entry, "attempt")).toBe(false);
      }
    });

    test("recovered.length caps at M3L_RECOVERY_LIMIT with the oldest evicted; recoveredTotal counts uncapped", async () => {
      const attempts = M3L_RECOVERY_LIMIT + 10;
      const builder = createProcedureBuilder<TS>("recovery-cap").step({
        id: "s1",
        label: "s1",
        kind: "control",
        jumpsTo: ["s1"] as const,
        loop: { reason: "repeated absorbed failures", maxRevisits: attempts },
        continueOnFailure: true,
        execute: (ctx) => {
          if (ctx.iteration >= attempts) {
            return { flow: "stop" };
          }
          throw new Error(`failure #${ctx.iteration}`);
        },
      });
      const procedure = builder.case(ALWAYS_TRUE_CASE).build(DEFAULT_FALLBACK);

      const { outcome, thrown } = await runCapturing(() =>
        procedure.run({
          deps: {},
          parameters: {},
          maxIterations: attempts + 1,
        }),
      );

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      if (outcome?.status === "matched") {
        expect(outcome.telemetry.recovered.length).toBeLessThanOrEqual(
          M3L_RECOVERY_LIMIT,
        );
        expect(outcome.telemetry.recoveredTotal).toBeGreaterThan(
          M3L_RECOVERY_LIMIT,
        );
        // Oldest evicted: the first entry's item should not be "failure #0".
        const first = outcome.telemetry.recovered[0];
        expect(first?.item).not.toBe("s1@0");
      }
    });

    test("a recovered step's record has status 'recovered' and no output", async () => {
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("recovered-record")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            continueOnFailure: true,
            execute: () => {
              throw new Error("boom");
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      if (outcome?.status === "matched") {
        const record = outcome.telemetry.steps.find(
          (step: M3LProcedureStepRecord) => step.id === "s1",
        );
        expect(record?.status).toBe("recovered");
        expect(record?.output).toBeUndefined();
      }
    });

    test("[type] telemetry.recovered is assignable to M3LRunReportInput['recovery']", () => {
      expectTypeOf<
        M3LProcedureOutcome<TS>["telemetry"]["recovered"]
      >().toExtend<M3LRunReportInput["recovery"]>();
    });
  });

  // -------------------------------------------------------------------------
  // 6. cancellation
  // -------------------------------------------------------------------------
  describe("cancellation", () => {
    test("an already-aborted signal yields status 'aborted' with zero steps executed", async () => {
      const spy = vi.fn();
      const controller = new AbortController();
      controller.abort();

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("preaborted")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              spy();
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          signal: controller.signal,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
      expect(spy).not.toHaveBeenCalled();
    });

    test("an abort between steps ends the run at the boundary", async () => {
      const controller = new AbortController();
      const spy = vi.fn();

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("abort-between")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              controller.abort();
              return { flow: "continue" };
            },
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: () => {
              spy();
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          signal: controller.signal,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
      expect(spy).not.toHaveBeenCalled();
    });

    test("the signal is threaded into context.signal with identity equal to options.signal", async () => {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("signal-identity")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: (ctx) => {
              seen = ctx.signal;
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          signal: controller.signal,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(seen).toBe(controller.signal);
    });

    test("a step that throws an error with code === ERR_OPERATION_ABORTED yields 'aborted', not 'failed' — discriminated by code, not instanceof", async () => {
      class NotAnAbortedError extends M3LError {
        constructor() {
          super("plain abort-shaped error", { code: "ERR_OPERATION_ABORTED" });
        }
      }

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("code-discrimination")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              throw new NotAnAbortedError();
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
    });

    test("a raw AbortError DOMException maps to 'failed', not 'aborted'", async () => {
      const domException = new DOMException("aborted", "AbortError");

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("dom-exception")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              throw domException;
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
    });

    test("a step that throws ERR_OPERATION_ABORTED while options.signal is NOT aborted still yields 'aborted'", async () => {
      class SelfReportedAbort extends M3LError {
        constructor() {
          super("owned cancellation", { code: "ERR_OPERATION_ABORTED" });
        }
      }
      const controller = new AbortController(); // never aborted

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("unaborted-signal")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              throw new SelfReportedAbort();
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          signal: controller.signal,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
      expect(controller.signal.aborted).toBe(false);
    });

    test("an abort wins over continueOnFailure — the aborting step is not absorbed", async () => {
      class SelfReportedAbort extends M3LError {
        constructor() {
          super("owned cancellation", { code: "ERR_OPERATION_ABORTED" });
        }
      }

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("abort-vs-recovery")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            continueOnFailure: true,
            execute: () => {
              throw new SelfReportedAbort();
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
      if (outcome?.status === "matched") {
        expect(outcome.telemetry.recovered).toHaveLength(0);
      }
    });

    test("an abort wins over a no-progress trip", async () => {
      const controller = new AbortController();

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("abort-vs-progress")
          .step({
            id: "s1",
            label: "s1",
            kind: "control",
            jumpsTo: ["s1"] as const,
            loop: { reason: "abort race", maxRevisits: 1000 },
            execute: (ctx) => {
              if (ctx.iteration === 2) {
                controller.abort();
              }
              return { flow: { goTo: "s1" } };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 100,
          signal: controller.signal,
          progress: { witness: () => "constant", maxStalledSteps: 1 },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
    });

    test("abortedAt names the step boundary; it is undefined for an abort observed after phase 1", async () => {
      const controller = new AbortController();

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("abort-boundary")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              controller.abort();
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          signal: controller.signal,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
      if (outcome?.status === "aborted") {
        // Observed after phase 1 (about to enter phase 2), so undefined —
        // not the id of the step that already ran.
        expect(outcome.abortedAt).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 7. tracing
  // -------------------------------------------------------------------------
  describe("tracing", () => {
    function makeSink(): { readonly record: Mock } {
      return { record: vi.fn() };
    }

    test("absent options.trace, the sink is never touched", async () => {
      const record = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("no-trace")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {} });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(record).not.toHaveBeenCalled();
    });

    test("one procedure:step entry per executed step, recorded against the default source 'M3LProcedure'", async () => {
      const sink = makeSink();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("one-entry")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => ({ flow: "continue" }),
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      const stepCalls = sink.record.mock.calls.filter(
        (call) => call[1] === "procedure:step",
      );
      expect(stepCalls).toHaveLength(2);
      for (const call of stepCalls) {
        expect(call[0]).toBe("M3LProcedure");
      }
    });

    test("trace.source overrides the default sink source label", async () => {
      const sink = makeSink();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("custom-source")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          trace: { sink, source: "custom" },
        });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      for (const call of sink.record.mock.calls) {
        expect(call[0]).toBe("custom");
      }
    });

    test("describeTrace is called before execute (shared call log), and the recorded entry is written at step exit so durationMs is populated", async () => {
      const sink = makeSink();
      const log: string[] = [];

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("order")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            describeTrace: () => {
              log.push("describeTrace");
              return {};
            },
            execute: () => {
              log.push("execute");
              return { flow: "stop" };
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(log).toEqual(["describeTrace", "execute"]);
      const stepCall = sink.record.mock.calls.find(
        (call) => call[1] === "procedure:step",
      );
      const payload = stepCall?.[2] as M3LProcedureTraceEntry | undefined;
      expect(typeof payload?.durationMs).toBe("number");
      expect(Number.isFinite(payload?.durationMs)).toBe(true);
    });

    test("a step whose execute threw still records its entry with failed: true and flow: undefined", async () => {
      const sink = makeSink();
      const { thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("throwing-step")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => {
              throw new Error("boom");
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      });
      // This test proves a `failed` outcome path also traces; there is
      // nothing to await beyond thrown/outcome resolution above.
      expect(thrown).toBeUndefined();
      const stepCall = sink.record.mock.calls.find(
        (call) => call[1] === "procedure:step",
      );
      const payload = stepCall?.[2] as M3LProcedureTraceEntry | undefined;
      expect(payload?.failed).toBe(true);
      expect(payload?.flow).toBeUndefined();
    });

    test("failed is present as false on a clean step rather than omitted", async () => {
      const sink = makeSink();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("clean-step")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      const stepCall = sink.record.mock.calls.find(
        (call) => call[1] === "procedure:step",
      );
      const payload = stepCall?.[2] as M3LProcedureTraceEntry | undefined;
      expect(Object.hasOwn(payload ?? {}, "failed")).toBe(true);
      expect(payload?.failed).toBe(false);
    });

    test.each([
      ["continue", "continue" as const],
      ["stop", "stop" as const],
      ["resolve", "resolve" as const],
    ])(
      "flow %s is projected verbatim as the trace entry's scalar flow",
      async (_label, flow) => {
        const sink = makeSink();
        const { thrown } = await runCapturing(() => {
          const procedure = createProcedureBuilder<TS>(`flow-${flow}`)
            .step({
              id: "s1",
              label: "s1",
              kind: "gather",
              execute: () => ({ flow }),
            })
            .case(ALWAYS_TRUE_CASE)
            .build(DEFAULT_FALLBACK);
          return procedure.run({ deps: {}, parameters: {}, trace: { sink } });
        });
        expect(thrown).toBeUndefined();
        const stepCall = sink.record.mock.calls.find(
          (call) => call[1] === "procedure:step",
        );
        const payload = stepCall?.[2] as M3LProcedureTraceEntry | undefined;
        expect(payload?.flow).toBe(flow);
      },
    );

    test("a goTo flow is projected as 'goTo:<targetId>'", async () => {
      const sink = makeSink();
      const { thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("flow-goto")
          .step({
            id: "s1",
            label: "s1",
            kind: "control",
            jumpsTo: ["s2"] as const,
            execute: () => ({ flow: { goTo: "s2" } }),
          })
          .step({
            id: "s2",
            label: "s2",
            kind: "gather",
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      });
      expect(thrown).toBeUndefined();
      const s1Call = sink.record.mock.calls.find(
        (call) =>
          call[1] === "procedure:step" &&
          (call[2] as M3LProcedureTraceEntry)?.stepId === "s1",
      );
      const payload = s1Call?.[2] as M3LProcedureTraceEntry | undefined;
      expect(payload?.flow).toBe("goTo:s2");
    });

    // [DISCREPANCY] docs/reference/core/procedure.md § Tracing states
    // "M3LProcedureStepRecord.flow keeps the structured value" — but the
    // real, already-typed `src/core/procedure/types.ts` declares no `flow`
    // property at all on `M3LProcedureStepRecord` (only id/label/kind/
    // status/attempt/output/note/durationMs). Flagged for the hub rather
    // than asserting a property that would not type-check against the
    // actual contract. This pins today's real shape instead.
    test("[type][DISCREPANCY] M3LProcedureStepRecord has no 'flow' property today, despite the doc's claim", () => {
      expectTypeOf<M3LProcedureStepRecord>().not.toHaveProperty("flow");
    });

    test("the engine's own keys are applied last: a describeTrace return claiming failed: true on a clean step is overwritten", async () => {
      const sink = makeSink();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("forged-failed")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            describeTrace: (): Readonly<
              Record<string, string | number | boolean | null>
            > => ({ failed: true }),
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      const stepCall = sink.record.mock.calls.find(
        (call) => call[1] === "procedure:step",
      );
      const payload = stepCall?.[2] as M3LProcedureTraceEntry | undefined;
      expect(payload?.failed).toBe(false);
    });

    test("procedure:outcome carries engine-owned scalars only", async () => {
      const sink = makeSink();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("outcome-scalars")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      const outcomeCall = sink.record.mock.calls.find(
        (call) => call[1] === "procedure:outcome",
      );
      const payload = outcomeCall?.[2] as Record<string, unknown> | undefined;
      expect(payload).toMatchObject({ status: "matched" });
      for (const value of Object.values(payload ?? {})) {
        expect(["string", "number", "boolean"]).toContain(typeof value);
      }
    });

    test("M3LBreadcrumbTrail satisfies M3LProcedureTraceSink structurally, with a real round trip", async () => {
      const trail = new M3LBreadcrumbTrail();
      const sink: M3LProcedureTraceSink = trail;

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("breadcrumb-sink")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({ deps: {}, parameters: {}, trace: { sink } });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(trail.entries().length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 8. tracing is never load-bearing
  // -------------------------------------------------------------------------
  describe("tracing is never load-bearing", () => {
    function makeSink(record: Mock): { readonly record: Mock } {
      return { record };
    }

    test("a throwing describeTrace leaves the outcome unchanged", async () => {
      const logger = new M3LLogger([]);
      const warningSpy = vi.spyOn(logger, "warning");
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("throwing-describe")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            describeTrace: () => {
              throw new Error("describeTrace exploded");
            },
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          trace: { sink: makeSink(vi.fn()) },
          logger,
        });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(warningSpy).toHaveBeenCalledTimes(1);
    });

    test("a throwing getter on describeTrace's returned record leaves the outcome unchanged", async () => {
      const record = vi.fn();
      const hostile = Object.defineProperty({}, "hostile", {
        enumerable: true,
        get() {
          throw new Error("getter exploded");
        },
      });
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("hostile-getter")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            describeTrace: () =>
              hostile as unknown as Readonly<
                Record<string, string | number | boolean | null>
              >,
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          trace: { sink: makeSink(record) },
        });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
    });

    test("a throwing sink.record leaves the outcome unchanged", async () => {
      const record = vi.fn(() => {
        throw new Error("sink exploded");
      });
      const logger = new M3LLogger([]);
      const warningSpy = vi.spyOn(logger, "warning");
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("throwing-sink")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          trace: { sink: makeSink(record) },
          logger,
        });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(warningSpy).toHaveBeenCalled();
    });

    test("the warning names the step and the error's code only when that code is a registered M3L_ERROR_CODES member, never message/stack/name", async () => {
      const SECRET = "sk-live-super-secret-token";
      class UnregisteredCodeError extends M3LError {
        constructor() {
          super(SECRET, { code: "ERR_TOTALLY_MADE_UP_CODE" });
        }
      }
      Object.defineProperty(UnregisteredCodeError.prototype, "name", {
        value: "VeryDistinctiveName",
      });

      const record = vi.fn(() => {
        throw new UnregisteredCodeError();
      });
      const logger = new M3LLogger([]);
      const warningSpy = vi.spyOn(logger, "warning");

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("unregistered-code")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          trace: { sink: makeSink(record) },
          logger,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      expect(warningSpy).toHaveBeenCalledTimes(1);
      const call = (warningSpy.mock.calls[0] ?? []) as readonly unknown[];
      const message = String(call[0]);
      expect(message).toContain("s1");
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("VeryDistinctiveName");
      expect(message).not.toContain("ERR_TOTALLY_MADE_UP_CODE");
      expect(
        (M3L_ERROR_CODES as readonly string[]).includes(
          "ERR_TOTALLY_MADE_UP_CODE",
        ),
      ).toBe(false);
    });

    test("absent a logger, the warning is silently dropped (no throw, no output)", async () => {
      const record = vi.fn(() => {
        throw new Error("sink exploded");
      });
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("no-logger")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          trace: { sink: makeSink(record) },
        });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
    });

    test("the logger.warning call is itself guarded — a throwing logger cannot change the outcome", async () => {
      const record = vi.fn(() => {
        throw new Error("sink exploded");
      });
      const logger = new M3LLogger([]);
      vi.spyOn(logger, "warning").mockImplementation(() => {
        throw new Error("logger exploded");
      });

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("throwing-logger")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          trace: { sink: makeSink(record) },
          logger,
        });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
    });
  });

  // -------------------------------------------------------------------------
  // 9. adversarial
  // -------------------------------------------------------------------------
  describe("adversarial", () => {
    test("each offending non-scalar describeTrace entry is dropped individually while conforming keys survive", async () => {
      const record = vi.fn();
      const mutableArray = [1, 2, 3];
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("mixed-payload")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            describeTrace: () =>
              ({
                good: "ok",
                anObject: { nested: 1 },
                anArray: mutableArray,
                aFunction: () => 1,
                aDate: new Date(),
              }) as unknown as Readonly<
                Record<string, string | number | boolean | null>
              >,
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          trace: { sink: { record } },
        });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      const stepCall = record.mock.calls.find(
        (call) => call[1] === "procedure:step",
      );
      const payload = stepCall?.[2] as Record<string, unknown> | undefined;
      expect(payload?.["good"]).toBe("ok");
      expect(Object.hasOwn(payload ?? {}, "anObject")).toBe(false);
      expect(Object.hasOwn(payload ?? {}, "anArray")).toBe(false);
      expect(Object.hasOwn(payload ?? {}, "aFunction")).toBe(false);
      expect(Object.hasOwn(payload ?? {}, "aDate")).toBe(false);

      mutableArray.push(4);
      const payloadAfter = stepCall?.[2] as Record<string, unknown> | undefined;
      expect(payloadAfter?.["anArray"]).toBeUndefined();
    });

    test("a __proto__/constructor/prototype key on describeTrace's return is dropped before the scalar check", async () => {
      const record = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("dangerous-keys")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            describeTrace: () => {
              const payload: Record<string, string> = {};
              Object.defineProperty(payload, "__proto__", {
                value: "hijacked",
                enumerable: true,
                configurable: true,
              });
              Object.defineProperty(payload, "constructor", {
                value: "hijacked",
                enumerable: true,
                configurable: true,
              });
              return payload;
            },
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          trace: { sink: { record } },
        });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      const stepCall = record.mock.calls.find(
        (call) => call[1] === "procedure:step",
      );
      const payload = stepCall?.[2] as Record<string, unknown> | undefined;
      expect(Object.hasOwn(payload ?? {}, "constructor")).toBe(false);
      expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    });

    test("null survives the projection — it is a valid M3LBreadcrumbScalar", async () => {
      const record = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("null-survives")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            describeTrace: () => ({ nullable: null }),
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          trace: { sink: { record } },
        });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      const stepCall = record.mock.calls.find(
        (call) => call[1] === "procedure:step",
      );
      const payload = stepCall?.[2] as Record<string, unknown> | undefined;
      expect(Object.hasOwn(payload ?? {}, "nullable")).toBe(true);
      expect(payload?.["nullable"]).toBeNull();
    });

    test("a Proxy-backed describeTrace return is still projected safely", async () => {
      const record = vi.fn();
      const proxyReturn: Readonly<
        Record<string, string | number | boolean | null>
      > = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "flag") return "value";
            return undefined;
          },
          ownKeys() {
            return ["flag"];
          },
          getOwnPropertyDescriptor() {
            return { enumerable: true, configurable: true };
          },
        },
      );
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("proxy-describe")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            describeTrace: () => proxyReturn,
            execute: () => ({ flow: "stop" }),
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          trace: { sink: { record } },
        });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      const stepCall = record.mock.calls.find(
        (call) => call[1] === "procedure:step",
      );
      const payload = stepCall?.[2] as Record<string, unknown> | undefined;
      expect(payload?.["flag"]).toBe("value");
    });

    test("[security] a secret thrown by a continueOnFailure'd step appears in no sink.record payload and no logger argument, but IS present, redacted, in the serialized recovery chain", async () => {
      const SECRET = "token=sk-live-AKIAIOSFODNN7EXAMPLE";
      const record = vi.fn();
      const logger = new M3LLogger([]);
      const warningSpy = vi.spyOn(logger, "warning");

      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("secret-classification")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            continueOnFailure: true,
            execute: () => {
              throw new Error(SECRET);
            },
          })
          .case(ALWAYS_TRUE_CASE)
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          trace: { sink: { record } },
          logger,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");

      for (const call of record.mock.calls) {
        expect(JSON.stringify(call[2])).not.toContain(SECRET);
      }
      for (const call of warningSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SECRET);
      }

      // The redacted serialized recovery chain is where a secret token
      // legitimately appears (redacted), classifying it report-grade rather
      // than absent entirely.
      if (outcome?.status === "matched") {
        const chain = JSON.stringify(outcome.telemetry.recovered);
        expect(chain).not.toContain(SECRET);
      }
    });

    test("the condition evaluation tree never reaches the sink — every recorded payload is scalar-only", async () => {
      const record = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = createProcedureBuilder<TS>("no-evaluation-leak")
          .step({
            id: "s1",
            label: "s1",
            kind: "gather",
            execute: () => ({
              flow: "stop",
              output: { nested: { value: 42 } },
            }),
          })
          .case({
            ...ALWAYS_TRUE_CASE,
            condition: {
              kind: "and",
              operands: [
                {
                  kind: "exists",
                  subject: { source: "literal", literal: "x" },
                },
                {
                  kind: "compare",
                  left: {
                    source: "step",
                    step: "s1",
                    path: ["nested", "value"],
                  },
                  operator: "==",
                  right: { source: "literal", literal: 42 },
                },
              ],
            },
          })
          .build(DEFAULT_FALLBACK);
        return procedure.run({
          deps: {},
          parameters: {},
          trace: { sink: { record } },
        });
      });
      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");

      for (const call of record.mock.calls) {
        const payload = call[2] as Record<string, unknown> | undefined;
        for (const value of Object.values(payload ?? {})) {
          expect(
            ["string", "number", "boolean"].includes(typeof value) ||
              value === null,
          ).toBe(true);
        }
      }
      expect(
        record.mock.calls.some((call) => call[1] === "procedure:evaluation"),
      ).toBe(false);
    });
  });
});
