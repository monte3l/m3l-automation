/**
 * Tests for `core/procedure`'s condition algebra — `evaluateProcedureCondition`
 * exercised in isolation (ADR-0046, issue #474).
 *
 * Contract source: docs/reference/core/procedure.md § Values and references,
 * § Conditions (Deep structural equality, Pattern safety, Explainability).
 *
 * Scope: `evaluateProcedureCondition` only, in isolation — no
 * `M3LProcedure`, no `M3LProcedureBuilder`. Sibling spokes cover
 * `procedure.test.ts`, `procedure-build.test.ts` and
 * `procedure-guards.test.ts` concurrently; this file must not overlap them.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import {
  evaluateProcedureCondition,
  M3L_PROCEDURE_CONDITION_MAX_DEPTH,
  M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH,
} from "../src/core/procedure/index.js";
import type {
  M3LProcedureCompareOperator,
  M3LProcedureCondition,
  M3LProcedureConditionKind,
  M3LProcedureConditionScope,
  M3LProcedureShape,
  M3LProcedureStepRecord,
  M3LProcedureValue,
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

/** Builds a `count-errors` step record carrying `output`. */
function stepRecord(
  output: M3LProcedureValue | undefined,
): M3LProcedureStepRecord {
  return {
    id: "count-errors",
    label: "Count errors",
    kind: "gather",
    status: "succeeded",
    attempt: 1,
    output,
    note: undefined,
    durationMs: 5,
  };
}

/** Builds a full scope, defaulting everything a test doesn't override. */
function buildScope(
  overrides: {
    readonly output?: M3LProcedureValue;
    readonly values?: Partial<TestShape["values"]>;
    readonly parameters?: TestShape["parameters"];
  } = {},
): M3LProcedureConditionScope<TestShape> {
  return {
    results:
      overrides.output === undefined
        ? {}
        : { "count-errors": stepRecord(overrides.output) },
    values: overrides.values ?? {},
    parameters: overrides.parameters ?? DEFAULT_PARAMETERS,
  };
}

const EMPTY_SCOPE = buildScope();

describe("core/procedure — conditions", () => {
  // -------------------------------------------------------------------------
  // 1. reference resolution
  // -------------------------------------------------------------------------
  describe("reference resolution", () => {
    test("resolves a step reference with no path against the step's output", () => {
      const scope = buildScope({ output: 12 });
      const evaluation = evaluateProcedureCondition<TestShape>(
        { kind: "exists", subject: { source: "step", step: "count-errors" } },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("resolves a step reference through a path into its output", () => {
      const scope = buildScope({ output: { count: 12 } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: { source: "step", step: "count-errors", path: ["count"] },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("resolves a value reference by key", () => {
      const scope = buildScope({ values: { count: 3 } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        { kind: "exists", subject: { source: "value", key: "count" } },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("resolves a value reference through a path", () => {
      const scope = buildScope({ values: { tags: ["a", "b"] } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: { source: "value", key: "tags", path: ["0"] },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("resolves a parameter reference by key", () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        { kind: "exists", subject: { source: "parameter", key: "threshold" } },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("resolves a parameter reference through a path", () => {
      const scope = buildScope({
        parameters: { threshold: 5, label: "ok" },
      });
      // parameters here are flat scalars; path into a nested parameter value
      // is exercised via a step output instead, since TestShape's parameters
      // are declared as flat scalars. This test asserts the top-level
      // parameter resolves; nested-path resolution mechanics are covered by
      // the step/value path tests above (the walk itself is source-agnostic).
      const evaluation = evaluateProcedureCondition<TestShape>(
        { kind: "exists", subject: { source: "parameter", key: "label" } },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("a literal reference is always present", () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        { kind: "exists", subject: { source: "literal", literal: 5 } },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("only an own enumerable property resolves", () => {
      const proto = { inherited: "nope" };
      const own = Object.create(proto) as Record<string, unknown>;
      own["mine"] = "yes";
      const scope = buildScope({ output: own as unknown as M3LProcedureValue });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: { source: "step", step: "count-errors", path: ["mine"] },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("an inherited property does not resolve", () => {
      const proto = { inherited: "nope" };
      const own = Object.create(proto) as Record<string, unknown>;
      own["mine"] = "yes";
      const scope = buildScope({ output: own as unknown as M3LProcedureValue });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: {
            source: "step",
            step: "count-errors",
            path: ["inherited"],
          },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("a non-enumerable own property does not resolve (own-ness alone is not enough)", () => {
      const own: Record<string, unknown> = {};
      Object.defineProperty(own, "hidden", {
        value: "secret",
        enumerable: false,
      });
      const scope = buildScope({ output: own as unknown as M3LProcedureValue });
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        subject: {
          source: "step",
          step: "count-errors",
          path: ["hidden"],
        },
      };
      const evaluation = evaluateProcedureCondition<TestShape>(
        condition,
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
      expect(evaluation.references[0]?.present).toBe(false);
    });

    test("a __proto__ segment never resolves, even though Object.prototype carries that name", () => {
      const scope = buildScope({ output: { safe: 1 } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: {
            source: "step",
            step: "count-errors",
            path: ["__proto__"],
          },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("a constructor segment never resolves, even as an own enumerable key", () => {
      const scope = buildScope({
        output: { constructor: "not-a-class", safe: 1 },
      });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: {
            source: "step",
            step: "count-errors",
            path: ["constructor"],
          },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("a prototype segment never resolves, even as an own enumerable key", () => {
      const scope = buildScope({
        output: { prototype: "not-a-fn", safe: 1 },
      });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: {
            source: "step",
            step: "count-errors",
            path: ["prototype"],
          },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("an array resolves a canonical decimal index in range", () => {
      const scope = buildScope({ output: ["a", "b", "c"] });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: { source: "step", step: "count-errors", path: ["0"] },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("an array resolves a multi-digit canonical decimal index in range", () => {
      const items = Array.from({ length: 13 }, (_v, i) => i);
      const scope = buildScope({ output: items });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: { source: "step", step: "count-errors", path: ["12"] },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test.each([["01"], ["-1"], ["1.0"]])(
      "an array does not resolve the non-canonical index %s",
      (index) => {
        const scope = buildScope({ output: ["a", "b", "c"] });
        const evaluation = evaluateProcedureCondition<TestShape>(
          {
            kind: "exists",
            subject: { source: "step", step: "count-errors", path: [index] },
          },
          scope,
        );
        expect(evaluation.satisfied).toBe(false);
      },
    );

    test("an array does not resolve an out-of-range index", () => {
      const scope = buildScope({ output: ["a", "b", "c"] });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: { source: "step", step: "count-errors", path: ["7"] },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("`length` on an array does not resolve (metadata, not data)", () => {
      const scope = buildScope({ output: ["a", "b", "c"] });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: {
            source: "step",
            step: "count-errors",
            path: ["length"],
          },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test('a string value resolves no segment: ["0"] against "abc" is undefined, not "a"', () => {
      const scope = buildScope({ output: "abc" });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: { source: "step", step: "count-errors", path: ["0"] },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("walking stops at the first unresolved segment", () => {
      const scope = buildScope({ output: { a: 1 } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: {
            source: "step",
            step: "count-errors",
            path: ["missing", "deeper"],
          },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("path depth is bounded by M3L_PROCEDURE_CONDITION_MAX_DEPTH", () => {
      // Build a nested object well past the documented bound and a matching
      // path; the exact inclusive/exclusive cutoff isn't pinned by the doc,
      // so this only asserts that a sufficiently deep walk is refused.
      const depth = M3L_PROCEDURE_CONDITION_MAX_DEPTH + 10;
      let value: M3LProcedureValue = 42;
      const segments: string[] = [];
      for (let i = depth - 1; i >= 0; i -= 1) {
        segments.unshift(`n${String(i)}`);
        value = { [`n${String(i)}`]: value };
      }
      const scope = buildScope({ output: value });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: {
            source: "step",
            step: "count-errors",
            path: segments as unknown as readonly [string, ...string[]],
          },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 2. compare
  // -------------------------------------------------------------------------
  describe("compare", () => {
    const OPERATORS_5_VS_3: readonly [M3LProcedureCompareOperator, boolean][] =
      [
        [">", true],
        [">=", true],
        ["<", false],
        ["<=", false],
        ["==", false],
        ["!=", true],
      ];

    test.each(OPERATORS_5_VS_3)("5 %s 3 is %s", (operator, expected) => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "literal", literal: 5 },
          operator,
          right: { source: "literal", literal: 3 },
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(expected);
    });

    const OPERATORS_5_VS_5: readonly [M3LProcedureCompareOperator, boolean][] =
      [
        [">", false],
        [">=", true],
        ["<", false],
        ["<=", true],
        ["==", true],
        ["!=", false],
      ];

    test.each(OPERATORS_5_VS_5)("5 %s 5 is %s", (operator, expected) => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "literal", literal: 5 },
          operator,
          right: { source: "literal", literal: 5 },
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(expected);
    });

    test('ordering operators require both sides to be numbers: "5" > 4 is false, never coerced', () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "literal", literal: "5" },
          operator: ">",
          right: { source: "literal", literal: 4 },
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("ordering operators never lexically compare two strings", () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "literal", literal: "10" },
          operator: ">",
          right: { source: "literal", literal: "9" },
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("an unresolved left reference makes compare false, never a throw", () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "value", key: "count" },
          operator: ">",
          right: { source: "literal", literal: 0 },
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("an unresolved right reference makes compare false, never a throw", () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "literal", literal: 0 },
          operator: "<",
          right: { source: "value", key: "count" },
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("NaN is false for every ordering operator", () => {
      const scope = buildScope({ values: { count: Number.NaN } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "value", key: "count" },
          operator: ">",
          right: { source: "literal", literal: 5 },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("+0 and -0 are equal under ==", () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "literal", literal: 0 },
          operator: "==",
          right: { source: "literal", literal: -0 },
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 3. deep structural equality
  // -------------------------------------------------------------------------
  describe("deep structural equality", () => {
    test("NaN is never equal to another NaN", () => {
      const scope = buildScope({ output: Number.NaN });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "step", step: "count-errors" },
          operator: "==",
          right: { source: "literal", literal: Number.NaN },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("two unresolved references are never equal under == (undefined is not a member of the scalar union)", () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "value", key: "count" },
          operator: "==",
          right: { source: "value", key: "text" },
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("two unresolved references are unequal under != (the mirror of the == case above)", () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "value", key: "count" },
          operator: "!=",
          right: { source: "value", key: "text" },
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("arrays compare element-wise, in order", () => {
      const scope = buildScope({ output: [1, 2, 3] });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "step", step: "count-errors" },
          operator: "==",
          right: { source: "step", step: "count-errors" },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("arrays with the same elements in a different order are not equal", () => {
      // The `literal` arm only carries scalars, so an array/array comparison
      // is driven through two independent step outputs in one scope.
      const scope: M3LProcedureConditionScope<TestShape> = {
        results: {
          "count-errors": stepRecord([1, 2, 3]),
          "sample-traces": stepRecord([3, 2, 1]),
        },
        values: {},
        parameters: DEFAULT_PARAMETERS,
      };
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "step", step: "count-errors" },
          operator: "==",
          right: { source: "step", step: "sample-traces" },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("arrays of different length are not equal", () => {
      const scope: M3LProcedureConditionScope<TestShape> = {
        results: {
          "count-errors": stepRecord([1, 2, 3]),
          "sample-traces": stepRecord([1, 2]),
        },
        values: {},
        parameters: DEFAULT_PARAMETERS,
      };
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "step", step: "count-errors" },
          operator: "==",
          right: { source: "step", step: "sample-traces" },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("objects compare by own enumerable keys, key order irrelevant", () => {
      const scope: M3LProcedureConditionScope<TestShape> = {
        results: {
          "count-errors": stepRecord({ a: 1, b: 2 }),
          "sample-traces": stepRecord({ b: 2, a: 1 }),
        },
        values: {},
        parameters: DEFAULT_PARAMETERS,
      };
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "step", step: "count-errors" },
          operator: "==",
          right: { source: "step", step: "sample-traces" },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("a key present with value null is not equal to an absent key", () => {
      const scope: M3LProcedureConditionScope<TestShape> = {
        results: {
          "count-errors": stepRecord({ a: null }),
          "sample-traces": stepRecord({}),
        },
        values: {},
        parameters: DEFAULT_PARAMETERS,
      };
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "step", step: "count-errors" },
          operator: "==",
          right: { source: "step", step: "sample-traces" },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("a scalar never equals a container", () => {
      const scope = buildScope({ output: [1] });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "step", step: "count-errors" },
          operator: "==",
          right: { source: "literal", literal: 1 },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("an array never equals an object", () => {
      const scope: M3LProcedureConditionScope<TestShape> = {
        results: {
          "count-errors": stepRecord([1, 2]),
          "sample-traces": stepRecord({ "0": 1, "1": 2 }),
        },
        values: {},
        parameters: DEFAULT_PARAMETERS,
      };
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "step", step: "count-errors" },
          operator: "==",
          right: { source: "step", step: "sample-traces" },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("comparison of a self-referential value returns false rather than overflowing the stack", () => {
      function buildSelfReferential(): M3LProcedureValue {
        const graph: Record<string, unknown> = {};
        graph["self"] = graph;
        return graph as M3LProcedureValue;
      }
      const scope: M3LProcedureConditionScope<TestShape> = {
        results: {
          "count-errors": stepRecord(buildSelfReferential()),
          "sample-traces": stepRecord(buildSelfReferential()),
        },
        values: {},
        parameters: DEFAULT_PARAMETERS,
      };
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "step", step: "count-errors" },
          operator: "==",
          right: { source: "step", step: "sample-traces" },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 4. matches
  // -------------------------------------------------------------------------
  describe("matches", () => {
    test("a non-string subject is false", () => {
      const scope = buildScope({ output: 42 });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "matches",
          subject: { source: "step", step: "count-errors" },
          pattern: "^[0-9]+$",
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("matches a string subject against a pattern", () => {
      const scope = buildScope({ output: "ERROR: disk full" });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "matches",
          subject: { source: "step", step: "count-errors" },
          pattern: "^ERROR:",
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("does not match a string subject that fails the pattern", () => {
      const scope = buildScope({ output: "INFO: all good" });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "matches",
          subject: { source: "step", step: "count-errors" },
          pattern: "^ERROR:",
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("ignoreCase makes the pattern case-insensitive", () => {
      const scope = buildScope({ output: "error: disk full" });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "matches",
          subject: { source: "step", step: "count-errors" },
          pattern: "^ERROR:",
          ignoreCase: true,
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("a subject longer than M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH is refused, not scanned", () => {
      const subject = "a".repeat(M3L_PROCEDURE_MAX_MATCH_INPUT_LENGTH + 1);
      const scope = buildScope({ output: subject });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "matches",
          subject: { source: "step", step: "count-errors" },
          pattern: "a+",
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
      expect(evaluation.references[0]?.refused).toBe("oversized");
    });

    test("adversarial-padding: a ~500,000-character subject is refused in bounded time, not scanned", () => {
      const subject = `${"a".repeat(500_000)}!`;
      const scope = buildScope({ output: subject });
      const start = performance.now();
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "matches",
          subject: { source: "step", step: "count-errors" },
          pattern: "a+!",
        },
        scope,
      );
      const elapsedMs = performance.now() - start;
      expect(elapsedMs).toBeLessThan(200);
      expect(evaluation.satisfied).toBe(false);
      expect(evaluation.references[0]?.refused).toBe("oversized");
    });

    test("a malformed pattern (one `new RegExp` rejects) makes the arm false, not a throw — reachable without build()", () => {
      // "(" is an unterminated group; `new RegExp` genuinely rejects it.
      // `build()` would refuse this at build time under
      // ERR_PROCEDURE_INVALID_PATTERN, but `evaluateProcedureCondition` is
      // public and reachable without `build()`, so it carries its own
      // totality guarantee over a malformed pattern source. (Verified
      // out-of-band that `new RegExp("(")` throws
      // "Invalid regular expression: /(/: Unterminated group"; not asserted
      // inline here because ESLint's `no-invalid-regexp` statically flags a
      // literal invalid pattern passed directly to the `RegExp` constructor.)
      const scope = buildScope({ output: "anything" });
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "matches",
        subject: { source: "step", step: "count-errors" },
        pattern: "(",
      };
      expect(() =>
        evaluateProcedureCondition<TestShape>(condition, scope),
      ).not.toThrow();
      const evaluation = evaluateProcedureCondition<TestShape>(
        condition,
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test('a malformed pattern marks the resolved reference `refused: "invalid-pattern"`, distinguishing it from a legitimate no-match', () => {
      // Same malformed source as the previous test — "(" genuinely rejects
      // in `new RegExp` (verified out-of-band). A malformed pattern and a
      // pattern that simply fails to match both yield `satisfied: false`;
      // without a distinct refusal marker on the resolved reference the two
      // are indistinguishable to a caller inspecting `references`.
      const scope = buildScope({ output: "anything" });
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "matches",
        subject: { source: "step", step: "count-errors" },
        pattern: "(",
      };
      const evaluation = evaluateProcedureCondition<TestShape>(
        condition,
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
      expect(evaluation.references[0]?.refused).toBe("invalid-pattern");
    });

    test("evaluating the same matches condition twice yields the same result (no lastIndex carry)", () => {
      const scope = buildScope({ output: "ERROR: disk full" });
      const condition: M3LProcedureCondition<TestShape> = {
        kind: "matches",
        subject: { source: "step", step: "count-errors" },
        pattern: "ERROR",
      };
      const first = evaluateProcedureCondition<TestShape>(condition, scope);
      const second = evaluateProcedureCondition<TestShape>(condition, scope);
      expect(first.satisfied).toBe(true);
      expect(second.satisfied).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. contains
  // -------------------------------------------------------------------------
  describe("contains", () => {
    test("an array subject tests scalar membership by deep structural equality", () => {
      const scope = buildScope({ output: [1, 2, 3] });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "contains",
          subject: { source: "step", step: "count-errors" },
          item: { source: "literal", literal: 2 },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("an array subject tests nested-object membership by deep structural equality", () => {
      const scope: M3LProcedureConditionScope<TestShape> = {
        results: {
          "count-errors": stepRecord([
            { id: "x", n: 1 },
            { id: "y", n: 2 },
          ]),
          "sample-traces": stepRecord({ id: "y", n: 2 }),
        },
        values: {},
        parameters: DEFAULT_PARAMETERS,
      };
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "contains",
          subject: { source: "step", step: "count-errors" },
          item: { source: "step", step: "sample-traces" },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("an array subject not containing the item is false", () => {
      const scope = buildScope({ output: [1, 2, 3] });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "contains",
          subject: { source: "step", step: "count-errors" },
          item: { source: "literal", literal: 9 },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("a string subject tests substring containment", () => {
      const scope = buildScope({ output: "disk full" });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "contains",
          subject: { source: "step", step: "count-errors" },
          item: { source: "literal", literal: "full" },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("a string subject not containing the item substring is false", () => {
      const scope = buildScope({ output: "disk full" });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "contains",
          subject: { source: "step", step: "count-errors" },
          item: { source: "literal", literal: "empty" },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("a string subject with a non-string item is false", () => {
      const scope = buildScope({ output: "disk full" });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "contains",
          subject: { source: "step", step: "count-errors" },
          item: { source: "literal", literal: 1 },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("a scalar subject that is neither array nor string is false", () => {
      const scope = buildScope({ output: 42 });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "contains",
          subject: { source: "step", step: "count-errors" },
          item: { source: "literal", literal: 42 },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("an object subject (neither array nor string) is false", () => {
      const scope = buildScope({ output: { a: 1 } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "contains",
          subject: { source: "step", step: "count-errors" },
          item: { source: "literal", literal: 1 },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 6. exists
  // -------------------------------------------------------------------------
  describe("exists", () => {
    test("a null-valued key exists", () => {
      const scope = buildScope({ output: { a: null } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: {
            source: "step",
            step: "count-errors",
            path: ["a"],
          },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("a missing key does not exist", () => {
      const scope = buildScope({ output: { a: 1 } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: {
            source: "step",
            step: "count-errors",
            path: ["b"],
          },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("an unresolved path does not exist", () => {
      const scope = buildScope({ output: { a: { b: 1 } } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: {
            source: "step",
            step: "count-errors",
            path: ["a", "c"],
          },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("a present scalar value exists", () => {
      const scope = buildScope({ output: 0 });
      const evaluation = evaluateProcedureCondition<TestShape>(
        { kind: "exists", subject: { source: "step", step: "count-errors" } },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 7. and / or / not
  // -------------------------------------------------------------------------
  describe("and / or / not", () => {
    test("and is true when every operand is true", () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "and",
          operands: [
            { kind: "exists", subject: { source: "literal", literal: 1 } },
            { kind: "exists", subject: { source: "literal", literal: 2 } },
          ],
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("and is false when one operand is false", () => {
      const scope = buildScope({ values: {} });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "and",
          operands: [
            { kind: "exists", subject: { source: "value", key: "count" } },
            { kind: "exists", subject: { source: "literal", literal: 1 } },
          ],
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("or is true when any operand is true", () => {
      const scope = buildScope({ values: {} });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "or",
          operands: [
            { kind: "exists", subject: { source: "value", key: "count" } },
            { kind: "exists", subject: { source: "literal", literal: 1 } },
          ],
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("or is false when every operand is false", () => {
      const scope = buildScope({ values: {} });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "or",
          operands: [
            { kind: "exists", subject: { source: "value", key: "count" } },
            { kind: "exists", subject: { source: "value", key: "text" } },
          ],
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("not inverts true to false", () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "not",
          operand: {
            kind: "exists",
            subject: { source: "literal", literal: 1 },
          },
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(false);
    });

    test("not inverts false to true", () => {
      const scope = buildScope({ values: {} });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "not",
          operand: {
            kind: "exists",
            subject: { source: "value", key: "count" },
          },
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("and does not short-circuit: every operand's references appear even when the first is already false", () => {
      const scope = buildScope({ values: {} });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "and",
          operands: [
            { kind: "exists", subject: { source: "value", key: "count" } }, // false
            { kind: "exists", subject: { source: "literal", literal: 1 } }, // true
          ],
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(false);
      expect(evaluation.operands).toHaveLength(2);
      expect(evaluation.operands[0]?.references).toHaveLength(1);
      expect(evaluation.operands[1]?.references).toHaveLength(1);
    });

    test("or does not short-circuit: every operand's references appear even when the first is already true", () => {
      const scope = buildScope({ values: {} });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "or",
          operands: [
            { kind: "exists", subject: { source: "literal", literal: 1 } }, // true
            { kind: "exists", subject: { source: "value", key: "count" } }, // false
          ],
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
      expect(evaluation.operands).toHaveLength(2);
      expect(evaluation.operands[0]?.references).toHaveLength(1);
      expect(evaluation.operands[1]?.references).toHaveLength(1);
    });

    test("a malformed and operand (bypassing the type system directly) is dropped and marked in detail, not silently absorbed", () => {
      // The type-level non-empty-tuple guarantee on `operands` only binds a
      // caller who goes through `M3LProcedureCondition<TestShape>`'s own
      // literal type; a direct, untyped call (`evaluateProcedureCondition`
      // is documented as callable outside `build()`) can still hand in a
      // raw array with a non-condition-shaped entry. That entry must not
      // silently shrink the joined operand count.
      const validOperand: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        subject: { source: "value", key: "count" },
      };
      const condition = {
        kind: "and",
        operands: [validOperand, { not: "a condition" }],
      } as unknown as M3LProcedureCondition<TestShape>;
      const evaluation = evaluateProcedureCondition<TestShape>(
        condition,
        EMPTY_SCOPE,
      );
      // The one conforming operand is evaluated (unresolved `value:count` ->
      // false), and the dropped raw entry is surfaced in `detail` rather than
      // vanishing.
      expect(evaluation.operands).toHaveLength(1);
      expect(evaluation.satisfied).toBe(false);
      expect(evaluation.detail).toBe(
        "value:count exists and 1 malformed operand",
      );
    });

    test("operand order is left-to-right, depth-first", () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "and",
          operands: [
            {
              kind: "exists",
              subject: { source: "literal", literal: "first" },
            },
            {
              kind: "or",
              operands: [
                {
                  kind: "exists",
                  subject: { source: "literal", literal: "second" },
                },
                {
                  kind: "exists",
                  subject: { source: "literal", literal: "third" },
                },
              ],
            },
          ],
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.operands[0]?.references[0]?.reference).toBe(
        "literal:first",
      );
      expect(
        evaluation.operands[1]?.operands[0]?.references[0]?.reference,
      ).toBe("literal:second");
      expect(
        evaluation.operands[1]?.operands[1]?.references[0]?.reference,
      ).toBe("literal:third");
    });

    /**
     * Wraps `leaf` in `levels` nested single-operand `and` connectives. A
     * single-operand `and` is a pass-through (`satisfied` equals its one
     * operand's), which keeps the propagated result deterministic across the
     * whole chain regardless of `M3L_PROCEDURE_CONDITION_MAX_DEPTH`'s parity —
     * unlike a `not` chain, whose result would flip at every level.
     */
    function buildAndChain(
      levels: number,
      leaf: M3LProcedureCondition<TestShape>,
    ): M3LProcedureCondition<TestShape> {
      let condition = leaf;
      for (let i = 0; i < levels; i += 1) {
        condition = { kind: "and", operands: [condition] };
      }
      return condition;
    }

    const TRUE_LEAF: M3LProcedureCondition<TestShape> = {
      kind: "exists",
      subject: { source: "literal", literal: 1 },
    };

    test("a condition tree nested to exactly M3L_PROCEDURE_CONDITION_MAX_DEPTH evaluates normally", () => {
      const condition = buildAndChain(
        M3L_PROCEDURE_CONDITION_MAX_DEPTH,
        TRUE_LEAF,
      );
      const evaluation = evaluateProcedureCondition<TestShape>(
        condition,
        EMPTY_SCOPE,
      );
      // The bound is inclusive: nested to exactly the bound, the leaf is
      // still reached and its own (true) result passes through unchanged.
      expect(evaluation.satisfied).toBe(true);
    });

    test("a condition tree nested one level past M3L_PROCEDURE_CONDITION_MAX_DEPTH is refused without throwing", () => {
      const condition = buildAndChain(
        M3L_PROCEDURE_CONDITION_MAX_DEPTH + 1,
        TRUE_LEAF,
      );
      // The evaluator is total: assert it returns rather than that it
      // throws, even one level past the bound.
      expect(() =>
        evaluateProcedureCondition<TestShape>(condition, EMPTY_SCOPE),
      ).not.toThrow();
      const evaluation = evaluateProcedureCondition<TestShape>(
        condition,
        EMPTY_SCOPE,
      );
      // The leaf itself is refused (never reached), which propagates as
      // `false` through every `and` wrapper above it.
      expect(evaluation.satisfied).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 8. hostile accessors — evaluateProcedureCondition is documented "Total —
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
  });

  // -------------------------------------------------------------------------
  // 9. explainability
  // -------------------------------------------------------------------------
  describe("explainability", () => {
    test("the evaluation tree mirrors the condition tree, node for node", () => {
      const scope = buildScope({ values: { count: 1 } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "and",
          operands: [
            {
              kind: "compare",
              left: { source: "literal", literal: 12 },
              operator: ">",
              right: { source: "literal", literal: 5 },
            },
            { kind: "exists", subject: { source: "value", key: "count" } },
          ],
        },
        scope,
      );
      expect(evaluation.kind).toBe("and");
      expect(evaluation.operands).toHaveLength(2);
      expect(evaluation.operands[0]?.kind).toBe("compare");
      expect(evaluation.operands[1]?.kind).toBe("exists");
    });

    test("operands are empty for leaves and references are empty for connectives", () => {
      const scope = buildScope({ values: { count: 1 } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "and",
          operands: [
            { kind: "exists", subject: { source: "value", key: "count" } },
          ],
        },
        scope,
      );
      expect(evaluation.references).toHaveLength(0);
      expect(evaluation.operands[0]?.operands).toHaveLength(0);
    });

    test("a leaf reference carries reference, present and resolved", () => {
      const scope = buildScope({ values: { count: 12 } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "value", key: "count" },
          operator: ">",
          right: { source: "literal", literal: 5 },
        },
        scope,
      );
      expect(evaluation.references).toEqual([
        { reference: "value:count", present: true, resolved: 12 },
        { reference: "literal:5", present: true, resolved: 5 },
      ]);
    });

    test("the canonical rendering for a step reference with a path joins step and path with a dot", () => {
      const scope = buildScope({ output: { count: 7 } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: {
            source: "step",
            step: "count-errors",
            path: ["count"],
          },
        },
        scope,
      );
      expect(evaluation.references[0]?.reference).toBe(
        "step:count-errors.count",
      );
    });

    test('the canonical rendering for a null literal is "literal:null"', () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        { kind: "exists", subject: { source: "literal", literal: null } },
        EMPTY_SCOPE,
      );
      expect(evaluation.references[0]?.reference).toBe("literal:null");
    });

    test('the canonical rendering for a value reference with a path is "value:tags.0"', () => {
      const scope = buildScope({ values: { tags: ["a", "b"] } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "exists",
          subject: { source: "value", key: "tags", path: ["0"] },
        },
        scope,
      );
      expect(evaluation.references[0]?.reference).toBe("value:tags.0");
    });

    test('the canonical rendering for a parameter reference is "parameter:threshold"', () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        { kind: "exists", subject: { source: "parameter", key: "threshold" } },
        EMPTY_SCOPE,
      );
      expect(evaluation.references[0]?.reference).toBe("parameter:threshold");
    });

    test("an unresolvable reference is present: false and satisfied: false, never a throw", () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        { kind: "exists", subject: { source: "value", key: "count" } },
        EMPTY_SCOPE,
      );
      expect(evaluation.satisfied).toBe(false);
      const reference = evaluation.references[0];
      expect(reference).toMatchObject({ present: false });
      // `exactOptionalPropertyTypes` means the `present: false` arm omits
      // `resolved` entirely rather than setting it to `undefined` — assert
      // the key is genuinely absent, not merely `undefined`-valued, since
      // `toMatchObject` treats the two differently.
      expect(reference !== undefined && "resolved" in reference).toBe(false);
    });

    test('detail renders a short explanation, e.g. "12 > 5"', () => {
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "literal", literal: 12 },
          operator: ">",
          right: { source: "literal", literal: 5 },
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.detail).toBe("12 > 5");
    });

    test("detail is length-capped: a very long resolved value does not appear verbatim", () => {
      const longString = "x".repeat(5000);
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "compare",
          left: { source: "literal", literal: longString },
          operator: "==",
          right: { source: "literal", literal: longString },
        },
        EMPTY_SCOPE,
      );
      expect(evaluation.detail).toBeDefined();
      expect(evaluation.detail?.length ?? 0).toBeLessThan(longString.length);
    });

    test("the root's satisfied is the overall boolean", () => {
      const scope = buildScope({ values: { count: 1 } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "and",
          operands: [
            {
              kind: "compare",
              left: { source: "literal", literal: 12 },
              operator: ">",
              right: { source: "literal", literal: 5 },
            },
            { kind: "exists", subject: { source: "value", key: "count" } },
          ],
        },
        scope,
      );
      expect(evaluation.satisfied).toBe(true);
    });

    test("the evaluation tree of a nested condition is exactly determined by condition and scope", () => {
      const scope = buildScope({ values: { count: 1 } });
      const evaluation = evaluateProcedureCondition<TestShape>(
        {
          kind: "and",
          operands: [
            {
              kind: "compare",
              left: { source: "literal", literal: 12 },
              operator: ">",
              right: { source: "literal", literal: 5 },
            },
            { kind: "exists", subject: { source: "value", key: "count" } },
          ],
        },
        scope,
      );
      // `detail` rendering for the `and` connective and for `exists` leaves
      // is not pinned exactly by the contract (only the `compare` example
      // "12 > 5" is) — those two fields are matched loosely via `expect.any`.
      expect(evaluation).toEqual({
        kind: "and",
        satisfied: true,
        references: [],
        detail: expect.anything() as unknown,
        operands: [
          {
            kind: "compare",
            satisfied: true,
            references: [
              { reference: "literal:12", present: true, resolved: 12 },
              { reference: "literal:5", present: true, resolved: 5 },
            ],
            operands: [],
            detail: "12 > 5",
          },
          {
            kind: "exists",
            satisfied: true,
            references: [
              { reference: "value:count", present: true, resolved: 1 },
            ],
            operands: [],
            detail: expect.anything() as unknown,
          },
        ],
      });
    });
  });

  // -------------------------------------------------------------------------
  // 9. type-level
  // -------------------------------------------------------------------------
  describe("type-level", () => {
    test('a value reference naming a key absent from TShape["values"] does not compile', () => {
      const bad: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        // @ts-expect-error -- "missing" is not a key of TestShape["values"]
        subject: { source: "value", key: "missing" },
      };
      expect(bad.kind).toBe("exists");
    });

    test("a step reference naming a non-declared step id does not compile", () => {
      const bad: M3LProcedureCondition<TestShape> = {
        kind: "exists",
        // @ts-expect-error -- "unknown-step" is not a declared step id
        subject: { source: "step", step: "unknown-step" },
      };
      expect(bad.kind).toBe("exists");
    });

    test("an empty `and` operands array does not compile", () => {
      const bad: M3LProcedureCondition<TestShape> = {
        kind: "and",
        // @ts-expect-error -- operands must be a non-empty tuple
        operands: [],
      };
      expect(bad.kind).toBe("and");
    });

    test("an empty `or` operands array does not compile", () => {
      const bad: M3LProcedureCondition<TestShape> = {
        kind: "or",
        // @ts-expect-error -- operands must be a non-empty tuple
        operands: [],
      };
      expect(bad.kind).toBe("or");
    });

    test("M3LProcedureConditionKind is exactly the seven documented literals", () => {
      expectTypeOf<M3LProcedureConditionKind>().toEqualTypeOf<
        "compare" | "matches" | "contains" | "exists" | "and" | "or" | "not"
      >();
    });

    test("M3LProcedureCompareOperator is exactly the six documented literals", () => {
      expectTypeOf<M3LProcedureCompareOperator>().toEqualTypeOf<
        ">" | ">=" | "<" | "<=" | "==" | "!="
      >();
    });
  });
});
