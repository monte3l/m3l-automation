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
 *
 * Every field the projector (`projectEntry`) reads off `decision` is proven
 * here — this claim has needed three review rounds to become true
 * (`decision` itself, then `decision.action.target`, then
 * `decision.action.operation`), so it is now backed by more than prose:
 * {@link DECISION_KEYS_PROOF}, {@link DECISION_ACTION_KEYS_PROOF}, and
 * {@link DECISION_ACTION_TARGET_KEYS_PROOF} are `Record<keyof T, true>`
 * literals that only type-check when their key set exactly matches the
 * mirrored interface's (`M3LAgentDecision`, `M3LAgentActionRecord`,
 * `M3LAgentActionRecordTarget`), so a field added to one of those
 * interfaces without a matching edit here is a compile error. That proves
 * the *allowlist* stays complete; it cannot prove a validation call exists
 * for a key the allowlist admits, which is the half that slipped for
 * `operation` — see the read-set/proven-set ledger on
 * {@link assertValidDecisionAction} for that half.
 */

import type {
  M3LAgentActionRecord,
  M3LAgentActionRecordTarget,
} from "../../core/agent/action-types.js";
import type { M3LAgentDecision } from "../../core/agent/verdict-types.js";
import { M3LAgentActionValidationError } from "../../core/agent/M3LAgentActionValidationError.js";
import type {
  M3LAgentDecisionLogEntry,
  M3LAgentDecisionOutcome,
  M3LAgentIdentity,
} from "../../core/agent/decision-log-types.js";
// `core/agent/guards.js` imports only types from `./verdict-types.js` — no
// cycle back into `internal/agent` — so its rule-id membership check is
// reused here rather than hand-written a second time.
import { isAgentPolicyRuleId } from "../../core/agent/guards.js";
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

/**
 * Compile-time proof that {@link DECISION_KEYS} names every field of
 * `M3LAgentDecision` — this object literal type-checks only when its key set
 * exactly matches `keyof M3LAgentDecision`; a field added to (or removed
 * from) that type without a matching edit here is a `TS2741` (missing
 * property) or `TS2353` (excess property) compile error, not a silent gap.
 * It does not, by itself, prove the field is *validated* — see the header
 * comment above {@link assertValidDecision} for that half of the claim.
 */
const DECISION_KEYS_PROOF: Record<keyof M3LAgentDecision, true> = {
  action: true,
  verdict: true,
  rule: true,
  reason: true,
};

/**
 * The only own keys a decision may carry (mirrors `M3LAgentDecision`).
 *
 * @remarks
 * Derived from {@link DECISION_KEYS_PROOF} rather than a hand-written array:
 * see that constant for why this Set can never silently drift from the type
 * it mirrors.
 */
const DECISION_KEYS: ReadonlySet<string> = new Set(
  Object.keys(DECISION_KEYS_PROOF),
);

/**
 * Compile-time proof that {@link DECISION_ACTION_KEYS} names every field of
 * `M3LAgentActionRecord`. This is the record a field added to the interface
 * (e.g. `operation`, the field this module's third review round found
 * unvalidated) must now also join, or the file fails to compile.
 */
const DECISION_ACTION_KEYS_PROOF: Record<keyof M3LAgentActionRecord, true> = {
  script: true,
  operation: true,
  kind: true,
  target: true,
  parameterNames: true,
  dryRun: true,
  shapeKey: true,
};

/**
 * The only own keys a decision's action record may carry (mirrors
 * `M3LAgentActionRecord`). Derived from {@link DECISION_ACTION_KEYS_PROOF};
 * see {@link DECISION_KEYS_PROOF} for the mechanism.
 */
const DECISION_ACTION_KEYS: ReadonlySet<string> = new Set(
  Object.keys(DECISION_ACTION_KEYS_PROOF),
);

/**
 * Compile-time proof that {@link DECISION_ACTION_TARGET_KEYS} names every
 * field of `M3LAgentActionRecordTarget`.
 */
const DECISION_ACTION_TARGET_KEYS_PROOF: Record<
  keyof M3LAgentActionRecordTarget,
  true
> = {
  profile: true,
  region: true,
  accountId: true,
};

/**
 * The only own keys a decision's action `target` may carry (mirrors
 * `M3LAgentActionRecordTarget`). Derived from
 * {@link DECISION_ACTION_TARGET_KEYS_PROOF}; see {@link DECISION_KEYS_PROOF}
 * for the mechanism.
 */
const DECISION_ACTION_TARGET_KEYS: ReadonlySet<string> = new Set(
  Object.keys(DECISION_ACTION_TARGET_KEYS_PROOF),
);

/** The three `M3LAgentVerdict` members — this build's closed vocabulary. */
const AGENT_VERDICTS: ReadonlySet<string> = new Set([
  "auto-approved",
  "escalate",
  "denied",
]);

/** The two `M3LAgentActionKind` members. */
const AGENT_ACTION_KINDS: ReadonlySet<string> = new Set([
  "read-only",
  "mutating",
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

/**
 * Reads an optional non-blank string field where an own key holding
 * `undefined` is legitimate input — not merely "absent" — matching the
 * "required, holding `undefined`" shape `M3LAgentActionRecordTarget` and
 * `M3LAgentActionRecord.operation` both use (`core/agent/action-types.ts`).
 * A present-but-blank or a present-non-string, non-`undefined` value is
 * malformed and throws. Shared by `decision.action.target`'s own fields and
 * `decision.action.operation` — every field this module reads that has this
 * exact shape goes through here, so the shape is proven once.
 */
function readRequiredHoldingUndefinedString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): string | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isNonBlankString(value)) {
    throw logFailure(field, "blank-or-non-string");
  }
  return value;
}

/**
 * Validates `decision.action.target`: absent (or an own key holding
 * `undefined`), or a plain object carrying only `profile` / `region` /
 * `accountId`, each an optional non-blank string. Proving this shape closes
 * the gap where a non-object `target` (or one whose fields were never
 * checked) silently produced an entry that lost its target coordinates
 * instead of throwing.
 */
function assertValidDecisionActionTarget(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isPlainObject(value)) {
    throw logFailure("decision.action.target", "not-a-plain-object");
  }
  assertAllowedKeys(
    value,
    DECISION_ACTION_TARGET_KEYS,
    "decision.action.target",
    logFailure,
  );
  readRequiredHoldingUndefinedString(
    value,
    "profile",
    "decision.action.target.profile",
  );
  readRequiredHoldingUndefinedString(
    value,
    "region",
    "decision.action.target.region",
  );
  readRequiredHoldingUndefinedString(
    value,
    "accountId",
    "decision.action.target.accountId",
  );
}

/**
 * Requires a non-blank string field that is also a member of a closed
 * vocabulary. Distinguishes "not a string at all" (`blank-or-non-string`,
 * from {@link requireNonBlankString}) from "a string, but not a recognised
 * member" (`notInUnionLabel`), so the two failures stay distinguishable —
 * `context` never carries the offending value either way.
 */
function requireStringInUnion(
  record: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  isMember: (value: string) => boolean,
  notInUnionLabel: string,
): string {
  const value = requireNonBlankString(record, key, field);
  if (!isMember(value)) {
    throw logFailure(field, notInUnionLabel);
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
 *
 * @remarks
 * READ-SET / PROVEN-SET LEDGER — every field `projectEntry` reads off
 * `action` (`action.script`, `action.operation`, `action.kind`,
 * `action.target`, `action.parameterNames`, `action.shapeKey`) is proven by
 * a call below; `action.dryRun` is proven too even though `projectEntry`
 * does not read it (it is deliberately excluded from the entry — see
 * `M3LAgentDecisionLogEntry`'s remarks). {@link DECISION_ACTION_KEYS_PROOF}
 * forces this function to be revisited — a missing case here plus a missing
 * row there is now two compile errors, not one — whenever
 * `M3LAgentActionRecord` gains a field: add the field to the proof record,
 * then add a validation call in this function proving it, in the same edit.
 * `operation`'s absence here (a caller-supplied `{ apiKey: "…" }` copied
 * straight into the audit log) was this ledger's third and, so far, last
 * gap — see the module header.
 */
function assertValidDecisionAction(
  value: unknown,
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) {
    throw logFailure("decision.action", "not-a-plain-object");
  }
  assertAllowedKeys(value, DECISION_ACTION_KEYS, "decision.action", logFailure);

  requireNonBlankString(value, "script", "decision.action.script");
  readRequiredHoldingUndefinedString(
    value,
    "operation",
    "decision.action.operation",
  );
  requireStringInUnion(
    value,
    "kind",
    "decision.action.kind",
    (kind) => AGENT_ACTION_KINDS.has(kind),
    "not-a-known-kind",
  );
  requireNonBlankString(value, "shapeKey", "decision.action.shapeKey");

  const target = Object.hasOwn(value, "target") ? value["target"] : undefined;
  assertValidDecisionActionTarget(target);

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

  requireStringInUnion(
    value,
    "verdict",
    "decision.verdict",
    (verdict) => AGENT_VERDICTS.has(verdict),
    "not-a-known-verdict",
  );
  requireStringInUnion(
    value,
    "rule",
    "decision.rule",
    isAgentPolicyRuleId,
    "not-a-known-rule-id",
  );
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
