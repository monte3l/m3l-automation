/**
 * Tests for the `core/procedure` submodule — slice 3a (ADR-0046, issue #474):
 * `M3LProcedure.run()`'s option validation, capture-by-value, and the
 * iteration ceiling. `run()` does not exist on `main` yet, so every test in
 * this file is written against the documented, eventual contract and is
 * expected to fail RED until this slice lands — that failure is the point,
 * not a defect in the test.
 *
 * Sibling file `procedure-run-faults.test.ts` owns the same slice's
 * undeclared-jump guard, `continueOnFailure`/recovery, and cancellation
 * blocks — the split is purely a file-size partition (ADR-0072); both files
 * share the same contract source and scope notes.
 *
 * Contract source: docs/reference/core/procedure.md § Option validation,
 * § Flow directives, § Phase 1 — steps (steps 5–6), § Outcome.
 *
 * Scope owned by this file: the three blocks named above only. `progress`
 * (the no-progress guard), `trace`/`logger` and tracing are NOT part of this
 * slice's `M3LProcedureRunOptions` — every fixture below omits them. Later
 * slices (3b/3c) own the no-progress guard, tracing, and adversarial trace
 * payloads in their own files.
 *
 * No error class is exported from `core/procedure` — every failure is
 * asserted via `instanceof M3LError` plus the machine-readable `code`, never
 * a whitebox subclass import.
 */

import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import {
  createProcedureBuilder,
  M3L_PROCEDURE_CONDITION_MAX_DEPTH,
} from "../src/core/procedure/index.js";
import type {
  M3LProcedure,
  M3LProcedureCase,
  M3LProcedureFallback,
  M3LProcedureShape,
  M3LProcedureValue,
} from "../src/core/procedure/index.js";
import { M3LError } from "../src/core/errors/index.js";

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

/** Builds a deeply nested, otherwise-valid `M3LProcedureValue`, `depth` levels deep. */
function buildDeeplyNestedValue(depth: number): M3LProcedureValue {
  let nested: M3LProcedureValue = "leaf";
  for (let level = 0; level < depth; level += 1) {
    nested = { a: nested };
  }
  return nested;
}

/**
 * Builds a deeply nested, otherwise-valid `M3LProcedureValue`, `depth` levels
 * deep through ARRAY nesting (`[[[...["leaf"]...]]]`) rather than object
 * nesting — mirrors {@link buildDeeplyNestedValue} but exercises
 * `projectValue`'s array branch instead of its object branch.
 */
function buildDeeplyNestedArrayValue(depth: number): M3LProcedureValue {
  let nested: M3LProcedureValue = "leaf";
  for (let level = 0; level < depth; level += 1) {
    nested = [nested];
  }
  return nested;
}

// ---------------------------------------------------------------------------

describe("core/procedure — run guards", () => {
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

    // ------------------------------------------------------------------
    // New regressions: unbounded-depth / cyclic / throwing-getter caller
    // graphs must be rejected, never stack-overflowed or leaked raw.
    // ------------------------------------------------------------------

    test("a parameters value nested well past M3L_PROCEDURE_CONDITION_MAX_DEPTH throws ERR_PROCEDURE_INVALID_OPTION, not a RangeError", () => {
      const spy = vi.fn();
      const deepValue = buildDeeplyNestedValue(
        M3L_PROCEDURE_CONDITION_MAX_DEPTH + 184,
      );
      const thrown = captureSyncThrow(() => {
        const procedure = buildOptProcedure(spy);
        void procedure.run({
          deps: { marker: true },
          parameters: {
            threshold: deepValue,
          } as unknown as OptShape["parameters"],
        });
      });
      expect(thrown).not.toBeInstanceOf(RangeError);
      const error = asM3LError(thrown);
      expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
      expect(spy).not.toHaveBeenCalled();
    });

    test("a cyclic parameters object throws ERR_PROCEDURE_INVALID_OPTION, not a RangeError or an infinite loop", () => {
      const spy = vi.fn();
      const cyclic: Record<string, unknown> = {};
      cyclic["self"] = cyclic;
      const thrown = captureSyncThrow(() => {
        const procedure = buildOptProcedure(spy);
        void procedure.run({
          deps: { marker: true },
          parameters: {
            threshold: cyclic,
          } as unknown as OptShape["parameters"],
        });
      });
      expect(thrown).not.toBeInstanceOf(RangeError);
      const error = asM3LError(thrown);
      expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
      expect(spy).not.toHaveBeenCalled();
    });

    test("a throwing nested getter inside parameters is normalized to ERR_PROCEDURE_INVALID_OPTION, never leaked raw", () => {
      const spy = vi.fn();
      const nestedBoom = new Error("nested boom");
      const hostile = {
        get poison(): never {
          throw nestedBoom;
        },
      };
      const thrown = captureSyncThrow(() => {
        const procedure = buildOptProcedure(spy);
        void procedure.run({
          deps: { marker: true },
          parameters: {
            threshold: hostile,
          } as unknown as OptShape["parameters"],
        });
      });
      // The raw Error must never escape unwrapped/un-normalized.
      expect(thrown).not.toBe(nestedBoom);
      const error = asM3LError(thrown);
      expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
      expect(spy).not.toHaveBeenCalled();
    });

    test.each(["__proto__", "constructor", "prototype"])(
      "a dangerous key %s in initialValues throws ERR_PROCEDURE_INVALID_OPTION, same as parameters",
      (dangerousKey) => {
        const spy = vi.fn();
        const initialValues = { [dangerousKey]: {} };
        const thrown = captureSyncThrow(() => {
          const procedure = buildOptProcedure(spy);
          void procedure.run({
            deps: { marker: true },
            parameters: { threshold: 1 },
            initialValues,
          });
        });
        const error = asM3LError(thrown);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(spy).not.toHaveBeenCalled();
      },
    );

    test("initialValues nested well past M3L_PROCEDURE_CONDITION_MAX_DEPTH throws ERR_PROCEDURE_INVALID_OPTION, not a RangeError", () => {
      const spy = vi.fn();
      const deepValue = buildDeeplyNestedValue(
        M3L_PROCEDURE_CONDITION_MAX_DEPTH + 184,
      );
      const thrown = captureSyncThrow(() => {
        const procedure = buildOptProcedure(spy);
        void procedure.run({
          deps: { marker: true },
          parameters: { threshold: 1 },
          initialValues: { a: deepValue } as unknown as OptShape["values"],
        });
      });
      expect(thrown).not.toBeInstanceOf(RangeError);
      const error = asM3LError(thrown);
      expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
      expect(spy).not.toHaveBeenCalled();
    });

    test("a parameters value nested well past M3L_PROCEDURE_CONDITION_MAX_DEPTH through an ARRAY throws ERR_PROCEDURE_INVALID_OPTION, not a RangeError", () => {
      const spy = vi.fn();
      const deepArrayValue = buildDeeplyNestedArrayValue(
        M3L_PROCEDURE_CONDITION_MAX_DEPTH + 184,
      );
      const thrown = captureSyncThrow(() => {
        const procedure = buildOptProcedure(spy);
        void procedure.run({
          deps: { marker: true },
          parameters: {
            threshold: deepArrayValue,
          } as unknown as OptShape["parameters"],
        });
      });
      expect(thrown).not.toBeInstanceOf(RangeError);
      const error = asM3LError(thrown);
      expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
      expect(spy).not.toHaveBeenCalled();
    });

    test("a throwing array element inside parameters is normalized to ERR_PROCEDURE_INVALID_OPTION, never leaked raw", () => {
      const spy = vi.fn();
      const nestedBoom = new Error("nested array boom");
      const hostileArray: unknown[] = [1, 2];
      Object.defineProperty(hostileArray, 0, {
        get(): never {
          throw nestedBoom;
        },
        enumerable: true,
        configurable: true,
      });
      const thrown = captureSyncThrow(() => {
        const procedure = buildOptProcedure(spy);
        void procedure.run({
          deps: { marker: true },
          parameters: {
            threshold: hostileArray,
          } as unknown as OptShape["parameters"],
        });
      });
      // The raw Error must never escape unwrapped/un-normalized.
      expect(thrown).not.toBe(nestedBoom);
      const error = asM3LError(thrown);
      expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
      expect(spy).not.toHaveBeenCalled();
    });

    // ------------------------------------------------------------------
    // New regressions: an exotic class instance (Map/Set/Date) is not a
    // plain-data M3LProcedureValue — a naive enumerable-own-keys projection
    // would silently coerce it to `{}` rather than rejecting it. Both a
    // nested occurrence and the top-level `parameters` value itself must be
    // rejected, never silently passed through.
    // ------------------------------------------------------------------

    test.each([
      ["a nested Map", new Map([["x", 1]])],
      ["a nested Set", new Set([1, 2])],
      ["a nested Date", new Date()],
    ])(
      "a parameters value containing %s throws ERR_PROCEDURE_INVALID_OPTION, not a silent coercion to {}",
      (_label, exotic) => {
        const spy = vi.fn();
        const thrown = captureSyncThrow(() => {
          const procedure = buildOptProcedure(spy);
          void procedure.run({
            deps: { marker: true },
            parameters: {
              threshold: exotic,
            } as unknown as OptShape["parameters"],
          });
        });
        const error = asM3LError(thrown);
        expect(error.code).toBe("ERR_PROCEDURE_INVALID_OPTION");
        expect(spy).not.toHaveBeenCalled();
      },
    );

    test.each([
      ["a Map", new Map([["threshold", 1]])],
      ["an array", [1, 2, 3]],
    ])(
      "parameters being %s directly (not a plain object) throws ERR_PROCEDURE_INVALID_OPTION, not a silent pass-through",
      (_label, exoticParameters) => {
        const spy = vi.fn();
        const thrown = captureSyncThrow(() => {
          const procedure = buildOptProcedure(spy);
          void procedure.run({
            deps: { marker: true },
            // Simulates an untyped caller: `parameters` is typed as a plain
            // object (`OptShape["parameters"]`), so a real TS caller cannot
            // construct this literal — the exotic value is threaded through
            // a cast, matching the file's established "untyped caller"
            // pattern used throughout this describe block.
            parameters: exoticParameters as unknown as OptShape["parameters"],
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

      const { outcome, thrown } = await runCapturing(() => {
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

      const { outcome, thrown } = await runCapturing(() => {
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

      const { outcome, thrown } = await runCapturing(() => {
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

    // ------------------------------------------------------------------
    // New regression: the overall iteration ceiling is a guard failure —
    // no single step is "at fault" for it, since a goTo loop counts every
    // pass across potentially many steps — so `failedStep` must be
    // `undefined`. The per-step revisit ceiling, by contrast, names the
    // one step that kept re-executing past its own declared `maxRevisits`.
    // ------------------------------------------------------------------

    test("exceeding maxIterations yields failedStep undefined — the overall ceiling is a guard failure, not any one step's fault", async () => {
      const spy = vi.fn();
      const { outcome, thrown } = await runCapturing(() => {
        const procedure = buildSelfLoopProcedure(spy, 1000);
        return procedure.run({ deps: {}, parameters: {}, maxIterations: 5 });
      });

      expect(thrown).toBeUndefined();
      expect(outcome?.status).toBe("failed");
      if (outcome?.status === "failed") {
        const error = asM3LError(outcome.error);
        expect(error.context["limit"]).toBe("iterations");
        expect(outcome.failedStep).toBeUndefined();
      }
    });

    test("exceeding maxRevisits yields failedStep equal to the looping step's own id", async () => {
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
        expect(error.context["limit"]).toBe("revisits");
        expect(outcome.failedStep).toBe("s1");
      }
    });
  });
});
