/**
 * Tests for `core/procedure`'s condition algebra — `evaluateProcedureCondition`
 * exercised in isolation (ADR-0046, issue #474). This is the boundary sibling
 * of `procedure-conditions.test.ts`, split out solely to keep both files
 * under the `check:file-budget` ceiling (ADR-0072): it covers hostile
 * accessors and a malformed root condition, the two boundary-testing blocks
 * of that file's original suite.
 *
 * Contract source: docs/reference/core/procedure.md § Values and references,
 * § Conditions (Explainability — the "Total, never throws" guarantee).
 *
 * Scope: `evaluateProcedureCondition` only, in isolation — no
 * `M3LProcedure`, no `M3LProcedureBuilder`. Sibling spokes cover
 * `procedure.test.ts`, `procedure-build.test.ts` and
 * `procedure-guards.test.ts` concurrently; this file must not overlap them.
 * Shared fixtures (`TestShape`, `DEFAULT_PARAMETERS`, `EMPTY_SCOPE`) are
 * small, deliberate duplicates of `procedure-conditions.test.ts`'s own copies
 * rather than a cross-file import, per this repo's ADR-0072 sibling-file
 * convention.
 */

import { describe, expect, test } from "vitest";

import { evaluateProcedureCondition } from "../src/core/procedure/index.js";
import type {
  M3LProcedureCondition,
  M3LProcedureConditionKind,
  M3LProcedureConditionScope,
  M3LProcedureShape,
  M3LProcedureStepRecord,
} from "../src/core/procedure/index.js";

/** The shared shape every condition in this file is parameterised by. */
interface TestShape extends M3LProcedureShape {
  readonly deps: unknown;
  readonly values: {
    readonly count: number;
    readonly text: string;
    readonly tags: readonly string[];
    readonly flag: boolean;
  };
  readonly parameters: {
    readonly threshold: number;
    readonly label: string;
  };
  readonly conclusion: void;
  readonly stepId: "count-errors" | "sample-traces";
  readonly caseId: "quiet" | "spiking";
}

const DEFAULT_PARAMETERS: TestShape["parameters"] = {
  threshold: 5,
  label: "ok",
};

const EMPTY_SCOPE: M3LProcedureConditionScope<TestShape> = {
  results: {},
  values: {},
  parameters: DEFAULT_PARAMETERS,
};

describe("core/procedure — conditions (boundary)", () => {
  // -------------------------------------------------------------------------
  // hostile accessors — evaluateProcedureCondition is documented "Total —
  // never throws", even when caller-supplied state throws mid-read.
  // -------------------------------------------------------------------------
  describe("hostile accessors", () => {
    /**
     * Asserts the exact degraded shape a hostile-getter read collapses to
     * (`degradedEvaluation()` in `internal/procedure/evaluate.ts`): the
     * caught error's own message is never echoed (it originates from the
     * caller's own object and could carry anything), so only `detail`'s
     * non-emptiness is checked, not its wording.
     */
    function expectDegraded(
      evaluation: ReturnType<typeof evaluateProcedureCondition<TestShape>>,
      expectedKind: M3LProcedureConditionKind,
    ): void {
      expect(evaluation.kind).toBe(expectedKind);
      expect(evaluation.satisfied).toBe(false);
      expect(evaluation.references).toEqual([]);
      expect(evaluation.operands).toEqual([]);
      expect(typeof evaluation.detail).toBe("string");
      expect(evaluation.detail?.length ?? 0).toBeGreaterThan(0);
    }

    test("a hostile getter on values does not throw and degrades to a total, safe evaluation", () => {
      const hostileValues = {
        get count(): never {
          throw new Error("hostile getter fired");
        },
      };
      const scope: M3LProcedureConditionScope<TestShape> = {
        results: {},
        values: hostileValues,
        parameters: DEFAULT_PARAMETERS,
      };
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "compare",
        left: { source: "value", key: "count" },
        operator: "==",
        right: { source: "literal", literal: 0 },
      };
      expect(() =>
        evaluateProcedureCondition<TestShape>(condition, scope),
      ).not.toThrow();
      const evaluation = evaluateProcedureCondition<TestShape>(
        condition,
        scope,
      );
      expectDegraded(evaluation, "compare");
    });

    test("a hostile getter on parameters does not throw and degrades to a total, safe evaluation", () => {
      const hostileParameters = {
        get threshold(): never {
          throw new Error("hostile parameter getter fired");
        },
        label: "ok",
      };
      const scope: M3LProcedureConditionScope<TestShape> = {
        results: {},
        values: {},
        parameters: hostileParameters,
      };
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        subject: { source: "parameter", key: "threshold" },
      };
      expect(() =>
        evaluateProcedureCondition<TestShape>(condition, scope),
      ).not.toThrow();
      const evaluation = evaluateProcedureCondition<TestShape>(
        condition,
        scope,
      );
      expectDegraded(evaluation, "exists");
    });

    test("a hostile getter on a step's recorded output does not throw and degrades to a total, safe evaluation", () => {
      const hostileStepRecord = {
        id: "count-errors",
        label: "Count errors",
        kind: "gather",
        status: "succeeded",
        attempt: 1,
        get output(): never {
          throw new Error("hostile output getter fired");
        },
        note: undefined,
        durationMs: 5,
      };
      const scope: M3LProcedureConditionScope<TestShape> = {
        results: {
          "count-errors":
            hostileStepRecord as unknown as M3LProcedureStepRecord,
        },
        values: {},
        parameters: DEFAULT_PARAMETERS,
      };
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        subject: { source: "step", step: "count-errors" },
      };
      expect(() =>
        evaluateProcedureCondition<TestShape>(condition, scope),
      ).not.toThrow();
      const evaluation = evaluateProcedureCondition<TestShape>(
        condition,
        scope,
      );
      expectDegraded(evaluation, "exists");
    });

    // `evaluateNotNode` (internal/procedure/evaluate.ts) propagates a
    // child's `refused` flag instead of inverting its degraded
    // `satisfied: false` into a fail-open `true`. `degradedEvaluation()`
    // (a hostile-getter throw mid-evaluation) sets `refused: true` on the
    // evaluation it returns, so `not` wrapping a `compare` whose getter
    // throws propagates that refusal rather than fail-opening to
    // `satisfied: true`.
    test("not wrapping a child whose evaluation degrades propagates the refusal instead of inverting it to a fail-open true", () => {
      const hostileValues = {
        get count(): never {
          throw new Error("hostile getter fired");
        },
      };
      const scope: M3LProcedureConditionScope<TestShape> = {
        results: {},
        values: hostileValues,
        parameters: DEFAULT_PARAMETERS,
      };
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "not",
        operand: {
          kind: "compare",
          left: { source: "value", key: "count" },
          operator: ">",
          right: { source: "literal", literal: 5 },
        },
      };
      const evaluation = evaluateProcedureCondition<TestShape>(
        condition,
        scope,
      );
      const degradedCompare = {
        kind: "compare",
        satisfied: false,
        refused: true,
        references: [],
        operands: [],
        detail: "evaluation failed: a value could not be read",
      };
      expect(evaluation).toStrictEqual({
        kind: "not",
        satisfied: false,
        refused: true,
        references: [],
        operands: [degradedCompare],
        detail: "not (evaluation failed: a value could not be read)",
      });
    });
  });

  // -------------------------------------------------------------------------
  // malformed root condition — `evaluateCondition` shape-validates the root
  // node before dispatching, so a root that is not one of the seven
  // recognised kinds degrades to `malformedRootEvaluation()` instead of
  // falling through the exhaustive `switch`'s `default` arm and echoing the
  // raw input back to the caller as if it were a real evaluation.
  // -------------------------------------------------------------------------
  describe("malformed root condition", () => {
    /**
     * Asserts the exact degraded shape `malformedRootEvaluation()` returns
     * (`internal/procedure/evaluate.ts`): unlike a hostile-accessor
     * degradation, this shape is fixed and caller-independent, so every
     * field — including `kind` and `detail`'s exact wording — is pinned.
     */
    function expectMalformedRoot(
      evaluation: ReturnType<typeof evaluateProcedureCondition<TestShape>>,
    ): void {
      expect(evaluation).toStrictEqual({
        kind: "exists",
        satisfied: false,
        refused: true,
        references: [],
        operands: [],
        detail: "condition is malformed (not a recognised node)",
      });
    }

    test("a root with an unrecognised kind does not throw and degrades to the malformed-root evaluation", () => {
      const condition = {
        kind: "bogus",
      } as unknown as M3LProcedureCondition<TestShape>;
      expect(() =>
        evaluateProcedureCondition<TestShape>(condition, EMPTY_SCOPE),
      ).not.toThrow();
      const evaluation = evaluateProcedureCondition<TestShape>(
        condition,
        EMPTY_SCOPE,
      );
      expectMalformedRoot(evaluation);
    });

    test("a root that is not a plain object at all does not throw and degrades to the malformed-root evaluation", () => {
      const condition = null as unknown as M3LProcedureCondition<TestShape>;
      expect(() =>
        evaluateProcedureCondition<TestShape>(condition, EMPTY_SCOPE),
      ).not.toThrow();
      const evaluation = evaluateProcedureCondition<TestShape>(
        condition,
        EMPTY_SCOPE,
      );
      expectMalformedRoot(evaluation);
    });
  });
});
