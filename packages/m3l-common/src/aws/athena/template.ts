/**
 * `aws/athena/template` — compiles a SQL template written with named
 * `:identifier` placeholders into Athena/Trino's positional
 * `?`/`ExecutionParameters` shape. See the "Named-placeholder query
 * templating" section of `docs/reference/aws/athena.md` for the full
 * scanning/validation contract.
 *
 * @packageDocumentation
 */

import { M3LAthenaTemplateError } from "./errors.js";

/** Matches the first character of a placeholder identifier (`:name`). */
const IDENTIFIER_START_PATTERN = /[A-Za-z_]/;
/** Matches every subsequent character of a placeholder identifier. */
const IDENTIFIER_PART_PATTERN = /[A-Za-z0-9_]/;
/** Length, in characters, of a two-character token (`''` escape, `::` cast). */
const TWO_CHAR_TOKEN_LENGTH = 2;

/**
 * The result of {@link compileAthenaQueryTemplate}: a positional-parameter
 * query ready for `StartAthenaQueryInput.queryString`/`.executionParameters`.
 */
export interface M3LAthenaCompiledQuery {
  /** `template` with every top-level `:name` placeholder replaced by a positional `?`. */
  readonly queryString: string;
  /** One value per `?`, in source order — a repeated placeholder contributes one entry per occurrence. */
  readonly executionParameters: readonly string[];
}

/** The outcome of one left-to-right scan of a template. */
interface TemplateScan {
  /** The template with every placeholder replaced by `?`. */
  readonly queryString: string;
  /** Every placeholder name encountered, in source order, one entry per occurrence. */
  readonly occurrences: readonly string[];
}

/** One step of {@link scanTemplate}'s left-to-right scan. */
interface ScanStep {
  /** Text to append to the rewritten `queryString` for this step. */
  readonly text: string;
  /** Index to resume scanning from. */
  readonly nextIndex: number;
  /** Whether the scan is inside a single-quoted string literal after this step. */
  readonly nextInString: boolean;
  /** A placeholder name resolved by this step, if any. */
  readonly occurrence?: string;
}

/**
 * Reads one placeholder identifier starting at `start` (the character after
 * the leading `:`), matching `[A-Za-z0-9_]*`.
 *
 * @param template - The SQL text being scanned.
 * @param start - Index of the first identifier character.
 * @returns The identifier `name` and the index of the first character after it.
 */
function scanIdentifier(
  template: string,
  start: number,
): { readonly name: string; readonly nextIndex: number } {
  let index = start;
  let name = "";
  while (IDENTIFIER_PART_PATTERN.test(template.charAt(index))) {
    name += template.charAt(index);
    index += 1;
  }
  return { name, nextIndex: index };
}

/**
 * Scans one character while inside a single-quoted string literal: handles
 * the `''` escaped-quote convention and the literal's closing `'`.
 *
 * @param template - The SQL text being scanned.
 * @param i - Index of the current character.
 * @returns The step's appended text, resume index, and next in-string state.
 */
function scanInStringChar(template: string, i: number): ScanStep {
  const char = template.charAt(i);
  if (char === "'" && template.charAt(i + 1) === "'") {
    return {
      text: "''",
      nextIndex: i + TWO_CHAR_TOKEN_LENGTH,
      nextInString: true,
    };
  }
  if (char === "'") {
    return { text: char, nextIndex: i + 1, nextInString: false };
  }
  return { text: char, nextIndex: i + 1, nextInString: true };
}

/**
 * Scans one character outside a string literal: opens a string literal on
 * `'`, passes the Presto/Trino `::` cast operator through untouched, resolves
 * a `:name` placeholder to `?`, and otherwise copies the character through.
 *
 * @param template - The SQL text being scanned.
 * @param i - Index of the current character.
 * @returns The step's appended text, resume index, next in-string state, and
 *   a resolved placeholder `occurrence` if this step matched one.
 */
function scanOutsideStringChar(template: string, i: number): ScanStep {
  const char = template.charAt(i);
  if (char === "'") {
    return { text: char, nextIndex: i + 1, nextInString: true };
  }
  if (char === ":" && template.charAt(i + 1) === ":") {
    return {
      text: "::",
      nextIndex: i + TWO_CHAR_TOKEN_LENGTH,
      nextInString: false,
    };
  }
  if (char === ":" && IDENTIFIER_START_PATTERN.test(template.charAt(i + 1))) {
    const { name, nextIndex } = scanIdentifier(template, i + 1);
    return { text: "?", nextIndex, nextInString: false, occurrence: name };
  }
  if (char === "?") {
    // Every `?` in the compiled queryString must originate from this
    // compiler's own placeholder substitution, or Athena's positional
    // binding silently misaligns (a pre-existing `?` in the template
    // consumes a position, shifting every subsequent placeholder's bound
    // value by one). Reject as soon as it is seen, independent of what
    // `parameters` was passed — this is a structural rejection, not a
    // name-mismatch one, so both mismatch arrays are empty.
    throw new M3LAthenaTemplateError(
      'compileAthenaQueryTemplate: template contains a literal "?" outside a string literal, which would misalign positional execution parameters',
      { missingParameters: [], unusedParameters: [] },
    );
  }
  return { text: char, nextIndex: i + 1, nextInString: false };
}

/**
 * Single left-to-right scan over `template`, tracking single-quoted string
 * literal state and replacing every top-level `:name` placeholder with `?`.
 * A placeholder inside a single-quoted literal is left untouched (the
 * standard SQL `''` escaped-quote convention is understood); the Presto/Trino
 * `::` cast operator is never mistaken for a placeholder start, inside or
 * outside a literal. SQL comments and double-quoted identifiers receive no
 * special treatment — this is a lightweight template compiler, not a SQL
 * tokenizer.
 *
 * @param template - The SQL text to scan.
 * @returns The rewritten `queryString` plus every placeholder `name` encountered, in order.
 */
function scanTemplate(template: string): TemplateScan {
  let queryString = "";
  const occurrences: string[] = [];
  let inString = false;
  let i = 0;

  while (i < template.length) {
    const step: ScanStep = inString
      ? scanInStringChar(template, i)
      : scanOutsideStringChar(template, i);
    queryString += step.text;
    if (step.occurrence !== undefined) {
      occurrences.push(step.occurrence);
    }
    inString = step.nextInString;
    i = step.nextIndex;
  }

  return { queryString, occurrences };
}

/**
 * Returns the distinct names in `names`, in first-occurrence order.
 *
 * @param names - Placeholder names, possibly with duplicates.
 * @returns The distinct names, first-occurrence order preserved.
 */
function distinctInOrder(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

/**
 * Validates that `occurrences` and `parameters` match 1:1 in both
 * directions, throwing a single {@link M3LAthenaTemplateError} carrying both
 * mismatch arrays when either is non-empty. Uses `Object.hasOwn` (never
 * bracket-index presence) so a placeholder named after an inherited
 * `Object.prototype` property (e.g. `:constructor`) is never silently
 * resolved.
 *
 * @param occurrences - Every placeholder name referenced in the template, in source order.
 * @param parameters - The caller's parameter values.
 * @throws {@link M3LAthenaTemplateError} if a referenced name has no matching
 *   parameter, or a parameter is never referenced.
 */
function validateOccurrences(
  occurrences: readonly string[],
  parameters: Readonly<Record<string, string>>,
): void {
  const missingParameters = distinctInOrder(occurrences).filter(
    (name) => !Object.hasOwn(parameters, name),
  );
  const referencedNames = new Set(occurrences);
  const unusedParameters = Object.keys(parameters).filter(
    (name) => !referencedNames.has(name),
  );

  if (missingParameters.length > 0 || unusedParameters.length > 0) {
    throw new M3LAthenaTemplateError(
      "compileAthenaQueryTemplate: template placeholders and parameters do not match 1:1",
      { missingParameters, unusedParameters },
    );
  }
}

/**
 * Reads `parameters[name]`, safe under `noUncheckedIndexedAccess` without a
 * non-null assertion. Only ever called after {@link validateOccurrences} has
 * already proven `name` is an own key of `parameters` via `Object.hasOwn`.
 *
 * @param parameters - The caller's parameter values.
 * @param name - A placeholder name already proven present in `parameters`.
 * @throws {@link M3LAthenaTemplateError} if `name` is somehow absent —
 *   unreachable given the caller's validation guarantee.
 */
function readParameterValue(
  parameters: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = parameters[name];
  if (value === undefined) {
    /* istanbul ignore next -- unreachable: validateOccurrences already
       proved every occurrence name is an own key of parameters via
       Object.hasOwn before this function is ever called. */
    throw new M3LAthenaTemplateError(
      `compileAthenaQueryTemplate: parameter "${name}" resolved to undefined after validation`,
      { missingParameters: [name], unusedParameters: [] },
    );
  }
  return value;
}

/**
 * Compiles a SQL template written with named `:identifier` placeholders
 * into Athena/Trino's positional `?`/`ExecutionParameters` shape, since
 * `ExecutionParameters` are positional (values supplied in order) and thus
 * awkward for a query with several parameters — reordering a `?` in the SQL
 * text would silently misalign the values array.
 *
 * A placeholder is `:` immediately followed by an identifier matching
 * `[A-Za-z_][A-Za-z0-9_]*`. A placeholder repeated multiple times compiles
 * to one `?`/parameter-value pair **per occurrence**, in source order. Fails
 * loud, never partially compiling: every `:name` referenced in `template`
 * must have a matching key in `parameters`, and every key in `parameters`
 * must be referenced at least once in `template`.
 *
 * @param template - SQL text with `:name` placeholders.
 * @param parameters - One value per placeholder name referenced in `template`.
 * @returns The compiled `{ queryString, executionParameters }` pair.
 * @throws {@link M3LAthenaTemplateError} for one of two distinct conditions:
 *   (1) a `:name` in `template` has no matching key in `parameters`, or a key
 *   in `parameters` is never referenced in `template` — both directions are
 *   checked, and both mismatch arrays are computed, with at least one
 *   non-empty; or (2) a literal `?` is scanned outside single-quote state,
 *   which would misalign positional execution parameters — a structural
 *   rejection unrelated to name matching, so both mismatch arrays are empty
 *   and the message names the literal `?` as the cause instead.
 *
 * @example
 * ```ts
 * import { compileAthenaQueryTemplate } from "@m3l-automation/m3l-common/aws";
 *
 * const compiled = compileAthenaQueryTemplate(
 *   "SELECT * FROM logs WHERE region = :region AND day = :day",
 *   { region: "us-east-1", day: "2026-08-11" },
 * );
 * // compiled.queryString === "SELECT * FROM logs WHERE region = ? AND day = ?"
 * // compiled.executionParameters === ["us-east-1", "2026-08-11"]
 * ```
 */
export function compileAthenaQueryTemplate(
  template: string,
  parameters: Readonly<Record<string, string>>,
): M3LAthenaCompiledQuery {
  const { queryString, occurrences } = scanTemplate(template);
  validateOccurrences(occurrences, parameters);

  return {
    queryString,
    executionParameters: occurrences.map((name) =>
      readParameterValue(parameters, name),
    ),
  };
}
