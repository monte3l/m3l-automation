/**
 * `runs/parameters` — validates an untrusted run-request body into the
 * closed {@link M3LRunRequestBody} shape the X4 run-governor's HTTP layer
 * hands to the rest of `runs/`.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../errors/console-error.js";

/** The pattern a valid `scriptName` must match: kebab-case, lowercase-leading. */
const SCRIPT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * A validated run request: the script to run, whether the caller confirmed
 * a non-dry-run execution, whether to run in dry-run mode, and the
 * caller-supplied parameters.
 *
 * @example
 * ```ts
 * const body: M3LRunRequestBody = {
 *   scriptName: "sqs-etl",
 *   confirmed: true,
 *   dryRun: false,
 *   parameters: { queue: "my-q" },
 * };
 * ```
 */
export interface M3LRunRequestBody {
  /** The kebab-case name of the script to run. */
  readonly scriptName: string;
  /** Whether the caller explicitly confirmed a non-dry-run execution. */
  readonly confirmed: boolean;
  /** Whether the run should execute in dry-run mode. */
  readonly dryRun: boolean;
  /** The caller-supplied parameters, every value a string. */
  readonly parameters: Readonly<Record<string, string>>;
}

/** Throws `ERR_CONSOLE_BAD_REQUEST` naming `field` and the reason it failed. */
function rejectBody(field: string, reason: string): never {
  throw new M3LConsoleError(
    "ERR_CONSOLE_BAD_REQUEST",
    `invalid run request: '${field}' ${reason}`,
    { context: { field } },
  );
}

/** Validates and returns the required `scriptName` field. */
function readScriptName(body: Record<string, unknown>): string {
  if (!Object.hasOwn(body, "scriptName")) {
    rejectBody("scriptName", "is required");
  }
  const scriptName = body["scriptName"];
  if (!Core.isString(scriptName)) {
    rejectBody("scriptName", "must be a string");
  }
  if (!SCRIPT_NAME_PATTERN.test(scriptName)) {
    rejectBody("scriptName", "must be a kebab-case identifier");
  }
  return scriptName;
}

/** Validates and returns the optional `confirmed` field, defaulting to `false`. */
function readConfirmed(body: Record<string, unknown>): boolean {
  if (!Object.hasOwn(body, "confirmed")) return false;
  const confirmed = body["confirmed"];
  if (!Core.isBoolean(confirmed)) {
    rejectBody("confirmed", "must be a boolean");
  }
  return confirmed;
}

/** Validates and returns the optional `dryRun` field, defaulting to `false`. */
function readDryRun(body: Record<string, unknown>): boolean {
  if (!Object.hasOwn(body, "dryRun")) return false;
  const dryRun = body["dryRun"];
  if (!Core.isBoolean(dryRun)) {
    rejectBody("dryRun", "must be a boolean");
  }
  return dryRun;
}

/**
 * Validates and returns the optional `parameters` field, defaulting to `{}`.
 * Every value must be a string.
 */
function readParameters(
  body: Record<string, unknown>,
): Readonly<Record<string, string>> {
  if (!Object.hasOwn(body, "parameters")) return {};
  const parameters = body["parameters"];
  if (!Core.isPlainObject(parameters)) {
    rejectBody("parameters", "must be a plain object");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (!Core.isString(value)) {
      rejectBody(`parameters.${key}`, "must be a string");
    }
    result[key] = value;
  }
  return result;
}

/**
 * Validates an untrusted `body` — typically a parsed JSON request body —
 * into a closed {@link M3LRunRequestBody}. Rejects a non-object body (`null`,
 * an array, a string, a number), a missing/malformed `scriptName`, and a
 * non-boolean `confirmed`/`dryRun` or non-string-valued `parameters`.
 * `confirmed`, `dryRun`, and `parameters` default to `false`, `false`, and
 * `{}` respectively when absent.
 *
 * @param body - The untrusted request body to validate.
 * @returns The validated {@link M3LRunRequestBody}.
 * @throws {@link M3LConsoleError} with code `"ERR_CONSOLE_BAD_REQUEST"` when
 *   `body` fails validation.
 *
 * @example
 * ```ts
 * import { parseRunRequest } from "./runs/parameters.js";
 *
 * const request = parseRunRequest({ scriptName: "sqs-etl" });
 * // { scriptName: "sqs-etl", confirmed: false, dryRun: false, parameters: {} }
 * ```
 */
export function parseRunRequest(body: unknown): M3LRunRequestBody {
  if (!Core.isPlainObject(body)) {
    rejectBody("body", "must be a JSON object");
  }
  return {
    scriptName: readScriptName(body),
    confirmed: readConfirmed(body),
    dryRun: readDryRun(body),
    parameters: readParameters(body),
  };
}
