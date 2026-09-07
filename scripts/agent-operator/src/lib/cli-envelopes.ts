/**
 * `agent-operator/lib/cli-envelopes` — parses the JSON emitted by the `m3l`
 * CLI's `list --json`, `doctor --json`, `inspect <name> --json`, and
 * `run <name> --json` invocations into local mirror types, treating every
 * byte of that output as untrusted (it can be influenced by a malicious
 * script's own config declarations).
 *
 * These are parse functions, not type predicates: each one reads every field
 * through `Object.hasOwn` (never a bare index access that would walk the
 * prototype chain), wraps the whole per-row read in a `try`/`catch` so a
 * throwing getter degrades to a rejection instead of propagating, and
 * returns a *fresh, frozen* literal on success — never the parsed input
 * object itself — so a caller can never re-read attacker-controlled memory
 * and a mutated/re-triggered getter cannot disagree with what was already
 * validated.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

/** Local alias for readability; re-exported nowhere — see {@link AgentOperatorParamDescriptor}. */
type M3LConfigOperationDescriptor = Core.M3LConfigOperationDescriptor;

/**
 * The maximum number of rows any of the three array-shaped CLI outputs
 * (`list`, `doctor`, `inspect`) may contain before a parse call fails
 * closed with `"too-many-rows"`. A CLI compromised into emitting an
 * unbounded array must not be allowed to force unbounded memory use on the
 * agent-operator side. Module-private: only {@link parseArray} needs it.
 */
const MAX_ENVELOPE_ROWS = 512;

/**
 * The closed set of reasons a `cli-envelopes` parse function can fail with.
 * Deliberately closed (never a free-form `string`) so a `switch` over it can
 * be exhaustive at every call site.
 */
export type EnvelopeParseFailure =
  | "not-json"
  | "not-an-array"
  | "not-an-object"
  | "row-not-an-object"
  | "missing-field"
  | "field-wrong-type"
  | "non-finite-number"
  | "unknown-status"
  | "unsupported-schema-version"
  | "wrong-kind"
  | "too-many-rows";

/**
 * The result of a `cli-envelopes` parse function: either the parsed,
 * fresh-and-frozen value, or a closed failure reason. A discriminated union
 * on `ok` rather than a thrown error, so a caller narrows with a plain
 * `if (result.ok)` instead of a `try`/`catch`.
 *
 * @example
 * ```ts
 * import type { ParseResult } from "@m3l-automation/m3l-common/core";
 * // (illustrative import path; ParseResult itself lives in this script)
 *
 * function handle(result: ParseResult<number>): number {
 *   if (!result.ok) throw new Error(`parse failed: ${result.reason}`);
 *   return result.value;
 * }
 * ```
 */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: EnvelopeParseFailure };

/** One row of `m3l doctor --json`. */
export interface AgentOperatorDoctorCheck {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

/**
 * One row of `m3l list --json`. A discriminated union on `loadError`: a
 * script that loaded its config successfully reports a numeric
 * `parameterCount` and `loadError: null`; a script whose config failed to
 * load reports `parameterCount: null` and the load failure as `loadError`.
 */
export type AgentOperatorListRow =
  | {
      readonly name: string;
      readonly description: string;
      readonly parameterCount: number;
      readonly loadError: null;
    }
  | {
      readonly name: string;
      readonly description: string;
      readonly parameterCount: null;
      readonly loadError: string;
    };

/** One row of `m3l inspect <name> --json`. */
export interface AgentOperatorParamDescriptor {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly type: string;
  readonly required: boolean;
  readonly defaultValue: string | undefined;
  readonly description: string;
  readonly secret: boolean;
  readonly operations: readonly M3LConfigOperationDescriptor[];
}

/** The exit-code name vocabulary, derived from the registry — never retyped. */
export type AgentOperatorExitCodeName = keyof typeof Core.M3L_EXIT_CODES;

/**
 * The closed outcome vocabulary a `run --json` envelope's `outcome` field
 * carries — aliased directly to `Core.M3LRunOutcome` (rather than a
 * hand-retyped union) so the two vocabularies cannot drift: this module and
 * `core/diagnostics` describe the same event with the same word by
 * construction, not by a separately-maintained pin.
 */
export type AgentOperatorRunOutcome = Core.M3LRunOutcome;

/** The closed reason vocabulary a `run --json` envelope's `reportUnavailable` field carries. */
export type AgentOperatorReportUnavailableReason =
  | "output-directory-missing"
  | "output-directory-unreadable"
  | "no-matching-report"
  | "report-unreadable"
  | "report-malformed";

/**
 * The single-object envelope emitted by `m3l run <name> --json`. Unlike the
 * three array-shaped outputs, this one carries `kind`/`schemaVersion`
 * markers that {@link parseRunEnvelope} fails closed on.
 */
export interface AgentOperatorRunEnvelope {
  readonly kind: "m3l.run.result";
  readonly schemaVersion: 1;
  readonly script: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly exitCodeName: AgentOperatorExitCodeName | null;
  readonly outcome: AgentOperatorRunOutcome | null;
  readonly reportPath: string | null;
  readonly reportUnavailable: AgentOperatorReportUnavailableReason | null;
  readonly timelineCount: number | null;
  readonly timelineSourceCount: number | null;
  readonly recoveryTotal: number | null;
}

/**
 * The runtime set of valid exit-code names, derived once at module load
 * directly from the ADR-0035 registry (`Core.M3L_EXIT_CODES`) rather than
 * hand-retyped as a literal array, so a new exit code added to the registry
 * is recognized here with no second edit. `Object.keys` is typed `string[]`
 * regardless of the object's literal key types, so this cast narrows that
 * `string[]` back down to the registry's own key union — the standard
 * earned case for a narrowing assertion over a library-owned "as const"
 * registry, not a workaround for anything unsound.
 */
const EXIT_CODE_NAME_SET: ReadonlySet<AgentOperatorExitCodeName> = new Set(
  Object.keys(Core.M3L_EXIT_CODES) as AgentOperatorExitCodeName[],
);

/**
 * The exhaustive member table backing {@link RUN_OUTCOME_SET}, keyed off
 * {@link AgentOperatorRunOutcome} itself. Because that type is an alias of
 * `Core.M3LRunOutcome`, a sixth library outcome widens it automatically —
 * this literal then fails to compile (a missing or excess key) rather than
 * silently letting the new outcome parse as `"field-wrong-type"` at runtime.
 */
const RUN_OUTCOME_MEMBERS: Record<AgentOperatorRunOutcome, true> = {
  success: true,
  failure: true,
  "dry-run": true,
  interrupted: true,
  partial: true,
};

/** The runtime set of valid run-envelope `outcome` values, derived from {@link RUN_OUTCOME_MEMBERS}. */
const RUN_OUTCOME_SET: ReadonlySet<AgentOperatorRunOutcome> = new Set(
  Object.keys(RUN_OUTCOME_MEMBERS) as AgentOperatorRunOutcome[],
);

/**
 * The exhaustive member table backing {@link REPORT_UNAVAILABLE_SET}, keyed
 * off {@link AgentOperatorReportUnavailableReason} for the same
 * compile-linked-completeness reason as {@link RUN_OUTCOME_MEMBERS}.
 */
const REPORT_UNAVAILABLE_MEMBERS: Record<
  AgentOperatorReportUnavailableReason,
  true
> = {
  "output-directory-missing": true,
  "output-directory-unreadable": true,
  "no-matching-report": true,
  "report-unreadable": true,
  "report-malformed": true,
};

/** The runtime set of valid run-envelope `reportUnavailable` values, derived from {@link REPORT_UNAVAILABLE_MEMBERS}. */
const REPORT_UNAVAILABLE_SET: ReadonlySet<AgentOperatorReportUnavailableReason> =
  new Set(
    Object.keys(
      REPORT_UNAVAILABLE_MEMBERS,
    ) as AgentOperatorReportUnavailableReason[],
  );

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function err(reason: EnvelopeParseFailure): ParseResult<never> {
  return { ok: false, reason };
}

/** Reads an own field off `record` via `Object.hasOwn`; absent → `"missing-field"`. */
function requireOwn(
  record: Record<string, unknown>,
  key: string,
): ParseResult<unknown> {
  if (!Object.hasOwn(record, key)) return err("missing-field");
  return ok(record[key]);
}

/** Reads and type-guards an own field; a present-but-wrong-typed field fails closed. */
function requireTyped<T>(
  record: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T,
): ParseResult<T> {
  const field = requireOwn(record, key);
  if (!field.ok) return field;
  if (!guard(field.value)) return err("field-wrong-type");
  return ok(field.value);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
): ParseResult<string> {
  return requireTyped(record, key, Core.isString);
}

function requireBoolean(
  record: Record<string, unknown>,
  key: string,
): ParseResult<boolean> {
  return requireTyped(record, key, Core.isBoolean);
}

function requireFiniteNumber(
  record: Record<string, unknown>,
  key: string,
): ParseResult<number> {
  const field = requireTyped(record, key, Core.isNumber);
  if (!field.ok) return field;
  if (!Number.isFinite(field.value)) return err("non-finite-number");
  return ok(field.value);
}

function requireStringArray(
  record: Record<string, unknown>,
  key: string,
): ParseResult<readonly string[]> {
  const field = requireOwn(record, key);
  if (!field.ok) return field;
  if (!Array.isArray(field.value) || !field.value.every(Core.isString)) {
    return err("field-wrong-type");
  }
  return ok([...field.value]);
}

/** Reads an optional string field: absent key → `undefined`, present non-string → failure. */
function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): ParseResult<string | undefined> {
  if (!Object.hasOwn(record, key)) return ok(undefined);
  const value = record[key];
  if (typeof value !== "string") return err("field-wrong-type");
  return ok(value);
}

/** Reads a nullable typed field: `null` passes through, otherwise the guard applies. */
function readNullable<T>(
  record: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T,
): ParseResult<T | null> {
  const field = requireOwn(record, key);
  if (!field.ok) return field;
  if (field.value === null) return ok(null);
  if (!guard(field.value)) return err("field-wrong-type");
  return ok(field.value);
}

/** Reads a nullable finite-number field. */
function readNullableFiniteNumber(
  record: Record<string, unknown>,
  key: string,
): ParseResult<number | null> {
  const field = readNullable(record, key, Core.isNumber);
  if (!field.ok) return field;
  if (field.value !== null && !Number.isFinite(field.value)) {
    return err("non-finite-number");
  }
  return field;
}

/**
 * Reads a nullable field constrained to a fixed literal set (an enum-shaped
 * string). A present value outside `allowed` fails as `"field-wrong-type"`
 * — there is no dedicated "unrecognized literal" reason in
 * {@link EnvelopeParseFailure} for this case.
 *
 * `allowed` is bound to `T` (`ReadonlySet<T>`, not `ReadonlySet<string>`) so
 * a caller cannot pass the wrong literal set for the type parameter it
 * names — that mismatch used to compile silently and rely on a trailing type
 * assertion to paper over it. Matching by iterating `allowed` and returning
 * the matched member (rather than `Set.has` on the raw string) keeps this
 * function's return path assertion-free: each `candidate` is already typed
 * `T` from the set itself.
 */
function readNullableLiteral<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<T>,
): ParseResult<T | null> {
  const field = readNullable(record, key, Core.isString);
  if (!field.ok) return field;
  if (field.value === null) return ok(null);
  for (const candidate of allowed) {
    if (candidate === field.value) return ok(candidate);
  }
  return err("field-wrong-type");
}

/**
 * Parses raw JSON text, mapping a malformed document to a failed result
 * carrying reason `"not-json"`. Never reads the thrown `SyntaxError`'s
 * `.message` (which embeds a snippet of the offending input) and never
 * chains it as `cause` — this function's failure path carries no trace of
 * `text` at all.
 *
 * @param text - Raw text captured from a CLI child process's stdout.
 * @returns The parsed value on success, or a failed result with reason `"not-json"`.
 * @example
 * ```ts
 * import { parseJsonText } from "./cli-envelopes.js";
 *
 * const result = parseJsonText('{"a":1}');
 * if (result.ok) console.log(result.value);
 * ```
 */
export function parseJsonText(text: string): ParseResult<unknown> {
  try {
    return ok(JSON.parse(text));
  } catch {
    return err("not-json");
  }
}

/** Parses one `list --json` row, without freezing (the caller freezes the whole array). */
function parseListRow(raw: unknown): ParseResult<AgentOperatorListRow> {
  if (!Core.isPlainObject(raw)) return err("row-not-an-object");
  const name = requireString(raw, "name");
  if (!name.ok) return name;
  const description = requireString(raw, "description");
  if (!description.ok) return description;
  const parameterCount = requireOwn(raw, "parameterCount");
  if (!parameterCount.ok) return parameterCount;
  const loadError = requireOwn(raw, "loadError");
  if (!loadError.ok) return loadError;

  return buildListRow(
    name.value,
    description.value,
    parameterCount.value,
    loadError.value,
  );
}

/** Validates the `parameterCount`/`loadError` discriminated-union shape of a list row. */
function buildListRow(
  name: string,
  description: string,
  parameterCountRaw: unknown,
  loadErrorRaw: unknown,
): ParseResult<AgentOperatorListRow> {
  if (loadErrorRaw === null) {
    if (typeof parameterCountRaw !== "number") return err("field-wrong-type");
    if (!Number.isFinite(parameterCountRaw)) return err("non-finite-number");
    return ok({
      name,
      description,
      parameterCount: parameterCountRaw,
      loadError: null,
    });
  }
  if (typeof loadErrorRaw !== "string") return err("field-wrong-type");
  if (parameterCountRaw !== null) return err("field-wrong-type");
  return ok({
    name,
    description,
    parameterCount: null,
    loadError: loadErrorRaw,
  });
}

/** Parses one `doctor --json` row. */
function parseDoctorCheck(raw: unknown): ParseResult<AgentOperatorDoctorCheck> {
  if (!Core.isPlainObject(raw)) return err("row-not-an-object");
  const name = requireString(raw, "name");
  if (!name.ok) return name;
  const status = requireString(raw, "status");
  if (!status.ok) return status;
  if (
    status.value !== "ok" &&
    status.value !== "warn" &&
    status.value !== "fail"
  ) {
    return err("unknown-status");
  }
  const detail = requireString(raw, "detail");
  if (!detail.ok) return detail;
  return ok({ name: name.value, status: status.value, detail: detail.value });
}

/** Parses one operation entry of an `inspect --json` row's `operations` array. */
function parseOperationDescriptor(
  raw: unknown,
): ParseResult<M3LConfigOperationDescriptor> {
  if (!Core.isPlainObject(raw)) return err("row-not-an-object");
  const name = requireString(raw, "name");
  if (!name.ok) return name;
  const description = requireString(raw, "description");
  if (!description.ok) return description;
  const requiredParameters = requireStringArray(raw, "requiredParameters");
  if (!requiredParameters.ok) return requiredParameters;
  return ok({
    name: name.value,
    description: description.value,
    requiredParameters: requiredParameters.value,
  });
}

function requireOperationsArray(
  record: Record<string, unknown>,
  key: string,
): ParseResult<readonly M3LConfigOperationDescriptor[]> {
  const field = requireOwn(record, key);
  if (!field.ok) return field;
  if (!Array.isArray(field.value)) return err("field-wrong-type");
  const operations: M3LConfigOperationDescriptor[] = [];
  for (const item of field.value) {
    const parsed = parseOperationDescriptor(item);
    if (!parsed.ok) return parsed;
    operations.push(parsed.value);
  }
  return ok(operations);
}

/** Reads the `name`/`aliases`/`type`/`required` quarter of an `inspect --json` row. */
function parseParamDescriptorCore(raw: Record<string, unknown>): ParseResult<{
  readonly name: string;
  readonly aliases: readonly string[];
  readonly type: string;
  readonly required: boolean;
}> {
  const name = requireString(raw, "name");
  if (!name.ok) return name;
  const aliases = requireStringArray(raw, "aliases");
  if (!aliases.ok) return aliases;
  const type = requireString(raw, "type");
  if (!type.ok) return type;
  const required = requireBoolean(raw, "required");
  if (!required.ok) return required;
  return ok({
    name: name.value,
    aliases: aliases.value,
    type: type.value,
    required: required.value,
  });
}

/** Reads the `defaultValue`/`description`/`secret`/`operations` quarter of an `inspect --json` row. */
function parseParamDescriptorExtra(raw: Record<string, unknown>): ParseResult<{
  readonly defaultValue: string | undefined;
  readonly description: string;
  readonly secret: boolean;
  readonly operations: readonly M3LConfigOperationDescriptor[];
}> {
  const defaultValue = readOptionalString(raw, "defaultValue");
  if (!defaultValue.ok) return defaultValue;
  const description = requireString(raw, "description");
  if (!description.ok) return description;
  const secret = requireBoolean(raw, "secret");
  if (!secret.ok) return secret;
  const operations = requireOperationsArray(raw, "operations");
  if (!operations.ok) return operations;
  return ok({
    defaultValue: defaultValue.value,
    description: description.value,
    secret: secret.value,
    operations: operations.value,
  });
}

/** Parses one `inspect <name> --json` row. */
function parseParamDescriptorRow(
  raw: unknown,
): ParseResult<AgentOperatorParamDescriptor> {
  if (!Core.isPlainObject(raw)) return err("row-not-an-object");
  const core = parseParamDescriptorCore(raw);
  if (!core.ok) return core;
  const extra = parseParamDescriptorExtra(raw);
  if (!extra.ok) return extra;
  return ok({ ...core.value, ...extra.value });
}

/**
 * Parses one row via `parseRow`, catching a throwing getter so it degrades
 * to `{ ok: false }` instead of propagating out of the whole array parse.
 */
function safeParseRow<T>(
  raw: unknown,
  parseRow: (row: unknown) => ParseResult<T>,
): ParseResult<T> {
  try {
    return parseRow(raw);
  } catch {
    return err("row-not-an-object");
  }
}

/**
 * Parses `input` as a bounded array of rows, each validated by `parseRow`.
 * Returns a fresh, frozen array — never the caller's input array — capped at
 * {@link MAX_ENVELOPE_ROWS}.
 */
function parseArray<T>(
  input: unknown,
  parseRow: (row: unknown) => ParseResult<T>,
): ParseResult<readonly T[]> {
  if (!Array.isArray(input)) return err("not-an-array");
  if (input.length > MAX_ENVELOPE_ROWS) return err("too-many-rows");

  const rows: T[] = [];
  for (const raw of input) {
    const result = safeParseRow(raw, parseRow);
    if (!result.ok) return result;
    rows.push(result.value);
  }
  Object.freeze(rows);
  return ok(rows);
}

/**
 * Parses the bare JSON array emitted by `m3l list --json`.
 *
 * @param input - The value returned by {@link parseJsonText}.
 * @returns A fresh, frozen array of {@link AgentOperatorListRow}, or a
 *   closed failure reason.
 * @example
 * ```ts
 * import { parseJsonText, parseListRows } from "./cli-envelopes.js";
 *
 * const raw = parseJsonText(stdout);
 * const rows = raw.ok ? parseListRows(raw.value) : raw;
 * ```
 */
export function parseListRows(
  input: unknown,
): ParseResult<readonly AgentOperatorListRow[]> {
  return parseArray(input, parseListRow);
}

/**
 * Parses the bare JSON array emitted by `m3l doctor --json`.
 *
 * @param input - The value returned by {@link parseJsonText}.
 * @returns A fresh, frozen array of {@link AgentOperatorDoctorCheck}, or a
 *   closed failure reason.
 * @example
 * ```ts
 * import { parseDoctorChecks, parseJsonText } from "./cli-envelopes.js";
 *
 * const raw = parseJsonText(stdout);
 * const checks = raw.ok ? parseDoctorChecks(raw.value) : raw;
 * ```
 */
export function parseDoctorChecks(
  input: unknown,
): ParseResult<readonly AgentOperatorDoctorCheck[]> {
  return parseArray(input, parseDoctorCheck);
}

/**
 * Parses the bare JSON array emitted by `m3l inspect <name> --json`.
 *
 * @param input - The value returned by {@link parseJsonText}.
 * @returns A fresh, frozen array of {@link AgentOperatorParamDescriptor}, or
 *   a closed failure reason.
 * @example
 * ```ts
 * import { parseJsonText, parseParamDescriptors } from "./cli-envelopes.js";
 *
 * const raw = parseJsonText(stdout);
 * const descriptors = raw.ok ? parseParamDescriptors(raw.value) : raw;
 * ```
 */
export function parseParamDescriptors(
  input: unknown,
): ParseResult<readonly AgentOperatorParamDescriptor[]> {
  return parseArray(input, parseParamDescriptorRow);
}

/** Reads and validates the `kind`/`schemaVersion`/`script` header of a run envelope. */
function parseRunEnvelopeHeader(
  raw: Record<string, unknown>,
): ParseResult<{ readonly script: string }> {
  const kind = requireOwn(raw, "kind");
  if (!kind.ok) return kind;
  if (kind.value !== "m3l.run.result") return err("wrong-kind");

  const schemaVersion = requireOwn(raw, "schemaVersion");
  if (!schemaVersion.ok) return schemaVersion;
  if (schemaVersion.value !== 1) return err("unsupported-schema-version");

  const script = requireString(raw, "script");
  if (!script.ok) return script;
  return ok({ script: script.value });
}

/** Reads and validates the timing fields of a run envelope. */
function parseRunEnvelopeTiming(raw: Record<string, unknown>): ParseResult<{
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}> {
  const startedAt = requireString(raw, "startedAt");
  if (!startedAt.ok) return startedAt;
  const finishedAt = requireString(raw, "finishedAt");
  if (!finishedAt.ok) return finishedAt;
  const durationMs = requireFiniteNumber(raw, "durationMs");
  if (!durationMs.ok) return durationMs;
  return ok({
    startedAt: startedAt.value,
    finishedAt: finishedAt.value,
    durationMs: durationMs.value,
  });
}

/** Reads and validates the exit-code/outcome fields of a run envelope. */
function parseRunEnvelopeOutcome(raw: Record<string, unknown>): ParseResult<{
  readonly exitCode: number;
  readonly exitCodeName: AgentOperatorExitCodeName | null;
  readonly outcome: AgentOperatorRunOutcome | null;
}> {
  const exitCode = requireFiniteNumber(raw, "exitCode");
  if (!exitCode.ok) return exitCode;
  const exitCodeName = readNullableLiteral<AgentOperatorExitCodeName>(
    raw,
    "exitCodeName",
    EXIT_CODE_NAME_SET,
  );
  if (!exitCodeName.ok) return exitCodeName;
  const outcome = readNullableLiteral<AgentOperatorRunOutcome>(
    raw,
    "outcome",
    RUN_OUTCOME_SET,
  );
  if (!outcome.ok) return outcome;
  return ok({
    exitCode: exitCode.value,
    exitCodeName: exitCodeName.value,
    outcome: outcome.value,
  });
}

/** Reads and validates the report-availability fields of a run envelope. */
function parseRunEnvelopeReport(raw: Record<string, unknown>): ParseResult<{
  readonly reportPath: string | null;
  readonly reportUnavailable: AgentOperatorReportUnavailableReason | null;
}> {
  const reportPath = readNullable(raw, "reportPath", Core.isString);
  if (!reportPath.ok) return reportPath;
  const reportUnavailable =
    readNullableLiteral<AgentOperatorReportUnavailableReason>(
      raw,
      "reportUnavailable",
      REPORT_UNAVAILABLE_SET,
    );
  if (!reportUnavailable.ok) return reportUnavailable;
  return ok({
    reportPath: reportPath.value,
    reportUnavailable: reportUnavailable.value,
  });
}

/** Reads and validates the telemetry counters of a run envelope. */
function parseRunEnvelopeTelemetry(raw: Record<string, unknown>): ParseResult<{
  readonly timelineCount: number | null;
  readonly timelineSourceCount: number | null;
  readonly recoveryTotal: number | null;
}> {
  const timelineCount = readNullableFiniteNumber(raw, "timelineCount");
  if (!timelineCount.ok) return timelineCount;
  const timelineSourceCount = readNullableFiniteNumber(
    raw,
    "timelineSourceCount",
  );
  if (!timelineSourceCount.ok) return timelineSourceCount;
  const recoveryTotal = readNullableFiniteNumber(raw, "recoveryTotal");
  if (!recoveryTotal.ok) return recoveryTotal;
  return ok({
    timelineCount: timelineCount.value,
    timelineSourceCount: timelineSourceCount.value,
    recoveryTotal: recoveryTotal.value,
  });
}

/** Assembles the five validated field groups into a frozen `AgentOperatorRunEnvelope`. */
function buildRunEnvelope(
  raw: Record<string, unknown>,
): ParseResult<AgentOperatorRunEnvelope> {
  const header = parseRunEnvelopeHeader(raw);
  if (!header.ok) return header;
  const timing = parseRunEnvelopeTiming(raw);
  if (!timing.ok) return timing;
  const outcome = parseRunEnvelopeOutcome(raw);
  if (!outcome.ok) return outcome;
  const report = parseRunEnvelopeReport(raw);
  if (!report.ok) return report;
  const telemetry = parseRunEnvelopeTelemetry(raw);
  if (!telemetry.ok) return telemetry;

  const envelope: AgentOperatorRunEnvelope = {
    kind: "m3l.run.result",
    schemaVersion: 1,
    ...header.value,
    ...timing.value,
    ...outcome.value,
    ...report.value,
    ...telemetry.value,
  };
  Object.freeze(envelope);
  return ok(envelope);
}

/**
 * Parses the single-object envelope emitted by `m3l run <name> --json`,
 * failing closed on `kind !== "m3l.run.result"` (`"wrong-kind"`) and
 * `schemaVersion !== 1` (`"unsupported-schema-version"`) — the two markers
 * that let this parser reject a future, incompatible envelope shape instead
 * of silently misreading it.
 *
 * @param input - The value returned by {@link parseJsonText}.
 * @returns A fresh, frozen {@link AgentOperatorRunEnvelope}, or a closed
 *   failure reason.
 * @example
 * ```ts
 * import { parseJsonText, parseRunEnvelope } from "./cli-envelopes.js";
 *
 * const raw = parseJsonText(stdout);
 * const envelope = raw.ok ? parseRunEnvelope(raw.value) : raw;
 * ```
 */
export function parseRunEnvelope(
  input: unknown,
): ParseResult<AgentOperatorRunEnvelope> {
  if (!Core.isPlainObject(input)) return err("not-an-object");
  try {
    return buildRunEnvelope(input);
  } catch {
    return err("not-an-object");
  }
}

/**
 * The branch a flow step reports having taken — mirrors the CLI's own
 * `M3LCliFlowBranch` (`packages/m3l-cli/src/flow/envelope.ts`). Deliberately
 * a UNION rather than a bare string: `"continue"` and `"stop"` are closed
 * literals, while a jump carries the destination step id as `goto`.
 */
export type AgentOperatorFlowBranch =
  "continue" | "stop" | { readonly goto: string };

/**
 * One entry of a {@link AgentOperatorFlowEnvelope}'s `steps` array. Its
 * `run` field is a complete, self-marked {@link AgentOperatorRunEnvelope} —
 * the CLI stamps every nested run through its own `buildRunEnvelope` before
 * composing the step, so {@link parseFlowEnvelope} reads it with the
 * existing {@link parseRunEnvelope} rather than a second reader.
 */
export interface AgentOperatorFlowStepEnvelope {
  readonly stepId: string;
  readonly script: string;
  readonly attempt: number;
  readonly branch: AgentOperatorFlowBranch;
  readonly run: AgentOperatorRunEnvelope;
}

/**
 * The single-object envelope emitted by `m3l flow run <name> --json`.
 * Carries its own `kind: "m3l.flow.result"` marker — distinct from
 * {@link AgentOperatorRunEnvelope}'s `"m3l.run.result"` — so
 * {@link parseRunEnvelope} fails closed on it by design and this dedicated
 * shape exists instead.
 */
export interface AgentOperatorFlowEnvelope {
  readonly kind: "m3l.flow.result";
  readonly schemaVersion: 1;
  readonly flow: string;
  readonly runId: string;
  readonly definitionHash: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly status: string;
  readonly exitCode: number;
  readonly exitCodeName: AgentOperatorExitCodeName | null;
  readonly dryRun: boolean;
  readonly stepExecutionCount: number;
  readonly haltingStepId: string | null;
  readonly resumeStepId: string | null;
  readonly steps: readonly AgentOperatorFlowStepEnvelope[];
}

/** Reads and validates the `kind`/`schemaVersion`/identity header of a flow envelope. */
function parseFlowEnvelopeHeader(raw: Record<string, unknown>): ParseResult<{
  readonly flow: string;
  readonly runId: string;
  readonly definitionHash: string;
}> {
  const kind = requireOwn(raw, "kind");
  if (!kind.ok) return kind;
  if (kind.value !== "m3l.flow.result") return err("wrong-kind");

  const schemaVersion = requireOwn(raw, "schemaVersion");
  if (!schemaVersion.ok) return schemaVersion;
  if (schemaVersion.value !== 1) return err("unsupported-schema-version");

  const flow = requireString(raw, "flow");
  if (!flow.ok) return flow;
  const runId = requireString(raw, "runId");
  if (!runId.ok) return runId;
  const definitionHash = requireString(raw, "definitionHash");
  if (!definitionHash.ok) return definitionHash;

  return ok({
    flow: flow.value,
    runId: runId.value,
    definitionHash: definitionHash.value,
  });
}

/** Reads and validates the timing fields of a flow envelope, mirroring {@link parseRunEnvelopeTiming}'s field set. */
function parseFlowEnvelopeTiming(raw: Record<string, unknown>): ParseResult<{
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}> {
  const startedAt = requireString(raw, "startedAt");
  if (!startedAt.ok) return startedAt;
  const finishedAt = requireString(raw, "finishedAt");
  if (!finishedAt.ok) return finishedAt;
  const durationMs = requireFiniteNumber(raw, "durationMs");
  if (!durationMs.ok) return durationMs;
  return ok({
    startedAt: startedAt.value,
    finishedAt: finishedAt.value,
    durationMs: durationMs.value,
  });
}

/** Reads and validates the `status`/`exitCode`/`exitCodeName`/`dryRun` fields of a flow envelope. */
function parseFlowEnvelopeOutcome(raw: Record<string, unknown>): ParseResult<{
  readonly status: string;
  readonly exitCode: number;
  readonly exitCodeName: AgentOperatorExitCodeName | null;
  readonly dryRun: boolean;
}> {
  const status = requireString(raw, "status");
  if (!status.ok) return status;
  const exitCode = requireFiniteNumber(raw, "exitCode");
  if (!exitCode.ok) return exitCode;
  const exitCodeName = readNullableLiteral<AgentOperatorExitCodeName>(
    raw,
    "exitCodeName",
    EXIT_CODE_NAME_SET,
  );
  if (!exitCodeName.ok) return exitCodeName;
  const dryRun = requireBoolean(raw, "dryRun");
  if (!dryRun.ok) return dryRun;
  return ok({
    status: status.value,
    exitCode: exitCode.value,
    exitCodeName: exitCodeName.value,
    dryRun: dryRun.value,
  });
}

/** Reads and validates the step-progress fields of a flow envelope. */
function parseFlowEnvelopeProgress(raw: Record<string, unknown>): ParseResult<{
  readonly stepExecutionCount: number;
  readonly haltingStepId: string | null;
  readonly resumeStepId: string | null;
}> {
  const stepExecutionCount = requireFiniteNumber(raw, "stepExecutionCount");
  if (!stepExecutionCount.ok) return stepExecutionCount;
  const haltingStepId = readNullable(raw, "haltingStepId", Core.isString);
  if (!haltingStepId.ok) return haltingStepId;
  const resumeStepId = readNullable(raw, "resumeStepId", Core.isString);
  if (!resumeStepId.ok) return resumeStepId;
  return ok({
    stepExecutionCount: stepExecutionCount.value,
    haltingStepId: haltingStepId.value,
    resumeStepId: resumeStepId.value,
  });
}

/** The literal half of {@link AgentOperatorFlowBranch} — checked via {@link readNullableLiteral} before the `{ goto }` arm is hand-rolled. */
const FLOW_BRANCH_LITERAL_SET: ReadonlySet<"continue" | "stop"> = new Set([
  "continue",
  "stop",
]);

/**
 * Reads and validates a step's `branch` field against the closed
 * {@link AgentOperatorFlowBranch} union: the `"continue"`/`"stop"` literal
 * half is checked via {@link readNullableLiteral} (its nullable-passthrough
 * is harmless here since the branch is otherwise validated to be present);
 * a value that is neither one of those literals nor `null` falls through to
 * the `{ goto }` object arm, guarded with `Object.hasOwn` — never the `in`
 * operator, which walks the prototype chain.
 */
function parseFlowBranch(
  raw: Record<string, unknown>,
): ParseResult<AgentOperatorFlowBranch> {
  const literal = readNullableLiteral<"continue" | "stop">(
    raw,
    "branch",
    FLOW_BRANCH_LITERAL_SET,
  );
  if (literal.ok && literal.value !== null) return ok(literal.value);

  const field = requireOwn(raw, "branch");
  if (!field.ok) return field;
  if (!Core.isPlainObject(field.value) || !Object.hasOwn(field.value, "goto")) {
    return err("field-wrong-type");
  }
  const goto = requireString(field.value, "goto");
  if (!goto.ok) return goto;
  return ok({ goto: goto.value });
}

/** Reads the `stepId`/`script`/`attempt` trio of a flow step. */
function parseFlowStepCore(raw: Record<string, unknown>): ParseResult<{
  readonly stepId: string;
  readonly script: string;
  readonly attempt: number;
}> {
  const stepId = requireString(raw, "stepId");
  if (!stepId.ok) return stepId;
  const script = requireString(raw, "script");
  if (!script.ok) return script;
  const attempt = requireFiniteNumber(raw, "attempt");
  if (!attempt.ok) return attempt;
  return ok({
    stepId: stepId.value,
    script: script.value,
    attempt: attempt.value,
  });
}

/**
 * Parses one entry of a flow envelope's `steps` array. The nested `run`
 * field is delegated to the existing {@link parseRunEnvelope} — never a
 * second, hand-rolled reader — because the CLI composes every step through
 * its own `buildRunEnvelope`, which stamps `kind: "m3l.run.result"` and
 * `schemaVersion: 1` on the nested object before it ever reaches here.
 *
 * A malformed step's failure reason is returned UNCHANGED (never mapped to
 * a generic reason and never skipped): a partially-read flow result would
 * under-report what actually executed, and this envelope is the agent's
 * only account of a mutating run.
 */
function parseFlowStepEnvelope(
  raw: unknown,
): ParseResult<AgentOperatorFlowStepEnvelope> {
  if (!Core.isPlainObject(raw)) return err("row-not-an-object");
  const core = parseFlowStepCore(raw);
  if (!core.ok) return core;
  const branch = parseFlowBranch(raw);
  if (!branch.ok) return branch;
  const run = requireOwn(raw, "run");
  if (!run.ok) return run;
  const parsedRun = parseRunEnvelope(run.value);
  if (!parsedRun.ok) return parsedRun;
  return ok({
    stepId: core.value.stepId,
    script: core.value.script,
    attempt: core.value.attempt,
    branch: branch.value,
    run: parsedRun.value,
  });
}

/** Assembles the validated field groups into a frozen `AgentOperatorFlowEnvelope`. */
function buildFlowEnvelope(
  raw: Record<string, unknown>,
): ParseResult<AgentOperatorFlowEnvelope> {
  const header = parseFlowEnvelopeHeader(raw);
  if (!header.ok) return header;
  const timing = parseFlowEnvelopeTiming(raw);
  if (!timing.ok) return timing;
  const outcome = parseFlowEnvelopeOutcome(raw);
  if (!outcome.ok) return outcome;
  const progress = parseFlowEnvelopeProgress(raw);
  if (!progress.ok) return progress;
  const stepsField = requireOwn(raw, "steps");
  if (!stepsField.ok) return stepsField;
  const steps = parseArray(stepsField.value, parseFlowStepEnvelope);
  if (!steps.ok) return steps;

  const envelope: AgentOperatorFlowEnvelope = {
    kind: "m3l.flow.result",
    schemaVersion: 1,
    ...header.value,
    ...timing.value,
    ...outcome.value,
    ...progress.value,
    steps: steps.value,
  };
  Object.freeze(envelope);
  return ok(envelope);
}

/**
 * Parses the single-object envelope emitted by `m3l flow run <name> --json`,
 * failing closed on `kind !== "m3l.flow.result"` (`"wrong-kind"`) and
 * `schemaVersion !== 1` (`"unsupported-schema-version"`) — the same two
 * markers {@link parseRunEnvelope} fails closed on, for its own `kind`.
 *
 * A malformed entry in `steps` (a missing field, a wrong-kind nested run, an
 * unrecognized `branch`) rejects the WHOLE envelope with that entry's own
 * failure reason, never a partial or substituted result: this envelope is
 * the agent's only account of what a mutating flow run actually did, and a
 * silently-dropped step would under-report it.
 *
 * @param input - The value returned by {@link parseJsonText}.
 * @returns A fresh, frozen {@link AgentOperatorFlowEnvelope}, or a closed
 *   failure reason.
 * @example
 * ```ts
 * import { parseFlowEnvelope, parseJsonText } from "./cli-envelopes.js";
 *
 * const raw = parseJsonText(stdout);
 * const envelope = raw.ok ? parseFlowEnvelope(raw.value) : raw;
 * ```
 */
export function parseFlowEnvelope(
  input: unknown,
): ParseResult<AgentOperatorFlowEnvelope> {
  if (!Core.isPlainObject(input)) return err("not-an-object");
  try {
    return buildFlowEnvelope(input);
  } catch {
    return err("not-an-object");
  }
}
