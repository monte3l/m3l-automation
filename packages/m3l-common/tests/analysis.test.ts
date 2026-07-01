/**
 * Tests for core/analysis submodule.
 *
 * Contract source: docs/reference/core/analysis.md (+ finalized contract
 * supplied for this change set, including `M3LThresholdRuleValidationError`
 * and the `parseLocaleNumber` utils helper).
 *
 * Exports under test: M3LThresholdEvaluator, M3LThresholdRule,
 *   M3LThresholdRuleResult, M3LThresholdEvaluation,
 *   M3LThresholdRuleValidationError (5 symbols), plus `parseLocaleNumber`
 *   from core/utils.
 *
 * Key behavioral contracts:
 *  - evaluate() is SYNCHRONOUS: rules + rows in, M3LThresholdEvaluation out.
 *  - "any-row" aggregation checks each row independently (breached if any row
 *    satisfies operator+value); reducing aggregations (count/sum/avg/min/max)
 *    collapse the field column to one number first, then compare once.
 *  - Every rule produces exactly one result, in input order; no short-circuit.
 *  - `breached` is true iff >=1 result breached, regardless of severity.
 *  - Numeric cell parsing is locale-aware (comma decimal separator) and never
 *    throws; non-numeric cells are skipped by reducers.
 *  - Unknown operator / unknown aggregation / a field-requiring aggregation
 *    with no `field` all throw M3LThresholdRuleValidationError
 *    (code ERR_ANALYSIS_INVALID_RULE), an M3LError subclass.
 */

import { describe, expect, expectTypeOf, test } from "vitest";

import { M3LError } from "../src/core/errors/index.js";
import {
  M3LThresholdEvaluator,
  M3LThresholdRuleValidationError,
} from "../src/core/analysis/index.js";
import type {
  M3LThresholdEvaluation,
  M3LThresholdRule,
  M3LThresholdRuleResult,
} from "../src/core/analysis/index.js";
import { parseLocaleNumber } from "../src/core/utils/index.js";

// =============================================================================
// M3LThresholdEvaluator — happy paths
// =============================================================================
describe("M3LThresholdEvaluator", () => {
  describe("evaluate() — any-row aggregation", () => {
    test("breaches when at least one row's field satisfies operator+value", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "any-failed-row",
          field: "status",
          operator: "==",
          value: "FAILED",
          aggregation: "any-row",
          severity: "warning",
        },
      ];
      const rows = [{ status: "OK" }, { status: "FAILED" }, { status: "OK" }];

      const evaluator = new M3LThresholdEvaluator();
      const evaluation = evaluator.evaluate(rules, rows);

      expect(evaluation.breached).toBe(true);
      expect(evaluation.results).toHaveLength(1);
      expect(evaluation.results[0]).toMatchObject({
        name: "any-failed-row",
        breached: true,
        severity: "warning",
      });
    });

    test("does not breach when no row satisfies operator+value", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "any-failed-row",
          field: "status",
          operator: "==",
          value: "FAILED",
          aggregation: "any-row",
          severity: "warning",
        },
      ];
      const rows = [{ status: "OK" }, { status: "OK" }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.breached).toBe(false);
      expect(evaluation.results[0]?.breached).toBe(false);
    });

    test("actual is null for an any-row result", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "any-failed-row",
          field: "status",
          operator: "==",
          value: "FAILED",
          aggregation: "any-row",
          severity: "info",
        },
      ];
      const evaluation = new M3LThresholdEvaluator().evaluate(rules, [
        { status: "FAILED" },
      ]);

      expect(evaluation.results[0]?.actual).toBeNull();
    });

    test("numeric any-row operator uses numeric comparison per-row with locale parsing", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "any-row-over-threshold",
          field: "errorRate",
          operator: ">",
          value: 0.05,
          aggregation: "any-row",
          severity: "critical",
        },
      ];
      const rows = [{ errorRate: "0,01" }, { errorRate: "0,2" }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.breached).toBe(true);
    });
  });

  describe("evaluate() — equality operator string vs numeric semantics", () => {
    test("string value with '==' compares by string equality, not numeric coercion", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "status-failed",
          field: "status",
          operator: "==",
          value: "FAILED",
          aggregation: "any-row",
          severity: "warning",
        },
      ];
      const rows = [{ status: "FAILED" }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.results[0]?.breached).toBe(true);
    });

    test("'!=' with a string value is the inverse of '=='", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "status-not-ok",
          field: "status",
          operator: "!=",
          value: "OK",
          aggregation: "any-row",
          severity: "warning",
        },
      ];
      const rows = [{ status: "OK" }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.results[0]?.breached).toBe(false);
    });

    test("numeric value with '==' compares numerically (coercing the cell)", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "count-is-two",
          field: "count",
          operator: "==",
          value: 2,
          aggregation: "any-row",
          severity: "info",
        },
      ];
      const rows = [{ count: "2" }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.results[0]?.breached).toBe(true);
    });
  });

  describe("evaluate() — reducing aggregations", () => {
    test("count does not require a field and counts all data rows", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "too-many-rows",
          operator: ">",
          value: 2,
          aggregation: "count",
          severity: "warning",
        },
      ];
      const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.results[0]?.actual).toBe(3);
      expect(evaluation.results[0]?.breached).toBe(true);
    });

    test("sum reduces the field column and compares once", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "total-too-high",
          field: "amount",
          operator: ">",
          value: 5,
          aggregation: "sum",
          severity: "critical",
        },
      ];
      const rows = [{ amount: "1" }, { amount: "2" }, { amount: "3" }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.results[0]?.actual).toBe(6);
      expect(evaluation.results[0]?.breached).toBe(true);
    });

    test("avg reduces the field column to a mean", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "avg-too-high",
          field: "errorRate",
          operator: ">",
          value: 0.05,
          aggregation: "avg",
          severity: "critical",
        },
      ];
      const rows = [{ errorRate: "0.04" }, { errorRate: "0.1" }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.results[0]?.actual).toBeCloseTo(0.07);
      expect(evaluation.results[0]?.breached).toBe(true);
    });

    test("min reduces the field column to its minimum", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "min-too-low",
          field: "score",
          operator: "<",
          value: 10,
          aggregation: "min",
          severity: "warning",
        },
      ];
      const rows = [{ score: "20" }, { score: "5" }, { score: "30" }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.results[0]?.actual).toBe(5);
      expect(evaluation.results[0]?.breached).toBe(true);
    });

    test("max reduces the field column to its maximum", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "max-too-high",
          field: "score",
          operator: ">",
          value: 100,
          aggregation: "max",
          severity: "critical",
        },
      ];
      const rows = [{ score: "20" }, { score: "150" }, { score: "30" }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.results[0]?.actual).toBe(150);
      expect(evaluation.results[0]?.breached).toBe(true);
    });

    test("reducers skip non-numeric cells rather than treating them as 0 or NaN-poisoning the result", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "sum-skips-non-numeric",
          field: "amount",
          operator: "==",
          value: 3,
          aggregation: "sum",
          severity: "info",
        },
      ];
      const rows = [{ amount: "1" }, { amount: "abc" }, { amount: "2" }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.results[0]?.actual).toBe(3);
      expect(evaluation.results[0]?.breached).toBe(true);
    });

    test("locale comma-decimal cells are parsed correctly during aggregation", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "sum-locale",
          field: "amount",
          operator: "==",
          value: 3,
          aggregation: "sum",
          severity: "info",
        },
      ];
      const rows = [{ amount: "1,5" }, { amount: "1,5" }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.results[0]?.actual).toBeCloseTo(3);
    });
  });

  describe("evaluate() — empty rows", () => {
    test("sum over empty rows yields actual 0 and does not breach a positive threshold", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "sum-empty",
          field: "amount",
          operator: ">",
          value: 0,
          aggregation: "sum",
          severity: "warning",
        },
      ];
      const evaluation = new M3LThresholdEvaluator().evaluate(rules, []);

      expect(evaluation.results[0]?.actual).toBe(0);
      expect(evaluation.results[0]?.breached).toBe(false);
    });

    test("count over empty rows yields actual 0", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "count-empty",
          operator: ">",
          value: 0,
          aggregation: "count",
          severity: "warning",
        },
      ];
      const evaluation = new M3LThresholdEvaluator().evaluate(rules, []);

      expect(evaluation.results[0]?.actual).toBe(0);
      expect(evaluation.results[0]?.breached).toBe(false);
    });

    test.each<M3LThresholdRule["aggregation"]>(["avg", "min", "max"])(
      "%s over empty rows yields actual null and does not breach",
      (aggregation) => {
        const rules: readonly M3LThresholdRule[] = [
          {
            name: `${aggregation}-empty`,
            field: "amount",
            operator: ">",
            value: 0,
            aggregation,
            severity: "warning",
          },
        ];
        const evaluation = new M3LThresholdEvaluator().evaluate(rules, []);

        expect(evaluation.results[0]?.actual).toBeNull();
        expect(evaluation.results[0]?.breached).toBe(false);
      },
    );

    test("any-row over empty rows does not breach", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "any-row-empty",
          field: "status",
          operator: "==",
          value: "FAILED",
          aggregation: "any-row",
          severity: "warning",
        },
      ];
      const evaluation = new M3LThresholdEvaluator().evaluate(rules, []);

      expect(evaluation.results[0]?.breached).toBe(false);
    });

    test("evaluate(rules, []) still returns one result per rule", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "rule-a",
          operator: ">",
          value: 0,
          aggregation: "count",
          severity: "info",
        },
        {
          name: "rule-b",
          field: "x",
          operator: ">",
          value: 0,
          aggregation: "sum",
          severity: "info",
        },
      ];
      const evaluation = new M3LThresholdEvaluator().evaluate(rules, []);

      expect(evaluation.results).toHaveLength(2);
    });

    test("column with no numeric values yields actual null for avg/min/max", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "avg-all-non-numeric",
          field: "label",
          operator: ">",
          value: 0,
          aggregation: "avg",
          severity: "warning",
        },
      ];
      const rows = [{ label: "abc" }, { label: "def" }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.results[0]?.actual).toBeNull();
      expect(evaluation.results[0]?.breached).toBe(false);
    });
  });

  describe("evaluate() — empty rules", () => {
    test("evaluate([], rows) returns not-breached with no results and a non-empty summary", () => {
      const evaluation = new M3LThresholdEvaluator().evaluate([], [{ a: 1 }]);

      const { summary, ...rest } = evaluation;
      expect(rest).toEqual({
        breached: false,
        results: [],
      });
      expect(typeof summary).toBe("string");
      expect(summary.length).toBeGreaterThan(0);
    });
  });

  describe("evaluate() — independent evaluation across multiple rules", () => {
    test("results.length equals rules.length and every rule name appears exactly once, in input order", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "rule-one",
          field: "x",
          operator: ">",
          value: 100,
          aggregation: "sum",
          severity: "critical",
        },
        {
          name: "rule-two",
          field: "y",
          operator: "<",
          value: 0,
          aggregation: "min",
          severity: "info",
        },
        {
          name: "rule-three",
          operator: ">",
          value: 0,
          aggregation: "count",
          severity: "warning",
        },
      ];
      const rows = [
        { x: "1000", y: "5" },
        { x: "2000", y: "10" },
      ];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(evaluation.results).toHaveLength(3);
      expect(evaluation.results.map((r) => r.name)).toEqual([
        "rule-one",
        "rule-two",
        "rule-three",
      ]);
    });

    test("a breach in one rule does not omit or alter another rule's result", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "breaches",
          field: "x",
          operator: ">",
          value: 1,
          aggregation: "sum",
          severity: "critical",
        },
        {
          name: "does-not-breach",
          field: "x",
          operator: ">",
          value: 1000,
          aggregation: "sum",
          severity: "info",
        },
      ];
      const rows = [{ x: "10" }];

      const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);

      expect(
        evaluation.results.find((r) => r.name === "breaches")?.breached,
      ).toBe(true);
      expect(
        evaluation.results.find((r) => r.name === "does-not-breach")?.breached,
      ).toBe(false);
    });
  });

  describe("evaluate() — overall breached flag and severity", () => {
    test("breached is true when at least one result breaches", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "breaches",
          field: "x",
          operator: ">",
          value: 1,
          aggregation: "sum",
          severity: "warning",
        },
      ];
      const evaluation = new M3LThresholdEvaluator().evaluate(rules, [
        { x: "10" },
      ]);

      expect(evaluation.breached).toBe(true);
    });

    test("breached is false when no result breaches", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "does-not-breach",
          field: "x",
          operator: ">",
          value: 1000,
          aggregation: "sum",
          severity: "critical",
        },
      ];
      const evaluation = new M3LThresholdEvaluator().evaluate(rules, [
        { x: "10" },
      ]);

      expect(evaluation.breached).toBe(false);
    });

    test("an info-severity breach still sets the overall breached flag true (severity does not gate)", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "info-breach",
          field: "x",
          operator: ">",
          value: 1,
          aggregation: "sum",
          severity: "info",
        },
      ];
      const evaluation = new M3LThresholdEvaluator().evaluate(rules, [
        { x: "10" },
      ]);

      expect(evaluation.breached).toBe(true);
      expect(evaluation.results[0]?.severity).toBe("info");
    });
  });

  describe("evaluate() — summary", () => {
    test("summary is a non-empty string even when nothing breaches", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "quiet-rule",
          field: "x",
          operator: ">",
          value: 1000,
          aggregation: "sum",
          severity: "info",
        },
      ];
      const evaluation = new M3LThresholdEvaluator().evaluate(rules, [
        { x: "10" },
      ]);

      expect(typeof evaluation.summary).toBe("string");
      expect(evaluation.summary.length).toBeGreaterThan(0);
    });

    test("a breached rule's name is discoverable in the summary", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "discoverable-rule-name",
          field: "x",
          operator: ">",
          value: 1,
          aggregation: "sum",
          severity: "critical",
        },
      ];
      const evaluation = new M3LThresholdEvaluator().evaluate(rules, [
        { x: "10" },
      ]);

      expect(evaluation.summary).toContain("discoverable-rule-name");
    });
  });

  // ===========================================================================
  // Failure paths
  // ===========================================================================
  describe("evaluate() — failure paths", () => {
    test("throws M3LThresholdRuleValidationError for an unknown operator", () => {
      const rules = [
        {
          name: "bad-operator",
          field: "x",
          // deliberately feeding an operator value outside the documented
          // union to exercise the runtime validation guard; cast to the
          // property's own (indexed-access) type rather than `any` so no
          // eslint-disable is needed.
          operator: "~=" as M3LThresholdRule["operator"],
          value: 1,
          aggregation: "any-row",
          severity: "warning",
        },
      ] as readonly M3LThresholdRule[];

      const evaluator = new M3LThresholdEvaluator();

      expect(() => evaluator.evaluate(rules, [{ x: 1 }])).toThrow(
        M3LThresholdRuleValidationError,
      );
    });

    test("the unknown-operator error carries code ERR_ANALYSIS_INVALID_RULE and is an M3LError", () => {
      const rules = [
        {
          name: "bad-operator",
          field: "x",
          // deliberately feeding an operator value outside the documented
          // union to exercise the runtime validation guard; cast to the
          // property's own (indexed-access) type rather than `any` so no
          // eslint-disable is needed.
          operator: "~=" as M3LThresholdRule["operator"],
          value: 1,
          aggregation: "any-row",
          severity: "warning",
        },
      ] as readonly M3LThresholdRule[];

      const evaluator = new M3LThresholdEvaluator();
      let thrown: unknown;
      try {
        evaluator.evaluate(rules, [{ x: 1 }]);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(M3LThresholdRuleValidationError);
      expect(thrown).toBeInstanceOf(M3LError);
      expect((thrown as M3LThresholdRuleValidationError).code).toBe(
        "ERR_ANALYSIS_INVALID_RULE",
      );
      expect((thrown as M3LThresholdRuleValidationError).toJSON().code).toBe(
        "ERR_ANALYSIS_INVALID_RULE",
      );
    });

    test("throws M3LThresholdRuleValidationError for an unknown aggregation", () => {
      const rules = [
        {
          name: "bad-aggregation",
          field: "x",
          operator: ">",
          value: 1,
          // deliberately feeding an aggregation value outside the documented
          // union to exercise the runtime validation guard; cast to the
          // property's own (indexed-access) type rather than `any` so no
          // eslint-disable is needed.
          aggregation: "median" as M3LThresholdRule["aggregation"],
          severity: "warning",
        },
      ] as readonly M3LThresholdRule[];

      const evaluator = new M3LThresholdEvaluator();

      expect(() => evaluator.evaluate(rules, [{ x: 1 }])).toThrow(
        M3LThresholdRuleValidationError,
      );
    });

    test.each<M3LThresholdRule["aggregation"]>([
      "any-row",
      "sum",
      "avg",
      "min",
      "max",
    ])(
      "throws M3LThresholdRuleValidationError for aggregation '%s' with no field set",
      (aggregation) => {
        const rules: readonly M3LThresholdRule[] = [
          {
            name: "missing-field",
            operator: ">",
            value: 1,
            aggregation,
            severity: "warning",
          },
        ];

        const evaluator = new M3LThresholdEvaluator();

        expect(() => evaluator.evaluate(rules, [{ x: 1 }])).toThrow(
          M3LThresholdRuleValidationError,
        );
      },
    );

    test("does NOT throw for 'count' aggregation with no field set", () => {
      const rules: readonly M3LThresholdRule[] = [
        {
          name: "count-no-field",
          operator: ">",
          value: 0,
          aggregation: "count",
          severity: "info",
        },
      ];

      const evaluator = new M3LThresholdEvaluator();

      expect(() => evaluator.evaluate(rules, [{ x: 1 }])).not.toThrow();
    });

    describe("ordering operator with a non-numeric string value", () => {
      test.each<M3LThresholdRule["operator"]>([">", ">=", "<", "<="])(
        "operator '%s' with a non-numeric string value throws M3LThresholdRuleValidationError",
        (operator) => {
          const rules: readonly M3LThresholdRule[] = [
            {
              name: "bad-ordering-value",
              field: "x",
              operator,
              value: "abc",
              aggregation: "any-row",
              severity: "warning",
            },
          ];

          const evaluator = new M3LThresholdEvaluator();

          expect(() => evaluator.evaluate(rules, [{ x: 1 }])).toThrow(
            M3LThresholdRuleValidationError,
          );
        },
      );

      test("the thrown error carries code ERR_ANALYSIS_INVALID_RULE and is an M3LError", () => {
        const rules: readonly M3LThresholdRule[] = [
          {
            name: "bad-ordering-value",
            field: "x",
            operator: ">",
            value: "abc",
            aggregation: "any-row",
            severity: "warning",
          },
        ];

        const evaluator = new M3LThresholdEvaluator();
        let thrown: unknown;
        try {
          evaluator.evaluate(rules, [{ x: 1 }]);
        } catch (e) {
          thrown = e;
        }

        expect(thrown).toBeInstanceOf(M3LThresholdRuleValidationError);
        expect(thrown).toBeInstanceOf(M3LError);
        expect((thrown as M3LThresholdRuleValidationError).code).toBe(
          "ERR_ANALYSIS_INVALID_RULE",
        );
      });

      test.each<[string, number]>([
        ["5", 5],
        ["1,5", 1.5],
      ])(
        "negative control: a numeric string value %j does NOT throw (parses to %j)",
        (value) => {
          const rules: readonly M3LThresholdRule[] = [
            {
              name: "numeric-string-value",
              field: "x",
              operator: ">",
              value,
              aggregation: "any-row",
              severity: "warning",
            },
          ];

          const evaluator = new M3LThresholdEvaluator();

          expect(() => evaluator.evaluate(rules, [{ x: 100 }])).not.toThrow();
        },
      );
    });

    describe("ordering operator with a numeric string value compares numerically", () => {
      test.each<M3LThresholdRule["operator"]>([">", ">=", "<", "<="])(
        "operator '%s' with value \"5\" breaches/does not breach purely on numeric comparison",
        (operator) => {
          const rules: readonly M3LThresholdRule[] = [
            {
              name: "numeric-ordering",
              field: "n",
              operator,
              value: "5",
              aggregation: "any-row",
              severity: "warning",
            },
          ];

          const evaluator = new M3LThresholdEvaluator();

          // 10 vs 5: satisfies '>' and '>=', not '<' or '<='.
          const highEvaluation = evaluator.evaluate(rules, [{ n: 10 }]);
          // 1 vs 5: satisfies '<' and '<=', not '>' or '>='.
          const lowEvaluation = evaluator.evaluate(rules, [{ n: 1 }]);

          const expectedHighBreach = operator === ">" || operator === ">=";
          expect(highEvaluation.results[0]?.breached).toBe(expectedHighBreach);
          expect(lowEvaluation.results[0]?.breached).toBe(!expectedHighBreach);
        },
      );
    });
  });

  describe("M3LThresholdRuleValidationError — direct construction", () => {
    test("cause round-trips through the instance and toJSON()", () => {
      const underlying = new Error("boom");
      const err = new M3LThresholdRuleValidationError("bad rule", {
        cause: underlying,
      });

      expect(err.cause).toBe(underlying);
      expect(err.toJSON().cause).toBe(underlying);
    });
  });

  // ===========================================================================
  // Type-level contract
  // ===========================================================================
  describe("type-level contract", () => {
    test("evaluate() is synchronous, returning M3LThresholdEvaluation (not a Promise)", () => {
      expectTypeOf<
        M3LThresholdEvaluator["evaluate"]
      >().returns.toEqualTypeOf<M3LThresholdEvaluation>();
    });

    test("M3LThresholdEvaluation has the breached/summary/results shape", () => {
      expectTypeOf<M3LThresholdEvaluation>().toEqualTypeOf<{
        readonly breached: boolean;
        readonly summary: string;
        readonly results: readonly M3LThresholdRuleResult[];
      }>();
    });

    test("M3LThresholdRuleResult has the name/breached/severity/actual shape", () => {
      expectTypeOf<M3LThresholdRuleResult>().toMatchTypeOf<{
        name: string;
        breached: boolean;
        actual: number | null;
      }>();
    });

    test("M3LThresholdRule requires name/operator/value/aggregation/severity and an optional field", () => {
      expectTypeOf<M3LThresholdRule>().toMatchTypeOf<{
        name: string;
        field?: string;
        value: string | number;
      }>();
    });

    test("M3LThresholdEvaluator has a zero-arg constructor", () => {
      expectTypeOf(M3LThresholdEvaluator).instance.toEqualTypeOf<
        InstanceType<typeof M3LThresholdEvaluator>
      >();
      expect(() => new M3LThresholdEvaluator()).not.toThrow();
    });

    test("M3LThresholdRuleValidationError is an M3LError subclass", () => {
      expectTypeOf<M3LThresholdRuleValidationError>().toMatchTypeOf<M3LError>();
    });
  });
});

// =============================================================================
// parseLocaleNumber (core/utils)
// =============================================================================
describe("parseLocaleNumber", () => {
  test.each<[string, number]>([
    ["1.5", 1.5],
    ["42", 42],
    ["-3.25", -3.25],
    ["1,5", 1.5],
    ["1,000", 1],
  ])("parses %j as %j", (input, expected) => {
    expect(parseLocaleNumber(input)).toBeCloseTo(expected);
  });

  test("returns NaN for a non-numeric string, never throwing", () => {
    expect(() => parseLocaleNumber("abc")).not.toThrow();
    expect(Number.isNaN(parseLocaleNumber("abc"))).toBe(true);
  });

  test("returns NaN for an empty string", () => {
    expect(Number.isNaN(parseLocaleNumber(""))).toBe(true);
  });

  test("a lone comma is treated purely as a decimal separator, not thousands grouping", () => {
    // "1,000" must parse to 1 (comma = decimal point), NOT 1000.
    expect(parseLocaleNumber("1,000")).toBeCloseTo(1);
  });

  describe("type-level contract", () => {
    test("accepts a string and returns a number", () => {
      expectTypeOf(parseLocaleNumber).parameter(0).toBeString();
      expectTypeOf(parseLocaleNumber).returns.toBeNumber();
    });
  });
});
