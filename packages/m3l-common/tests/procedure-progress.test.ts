/**
 * Tests for the `core/procedure` submodule — slice 3c (ADR-0046, issue #474,
 * tracker B2): the opt-in no-progress guard, `options.progress`. This guard
 * does not exist on `main` yet — `progress` is not a field of
 * `M3LProcedureRunOptions`, and `ERR_PROCEDURE_NO_PROGRESS` is not a
 * registered error code — so every test in this file is written against the
 * documented, eventual contract and is expected to fail RED until this slice
 * lands: either a `tsc` diagnostic naming the not-yet-existing `progress`
 * field, or a runtime assertion failure because the guard never fires (the
 * engine currently ignores the extra `progress` property entirely). Neither
 * is a defect in this file.
 *
 * Contract source: docs/reference/core/procedure.md § Option validation,
 * § The run contract (Phase 1, step 9), § Errors, § Cancellation.
 *
 * Scope owned by this file: `options.progress` (the no-progress guard)
 * only — option validation, sampling ordering, capture-by-value, the two
 * mid-run failure translations, and the abort-always-wins interaction.
 * `maxIterations`/`parameters`/`initialValues`/`trace`/`logger` are owned by
 * sibling files (`procedure-run-guards.test.ts`, `procedure-run-faults.test.ts`,
 * `procedure-tracing.test.ts`).
 *
 * No error class is exported from `core/procedure` — every failure is
 * asserted via `instanceof M3LError` plus the machine-readable `code`, never
 * a whitebox subclass import.
 */

import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { createProcedureBuilder } from "../src/core/procedure/index.js";
import type {
  M3LProcedure,
  M3LProcedureCase,
  M3LProcedureContext,
  M3LProcedureFallback,
  M3LProcedureProgressOptions,
  M3LProcedureProgressWitness,
  M3LProcedureShape,
} from "../src/core/procedure/index.js";
import { M3LError } from "../src/core/errors/index.js";

// ---------------------------------------------------------------------------
// Shared shape
// ---------------------------------------------------------------------------

/** A general-purpose shape reused by every block in this file. */
interface TS extends M3LProcedureShape {
  readonly deps: Record<string, never>;
  readonly values: { readonly counter?: number };
  readonly parameters: Record<string, never>;
  readonly conclusion: { readonly verdict: string };
  readonly stepId: "s1" | "s2" | "s3" | "s4";
  readonly caseId: "caseA";
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

/**
 * A single self-looping `control` step: it goes back to itself (`goTo: "s1"`)
 * every "continuing" execution, incrementing `values.counter`, until
 * `options.stopAtCount` is reached — at which point it returns `"stop"`
 * instead (ending phase 1 without a further progress sample, per the
 * contract's "not a continuing step" carve-out). Omitting `stopAtCount`
 * loops forever, bounded only by the caller's `maxIterations`/`maxRevisits`.
 * `execSpy` is called with the 1-based execution count on every execution
 * (continuing or not), so a test can assert exactly how many times the step
 * ran independent of how many times the progress witness was sampled.
 */
function buildLoopProcedure(
  execSpy: Mock,
  options: { maxRevisits: number; stopAtCount?: number },
): M3LProcedure<TS> {
  return createProcedureBuilder<TS>("progress-loop")
    .step({
      id: "s1",
      label: "loop step",
      kind: "control",
      jumpsTo: ["s1"] as const,
      loop: {
        reason: "progress guard probe",
        maxRevisits: options.maxRevisits,
      },
      execute: (ctx) => {
        const count = (ctx.values.counter ?? 0) + 1;
        execSpy(count);
        if (options.stopAtCount !== undefined && count >= options.stopAtCount) {
          return { flow: "stop", values: { counter: count } };
        }
        return { flow: { goTo: "s1" }, values: { counter: count } };
      },
    })
    .case(ALWAYS_TRUE_CASE)
    .build(DEFAULT_FALLBACK);
}

/** A straight-line, four-step procedure; every step returns `"continue"`. */
function buildFourStepProcedure(executed: string[]): M3LProcedure<TS> {
  return createProcedureBuilder<TS>("progress-straight-line")
    .step({
      id: "s1",
      label: "s1",
      kind: "gather",
      execute: () => {
        executed.push("s1");
        return { flow: "continue" };
      },
    })
    .step({
      id: "s2",
      label: "s2",
      kind: "gather",
      execute: () => {
        executed.push("s2");
        return { flow: "continue" };
      },
    })
    .step({
      id: "s3",
      label: "s3",
      kind: "gather",
      execute: () => {
        executed.push("s3");
        return { flow: "continue" };
      },
    })
    .step({
      id: "s4",
      label: "s4",
      kind: "gather",
      execute: () => {
        executed.push("s4");
        return { flow: "continue" };
      },
    })
    .case(ALWAYS_TRUE_CASE)
    .build(DEFAULT_FALLBACK);
}

/**
 * A single step declaring `continueOnFailure: true` and `loop`, whose
 * `execute` throws unconditionally: every execution is absorbed by
 * `continueOnFailure` and, because the step declares `loop`, synthesized by
 * the engine as a **retry** (re-executing the same step) rather than a
 * genuine `"continue"`/`goTo` advance
 * (docs/reference/core/procedure.md § Phase 1, step 6 "Recovery"). `execSpy`
 * is called on every execution (there is no non-throwing path), so a test
 * can assert exactly how many retries ran independent of how many times the
 * progress witness was sampled.
 */
function buildThrowingLoopProcedure(
  execSpy: Mock,
  options: { maxRevisits: number },
): M3LProcedure<TS> {
  return createProcedureBuilder<TS>("progress-retry-loop")
    .step({
      id: "s1",
      label: "always-throwing loop step",
      kind: "control",
      continueOnFailure: true,
      loop: {
        reason: "retry on transient failure",
        maxRevisits: options.maxRevisits,
      },
      execute: (): never => {
        execSpy();
        throw new Error("transient failure");
      },
    })
    .case(ALWAYS_TRUE_CASE)
    .build(DEFAULT_FALLBACK);
}

/** Same four steps, but `s2` returns `"stop"` instead of `"continue"`. */
function buildStopMidwayProcedure(executed: string[]): M3LProcedure<TS> {
  return createProcedureBuilder<TS>("progress-stop-midway")
    .step({
      id: "s1",
      label: "s1",
      kind: "gather",
      execute: () => {
        executed.push("s1");
        return { flow: "continue" };
      },
    })
    .step({
      id: "s2",
      label: "s2",
      kind: "gather",
      execute: () => {
        executed.push("s2");
        return { flow: "stop" };
      },
    })
    .step({
      id: "s3",
      label: "s3",
      kind: "gather",
      execute: () => {
        executed.push("s3");
        return { flow: "continue" };
      },
    })
    .step({
      id: "s4",
      label: "s4",
      kind: "gather",
      execute: () => {
        executed.push("s4");
        return { flow: "continue" };
      },
    })
    .case(ALWAYS_TRUE_CASE)
    .build(DEFAULT_FALLBACK);
}

/** Same four steps, but `s2` returns `"resolve"` and a case always matches. */
function buildResolveEarlyProcedure(executed: string[]): M3LProcedure<TS> {
  return createProcedureBuilder<TS>("progress-resolve-early")
    .step({
      id: "s1",
      label: "s1",
      kind: "gather",
      execute: () => {
        executed.push("s1");
        return { flow: "continue" };
      },
    })
    .step({
      id: "s2",
      label: "s2",
      kind: "gather",
      execute: () => {
        executed.push("s2");
        return { flow: "resolve" };
      },
    })
    .step({
      id: "s3",
      label: "s3",
      kind: "gather",
      execute: () => {
        executed.push("s3");
        return { flow: "continue" };
      },
    })
    .step({
      id: "s4",
      label: "s4",
      kind: "gather",
      execute: () => {
        executed.push("s4");
        return { flow: "continue" };
      },
    })
    .case(ALWAYS_TRUE_CASE)
    .build(DEFAULT_FALLBACK);
}

/** Three steps, each writing a distinct `values.counter`, for the "live context" test. */
function buildValuesProcedure(): M3LProcedure<TS> {
  return createProcedureBuilder<TS>("progress-live-context")
    .step({
      id: "s1",
      label: "s1",
      kind: "gather",
      execute: () => ({ flow: "continue", values: { counter: 1 } }),
    })
    .step({
      id: "s2",
      label: "s2",
      kind: "gather",
      execute: () => ({ flow: "continue", values: { counter: 2 } }),
    })
    .step({
      id: "s3",
      label: "s3",
      kind: "gather",
      execute: () => ({ flow: "continue", values: { counter: 3 } }),
    })
    .case(ALWAYS_TRUE_CASE)
    .build(DEFAULT_FALLBACK);
}

/** A single-step procedure for the synchronous run-option-validation block. */
function buildValidationProcedure(execSpy: Mock): M3LProcedure<TS> {
  return createProcedureBuilder<TS>("progress-validation")
    .step({
      id: "s1",
      label: "s1",
      kind: "gather",
      execute: (ctx) => {
        execSpy(ctx);
        return { flow: "stop" };
      },
    })
    .case(ALWAYS_TRUE_CASE)
    .build(DEFAULT_FALLBACK);
}

// ---------------------------------------------------------------------------

describe("no-progress guard", () => {
  // -------------------------------------------------------------------------
  // 1. opt-in default
  // -------------------------------------------------------------------------
  describe("opt-in default", () => {
    test("with no progress option configured, the run completes normally and never fails under ERR_PROCEDURE_NO_PROGRESS", async () => {
      const procedure = buildFourStepProcedure([]);
      const { outcome, thrown } = await runCapturing(() =>
        procedure.run({ deps: {}, parameters: {} }),
      );

      expect(thrown).toBeUndefined();
      expect(
        outcome?.status === "matched" || outcome?.status === "unrecognized",
      ).toBe(true);
      if (outcome?.status === "failed") {
        expect(asM3LError(outcome.error).code).not.toBe(
          "ERR_PROCEDURE_NO_PROGRESS",
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. trip fires exactly on the Nth consecutive unchanged sample
  // -------------------------------------------------------------------------
  describe("stall counting", () => {
    test.each([1, 2, 3])(
      "with maxStalledSteps: %i, an always-same witness trips ERR_PROCEDURE_NO_PROGRESS exactly maxStalledSteps + 1 samples in",
      async (maxStalledSteps) => {
        const execSpy = vi.fn();
        const { outcome, thrown } = await runCapturing(() => {
          const procedure = buildLoopProcedure(execSpy, { maxRevisits: 50 });
          return procedure.run({
            deps: {},
            parameters: {},
            maxIterations: 50,
            progress: {
              witness: (): string => "same",
              maxStalledSteps,
            },
          });
        });

        expect(thrown).toBeUndefined();
        expect(outcome?.status).toBe("failed");
        if (outcome?.status === "failed") {
          const error = asM3LError(outcome.error);
          expect(error.code).toBe("ERR_PROCEDURE_NO_PROGRESS");
          expect(error.context["stalledSteps"]).toBe(maxStalledSteps);
          expect(error.context["lastStepId"]).toBe("s1");
        }
        // Neither one sample early nor one sample late.
        expect(execSpy).toHaveBeenCalledTimes(maxStalledSteps + 1);
      },
    );

    // RED note: because `run()` does not read `options.progress` at all yet,
    // this "never trips" assertion passes trivially today — it is a
    // regression lock, not proof the guard exists, until the guard lands.
    // Re-confirm after GREEN that it still discriminates (e.g. temporarily
    // widening `stopAtCount` so the guard WOULD trip if it existed, then
    // reverting) per the ordering-assertion discipline in this repo's rules.
    test("the baseline sample never trips: exactly maxStalledSteps continuing steps completes normally", async () => {
      const maxStalledSteps = 3;
      const execSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        // stopAtCount = maxStalledSteps + 1: counts 1..maxStalledSteps are
        // "continue" (sampled), count maxStalledSteps + 1 is "stop" (not
        // sampled) — exactly `maxStalledSteps` continuing steps in total,
        // one fewer than the `maxStalledSteps + 1` samples needed to trip.
        const procedure = buildLoopProcedure(execSpy, {
          maxRevisits: 50,
          stopAtCount: maxStalledSteps + 1,
        });
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 50,
          progress: {
            witness: (): string => "same",
            maxStalledSteps,
          },
        });
      });

      expect(thrown).toBeUndefined();
      expect(
        outcome?.status === "matched" || outcome?.status === "unrecognized",
      ).toBe(true);
      expect(execSpy).toHaveBeenCalledTimes(maxStalledSteps + 1);
    });

    test("a strictly changing witness value never trips, even across many more steps than maxStalledSteps", async () => {
      const maxStalledSteps = 2;
      const execSpy = vi.fn();
      let counter = 0;
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildLoopProcedure(execSpy, {
          maxRevisits: 50,
          stopAtCount: maxStalledSteps + 5,
        });
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 50,
          progress: {
            witness: (): number => {
              counter += 1;
              return counter;
            },
            maxStalledSteps,
          },
        });
      });

      expect(thrown).toBeUndefined();
      expect(
        outcome?.status === "matched" || outcome?.status === "unrecognized",
      ).toBe(true);
      expect(execSpy).toHaveBeenCalledTimes(maxStalledSteps + 5);
    });

    test("trips on repeated continueOnFailure+loop retries before the revisit ceiling, since the guard samples every retry", async () => {
      const maxStalledSteps = 2;
      const execSpy = vi.fn();
      const witness = vi.fn((): string => "same");
      const { outcome, thrown } = await runCapturing(() => {
        // maxRevisits (50) is far larger than maxStalledSteps (2): if the
        // guard did not sample on the engine-synthesized retry path, this
        // run would keep retrying toward ERR_PROCEDURE_ITERATION_LIMIT
        // instead of ever tripping ERR_PROCEDURE_NO_PROGRESS.
        const procedure = buildThrowingLoopProcedure(execSpy, {
          maxRevisits: 50,
        });
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 50,
          progress: { witness, maxStalledSteps },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_NO_PROGRESS");
        expect(error.context["stalledSteps"]).toBe(maxStalledSteps);
      }
      // Sampled on every retry, not skipped: exactly maxStalledSteps + 1
      // retries/samples, never reaching anywhere near maxRevisits (50).
      expect(execSpy).toHaveBeenCalledTimes(maxStalledSteps + 1);
      expect(witness).toHaveBeenCalledTimes(maxStalledSteps + 1);
    });
  });

  // -------------------------------------------------------------------------
  // 3. sampling ordering
  // -------------------------------------------------------------------------
  describe("sampling ordering", () => {
    test("a straight-line N-step run samples exactly N - 1 times — never on the last declared step's implicit continue", async () => {
      const executed: string[] = [];
      const witness = vi.fn((): number => witness.mock.calls.length);
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildFourStepProcedure(executed);
        return procedure.run({
          deps: {},
          parameters: {},
          progress: { witness, maxStalledSteps: 100 },
        });
      });

      expect(thrown).toBeUndefined();
      expect(
        outcome?.status === "matched" || outcome?.status === "unrecognized",
      ).toBe(true);
      expect(executed).toEqual(["s1", "s2", "s3", "s4"]);
      expect(witness).toHaveBeenCalledTimes(3);
    });

    test("a run ending via 'stop' mid-way samples once per step that genuinely continued, never for the stopping step itself", async () => {
      const executed: string[] = [];
      const witness = vi.fn((): number => witness.mock.calls.length);
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildStopMidwayProcedure(executed);
        return procedure.run({
          deps: {},
          parameters: {},
          progress: { witness, maxStalledSteps: 100 },
        });
      });

      expect(thrown).toBeUndefined();
      expect(
        outcome?.status === "matched" || outcome?.status === "unrecognized",
      ).toBe(true);
      // s2 returns "stop"; s3/s4 never execute.
      expect(executed).toEqual(["s1", "s2"]);
      expect(witness).toHaveBeenCalledTimes(1);
    });

    test("a run ending via an early 'resolve' match samples once per step that genuinely continued, never for the resolving step itself", async () => {
      const executed: string[] = [];
      const witness = vi.fn((): number => witness.mock.calls.length);
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildResolveEarlyProcedure(executed);
        return procedure.run({
          deps: {},
          parameters: {},
          progress: { witness, maxStalledSteps: 100 },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      if (outcome?.status === "matched") {
        expect(outcome.telemetry.earlyResolved).toBe(true);
      }
      // s2 returns "resolve" and a case matches; s3/s4 never execute.
      expect(executed).toEqual(["s1", "s2"]);
      expect(witness).toHaveBeenCalledTimes(1);
    });

    test("the witness observes the live, just-derived context — this step's own contribution, not a stale one", async () => {
      const seen: (number | undefined)[] = [];
      const witness = (context: M3LProcedureContext<TS>): number => {
        seen.push(context.values.counter);
        return context.values.counter ?? -1;
      };
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildValuesProcedure();
        return procedure.run({
          deps: {},
          parameters: {},
          progress: { witness, maxStalledSteps: 1 },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("matched");
      // Sampled after s1 (sees counter === 1) and after s2 (sees counter ===
      // 2); s3 is the last declared step, so its "continue" is never sampled.
      expect(seen).toEqual([1, 2]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. mid-run failure translations
  // -------------------------------------------------------------------------
  describe("witness failure translation", () => {
    test("a witness that throws an Error resolves failed under ERR_PROCEDURE_INVALID_OPTION, chaining the exact thrown instance as cause", async () => {
      const boom = new Error("witness boom");
      const execSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildLoopProcedure(execSpy, { maxRevisits: 50 });
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 50,
          progress: {
            witness: (): string => {
              throw boom;
            },
            maxStalledSteps: 2,
          },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(error.context["option"]).toBe("progress.witness");
        expect(error.cause).toBe(boom);
      }
    });

    test("a witness that throws a non-Error value chains the raw thrown value, unmodified, as cause", async () => {
      const execSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildLoopProcedure(execSpy, { maxRevisits: 50 });
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 50,
          progress: {
            witness: (): string => {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error throw, proving the guard chains the raw thrown value un-normalized
              throw "boom";
            },
            maxStalledSteps: 2,
          },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(error.context["option"]).toBe("progress.witness");
        expect(error.cause).toBe("boom");
      }
    });

    test("a witness returning a non-primitive value resolves failed under ERR_PROCEDURE_INVALID_OPTION with no cause", async () => {
      // The documented witness type is `(context) => string | number | bigint
      // | boolean`; this deliberately violates that at runtime (an untyped
      // caller could still hand back an object) to prove the runtime guard —
      // not the compiler — rejects it. The return type is widened locally,
      // at this one call site only.
      const badWitness = (): unknown => ({ stalled: true });
      const execSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildLoopProcedure(execSpy, { maxRevisits: 50 });
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 50,
          progress: {
            witness: badWitness as (
              context: M3LProcedureContext<TS>,
            ) => string | number | bigint | boolean,
            maxStalledSteps: 2,
          },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(error.context["option"]).toBe("progress.witness");
        expect(error.cause).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. abort always wins
  // -------------------------------------------------------------------------
  describe("abort always wins over a no-progress trip", () => {
    test("a signal already aborted before the tripping step runs resolves 'aborted', never 'failed'", async () => {
      const controller = new AbortController();
      controller.abort();
      const execSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildLoopProcedure(execSpy, { maxRevisits: 50 });
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 50,
          signal: controller.signal,
          progress: {
            witness: (): string => "same",
            maxStalledSteps: 1,
          },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
    });

    test("an abort fired as a side effect of the witness call itself still resolves 'aborted', even though the sample would otherwise trip the guard", async () => {
      const controller = new AbortController();
      let witnessCalls = 0;
      const execSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildLoopProcedure(execSpy, { maxRevisits: 50 });
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 50,
          signal: controller.signal,
          progress: {
            witness: (): string => {
              witnessCalls += 1;
              // maxStalledSteps: 1 means the SECOND sample ("same" again,
              // same as the baseline) would otherwise trip the guard — abort
              // as a side effect of computing that very sample.
              if (witnessCalls === 2) {
                controller.abort();
              }
              return "same";
            },
            maxStalledSteps: 1,
          },
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("aborted");
    });
  });

  // -------------------------------------------------------------------------
  // 6. synchronous option validation
  // -------------------------------------------------------------------------
  describe("run option validation", () => {
    test.each([
      ["a string", "not-a-function"],
      ["null", null],
      ["a number", 42],
    ])(
      "progress.witness that is %s throws ERR_PROCEDURE_INVALID_OPTION before any step executes",
      (_label, badWitness) => {
        const execSpy = vi.fn();
        const thrown = captureSyncThrow(() => {
          const procedure = buildValidationProcedure(execSpy);
          void procedure.run({
            deps: {},
            parameters: {},
            progress: {
              // Deliberate runtime-only violation of the declared witness
              // type (an untyped caller could still hand back a string,
              // null, or a number) — proves the boundary guard, not the
              // compiler, rejects it.
              witness: badWitness as unknown as M3LProcedureProgressWitness<TS>,
              maxStalledSteps: 2,
            },
          });
        });
        const error = asM3LError(thrown);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(error.context["option"]).toBe("progress.witness");
        expect(execSpy).not.toHaveBeenCalled();
      },
    );

    test.each([
      ["zero", 0],
      ["negative", -1],
      ["non-integer", 1.5],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["a string", "3"],
    ])(
      "progress.maxStalledSteps that is %s throws ERR_PROCEDURE_INVALID_OPTION before any step executes",
      (_label, badValue) => {
        const execSpy = vi.fn();
        const thrown = captureSyncThrow(() => {
          const procedure = buildValidationProcedure(execSpy);
          void procedure.run({
            deps: {},
            parameters: {},
            progress: {
              witness: (): string => "same",
              // Deliberate runtime-only violation of the declared `number`
              // type (an untyped caller could still hand back a string or
              // an out-of-range number) — proves the boundary guard, not
              // the compiler, rejects it.
              maxStalledSteps: badValue as unknown as number,
            },
          });
        });
        const error = asM3LError(thrown);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(error.context["option"]).toBe("progress.maxStalledSteps");
        expect(error.context["value"]).toBe(badValue);
        expect(execSpy).not.toHaveBeenCalled();
      },
    );

    test.each([
      ["null", null],
      ["an array", []],
      ["a string", "not-an-object"],
    ])(
      "progress that is %s throws ERR_PROCEDURE_INVALID_OPTION before any step executes",
      (_label, badProgress) => {
        const execSpy = vi.fn();
        const thrown = captureSyncThrow(() => {
          const procedure = buildValidationProcedure(execSpy);
          void procedure.run({
            deps: {},
            parameters: {},
            // Deliberate runtime-only violation of the declared
            // `M3LProcedureProgressOptions<TShape> | undefined` type (an
            // untyped caller could still hand back `null`, an array, or a
            // primitive) — proves the boundary guard rejects a malformed
            // `progress` itself, distinct from a malformed `progress.witness`
            // or `progress.maxStalledSteps` sub-field covered above.
            progress: badProgress as unknown as M3LProcedureProgressOptions<TS>,
          });
        });
        const error = asM3LError(thrown);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(error.context["option"]).toBe("progress");
        expect(execSpy).not.toHaveBeenCalled();
      },
    );
  });

  // -------------------------------------------------------------------------
  // 7. capture by value
  // -------------------------------------------------------------------------
  describe("capture by value", () => {
    test("progress.maxStalledSteps is read exactly once, even via a getter that throws if read a second time", async () => {
      let reads = 0;
      const progress = {
        witness: (): string => "same",
        get maxStalledSteps(): number {
          reads += 1;
          if (reads > 1) {
            throw new Error("progress.maxStalledSteps read more than once");
          }
          return 2;
        },
      };
      const execSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildLoopProcedure(execSpy, { maxRevisits: 50 });
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 50,
          progress,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.code).toBe("ERR_PROCEDURE_NO_PROGRESS");
        // Trips using the FIRST-read value (2), not a hypothetical later one.
        expect(error.context["stalledSteps"]).toBe(2);
      }
      expect(execSpy).toHaveBeenCalledTimes(3);
      expect(reads).toBe(1);
    });

    test("progress.witness is read as a property exactly once at run entry, even though the captured function is then invoked many times", async () => {
      let propertyReads = 0;
      let calls = 0;
      function actualWitness(): string {
        calls += 1;
        return "same";
      }
      const progress = {
        get witness() {
          propertyReads += 1;
          return actualWitness;
        },
        maxStalledSteps: 2,
      };
      const execSpy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildLoopProcedure(execSpy, { maxRevisits: 50 });
        return procedure.run({
          deps: {},
          parameters: {},
          maxIterations: 50,
          progress,
        });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      expect(propertyReads).toBe(1);
      // The captured function itself IS invoked once per continuing step —
      // that is normal use, not a re-read of the `progress` option itself.
      expect(calls).toBe(3);
    });
  });
});
