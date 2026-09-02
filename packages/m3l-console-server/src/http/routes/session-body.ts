/**
 * `http/routes/session-body` — the three body-field validators every session
 * route module shares: the rejection helper, and the required-string and
 * required-boolean readers built on it.
 *
 * A LEAF, deliberately: it imports nothing from its siblings, so
 * `http/routes/sessions.ts` and `http/routes/session-bindings.ts` can both
 * depend on it without either depending on the other. That is what let the
 * binding-entry validator move into the module that owns the binding
 * resource while `POST …/steps` keeps calling the same implementation —
 * `check:zones`' no-cycle guard forbids the shape where two route modules
 * import each other's helpers.
 *
 * Every rejection here is `ERR_CONSOLE_BAD_REQUEST` and names the offending
 * field, never its value: these read caller-supplied bodies, and a message
 * that echoed one back would put untrusted text in a response.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LConsoleError } from "../../errors/console-error.js";

/**
 * Throws `ERR_CONSOLE_BAD_REQUEST` naming `field` and the reason it failed.
 *
 * @param field - The field named in the message and the error context.
 * @param reason - Why it failed, appended to the message.
 * @throws {@link M3LConsoleError} always — its return type is `never`.
 *
 * @example
 * ```ts
 * import { rejectBody } from "@m3l-automation/m3l-console-server/http/routes/session-body.js";
 *
 * rejectBody("reference", "is required");
 * ```
 */
export function rejectBody(field: string, reason: string): never {
  throw new M3LConsoleError(
    "ERR_CONSOLE_BAD_REQUEST",
    `invalid session request: '${field}' ${reason}`,
    { context: { field } },
  );
}

/**
 * Validates and returns a required, non-empty string field.
 *
 * @param body - The object to read `field` from.
 * @param field - The actual object key to look up.
 * @param label - The field name reported in a rejection message; defaults
 *   to `field` (differs from it for a nested binding entry, e.g.
 *   `bindings[0].reference`).
 * @returns The validated value.
 * @throws {@link M3LConsoleError} `ERR_CONSOLE_BAD_REQUEST` when absent, not
 *   a string, or empty.
 *
 * @example
 * ```ts
 * import { readRequiredNonEmptyString } from "@m3l-automation/m3l-console-server/http/routes/session-body.js";
 *
 * readRequiredNonEmptyString({ operation: "sqs-etl" }, "operation");
 * ```
 */
export function readRequiredNonEmptyString(
  body: Record<string, unknown>,
  field: string,
  label: string = field,
): string {
  if (!Object.hasOwn(body, field)) {
    rejectBody(label, "is required");
  }
  const value = body[field];
  if (!Core.isString(value)) {
    rejectBody(label, "must be a string");
  }
  if (value.length === 0) {
    rejectBody(label, "must not be empty");
  }
  return value;
}

/**
 * Validates and returns a required boolean field.
 *
 * @param body - The object to read `field` from.
 * @param field - The actual object key to look up.
 * @param label - The field name reported in a rejection message; defaults
 *   to `field` (differs from it for a nested binding entry).
 * @returns The validated value.
 * @throws {@link M3LConsoleError} `ERR_CONSOLE_BAD_REQUEST` when absent or
 *   not a boolean.
 *
 * @example
 * ```ts
 * import { readRequiredBoolean } from "@m3l-automation/m3l-console-server/http/routes/session-body.js";
 *
 * readRequiredBoolean({ dryRun: true }, "dryRun");
 * ```
 */
export function readRequiredBoolean(
  body: Record<string, unknown>,
  field: string,
  label: string = field,
): boolean {
  if (!Object.hasOwn(body, field)) {
    rejectBody(label, "is required");
  }
  const value = body[field];
  if (!Core.isBoolean(value)) {
    rejectBody(label, "must be a boolean");
  }
  return value;
}
