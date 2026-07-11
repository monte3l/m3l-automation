import { Core } from "@m3l-automation/m3l-common";

/** The finite set of comparison operators a filter rule may use. */
type FilterOp = "eq" | "ne" | "contains" | "regex" | "gt" | "lt" | "exists";

/** A single parsed `path op value` filter rule. */
interface FilterRule {
  readonly path: string;
  readonly op: FilterOp;
  readonly value: string;
  /**
   * The `regex` operator's `value` compiled once at parse time, so a
   * malformed pattern is rejected up front and evaluation never recompiles
   * per record. `undefined` for every other operator.
   */
  readonly compiledRegex: RegExp | undefined;
}

const FILTER_OPS: readonly FilterOp[] = [
  "eq",
  "ne",
  "contains",
  "regex",
  "gt",
  "lt",
  "exists",
];

/**
 * Parses a `filters` entry (`"path op value"`) into its path, operator, and
 * value, fully validating it up front so a malformed rule fails before any
 * record is read (matching the guard-before-IO pattern the pipeline uses
 * elsewhere). The value may itself contain whitespace (e.g. a `contains`
 * phrase), so only the first two whitespace-separated tokens are taken as
 * `path` and `op`; everything after is rejoined as `value`.
 *
 * `gt`/`lt` require the rule's own literal `value` to be
 * `Core.parseLocaleNumber`-parseable (a record field being non-numeric is
 * legitimate external-data leniency handled at evaluation time; the rule's
 * literal is a config error). `regex` compiles `value` once here and caches
 * the `RegExp` on the returned rule, so evaluation never recompiles it per
 * record.
 *
 * @param rule - The raw `path op value` rule string.
 * @returns The parsed rule.
 * @throws {@link Core.M3LError} When `rule` does not name a recognized
 *   operator, a `gt`/`lt` literal is not a parseable number, or a `regex`
 *   pattern fails to compile — a malformed filter rule is a caller/config
 *   error, not tolerable external data.
 */
function parseFilterRule(rule: string): FilterRule {
  const [path, op, ...rest] = rule.trim().split(/\s+/);
  if (path === undefined || op === undefined || !isFilterOp(op)) {
    throw new Core.M3LError(`invalid filter rule: '${rule}'`, {
      code: "ERR_JSON_ETL_FILTER_RULE",
      context: { rule },
    });
  }
  const value = rest.join(" ");

  if (op === "gt" || op === "lt") {
    if (Number.isNaN(Core.parseLocaleNumber(value))) {
      throw new Core.M3LError(
        `invalid filter rule: '${rule}' (comparison value is not a number)`,
        { code: "ERR_JSON_ETL_FILTER_RULE", context: { rule } },
      );
    }
    return { path, op, value, compiledRegex: undefined };
  }

  if (op === "regex") {
    try {
      return { path, op, value, compiledRegex: new RegExp(value) };
    } catch (cause) {
      throw new Core.M3LError(
        `invalid filter rule: '${rule}' (pattern failed to compile)`,
        { code: "ERR_JSON_ETL_FILTER_RULE", context: { rule }, cause },
      );
    }
  }

  return { path, op, value, compiledRegex: undefined };
}

/**
 * Narrows an unvalidated operator token to {@link FilterOp}.
 *
 * @param op - The candidate operator token.
 * @returns Whether `op` is one of the recognized operators.
 */
function isFilterOp(op: string): op is FilterOp {
  return (FILTER_OPS as readonly string[]).includes(op);
}

/**
 * Renders a resolved field value as text for the string-based operators
 * (`eq`/`ne`/`contains`/`regex`): primitives stringify directly, and a
 * non-primitive falls back to `JSON.stringify` rather than `String()`'s
 * uninformative `"[object Object]"`.
 *
 * @param value - The raw resolved value, or `undefined` when unresolved.
 * @returns The display text, or `undefined` when `value` is `undefined`.
 */
function stringifyValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Evaluates a `gt`/`lt` comparison, parsing both operands via
 * `Core.parseLocaleNumber` and failing the comparison (rather than comparing
 * against `NaN`) when either operand is unparsable.
 *
 * @param op - `"gt"` or `"lt"`.
 * @param rawText - The record's resolved value, stringified, or `undefined`
 *   when the path resolved to nothing.
 * @param ruleValue - The rule's literal comparison operand.
 * @returns Whether the comparison holds.
 */
function evaluateNumericRule(
  op: "gt" | "lt",
  rawText: string | undefined,
  ruleValue: string,
): boolean {
  if (rawText === undefined) return false;
  const left = Core.parseLocaleNumber(rawText);
  const right = Core.parseLocaleNumber(ruleValue);
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return op === "gt" ? left > right : left < right;
}

/**
 * One evaluator per {@link FilterOp}, given the resolved raw value and the
 * whole parsed rule (so `regex` can reuse `rule.compiledRegex` instead of
 * recompiling `rule.value` per record).
 */
type FilterEvaluator = (
  rawText: string | undefined,
  raw: unknown,
  rule: FilterRule,
) => boolean;

/**
 * Every recognized filter operator's evaluation logic, keyed by
 * {@link FilterOp}. A `Record<FilterOp, …>` forces this map to stay
 * exhaustive at compile time — adding a `FilterOp` member without an entry
 * here is a type error.
 */
const FILTER_EVALUATORS: Record<FilterOp, FilterEvaluator> = {
  eq: (rawText, _raw, rule) => rawText === rule.value,
  ne: (rawText, _raw, rule) => rawText !== rule.value,
  contains: (rawText, _raw, rule) =>
    rawText !== undefined && rawText.includes(rule.value),
  regex: (rawText, _raw, rule) =>
    rawText !== undefined &&
    rule.compiledRegex !== undefined &&
    rule.compiledRegex.test(rawText),
  gt: (rawText, _raw, rule) => evaluateNumericRule("gt", rawText, rule.value),
  lt: (rawText, _raw, rule) => evaluateNumericRule("lt", rawText, rule.value),
  exists: (_rawText, raw) => raw !== undefined,
};

/**
 * Evaluates a single filter rule against `record`, comparing the value
 * resolved at `rule.path` (via `Core.navigateFieldPath`) to `rule.value`.
 *
 * @param record - The record to test.
 * @param rule - The parsed filter rule.
 * @returns Whether `record` satisfies `rule`.
 */
function evaluateRule(
  record: Record<string, unknown>,
  rule: FilterRule,
): boolean {
  const raw = Core.navigateFieldPath(record, rule.path);
  const rawText = stringifyValue(raw);
  return FILTER_EVALUATORS[rule.op](rawText, raw, rule);
}

/**
 * Yields only the records satisfying every `filters` rule (`path op value`;
 * ops `eq ne contains regex gt lt exists`) — a record must satisfy all of
 * them to pass. An empty `filters` list passes every record. Every rule is
 * parsed (and, for `regex`, compiled) up front by `parseFilterRule`, so a
 * malformed rule throws before any record is read.
 *
 * @param opts - The source records and the filter rule strings.
 * @returns An async generator yielding only the passing records, in source
 *   order.
 * @throws {@link Core.M3LError} When a `filters` entry is malformed — see
 *   `parseFilterRule`.
 *
 * @example
 * ```typescript
 * import { filterRecords } from "./filter-records.js";
 *
 * async function* records(): AsyncGenerator<Record<string, unknown>> {
 *   yield { status: "active" };
 * }
 *
 * for await (const record of filterRecords({
 *   records: records(),
 *   filters: ["status eq active"],
 * })) {
 *   // { status: "active" }
 * }
 * ```
 */
export async function* filterRecords(opts: {
  readonly records: AsyncIterable<Record<string, unknown>>;
  readonly filters: readonly string[];
}): AsyncGenerator<Record<string, unknown>> {
  const rules = opts.filters.map(parseFilterRule);

  for await (const record of opts.records) {
    if (rules.every((rule) => evaluateRule(record, rule))) {
      yield record;
    }
  }
}
