/**
 * `core/analysis/M3LThresholdEvaluator` — declarative threshold evaluation
 * over tabular data.
 *
 * @packageDocumentation
 */

import { parseLocaleNumber } from "../utils/index.js";
import { M3LThresholdRuleValidationError } from "./M3LThresholdRuleValidationError.js";

/** Comparison operators a {@link M3LThresholdRule} may use. */
export type M3LThresholdOperator = ">" | ">=" | "<" | "<=" | "==" | "!=";

/** The six recognized operators, used to validate a rule at evaluation time. */
const THRESHOLD_OPERATORS: readonly M3LThresholdOperator[] = [
  ">",
  ">=",
  "<",
  "<=",
  "==",
  "!=",
];

/** How a rule collapses (or inspects) the data rows. */
export type M3LThresholdAggregation =
  "any-row" | "count" | "sum" | "avg" | "min" | "max";

/** The six recognized aggregations, used to validate a rule at evaluation time. */
const THRESHOLD_AGGREGATIONS: readonly M3LThresholdAggregation[] = [
  "any-row",
  "count",
  "sum",
  "avg",
  "min",
  "max",
];

/** Aggregations that require {@link M3LThresholdRule.field} to be set. */
const FIELD_REQUIRING_AGGREGATIONS: ReadonlySet<M3LThresholdAggregation> =
  new Set(["any-row", "sum", "avg", "min", "max"]);

/** Severity classification for a breached rule; does not gate `breached`. */
export type M3LThresholdSeverity = "info" | "warning" | "critical";

/**
 * Declarative definition of a single threshold check over tabular data.
 *
 * @example
 * ```typescript
 * import type { M3LThresholdRule } from "@m3l-automation/m3l-common/core";
 *
 * const rule: M3LThresholdRule = {
 *   name: "error-rate-too-high",
 *   field: "errorRate",
 *   operator: ">",
 *   value: 0.05,
 *   aggregation: "avg",
 *   severity: "critical",
 * };
 * ```
 */
export interface M3LThresholdRule {
  /** Identifier for the rule; appears in results and the evaluation summary. */
  readonly name: string;
  /**
   * The column name the rule reads. Required for every aggregation except
   * `"count"`, which does not read a field.
   */
  readonly field?: string;
  /** The comparison operator applied against {@link value}. */
  readonly operator: M3LThresholdOperator;
  /** The threshold value compared against the row(s) or aggregate. */
  readonly value: string | number;
  /** How the rows are reduced (or inspected) before comparison. */
  readonly aggregation: M3LThresholdAggregation;
  /** Severity classification; does not affect the overall `breached` flag. */
  readonly severity: M3LThresholdSeverity;
}

/**
 * Outcome of evaluating a single {@link M3LThresholdRule}.
 *
 * @example
 * ```typescript
 * import type { M3LThresholdRuleResult } from "@m3l-automation/m3l-common/core";
 *
 * const result: M3LThresholdRuleResult = {
 *   name: "error-rate-too-high",
 *   breached: true,
 *   severity: "critical",
 *   actual: 0.12,
 * };
 * ```
 */
export interface M3LThresholdRuleResult {
  /** The name of the rule this result was produced from. */
  readonly name: string;
  /** Whether this rule's operator+value comparison matched. */
  readonly breached: boolean;
  /** The rule's severity, carried through unchanged. */
  readonly severity: M3LThresholdSeverity;
  /**
   * The aggregate value the operator was compared against, or `null` when no
   * single aggregate applies (`"any-row"`, or an empty reducer input for
   * `"avg"` / `"min"` / `"max"`).
   */
  readonly actual: number | null;
}

/**
 * Overall outcome of evaluating a set of rules against a set of rows.
 *
 * @example
 * ```typescript
 * import type { M3LThresholdEvaluation } from "@m3l-automation/m3l-common/core";
 *
 * function report(evaluation: M3LThresholdEvaluation): void {
 *   if (evaluation.breached) console.error(evaluation.summary);
 * }
 * ```
 */
export interface M3LThresholdEvaluation {
  /** `true` if at least one rule's result breached, regardless of severity. */
  readonly breached: boolean;
  /** A non-empty, human-readable description of the outcome. */
  readonly summary: string;
  /** One result per input rule, in input order. */
  readonly results: readonly M3LThresholdRuleResult[];
}

/**
 * Coerces a single row cell to a number for numeric comparison/aggregation.
 * Numbers pass through; strings are parsed with {@link parseLocaleNumber};
 * every other type (boolean, null, undefined, object) is treated as
 * non-numeric and yields `NaN`.
 */
function coerceCellToNumber(cell: unknown): number {
  if (typeof cell === "number") return cell;
  if (typeof cell === "string") return parseLocaleNumber(cell);
  return NaN;
}

/**
 * Coerces a rule's threshold `value` to a number, parsing string values with
 * {@link parseLocaleNumber}.
 */
function coerceThresholdToNumber(value: string | number): number {
  return typeof value === "number" ? value : parseLocaleNumber(value);
}

/**
 * Applies a numeric ordering/equality operator. Used for `any-row` numeric
 * comparisons and every reducing aggregation's final comparison.
 */
function compareNumeric(
  operator: M3LThresholdOperator,
  actual: number,
  threshold: number,
): boolean {
  switch (operator) {
    case ">":
      return actual > threshold;
    case ">=":
      return actual >= threshold;
    case "<":
      return actual < threshold;
    case "<=":
      return actual <= threshold;
    case "==":
      return actual === threshold;
    case "!=":
      return actual !== threshold;
    default: {
      // Unreachable through the public evaluate() path — validateRule()
      // already rejects any operator outside THRESHOLD_OPERATORS. Kept only
      // so adding a new operator to the union is a compile-time error here.
      const exhaustive: never = operator;
      throw new M3LThresholdRuleValidationError(
        `unhandled threshold operator: ${String(exhaustive)}`,
      );
    }
  }
}

/** Returns `true` for the four ordering operators, which always compare numerically. */
function isOrderingOperator(operator: M3LThresholdOperator): boolean {
  return (
    operator === ">" ||
    operator === ">=" ||
    operator === "<" ||
    operator === "<="
  );
}

/**
 * Validates that an ordering operator's `value` is numeric (or a numeric
 * string). Ordering operators always compare numerically, so a non-numeric
 * string `value` is a rule-authorship error, not tabular-data noise — it must
 * fail loud here rather than silently comparing against `NaN` (always
 * `false`) at evaluation time. `==`/`!=` are exempt: they support
 * string-equality semantics for a string `value`, so no numeric value is
 * required there.
 */
function validateOrderingValue(rule: M3LThresholdRule): void {
  if (
    isOrderingOperator(rule.operator) &&
    typeof rule.value === "string" &&
    Number.isNaN(parseLocaleNumber(rule.value))
  ) {
    throw new M3LThresholdRuleValidationError(
      `rule "${rule.name}" uses ordering operator "${rule.operator}" with a non-numeric value: ${JSON.stringify(rule.value)}`,
      {
        context: {
          name: rule.name,
          operator: rule.operator,
          value: rule.value,
        },
      },
    );
  }
}

/**
 * Validates a single rule's `operator`, `aggregation`, the field-requirement
 * invariant, and (for ordering operators) that `value` is numeric. Throws
 * {@link M3LThresholdRuleValidationError} on any violation; otherwise returns
 * nothing.
 */
function validateRule(rule: M3LThresholdRule): void {
  if (!THRESHOLD_OPERATORS.includes(rule.operator)) {
    throw new M3LThresholdRuleValidationError(
      `rule "${rule.name}" has an unrecognized operator: ${JSON.stringify(rule.operator)}`,
      { context: { name: rule.name, operator: rule.operator } },
    );
  }

  if (!THRESHOLD_AGGREGATIONS.includes(rule.aggregation)) {
    throw new M3LThresholdRuleValidationError(
      `rule "${rule.name}" has an unrecognized aggregation: ${JSON.stringify(rule.aggregation)}`,
      { context: { name: rule.name, aggregation: rule.aggregation } },
    );
  }

  if (
    FIELD_REQUIRING_AGGREGATIONS.has(rule.aggregation) &&
    (rule.field === undefined || rule.field === "")
  ) {
    throw new M3LThresholdRuleValidationError(
      `rule "${rule.name}" uses aggregation "${rule.aggregation}", which requires a "field"`,
      { context: { name: rule.name, aggregation: rule.aggregation } },
    );
  }

  validateOrderingValue(rule);
}

/**
 * Evaluates the `"any-row"` aggregation: breached iff at least one row's
 * `field` cell satisfies `operator` against `value`.
 */
function evaluateAnyRow(
  rule: M3LThresholdRule,
  field: string,
  rows: readonly Record<string, unknown>[],
): boolean {
  return rows.some((row) => matchesRow(rule, field, row));
}

/** Applies a single rule's operator+value comparison to one row's cell. */
function matchesRow(
  rule: M3LThresholdRule,
  field: string,
  row: Record<string, unknown>,
): boolean {
  const cell: unknown = row[field];

  if (
    (rule.operator === "==" || rule.operator === "!=") &&
    typeof rule.value === "string"
  ) {
    const isEqual = String(cell) === rule.value;
    return rule.operator === "==" ? isEqual : !isEqual;
  }

  const actual = coerceCellToNumber(cell);
  if (Number.isNaN(actual)) return false;

  const threshold = coerceThresholdToNumber(rule.value);
  return compareNumeric(rule.operator, actual, threshold);
}

/** Reduces a field column to the numeric cells only, skipping non-numeric ones. */
function numericColumn(
  field: string,
  rows: readonly Record<string, unknown>[],
): readonly number[] {
  const values: number[] = [];
  for (const row of rows) {
    const n = coerceCellToNumber(row[field]);
    if (!Number.isNaN(n)) values.push(n);
  }
  return values;
}

/** The subset of {@link M3LThresholdAggregation} handled by {@link reduceAggregate}. */
type ReducingAggregation = Exclude<M3LThresholdAggregation, "any-row">;

/**
 * Evaluates a reducing aggregation (`count`/`sum`/`avg`/`min`/`max`) and
 * returns its `actual` value; `null` means "no aggregate available", which
 * the caller treats as not-breached.
 */
function reduceAggregate(
  aggregation: ReducingAggregation,
  field: string | undefined,
  rows: readonly Record<string, unknown>[],
): number | null {
  if (aggregation === "count") return rows.length;

  // Every other reducing aggregation is field-requiring; validateRule()
  // already guarantees `field` is set here.
  const values = numericColumn(field ?? "", rows);

  switch (aggregation) {
    case "sum":
      return values.reduce((acc, v) => acc + v, 0);
    case "avg":
      return values.length === 0
        ? null
        : values.reduce((acc, v) => acc + v, 0) / values.length;
    case "min":
      return values.length === 0 ? null : Math.min(...values);
    case "max":
      return values.length === 0 ? null : Math.max(...values);
    default: {
      // Unreachable through the public evaluate() path — validateRule()
      // already rejects any aggregation outside THRESHOLD_AGGREGATIONS, and
      // ReducingAggregation excludes "any-row" at the type level. Kept only
      // so adding a new aggregation to the union is a compile-time error here.
      const exhaustive: never = aggregation;
      throw new M3LThresholdRuleValidationError(
        `unhandled reducing aggregation: ${String(exhaustive)}`,
      );
    }
  }
}

/** Evaluates a single already-validated rule and returns its result. */
function evaluateRule(
  rule: M3LThresholdRule,
  rows: readonly Record<string, unknown>[],
): M3LThresholdRuleResult {
  if (rule.aggregation === "any-row") {
    // validateRule() guarantees `rule.field` is set for "any-row".
    const field = rule.field ?? "";
    return {
      name: rule.name,
      breached: evaluateAnyRow(rule, field, rows),
      severity: rule.severity,
      actual: null,
    };
  }

  const actual = reduceAggregate(rule.aggregation, rule.field, rows);
  const breached =
    actual === null
      ? false
      : compareNumeric(
          rule.operator,
          actual,
          coerceThresholdToNumber(rule.value),
        );

  return { name: rule.name, breached, severity: rule.severity, actual };
}

/** Builds the non-empty, deterministic summary string for an evaluation. */
function buildSummary(results: readonly M3LThresholdRuleResult[]): string {
  const breachedNames = results.filter((r) => r.breached).map((r) => r.name);

  if (breachedNames.length === 0) {
    return results.length === 0
      ? "no rules evaluated"
      : `no thresholds breached (${String(results.length)} rule(s) evaluated)`;
  }

  return `${String(breachedNames.length)} threshold(s) breached: ${breachedNames.join(", ")}`;
}

/**
 * Applies a set of {@link M3LThresholdRule} definitions to an array of data
 * rows and reports which rules were breached.
 *
 * Each rule is evaluated independently: every rule produces exactly one
 * {@link M3LThresholdRuleResult}, in input order, with no short-circuiting on
 * an earlier breach. The overall {@link M3LThresholdEvaluation.breached} flag
 * is set whenever at least one result breached, regardless of severity.
 *
 * @example
 * ```typescript
 * import { M3LThresholdEvaluator } from "@m3l-automation/m3l-common/core";
 * import type { M3LThresholdRule } from "@m3l-automation/m3l-common/core";
 *
 * const rules: M3LThresholdRule[] = [
 *   {
 *     name: "error-rate-too-high",
 *     field: "errorRate",
 *     operator: ">",
 *     value: 0.05,
 *     aggregation: "avg",
 *     severity: "critical",
 *   },
 *   {
 *     name: "any-failed-row",
 *     field: "status",
 *     operator: "==",
 *     value: "FAILED",
 *     aggregation: "any-row",
 *     severity: "warning",
 *   },
 * ];
 *
 * const rows = [{ errorRate: "0.1", status: "OK" }];
 * const evaluation = new M3LThresholdEvaluator().evaluate(rules, rows);
 *
 * if (evaluation.breached) {
 *   console.error(evaluation.summary);
 * }
 * ```
 */
export class M3LThresholdEvaluator {
  /**
   * Evaluates `rules` against `rows`, synchronously.
   *
   * Rules are validated before evaluation: an unrecognized `operator`, an
   * unrecognized `aggregation`, or a field-requiring aggregation
   * (`any-row`/`sum`/`avg`/`min`/`max`) with no `field` set throws
   * {@link M3LThresholdRuleValidationError}. `count` is the only aggregation
   * that does not require `field`.
   *
   * @param rules - The threshold rules to evaluate, in the order results
   *   should appear.
   * @param rows - The tabular data rows to evaluate the rules against.
   * @returns The overall evaluation: `breached`, `summary`, and one
   *   {@link M3LThresholdRuleResult} per input rule.
   */
  evaluate(
    rules: readonly M3LThresholdRule[],
    rows: readonly Record<string, unknown>[],
  ): M3LThresholdEvaluation {
    for (const rule of rules) validateRule(rule);

    const results = rules.map((rule) => evaluateRule(rule, rows));
    const breached = results.some((r) => r.breached);

    return { breached, summary: buildSummary(results), results };
  }
}
