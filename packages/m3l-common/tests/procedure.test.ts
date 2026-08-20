/**
 * Tests for the `core/procedure` submodule (RED phase — issue #474,
 * ADR-0046). Contract source: `docs/reference/core/procedure.md`.
 *
 * The implementation is a **typed scaffold**: `M3LProcedureBuilder.step`,
 * `.case`, `.build`, `M3LProcedure.describe`/`.run`, and
 * `evaluateProcedureCondition` all throw or reject `M3LError` with code
 * `ERR_PROCEDURE_INVALID_DEFINITION` (see `src/internal/procedure/errors.ts`)
 * — nothing runs yet. Every behavioural test below therefore fails today at
 * the very first `.step()`/`.build()`/`.run()` call it reaches; that is the
 * correct RED reason. Assertions encode the real contract a GREEN pass must
 * satisfy, not the stub's message.
 *
 * The type-level block (§10) is split deliberately: assertions built from
 * bare `expectTypeOf<Type>()` generics and typed object-literal assignments
 * never invoke a scaffold method, so they compile- and runtime-pass today
 * (the type surface is real); the handful that must chain a real builder
 * call to exercise a pending-union constraint (duplicate id, missing
 * fallback) fail at RED for the same "not implemented yet" reason as every
 * other behavioural test.
 *
 * Scope: the engine's core behaviour only — builder chaining/build, step
 * execution/flow directives, copy-on-write context, early resolution, cases
 * and the mandatory fallback, repeated resolve passes, outcome shape,
 * definition digest, statelessness, and the type-level contract. Sibling
 * spokes cover `procedure-build.test.ts`, `procedure-conditions.test.ts`,
 * and `procedure-guards.test.ts` (build-time validation, run-option
 * validation, and condition-evaluation semantics are NOT duplicated here).
 */

import { describe, expect, expectTypeOf, test, vi } from "vitest";

import {
  createProcedureBuilder,
  M3LProcedure,
} from "../src/core/procedure/index.js";
import type {
  M3LProcedureCase,
  M3LProcedureCaseEvaluation,
  M3LProcedureCaseMatch,
  M3LProcedureCondition,
  M3LProcedureContext,
  M3LProcedureFallback,
  M3LProcedureOutcome,
  M3LProcedureReference,
  M3LProcedureRunOptions,
  M3LProcedureShape,
  M3LProcedureStep,
  M3LProcedureStepKind,
  M3LProcedureStepResult,
  M3LProcedureSummary,
} from "../src/core/procedure/index.js";

// ---------------------------------------------------------------------------
// Shared fixture shapes
// ---------------------------------------------------------------------------

interface Shape extends M3LProcedureShape {
  readonly deps: { readonly log: (message: string) => void };
  readonly values: { readonly count: number; readonly label: string };
  // `Record<never, never>`, not `Record<string, never>`: the latter carries a
  // `string` index signature, so `keyof` it is `string` (not `never`) and it
  // would NOT satisfy `M3LProcedureRunOptions`'s
  // `[keyof TShape["parameters"]] extends [never]` optional-parameters check —
  // see the "run options' parameters is optional…" type-level test below.
  readonly parameters: Record<never, never>;
  readonly conclusion: { readonly verdict: string };
  readonly stepId: "gather" | "transform" | "check" | "decide";
  readonly caseId: "primary" | "secondary" | "tertiary";
}

interface ParamShape extends M3LProcedureShape {
  readonly deps: unknown;
  readonly values: Record<string, never>;
  readonly parameters: { readonly threshold: number };
  readonly conclusion: void;
  readonly stepId: "only";
  readonly caseId: "hit";
}

function makeDeps(): Shape["deps"] {
  return { log: vi.fn() };
}

function lit(
  literal: string | number | boolean | null,
): M3LProcedureReference<Shape> {
  return { source: "literal", literal };
}

function valueRef(key: keyof Shape["values"]): M3LProcedureReference<Shape> {
  return { source: "value", key };
}

const TRUE_CONDITION: M3LProcedureCondition<Shape> = {
  kind: "compare",
  left: lit(1),
  operator: "==",
  right: lit(1),
};

const FALSE_CONDITION: M3LProcedureCondition<Shape> = {
  kind: "compare",
  left: lit(1),
  operator: "==",
  right: lit(2),
};

function countAtLeast(threshold: number): M3LProcedureCondition<Shape> {
  return {
    kind: "compare",
    left: valueRef("count"),
    operator: ">=",
    right: lit(threshold),
  };
}

function makeCase<TId extends Shape["caseId"]>(
  id: TId,
  condition: M3LProcedureCondition<Shape>,
  priority: number,
  action?: M3LProcedureCase<Shape, TId>["action"],
): M3LProcedureCase<Shape, TId> {
  return {
    id,
    description: `case ${id}`,
    prose: `prose for ${id}`,
    condition,
    priority,
    action: action ?? ((_ctx, match) => ({ verdict: match.caseId })),
  };
}

function makeFallback(
  action?: M3LProcedureFallback<Shape>["action"],
): M3LProcedureFallback<Shape> {
  return {
    description: "no case matched",
    prose: "Unrecognized evidence.",
    action: action ?? (() => ({ verdict: "unrecognized" })),
  };
}

describe("core/procedure", () => {
  // -------------------------------------------------------------------------
  // 1. builder chaining and build()
  // -------------------------------------------------------------------------
  describe("builder chaining and build()", () => {
    test("createProcedureBuilder returns a builder whose step()/case() chain to build()", async () => {
      const procedure = createProcedureBuilder<Shape>("chain-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", TRUE_CONDITION, 100))
        .case(makeCase("secondary", FALSE_CONDITION, 50))
        .build(makeFallback());

      expect(procedure).toBeInstanceOf(M3LProcedure);
      expect(typeof procedure.digest).toBe("string");
      expect(procedure.digest.length).toBeGreaterThan(0);

      const outcome = await procedure.run({ deps: makeDeps() });
      expect(outcome.digest).toBe(procedure.digest);
    });

    test("describe() returns the exact serialisable projection digest hashes", () => {
      const procedure = createProcedureBuilder<Shape>("describe-fixture")
        .step({
          id: "gather",
          label: "Gather evidence",
          kind: "gather",
          continueOnFailure: true,
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", TRUE_CONDITION, 100))
        .build(makeFallback());

      const summary: M3LProcedureSummary = procedure.describe();

      expect(summary).toMatchObject({
        name: "describe-fixture",
        revision: undefined,
        steps: [
          {
            id: "gather",
            label: "Gather evidence",
            kind: "gather",
            continueOnFailure: true,
            jumpsTo: [],
            loop: undefined,
          },
        ],
        cases: [
          {
            id: "primary",
            description: "case primary",
            prose: "prose for primary",
            priority: 100,
            condition: TRUE_CONDITION,
          },
        ],
        fallback: {
          description: "no case matched",
          prose: "Unrecognized evidence.",
        },
        parameters: [],
      });
    });

    test("M3LProcedureBuildOptions.revision surfaces on describe()", () => {
      const procedure = createProcedureBuilder<Shape>("revision-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback(), { revision: "rev-1" });

      expect(procedure.describe().revision).toBe("rev-1");
    });

    test("declared parameter names surface on describe().parameters", () => {
      const procedure = createProcedureBuilder<ParamShape>("param-fixture")
        .parameters(["threshold"])
        .step({
          id: "only",
          label: "Only step",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case({
          id: "hit",
          description: "hit case",
          prose: "prose",
          condition: {
            kind: "compare",
            left: { source: "parameter", key: "threshold" },
            operator: ">=",
            right: { source: "literal", literal: 0 },
          },
          priority: 1,
          action: () => undefined,
        })
        .build({
          description: "fallback",
          prose: "prose",
          action: () => undefined,
        });

      expect(procedure.describe().parameters).toEqual(["threshold"]);
    });
  });

  // -------------------------------------------------------------------------
  // 2. step execution and flow directives
  // -------------------------------------------------------------------------
  describe("step execution and flow directives", () => {
    test('"continue" advances steps in declaration order', async () => {
      const order: string[] = [];
      const executeA = vi.fn((): M3LProcedureStepResult<Shape> => {
        order.push("gather");
        return { flow: "continue" };
      });
      const executeB = vi.fn((): M3LProcedureStepResult<Shape> => {
        order.push("transform");
        return { flow: "continue" };
      });
      const executeC = vi.fn((): M3LProcedureStepResult<Shape> => {
        order.push("check");
        return { flow: "continue" };
      });

      const procedure = createProcedureBuilder<Shape>("order-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: executeA,
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: executeB,
        })
        .step({ id: "check", label: "Check", kind: "check", execute: executeC })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      await procedure.run({ deps: makeDeps() });

      expect(order).toEqual(["gather", "transform", "check"]);
      expect(executeA).toHaveBeenCalledTimes(1);
      expect(executeB).toHaveBeenCalledTimes(1);
      expect(executeC).toHaveBeenCalledTimes(1);
    });

    test('"stop" leaves phase 1 immediately for case evaluation', async () => {
      const executeB = vi.fn((): M3LProcedureStepResult<Shape> => ({
        flow: "continue",
      }));

      const procedure = createProcedureBuilder<Shape>("stop-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (): M3LProcedureStepResult<Shape> => ({ flow: "stop" }),
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: executeB,
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(executeB).toHaveBeenCalledTimes(0);
      expect(outcome.status).toBe("matched");
    });

    test('"{ goTo }" jumps to the named step, skipping the ones in between', async () => {
      const executeSkipped = vi.fn((): M3LProcedureStepResult<Shape> => ({
        flow: "continue",
      }));
      const executeTarget = vi.fn((): M3LProcedureStepResult<Shape> => ({
        flow: "continue",
      }));

      const procedure = createProcedureBuilder<Shape>("goto-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          jumpsTo: ["check"] as const,
          execute: (): M3LProcedureStepResult<Shape, "check"> => ({
            flow: { goTo: "check" },
          }),
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: executeSkipped,
        })
        .step({
          id: "check",
          label: "Check",
          kind: "check",
          execute: executeTarget,
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      await procedure.run({ deps: makeDeps() });

      expect(executeSkipped).toHaveBeenCalledTimes(0);
      expect(executeTarget).toHaveBeenCalledTimes(1);
    });

    test('phase 1 also ends when the last declared step returns "continue"', async () => {
      const procedure = createProcedureBuilder<Shape>("last-continue-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.telemetry.steps).toHaveLength(2);
      expect(outcome.status).toBe("matched");
    });

    test("a Promise-returning execute is awaited before the engine advances", async () => {
      const executeB = vi.fn(
        (ctx: M3LProcedureContext<Shape>): M3LProcedureStepResult<Shape> => ({
          flow: "continue",
          output: (ctx.results.gather?.output as number | undefined) ?? -1,
        }),
      );

      const procedure = createProcedureBuilder<Shape>("async-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (): Promise<M3LProcedureStepResult<Shape>> =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve({ flow: "continue", output: 42 });
              }, 0);
            }),
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: executeB,
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      await procedure.run({ deps: makeDeps() });

      expect(executeB).toHaveBeenCalledTimes(1);
      const receivedContext = executeB.mock.calls[0]?.[0];
      expect(receivedContext?.results.gather?.output).toBe(42);
    });
  });

  // -------------------------------------------------------------------------
  // 3. copy-on-write context
  // -------------------------------------------------------------------------
  describe("copy-on-write context", () => {
    test("each step receives a distinct, unchanged-in-place context object", async () => {
      const contexts: M3LProcedureContext<Shape>[] = [];
      const capture = (
        ctx: M3LProcedureContext<Shape>,
      ): M3LProcedureStepResult<Shape> => {
        contexts.push(ctx);
        return { flow: "continue" };
      };

      const procedure = createProcedureBuilder<Shape>("cow-identity-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: capture,
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: capture,
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      await procedure.run({ deps: makeDeps() });

      expect(contexts).toHaveLength(2);
      expect(contexts[0]).not.toBe(contexts[1]);
      // The object step 1 held is unchanged after step 2 ran.
      const snapshotAfterStep1: unknown = JSON.parse(
        JSON.stringify(contexts[0]?.values),
      );
      expect(contexts[0]?.values).toEqual(snapshotAfterStep1);
    });

    test("the context and its containers are frozen while deps is not and stays the same reference", async () => {
      const deps = makeDeps();
      const contexts: M3LProcedureContext<Shape>[] = [];
      const capture = (
        ctx: M3LProcedureContext<Shape>,
      ): M3LProcedureStepResult<Shape> => {
        contexts.push(ctx);
        return { flow: "continue" };
      };

      const procedure = createProcedureBuilder<Shape>("cow-frozen-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: capture,
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: capture,
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      await procedure.run({ deps });

      for (const ctx of contexts) {
        expect(Object.isFrozen(ctx)).toBe(true);
        expect(Object.isFrozen(ctx.results)).toBe(true);
        expect(Object.isFrozen(ctx.values)).toBe(true);
        expect(Object.isFrozen(ctx.parameters)).toBe(true);
        expect(Object.isFrozen(ctx.recovered)).toBe(true);
        expect(Object.isFrozen(ctx.deps)).toBe(false);
        expect(ctx.deps).toBe(deps);
      }
    });

    test("a values patch merges shallowly, last-write-wins, omitted keys untouched", async () => {
      const seenValues: Readonly<Partial<Shape["values"]>>[] = [];
      const capture = (ctx: M3LProcedureContext<Shape>): void => {
        seenValues.push(ctx.values);
      };

      const procedure = createProcedureBuilder<Shape>("cow-merge-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (ctx): M3LProcedureStepResult<Shape> => {
            capture(ctx);
            return { flow: "continue", values: { count: 1, label: "a" } };
          },
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: (ctx): M3LProcedureStepResult<Shape> => {
            capture(ctx);
            return { flow: "continue", values: { count: 2 } };
          },
        })
        .step({
          id: "check",
          label: "Check",
          kind: "check",
          execute: (ctx): M3LProcedureStepResult<Shape> => {
            capture(ctx);
            return { flow: "continue" };
          },
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      await procedure.run({ deps: makeDeps() });

      expect(seenValues[0]).toEqual({});
      expect(seenValues[1]).toEqual({ count: 1, label: "a" });
      expect(seenValues[2]).toEqual({ count: 2, label: "a" });
    });

    test("results[id] holds the returned output and iteration counts prior executions", async () => {
      const iterations: number[] = [];
      const procedure = createProcedureBuilder<Shape>("cow-results-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (ctx): M3LProcedureStepResult<Shape> => {
            iterations.push(ctx.iteration);
            return { flow: "continue", output: 7 };
          },
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: (ctx): M3LProcedureStepResult<Shape> => {
            iterations.push(ctx.iteration);
            expect(ctx.results.gather?.output).toBe(7);
            return { flow: "continue" };
          },
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      await procedure.run({ deps: makeDeps() });

      expect(iterations).toEqual([0, 1]);
    });

    test("run()'s initialValues seeds the first step's context.values", async () => {
      let firstLabel: string | undefined;
      const procedure = createProcedureBuilder<Shape>("cow-initial-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (ctx): M3LProcedureStepResult<Shape> => {
            firstLabel = ctx.values.label;
            return { flow: "continue" };
          },
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      await procedure.run({
        deps: makeDeps(),
        initialValues: { label: "seed" },
      });

      expect(firstLabel).toBe("seed");
    });

    test("parameters are constant for the whole run", async () => {
      const seenThresholds: number[] = [];
      const procedure = createProcedureBuilder<ParamShape>(
        "cow-parameters-fixture",
      )
        .parameters(["threshold"])
        .step({
          id: "only",
          label: "Only",
          kind: "gather",
          execute: (ctx): M3LProcedureStepResult<ParamShape> => {
            seenThresholds.push(ctx.parameters.threshold);
            return { flow: "continue" };
          },
        })
        .case({
          id: "hit",
          description: "hit",
          prose: "prose",
          condition: {
            kind: "compare",
            left: { source: "parameter", key: "threshold" },
            operator: ">=",
            right: { source: "literal", literal: 0 },
          },
          priority: 1,
          action: (ctx): void => {
            seenThresholds.push(ctx.parameters.threshold);
          },
        })
        .build({
          description: "fallback",
          prose: "prose",
          action: () => undefined,
        });

      await procedure.run({ deps: undefined, parameters: { threshold: 5 } });

      expect(seenThresholds.every((value) => value === 5)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 4. early resolution
  // -------------------------------------------------------------------------
  describe("early resolution", () => {
    test('a matching "resolve" terminates the run before later steps execute', async () => {
      const laterExecute = vi.fn((): M3LProcedureStepResult<Shape> => ({
        flow: "continue",
      }));

      const procedure = createProcedureBuilder<Shape>("resolve-match-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "resolve",
            values: { count: 10 },
          }),
        })
        .step({
          id: "transform",
          label: "Transform (expensive)",
          kind: "transform",
          execute: laterExecute,
        })
        .case(makeCase("primary", countAtLeast(5), 100))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(laterExecute).toHaveBeenCalledTimes(0);
      expect(outcome.status).toBe("matched");
    });

    test('a non-matching "resolve" continues exactly as "continue" would', async () => {
      const laterExecute = vi.fn((): M3LProcedureStepResult<Shape> => ({
        flow: "continue",
      }));

      const procedure = createProcedureBuilder<Shape>(
        "resolve-no-match-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "resolve",
            values: { count: 0 },
          }),
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: laterExecute,
        })
        .case(makeCase("primary", countAtLeast(5), 100))
        .build(makeFallback());

      await procedure.run({ deps: makeDeps() });

      expect(laterExecute).toHaveBeenCalledTimes(1);
    });

    test("resolveChecks counts every all-case pass a resolve triggered", async () => {
      const procedure = createProcedureBuilder<Shape>("resolve-count-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "resolve",
            values: { count: 0 },
          }),
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "resolve",
            values: { count: 0 },
          }),
        })
        .step({
          id: "check",
          label: "Check",
          kind: "check",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "resolve",
            values: { count: 10 },
          }),
        })
        .case(makeCase("primary", countAtLeast(5), 100))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.telemetry.resolveChecks).toBe(3);
    });

    test('a "resolve" on the last declared step still concludes the run', async () => {
      const procedure = createProcedureBuilder<Shape>(
        "resolve-last-step-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "resolve",
            values: { count: 10 },
          }),
        })
        .case(makeCase("primary", countAtLeast(5), 100))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.status).toBe("matched");
    });

    test("earlyResolved is true even when the last declared step is the one returning resolve", async () => {
      const procedure = createProcedureBuilder<Shape>(
        "resolve-last-step-flag-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "resolve",
            values: { count: 10 },
          }),
        })
        .case(makeCase("primary", countAtLeast(5), 100))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.telemetry.earlyResolved).toBe(true);
    });

    test("earlyResolved is false when the concluding pass is the ordinary end-of-phase-1 evaluation", async () => {
      const procedure = createProcedureBuilder<Shape>(
        "resolve-flag-false-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "continue",
            values: { count: 10 },
          }),
        })
        .case(makeCase("primary", countAtLeast(5), 100))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.telemetry.earlyResolved).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 5. cases and the mandatory fallback
  // -------------------------------------------------------------------------
  describe("cases and the mandatory fallback", () => {
    test("every case is evaluated with no short-circuit; descending priority selects the primary, the rest land in alsoMatched", async () => {
      const procedure = createProcedureBuilder<Shape>("cases-priority-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue", values: { count: 10 } }),
        })
        .case(makeCase("primary", countAtLeast(5), 300))
        .case(makeCase("secondary", countAtLeast(1), 200))
        .case(makeCase("tertiary", FALSE_CONDITION, 100))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.status).toBe("matched");
      if (outcome.status === "matched") {
        expect(outcome.primary.caseId).toBe("primary");
        expect(outcome.alsoMatched.map((match) => match.caseId)).toEqual([
          "secondary",
        ]);
      }
    });

    test("no case matching yields unrecognized, with investigated holding one entry per case", async () => {
      const procedure = createProcedureBuilder<Shape>(
        "cases-unrecognized-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", FALSE_CONDITION, 200))
        .case(makeCase("secondary", FALSE_CONDITION, 100))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.status).toBe("unrecognized");
      if (outcome.status === "unrecognized") {
        expect(outcome.investigated).toHaveLength(2);
        expect(outcome.investigated.map((entry) => entry.caseId)).toEqual([
          "primary",
          "secondary",
        ]);
        expect(outcome.conclusion).toEqual({ verdict: "unrecognized" });
      }
    });

    test("a case action receives (context, match) with a provably-satisfied evaluation", async () => {
      const action = vi.fn(
        (
          _ctx: M3LProcedureContext<Shape>,
          match: M3LProcedureCaseMatch<Shape>,
        ) => ({
          verdict: match.caseId,
        }),
      );

      const procedure = createProcedureBuilder<Shape>(
        "case-action-args-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", TRUE_CONDITION, 1, action))
        .build(makeFallback());

      await procedure.run({ deps: makeDeps() });

      expect(action).toHaveBeenCalledTimes(1);
      const match = action.mock.calls[0]?.[1];
      expect(match?.caseId).toBe("primary");
      expect(match?.evaluation.satisfied).toBe(true);
    });

    test("the fallback action receives (context, investigated)", async () => {
      const fallbackAction = vi.fn(
        (
          _ctx: M3LProcedureContext<Shape>,
          _investigated: readonly M3LProcedureCaseEvaluation<Shape>[],
        ) => ({ verdict: "unrecognized" }),
      );

      const procedure = createProcedureBuilder<Shape>("fallback-args-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", FALSE_CONDITION, 1))
        .build(makeFallback(fallbackAction));

      await procedure.run({ deps: makeDeps() });

      expect(fallbackAction).toHaveBeenCalledTimes(1);
      const investigated = fallbackAction.mock.calls[0]?.[1];
      expect(investigated).toHaveLength(1);
      expect(investigated?.[0]?.caseId).toBe("primary");
    });

    test("a throw from a case action propagates unmodified rather than becoming unrecognized", async () => {
      const thrown = new Error("case action boom");
      const procedure = createProcedureBuilder<Shape>("case-throw-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case(
          makeCase("primary", TRUE_CONDITION, 1, () => {
            throw thrown;
          }),
        )
        .build(makeFallback());

      await expect(procedure.run({ deps: makeDeps() })).rejects.toBe(thrown);
    });

    test("a throw from the fallback action propagates unmodified rather than becoming unrecognized", async () => {
      const thrown = new Error("fallback boom");
      const procedure = createProcedureBuilder<Shape>("fallback-throw-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", FALSE_CONDITION, 1))
        .build(
          makeFallback(() => {
            throw thrown;
          }),
        );

      await expect(procedure.run({ deps: makeDeps() })).rejects.toBe(thrown);
    });
  });

  // -------------------------------------------------------------------------
  // 6. repeated resolve passes
  // -------------------------------------------------------------------------
  describe("repeated resolve passes", () => {
    test("investigated reports only the final pass (one entry per case)", async () => {
      const procedure = createProcedureBuilder<Shape>(
        "repeated-resolve-investigated-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "resolve",
            values: { count: 0 },
          }),
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "continue",
            values: { count: 10 },
          }),
        })
        .case(makeCase("primary", countAtLeast(5), 100))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.status).toBe("matched");
      if (outcome.status === "matched") {
        expect(outcome.primary.evaluation.satisfied).toBe(true);
      }
    });

    test("alsoMatched reflects only the concluding pass", async () => {
      const procedure = createProcedureBuilder<Shape>(
        "repeated-resolve-also-matched-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          // First resolve pass: count=3 satisfies neither "primary" (>=10) nor
          // "secondary" (>=5). A matching "resolve" pass terminates the run
          // early (see 'a matching "resolve" terminates the run before later
          // steps execute' above), so this pass MUST match nothing, or
          // `transform` would never run and this test would prove nothing
          // about which pass gets reported.
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "resolve",
            values: { count: 3 },
          }),
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          // Second (concluding) pass: count=12 satisfies BOTH cases, so this
          // is the pass whose alsoMatched must be reported — the first
          // pass's non-match must not leak into it.
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "resolve",
            values: { count: 12 },
          }),
        })
        .case(makeCase("primary", countAtLeast(10), 200))
        .case(makeCase("secondary", countAtLeast(5), 100))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.status).toBe("matched");
      if (outcome.status === "matched") {
        expect(outcome.primary.caseId).toBe("primary");
        expect(outcome.alsoMatched.map((match) => match.caseId)).toEqual([
          "secondary",
        ]);
      }
    });

    test("resolveChecks counts every pass, whether or not it matched", async () => {
      const procedure = createProcedureBuilder<Shape>(
        "repeated-resolve-count-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "resolve",
            values: { count: 0 },
          }),
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "resolve",
            values: { count: 0 },
          }),
        })
        .step({
          id: "check",
          label: "Check",
          kind: "check",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "continue",
            values: { count: 10 },
          }),
        })
        .case(makeCase("primary", countAtLeast(5), 100))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.telemetry.resolveChecks).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 7. outcome shape
  // -------------------------------------------------------------------------
  describe("outcome shape", () => {
    function buildSimpleFixture(name: string): M3LProcedure<Shape> {
      return createProcedureBuilder<Shape>(name)
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());
    }

    test("every arm carries digest, parametersDigest, trace and telemetry", async () => {
      const procedure = buildSimpleFixture("outcome-common-fixture");
      const outcome = await procedure.run({ deps: makeDeps() });

      expect(typeof outcome.digest).toBe("string");
      expect(typeof outcome.parametersDigest).toBe("string");
      expect(Array.isArray(outcome.trace)).toBe(true);
      expect(outcome.telemetry).toBeDefined();
    });

    test("alsoMatched is a readonly [] on the non-matched arms, readable without narrowing", async () => {
      const procedure = createProcedureBuilder<Shape>(
        "outcome-unrecognized-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", FALSE_CONDITION, 1))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.alsoMatched.length).toBe(0);
    });

    test("telemetry.startedAt is an ISO-8601 timestamp", async () => {
      const procedure = buildSimpleFixture("outcome-started-at-fixture");
      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.telemetry.startedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
      );
    });

    test("stepsSkipped counts declared steps never reached via an early resolve", async () => {
      const procedure = createProcedureBuilder<Shape>(
        "outcome-skipped-resolve-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (): M3LProcedureStepResult<Shape> => ({
            flow: "resolve",
            values: { count: 10 },
          }),
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: () => ({ flow: "continue" }),
        })
        .step({
          id: "check",
          label: "Check",
          kind: "check",
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", countAtLeast(5), 1))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.telemetry.stepsSkipped).toBe(2);
    });

    test('stepsSkipped counts declared steps never reached via "stop"', async () => {
      const procedure = createProcedureBuilder<Shape>(
        "outcome-skipped-stop-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (): M3LProcedureStepResult<Shape> => ({ flow: "stop" }),
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: () => ({ flow: "continue" }),
        })
        .step({
          id: "check",
          label: "Check",
          kind: "check",
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.telemetry.stepsSkipped).toBe(2);
    });

    test("stepsSkipped counts a declared step skipped by a forward goTo", async () => {
      const procedure = createProcedureBuilder<Shape>(
        "outcome-skipped-goto-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          jumpsTo: ["check"] as const,
          execute: (): M3LProcedureStepResult<Shape, "check"> => ({
            flow: { goTo: "check" },
          }),
        })
        .step({
          id: "transform",
          label: "Transform",
          kind: "transform",
          execute: () => ({ flow: "continue" }),
        })
        .step({
          id: "check",
          label: "Check",
          kind: "check",
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.telemetry.stepsSkipped).toBe(1);
    });

    test("durationMs is non-negative and terminatedAt names the concluding step", async () => {
      const procedure = buildSimpleFixture("outcome-duration-fixture");
      const outcome = await procedure.run({ deps: makeDeps() });

      expect(outcome.telemetry.durationMs).toBeGreaterThanOrEqual(0);
      expect(outcome.telemetry.terminatedAt).toBe("gather");
    });
  });

  // -------------------------------------------------------------------------
  // 8. definition digest
  // -------------------------------------------------------------------------
  describe("definition digest", () => {
    interface DigestOverrides {
      readonly stepKind?: M3LProcedureStepKind;
      readonly priority?: number;
      readonly condition?: M3LProcedureCondition<Shape>;
      readonly revision?: string;
    }

    function buildDigestFixture(
      overrides: DigestOverrides = {},
    ): M3LProcedure<Shape> {
      return createProcedureBuilder<Shape>("digest-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: overrides.stepKind ?? "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case(
          makeCase(
            "primary",
            overrides.condition ?? TRUE_CONDITION,
            overrides.priority ?? 100,
            () => ({ verdict: "primary" }),
          ),
        )
        .build(
          makeFallback(),
          overrides.revision !== undefined
            ? { revision: overrides.revision }
            : undefined,
        );
    }

    test("digest is stable across two builds of the same definition", () => {
      const a = buildDigestFixture();
      const b = buildDigestFixture();

      expect(a.digest).toBe(b.digest);
    });

    test.each([
      ["case priority", { priority: 999 }],
      ["case condition", { condition: FALSE_CONDITION }],
      ["step kind", { stepKind: "check" as const }],
    ])(
      "digest moves when %s changes",
      (_label: string, overrides: DigestOverrides) => {
        const baseline = buildDigestFixture();
        const mutated = buildDigestFixture(overrides);

        expect(mutated.digest).not.toBe(baseline.digest);
      },
    );

    test("digest moves when a case's prose changes", () => {
      const baseline = createProcedureBuilder<Shape>("digest-prose-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case({
          id: "primary",
          description: "d",
          prose: "prose one",
          condition: TRUE_CONDITION,
          priority: 1,
          action: () => ({ verdict: "primary" }),
        })
        .build(makeFallback());
      const mutated = createProcedureBuilder<Shape>("digest-prose-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case({
          id: "primary",
          description: "d",
          prose: "prose two",
          condition: TRUE_CONDITION,
          priority: 1,
          action: () => ({ verdict: "primary" }),
        })
        .build(makeFallback());

      expect(mutated.digest).not.toBe(baseline.digest);
    });

    test("digest does NOT move when only a handler body changes (documented limit)", () => {
      const a = createProcedureBuilder<Shape>("digest-handler-body-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case(
          makeCase("primary", TRUE_CONDITION, 1, () => ({
            verdict: "primary",
          })),
        )
        .build(makeFallback());
      const b = createProcedureBuilder<Shape>("digest-handler-body-fixture")
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => {
            throw new Error("an entirely different handler body");
          },
        })
        .case(
          makeCase("primary", TRUE_CONDITION, 1, () => ({
            verdict: "totally different",
          })),
        )
        .build(makeFallback());

      expect(a.digest).toBe(b.digest);
    });

    test("digest moves with revision", () => {
      const a = buildDigestFixture({ revision: "r1" });
      const b = buildDigestFixture({ revision: "r2" });

      expect(a.digest).not.toBe(b.digest);
    });

    test("digest is identical under object-key-order permutation", () => {
      const conditionOrderA: M3LProcedureCondition<Shape> = {
        kind: "compare",
        left: lit(1),
        operator: "==",
        right: lit(1),
      };
      const conditionOrderB = {
        right: lit(1),
        operator: "==",
        left: lit(1),
        kind: "compare",
      } as M3LProcedureCondition<Shape>;

      const a = buildDigestFixture({ condition: conditionOrderA });
      const b = buildDigestFixture({ condition: conditionOrderB });

      expect(a.digest).toBe(b.digest);
    });

    test("parametersDigest moves with run parameters while digest does not", async () => {
      const procedure = createProcedureBuilder<ParamShape>(
        "digest-parameters-fixture",
      )
        .parameters(["threshold"])
        .step({
          id: "only",
          label: "Only",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case({
          id: "hit",
          description: "hit",
          prose: "prose",
          condition: {
            kind: "compare",
            left: { source: "parameter", key: "threshold" },
            operator: ">=",
            right: { source: "literal", literal: 0 },
          },
          priority: 1,
          action: () => undefined,
        })
        .build({
          description: "fallback",
          prose: "prose",
          action: () => undefined,
        });

      const outcomeLow = await procedure.run({
        deps: undefined,
        parameters: { threshold: 5 },
      });
      const outcomeHigh = await procedure.run({
        deps: undefined,
        parameters: { threshold: 10 },
      });

      expect(outcomeLow.digest).toBe(outcomeHigh.digest);
      expect(outcomeLow.parametersDigest).not.toBe(
        outcomeHigh.parametersDigest,
      );
    });

    test("the same digest appears on every outcome arm", async () => {
      const procedure = createProcedureBuilder<Shape>(
        "digest-every-arm-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        })
        .case(makeCase("primary", countAtLeast(5), 1))
        .build(makeFallback());

      const matched = await procedure.run({
        deps: makeDeps(),
        initialValues: { count: 10 },
      });
      const unrecognized = await procedure.run({
        deps: makeDeps(),
        initialValues: { count: 0 },
      });

      expect(matched.digest).toBe(procedure.digest);
      expect(unrecognized.digest).toBe(procedure.digest);
    });
  });

  // -------------------------------------------------------------------------
  // 9. statelessness across runs
  // -------------------------------------------------------------------------
  describe("statelessness across runs", () => {
    test("sequential runs with different deps/parameters leak nothing between them", async () => {
      const seenLogs: string[] = [];
      const procedure = createProcedureBuilder<Shape>(
        "stateless-sequential-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: (ctx): M3LProcedureStepResult<Shape> => {
            ctx.deps.log(`values:${JSON.stringify(ctx.values)}`);
            seenLogs.push(JSON.stringify(ctx.values));
            return { flow: "continue" };
          },
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      const firstOutcome = await procedure.run({
        deps: makeDeps(),
        initialValues: { count: 1 },
      });
      const secondOutcome = await procedure.run({
        deps: makeDeps(),
        initialValues: { count: 2 },
      });

      expect(seenLogs[0]).toBe(JSON.stringify({ count: 1 }));
      expect(seenLogs[1]).toBe(JSON.stringify({ count: 2 }));
      expect(firstOutcome.telemetry.steps).not.toBe(
        secondOutcome.telemetry.steps,
      );
      expect(secondOutcome.telemetry.recovered).toEqual([]);
    });

    test("two concurrent run() calls interleave without sharing context", async () => {
      let releaseFirst: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const procedure = createProcedureBuilder<Shape>(
        "stateless-concurrent-fixture",
      )
        .step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: async (ctx): Promise<M3LProcedureStepResult<Shape>> => {
            if (ctx.values.label === "first") {
              await gate;
            }
            const label = ctx.values.label;
            return {
              flow: "continue",
              ...(label !== undefined ? { output: label } : {}),
              values: label !== undefined ? { label } : {},
            };
          },
        })
        .case(makeCase("primary", TRUE_CONDITION, 1))
        .build(makeFallback());

      const firstRun = procedure.run({
        deps: makeDeps(),
        initialValues: { label: "first" },
      });
      const secondRun = procedure.run({
        deps: makeDeps(),
        initialValues: { label: "second" },
      });

      releaseFirst();
      const [firstOutcome, secondOutcome] = await Promise.all([
        firstRun,
        secondRun,
      ]);

      expect(firstOutcome.telemetry.steps[0]?.output).not.toBe(
        secondOutcome.telemetry.steps[0]?.output,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 10. type-level contract
  // -------------------------------------------------------------------------
  describe("type-level contract", () => {
    // These assertions never invoke a scaffold method — pure `expectTypeOf<Type>()`
    // generics and typed object-literal assignments — so they compile- and
    // runtime-pass today; the type surface is real even though the runtime
    // bodies are stubs.

    test("run() resolves M3LProcedureOutcome<TShape>", () => {
      expectTypeOf<ReturnType<M3LProcedure<Shape>["run"]>>().toEqualTypeOf<
        Promise<M3LProcedureOutcome<Shape>>
      >();
    });

    test("narrowing on status exposes the arm-specific fields", () => {
      expectTypeOf<
        Extract<M3LProcedureOutcome<Shape>, { status: "matched" }>
      >().toHaveProperty("primary");
      expectTypeOf<
        Extract<M3LProcedureOutcome<Shape>, { status: "unrecognized" }>
      >().toHaveProperty("investigated");
      expectTypeOf<
        Extract<M3LProcedureOutcome<Shape>, { status: "failed" }>
      >().toHaveProperty("failedStep");
    });

    test("conclusion is unreachable on the failed and aborted arms", () => {
      expectTypeOf<
        Extract<M3LProcedureOutcome<Shape>, { status: "failed" }>
      >().not.toHaveProperty("conclusion");
      expectTypeOf<
        Extract<M3LProcedureOutcome<Shape>, { status: "aborted" }>
      >().not.toHaveProperty("conclusion");
    });

    test("M3LProcedureCaseMatch's evaluation.satisfied is the literal true, not boolean", () => {
      expectTypeOf<
        M3LProcedureCaseMatch<Shape>["evaluation"]["satisfied"]
      >().toEqualTypeOf<true>();
    });

    test("context.deps is TShape['deps'], never widened to unknown or any", () => {
      expectTypeOf<M3LProcedureContext<Shape>["deps"]>().toEqualTypeOf<
        Shape["deps"]
      >();
    });

    test("run options' parameters is optional when the shape declares none, required otherwise", () => {
      const withoutParams: M3LProcedureRunOptions<Shape> = { deps: makeDeps() };
      expect(withoutParams.parameters).toBeUndefined();

      // @ts-expect-error - ParamShape declares `threshold`, so `parameters` is required.
      const missingParams: M3LProcedureRunOptions<ParamShape> = {
        deps: undefined,
      };
      void missingParams;

      const withParams: M3LProcedureRunOptions<ParamShape> = {
        deps: undefined,
        parameters: { threshold: 5 },
      };
      expect(withParams.parameters).toEqual({ threshold: 5 });
    });

    test("a step declaring no jumpsTo cannot return a { goTo } flow", () => {
      const step: M3LProcedureStep<Shape, "gather"> = {
        id: "gather",
        label: "Gather",
        kind: "gather",
        execute: () => ({
          // @ts-expect-error - TJump defaults to never; { goTo } is uninhabited without jumpsTo.
          flow: { goTo: "transform" },
        }),
      };
      expect(step.id).toBe("gather");
    });

    // These two necessarily chain a real builder call to exercise a
    // pending-union constraint, so — like every other behavioural test in
    // this file — they fail at RED via the scaffold's "not implemented yet"
    // throw, not a type error.

    test("re-adding a declared step id or case id does not compile", () => {
      const afterGather = createProcedureBuilder<Shape>("dup-fixture").step({
        id: "gather",
        label: "Gather",
        kind: "gather",
        execute: () => ({ flow: "continue" }),
      });
      afterGather.step({
        // @ts-expect-error - "gather" is no longer in the pending-steps union.
        id: "gather",
        label: "Gather again",
        kind: "gather",
        execute: () => ({ flow: "continue" }),
      });

      const afterPrimary = createProcedureBuilder<Shape>(
        "dup-case-fixture",
      ).case(makeCase("primary", TRUE_CONDITION, 1));
      // @ts-expect-error - "primary" is no longer in the pending-cases union.
      afterPrimary.case(makeCase("primary", FALSE_CONDITION, 2));
    });

    test("build() with no fallback argument does not compile", () => {
      // Wrapped in a never-invoked function: `build()` throws at runtime when
      // the fallback is genuinely missing, so calling it for real — even
      // past a `@ts-expect-error` — would fail this test for the wrong
      // reason. `tsc` still type-checks an uncalled function body in full,
      // which is all a `@ts-expect-error` needs (see `procedure-build.test.ts`'s
      // matching "[type-level] build() without a fallback does not compile").
      function typeOnly(): void {
        const builder = createProcedureBuilder<Shape>(
          "no-fallback-fixture",
        ).step({
          id: "gather",
          label: "Gather",
          kind: "gather",
          execute: () => ({ flow: "continue" }),
        });
        // @ts-expect-error - fallback is a required positional argument to build().
        builder.build();
      }
      expect(typeof typeOnly).toBe("function");
    });
  });
});
