/**
 * Parses the `m3l` CLI's `--json` envelopes into typed rows. Only `doctor`
 * ships in this slice (V10c); {@link ParseResult} and
 * {@link EnvelopeParseFailure} are shaped as a closed set precisely so a
 * later slice (V10f/V10g) can add `list`/`inspect`/`run` parsers alongside
 * `parseDoctorChecks` without reshaping either type.
 *
 * The one invariant every function here upholds: a parse failure is a fixed
 * token from {@link EnvelopeParseFailure}, never any part of the offending
 * input. Raw CLI stdout may carry caller data, and this parser's output can
 * reach a model verbatim in a later slice — so a `JSON.parse` failure's
 * `SyntaxError.message` (which echoes the source text) is deliberately
 * discarded rather than surfaced, and every row-level check reports only
 * which kind of thing went wrong, never the value that went wrong.
 *
 * @packageDocumentation
 */
import { Core } from "@monte3l/m3l-common";

/**
 * The closed set of reasons a parse in this module can fail for. Every
 * member is a fixed token — none of them, ever, carries a fragment of the
 * input that triggered it. A future envelope (`list`, `inspect`, `run`)
 * extends this union rather than reusing an existing member for an
 * unrelated cause.
 */
export type EnvelopeParseFailure =
  | "not-json"
  | "not-an-array"
  | "row-not-an-object"
  | "missing-field"
  | "field-not-a-string"
  | "unknown-status";

/**
 * The outcome of any parse in this module: either the typed value, or a
 * fixed {@link EnvelopeParseFailure} token. Generic over the success value
 * so `parseJsonText` (returns `unknown`) and `parseDoctorChecks` (returns a
 * typed row array) — and every parser V10f/V10g adds — share one shape.
 *
 * @example
 * ```ts
 * import type { ParseResult } from "./envelopes.js";
 *
 * function describe(result: ParseResult<number>): string {
 *   return result.ok ? String(result.value) : result.reason;
 * }
 * ```
 */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: EnvelopeParseFailure };

/**
 * One row of `m3l doctor --json`'s output, mirroring
 * `packages/m3l-cli/src/commands/doctor.ts`'s `M3LCliDoctorCheck` exactly —
 * that module, not this one, is the authority on the shape.
 */
export interface M3LMcpDoctorCheck {
  /** The check's stable identifier, e.g. `"node-version"`. */
  readonly name: string;
  /** The check's outcome. */
  readonly status: "ok" | "warn" | "fail";
  /** A human-readable explanation of the outcome. */
  readonly detail: string;
}

/** The exact set of statuses `m3l doctor` may emit today. */
const KNOWN_DOCTOR_STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "warn",
  "fail",
]);

/**
 * Narrows `value` to a known doctor status. Deliberately a set membership
 * check rather than a coercion: a status the CLI didn't emit before (a
 * future addition, or a truncated/corrupted stream) must surface as
 * `"unknown-status"`, never be silently folded into `"fail"`.
 */
function isKnownDoctorStatus(
  value: string,
): value is M3LMcpDoctorCheck["status"] {
  return KNOWN_DOCTOR_STATUSES.has(value);
}

/**
 * Reads `key` off `row` exactly once into a local and validates that local —
 * never a two-read `typeof row[key] === "string" ? row[key] : ...`, which
 * re-invokes an attacker-controlled getter between the check and the use.
 * Distinguishes "the key is absent" from "the key holds the wrong type" so
 * callers can report the more specific of `"missing-field"` /
 * `"field-not-a-string"`.
 */
function readRequiredStringField(
  row: Readonly<Record<string, unknown>>,
  key: "name" | "status" | "detail",
): ParseResult<string> {
  if (!Object.hasOwn(row, key)) {
    return { ok: false, reason: "missing-field" };
  }
  const value = row[key];
  if (typeof value !== "string") {
    return { ok: false, reason: "field-not-a-string" };
  }
  return { ok: true, value };
}

/**
 * Parses one candidate array element into a {@link M3LMcpDoctorCheck}.
 * Screens with {@link Core.isPlainObject} (never a bare
 * `typeof x === "object"`) so a row whose own prototype was replaced via
 * object-literal `__proto__` syntax is rejected before any field is read.
 * The returned success value is always a freshly built object literal —
 * never a spread of `row` — so an own `"__proto__"` data property (the
 * `JSON.parse`-produced kind, which does not alter the row's prototype) can
 * never ride along into the parsed output.
 */
function parseDoctorCheckRow(row: unknown): ParseResult<M3LMcpDoctorCheck> {
  if (!Core.isPlainObject(row)) {
    return { ok: false, reason: "row-not-an-object" };
  }

  const name = readRequiredStringField(row, "name");
  if (!name.ok) return name;
  const status = readRequiredStringField(row, "status");
  if (!status.ok) return status;
  const detail = readRequiredStringField(row, "detail");
  if (!detail.ok) return detail;

  if (!isKnownDoctorStatus(status.value)) {
    return { ok: false, reason: "unknown-status" };
  }

  return {
    ok: true,
    value: { name: name.value, status: status.value, detail: detail.value },
  };
}

/**
 * Parses raw text as JSON without ever surfacing the text itself. On a
 * `JSON.parse` throw this returns the fixed `"not-json"` token — the caught
 * `SyntaxError`'s `message` embeds the source text and is deliberately
 * discarded, never read into the result.
 *
 * @param raw - The CLI's raw stdout (or any other JSON-bearing text).
 * @returns `{ ok: true, value }` with the parsed value (still `unknown` —
 * shape validation is a separate step, e.g. {@link parseDoctorChecks}), or
 * `{ ok: false, reason: "not-json" }`.
 * @example
 * ```ts
 * import { parseJsonText } from "./envelopes.js";
 *
 * const result = parseJsonText('{"a":1}');
 * if (result.ok) {
 *   console.log(result.value);
 * }
 * ```
 */
export function parseJsonText(raw: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "not-json" };
  }
}

/**
 * Parses `input` — the value already produced by {@link parseJsonText} (or
 * any other JSON source) — into `m3l doctor --json`'s row array. The
 * producer, `packages/m3l-cli/src/commands/doctor.ts`, emits a bare array
 * with no wrapper object; a JSON object, or any other non-array value, is
 * `"not-an-array"`.
 *
 * An empty array is a success, not a failure — `m3l doctor` legitimately
 * reports zero checks in some configurations. Every non-empty input is
 * validated row by row; the first invalid row's failure reason is returned
 * immediately, and the returned success array is frozen so a caller cannot
 * mutate a previously parsed result out from under a later reader.
 *
 * @param input - A parsed JSON value, typically `parseJsonText(...).value`.
 * @returns `{ ok: true, value }` with a frozen, typed row array, or
 * `{ ok: false, reason }` naming the first structural problem found.
 * @example
 * ```ts
 * import {
 *   parseDoctorChecks,
 *   parseJsonText,
 * } from "./envelopes.js";
 *
 * const parsed = parseJsonText(stdout);
 * const result = parsed.ok
 *   ? parseDoctorChecks(parsed.value)
 *   : { ok: false as const, reason: parsed.reason };
 * ```
 */
export function parseDoctorChecks(
  input: unknown,
): ParseResult<readonly M3LMcpDoctorCheck[]> {
  if (!Array.isArray(input)) {
    return { ok: false, reason: "not-an-array" };
  }

  const rows: M3LMcpDoctorCheck[] = [];
  for (const candidate of input) {
    const parsed = parseDoctorCheckRow(candidate);
    if (!parsed.ok) return parsed;
    rows.push(parsed.value);
  }

  return { ok: true, value: Object.freeze(rows) };
}
