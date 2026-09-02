/**
 * `flow/validate-guards` — shared low-level primitives for boundary
 * validation of a `m3l flow` definition: type narrowing (`isRecord`,
 * `isUnknownArray`), the terminal rejection helper (`rejectFlow`), and the
 * two key-screening rules — prototype-pollution vectors and unknown keys —
 * that recur at every level of the format (flow, step, branch arm,
 * parameters).
 *
 * Split out of `flow/validate.ts` purely to keep that file under the
 * per-file byte budget. Every export here is an implementation detail the
 * validator shares with `flow/branch.ts`; neither of those two files imports
 * the other, so both depending on this one keeps the dependency graph a DAG
 * rather than a cycle.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import { M3LCliError } from "../cli/errors.js";

/**
 * Throws the one error class every rejection in `flow/validate.ts` and
 * `flow/branch.ts` raises. Declared `never` so a call reads as terminal at
 * each call site, keeping the rules themselves free of `else` branches.
 *
 * @param message - Human-readable description of the rule that was broken.
 * @param suggestions - "Did you mean…" candidates, when a near-miss ranking
 *   applies; deliberately left empty for a prototype-pollution rejection, so
 *   a pollution vector is never echoed back as a friendly hint.
 */
export function rejectFlow(
  message: string,
  suggestions: readonly string[] = [],
): never {
  throw new M3LCliError("ERR_CLI_FLOW_INVALID", message, { suggestions });
}

/**
 * Checks whether `value` is a non-array object — a YAML mapping.
 *
 * @param value - The candidate value.
 * @returns Whether `value` can be read as a keyed record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks whether `value` is an array, without widening its items to `any`.
 *
 * @param value - The candidate value.
 * @returns Whether `value` is an array.
 */
export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Narrows `value` to a record, or rejects.
 *
 * @param value - The candidate value.
 * @param label - How to name `value` in the rejection message.
 * @returns The value as a record.
 */
export function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    rejectFlow(`${label} must be a mapping`);
  }
  return value;
}

/**
 * Rejects when `record` declares a prototype-pollution vector key.
 *
 * `Core.M3LYAMLConfigProvider` screens only the document's TOP-LEVEL keys, so
 * every nested level — a step mapping, a `parameters` mapping, a branch
 * mapping — is this validator's own responsibility. The screen runs before
 * any unknown-key reporting: `__proto__` is also an undeclared name, and a
 * validator that reported unknown keys first would echo a pollution vector
 * back inside a "did you mean" list.
 *
 * Screens only `record`'s own keys — not any value nested underneath. A
 * `parameters` value is opaque to this validator, so `flow/validate.ts`
 * layers its own recursive screen on top of this one wherever a value's
 * nested mappings also need checking; every other call site (flow, step,
 * branch arm) has a fixed, already-declared shape where the direct keys are
 * the only surface that matters.
 *
 * @param record - The record whose own keys to screen.
 * @param label - How to name `record` in the rejection message.
 */
export function screenDangerousKeys(
  record: Record<string, unknown>,
  label: string,
): void {
  const dangerous = Object.keys(record).filter((key) =>
    Core.isDangerousKey(key),
  );
  if (dangerous.length > 0) {
    rejectFlow(
      `${label} declares prototype-pollution key(s): ${dangerous.join(", ")}`,
    );
  }
}

/**
 * Rejects when `record` declares a key outside `known`, naming every
 * offending key so one pass over the file fixes them all.
 *
 * @param record - The record whose own keys to screen.
 * @param known - The keys this level of the format accepts.
 * @param label - How to name `record` in the rejection message.
 */
export function screenUnknownKeys(
  record: Record<string, unknown>,
  known: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    rejectFlow(
      `${label} declares unknown key(s): ${unknown.join(", ")} — accepted: ${[...known].join(", ")}`,
    );
  }
}

/**
 * Reads a required string value, or rejects.
 *
 * @param record - The record to read from.
 * @param key - The key to read.
 * @param label - How to name `record` in the rejection message.
 * @returns The string value.
 */
export function readString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    rejectFlow(`${label} requires a string '${key}'`);
  }
  return value;
}
