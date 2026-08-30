/**
 * `internal/agent/decision-log` — the validation rules and the pure
 * projector for the ADR-0061 decision-log entry (V7 slice 1).
 *
 * Private to `core/agent`; never re-exported through a public barrel.
 * `decision` carries no runtime brand — unlike `M3LAgentPolicy`, there is no
 * validator whose registry membership can be checked — so it is validated
 * structurally here with the same allowlist discipline
 * `internal/agent/action.ts` already uses for the caller's action. Everything
 * else in the options bag (`identity`, `now`, `outcome`, `tokens`, `cost`,
 * and the bag's own key set) is validated the same way.
 */

import type { M3LAgentDecision } from "../../core/agent/verdict-types.js";
import { M3LAgentActionValidationError } from "../../core/agent/M3LAgentActionValidationError.js";
import type {
  M3LAgentDecisionLogEntry,
  M3LAgentDecisionOutcome,
  M3LAgentIdentity,
} from "../../core/agent/decision-log-types.js";
import { M3LError } from "../../core/errors/index.js";
import {
  isArray,
  isBoolean,
  isObject,
  isPlainObject,
  isString,
} from "../../core/utils/guards.js";
import { assertAllowedKeys, isNonBlankString } from "./validation.js";

/** The only own keys the options bag may carry. */
const OPTIONS_KEYS: ReadonlySet<string> = new Set([
  "decision",
  "identity",
  "now",
  "outcome",
  "tokens",
  "cost",
]);

/** The only own keys an identity may carry. */
const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  "name",
  "modelId",
  "awsPrincipal",
]);

/** The only own keys an outcome may carry. */
const OUTCOME_KEYS: ReadonlySet<string> = new Set([
  "dryRun",
  "exitCode",
  "registryName",
]);

/** The only own keys a decision may carry (mirrors `M3LAgentDecision`). */
const DECISION_KEYS: ReadonlySet<string> = new Set([
  "action",
  "verdict",
  "rule",
  "reason",
]);

/**
 * The only own keys a decision's action record may carry (mirrors
 * `M3LAgentActionRecord`).
 */
const DECISION_ACTION_KEYS: ReadonlySet<string> = new Set([
  "script",
  "operation",
  "kind",
  "target",
  "parameterNames",
  "dryRun",
  "shapeKey",
]);

/**
 * The maximum (and, negated, the minimum) time value `Date` can represent —
 * ECMA-262's own bound, ±100,000,000 days from the epoch in milliseconds.
 */
const MAX_DATE_TIME_VALUE_MS = 8_640_000_000_000_000;

/**
 * Builds the typed error this module throws for a named field and violation
 * kind. `context` carries the field and the violation only — never a value
 * read out of the caller's input.
 */
function logFailure(
  field: string,
  violation: string,
  detail?: Readonly<Record<string, unknown>>,
): M3LAgentActionValidationError {
  return new M3LAgentActionValidationError(
    `agent decision-log entry: "${field}" is invalid (${violation})`,
    { context: { field, violation, ...detail } },
  );
}

/**
 * Reads an optional non-blank string field. Presence is `Object.hasOwn`, so a
 * non-own `"__proto__"` resolves as absent; a present-but-blank or
 * non-string value is malformed input, not "absent", and throws.
 */
function readOptionalNonBlankString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): string | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (!isNonBlankString(value)) {
    throw logFailure(field, "blank-or-non-string");
  }
  return value;
}

/** The identity, projected into a fresh frozen object. */
function projectIdentity(value: unknown): M3LAgentIdentity {
  if (!isPlainObject(value)) {
    throw logFailure("identity", "not-a-plain-object");
  }
  assertAllowedKeys(value, IDENTITY_KEYS, "identity", logFailure);

  const name = Object.hasOwn(value, "name") ? value["name"] : undefined;
  if (!isNonBlankString(name)) {
    throw logFailure("identity.name", "blank-or-non-string");
  }
  const modelId = readOptionalNonBlankString(
    value,
    "modelId",
    "identity.modelId",
  );
  const awsPrincipal = readOptionalNonBlankString(
    value,
    "awsPrincipal",
    "identity.awsPrincipal",
  );

  // A fresh object, never the caller's reference — so a later mutation of
  // the caller's identity cannot rewrite the entry this projection feeds.
  return Object.freeze({
    name,
    ...(modelId !== undefined && { modelId }),
    ...(awsPrincipal !== undefined && { awsPrincipal }),
  });
}

/**
 * `now` must be a finite safe integer within the range `Date` can represent —
 * anything else throws rather than emitting a record stamped `Invalid Date`.
 */
function readNow(bag: Readonly<Record<string, unknown>>): number {
  if (!Object.hasOwn(bag, "now")) {
    throw logFailure("now", "missing");
  }
  const value = bag["now"];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw logFailure("now", "non-finite-or-non-integer");
  }
  if (Math.abs(value) > MAX_DATE_TIME_VALUE_MS) {
    throw logFailure("now", "outside-date-representable-range");
  }
  return value;
}

/** A negative or non-finite `tokens` / `cost` is malformed input. */
function readOptionalNonNegativeFiniteNumber(
  bag: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  if (!Object.hasOwn(bag, key)) {
    return undefined;
  }
  const value = bag[key];
  if (!(typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    throw logFailure(key, "negative-or-non-finite");
  }
  return value;
}

/** Reads an optional integer field. A present-but-non-integer value throws. */
function readOptionalInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): number | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw logFailure(field, "not-an-integer");
  }
  return value;
}

/** The outcome, projected into a fresh frozen object. */
function projectOutcome(value: unknown): M3LAgentDecisionOutcome {
  if (!isPlainObject(value)) {
    throw logFailure("outcome", "not-a-plain-object");
  }
  assertAllowedKeys(value, OUTCOME_KEYS, "outcome", logFailure);

  const dryRun = Object.hasOwn(value, "dryRun") ? value["dryRun"] : undefined;
  if (!isBoolean(dryRun)) {
    throw logFailure("outcome.dryRun", "not-a-boolean");
  }
  const exitCode = readOptionalInteger(value, "exitCode", "outcome.exitCode");
  const registryName = readOptionalNonBlankString(
    value,
    "registryName",
    "outcome.registryName",
  );

  return Object.freeze({
    dryRun,
    ...(exitCode !== undefined && { exitCode }),
    ...(registryName !== undefined && { registryName }),
  });
}

/**
 * Projects a validated decision and its companions into a flat, frozen
 * decision-log entry. Pure: no I/O, no clock read — `timestamp` is derived
 * from `now` alone.
 */
function projectEntry(
  decision: M3LAgentDecision,
  identity: M3LAgentIdentity,
  now: number,
  outcome: M3LAgentDecisionOutcome | undefined,
  tokens: number | undefined,
  cost: number | undefined,
): M3LAgentDecisionLogEntry {
  const { action, verdict, rule, reason } = decision;

  // Fresh frozen copy — `action.target` is already the library's own frozen
  // projection, but it is reached through `decision`, one of this
  // function's arguments, so the entry must not share it by reference.
  const target =
    action.target === undefined
      ? undefined
      : Object.freeze({
          profile: action.target.profile,
          region: action.target.region,
          accountId: action.target.accountId,
        });

  return Object.freeze({
    timestamp: new Date(now).toISOString(),
    identity,
    script: action.script,
    operation: action.operation,
    kind: action.kind,
    target,
    // Fresh frozen copy, for the same "no shared reference" reason as `target`.
    parameterNames: Object.freeze([...action.parameterNames]),
    shapeKey: action.shapeKey,
    verdict,
    rule,
    reason,
    ...(outcome !== undefined && { outcome }),
    ...(tokens !== undefined && { tokens }),
    ...(cost !== undefined && { cost }),
  });
}

/**
 * Reads a required non-blank string field. Presence is `Object.hasOwn`;
 * absent, blank, or non-string all throw the same `"blank-or-non-string"`
 * violation for `field` — this validator has no notion of "absent is fine"
 * for any of these fields.
 */
function requireNonBlankString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): string {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  if (!isNonBlankString(value)) {
    throw logFailure(field, "blank-or-non-string");
  }
  return value;
}

/**
 * Validates `decision.action`: a plain object carrying exactly the fields
 * `projectEntry` copies verbatim into the entry.
 */
function assertValidDecisionAction(
  value: unknown,
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) {
    throw logFailure("decision.action", "not-a-plain-object");
  }
  assertAllowedKeys(value, DECISION_ACTION_KEYS, "decision.action", logFailure);

  requireNonBlankString(value, "script", "decision.action.script");
  requireNonBlankString(value, "kind", "decision.action.kind");
  requireNonBlankString(value, "shapeKey", "decision.action.shapeKey");

  const parameterNames = Object.hasOwn(value, "parameterNames")
    ? value["parameterNames"]
    : undefined;
  if (!isArray(parameterNames) || !parameterNames.every(isString)) {
    throw logFailure(
      "decision.action.parameterNames",
      "not-an-array-of-strings",
    );
  }

  const dryRun = Object.hasOwn(value, "dryRun") ? value["dryRun"] : undefined;
  if (!isBoolean(dryRun)) {
    throw logFailure("decision.action.dryRun", "not-a-boolean");
  }
}

/**
 * Validates `decision` structurally: a plain object, carrying a plain-object
 * `action` with the fields `projectEntry` copies verbatim, plus `verdict` /
 * `rule` / `reason`. There is no runtime brand to check membership against —
 * see this module's header comment — so every field the projector reads is
 * proven here instead. A malformed `decision` is a bug to surface loudly,
 * never folded silently into an entry.
 *
 * Every violation label is qualified with `decision.` (or
 * `decision.action.`), never the bare field name, so the generic
 * `traversal-threw` catch in {@link buildAgentDecisionLogEntry} stays a
 * hostile-Proxy backstop rather than the label a merely malformed decision
 * gets.
 */
function assertValidDecision(
  value: unknown,
): asserts value is M3LAgentDecision {
  if (!isPlainObject(value)) {
    throw logFailure("decision", "not-a-plain-object");
  }
  assertAllowedKeys(value, DECISION_KEYS, "decision", logFailure);

  const action = Object.hasOwn(value, "action") ? value["action"] : undefined;
  assertValidDecisionAction(action);

  requireNonBlankString(value, "verdict", "decision.verdict");
  requireNonBlankString(value, "rule", "decision.rule");
  requireNonBlankString(value, "reason", "decision.reason");
}

/**
 * Validates the whole options bag and projects it into a frozen
 * {@link M3LAgentDecisionLogEntry}.
 *
 * @param options - The caller's options bag, trusted for nothing.
 * @throws M3LAgentActionValidationError On any structural violation; its
 *   `context` names the offending field and the violation kind, never a
 *   value.
 */
export function buildAgentDecisionLogEntry(
  options: unknown,
): M3LAgentDecisionLogEntry {
  if (!isObject(options)) {
    throw logFailure("options", "not-an-object");
  }
  const bag = options as Readonly<Record<string, unknown>>;
  try {
    assertAllowedKeys(bag, OPTIONS_KEYS, "options", logFailure);
    const decision = Object.hasOwn(bag, "decision")
      ? bag["decision"]
      : undefined;
    assertValidDecision(decision);
    const identity = projectIdentity(
      Object.hasOwn(bag, "identity") ? bag["identity"] : undefined,
    );
    const now = readNow(bag);
    const outcome = Object.hasOwn(bag, "outcome")
      ? projectOutcome(bag["outcome"])
      : undefined;
    const tokens = readOptionalNonNegativeFiniteNumber(bag, "tokens");
    const cost = readOptionalNonNegativeFiniteNumber(bag, "cost");
    return projectEntry(decision, identity, now, outcome, tokens, cost);
  } catch (cause) {
    // Already typed — re-throw unchanged rather than double-wrapping.
    if (cause instanceof M3LError) {
      throw cause;
    }
    // A throwing accessor or Proxy trap breaks the traversal — see the same
    // handling in `internal/agent/action.ts`'s `validateEvaluationOptions`.
    throw new M3LAgentActionValidationError(
      `agent decision-log entry: "options" is invalid (traversal-threw)`,
      {
        context: { field: "options", violation: "traversal-threw" },
        cause,
      },
    );
  }
}
