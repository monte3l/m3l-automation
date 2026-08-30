/**
 * `internal/agent/decision-log-projection` — proves the structure of an entry
 * handed to `M3LAgentDecisionLog.write` and rebuilds it as the library's own
 * prototype-free copy: the only object the writer ever serializes.
 *
 * Private to `core/agent`; never re-exported through a public barrel.
 *
 * `write()` is a public method, so the value reaching it is whatever the
 * caller passed — a static `M3LAgentDecisionLogEntry` annotation proves
 * nothing at runtime. Serializing that object directly fails in two ways, and
 * this module exists to close both:
 *
 * - `JSON.stringify` **returns `undefined`** (it does not throw) for a plain
 *   object whose `toJSON()` returns `undefined`, and interpolating that into
 *   a template literal launders it into the nine-character text `undefined` —
 *   a line no JSON reader can consume, appended while `write()` resolves;
 * - `JSON.stringify` dispatches an **inherited** `toJSON`, so a gadget planted
 *   on `Object.prototype` rewrites the record of an entry this library itself
 *   built and deep-froze. `Object.freeze` is no defence there: the property is
 *   not an own property of the entry.
 *
 * The repair is the rule `M3LAgentActionRecord` already states for the
 * evaluator (`core/agent/action-types.ts`): validate once, then never let
 * anything re-read the caller's object. Every field is read with
 * `Object.hasOwn`, every node of the projection is built with a **null
 * prototype** (see {@link detached}), and what the writer serializes is that
 * projection — so no inherited `toJSON` is reachable from any node of it.
 *
 * The entry's field rules are the ones `internal/agent/decision-log.ts`
 * already proves on the way in; the allowlists and vocabulary guards are
 * imported from there rather than restated, and the single-field readers come
 * from `internal/agent/validation.ts`, so there is one definition of "a valid
 * identity" / "a known verdict" for both directions.
 */

import { isAgentPolicyRuleId } from "../../core/agent/guards.js";
import type { M3LAgentActionRecordTarget } from "../../core/agent/action-types.js";
import type {
  M3LAgentDecisionLogEntry,
  M3LAgentDecisionOutcome,
  M3LAgentIdentity,
} from "../../core/agent/decision-log-types.js";
import {
  isArray,
  isBoolean,
  isPlainObject,
  isString,
} from "../../core/utils/guards.js";
import {
  DECISION_ACTION_TARGET_KEYS,
  IDENTITY_KEYS,
  OUTCOME_KEYS,
  isAgentActionKind,
  isAgentVerdict,
} from "./decision-log.js";
import type { M3LAgentValidationFailureFactory } from "./validation.js";
import {
  assertAllowedKeys,
  readOptionalInteger,
  readOptionalNonBlankString,
  readOptionalNonNegativeFiniteNumber,
  readRequiredHoldingUndefinedString,
  requireNonBlankString,
  requireStringInUnion,
} from "./validation.js";

/**
 * Compile-time proof that {@link ENTRY_KEYS} names every field of
 * `M3LAgentDecisionLogEntry` — the literal type-checks only when its key set
 * exactly matches `keyof M3LAgentDecisionLogEntry`, so a field added to that
 * interface without a matching edit here is a compile error rather than a
 * field the writer would silently reject as an unknown key. Same mechanism as
 * `DECISION_KEYS_PROOF` in `internal/agent/decision-log.ts`.
 */
const ENTRY_KEYS_PROOF: Record<keyof M3LAgentDecisionLogEntry, true> = {
  timestamp: true,
  identity: true,
  script: true,
  operation: true,
  kind: true,
  target: true,
  parameterNames: true,
  shapeKey: true,
  verdict: true,
  rule: true,
  reason: true,
  outcome: true,
  tokens: true,
  cost: true,
};

/** The only own keys an entry may carry; see {@link ENTRY_KEYS_PROOF}. */
const ENTRY_KEYS: ReadonlySet<string> = new Set(Object.keys(ENTRY_KEYS_PROOF));

/**
 * Seals one freshly built projection node: no prototype, then frozen.
 *
 * Dropping the prototype is the load-bearing half. `JSON.stringify` looks
 * `toJSON` up the prototype chain, so an object literal — inheriting from
 * `Object.prototype` — is still a forgery surface even when every value in it
 * was proven here. A node with no prototype has nothing to inherit.
 */
function detached<T extends object>(value: T): Readonly<T> {
  Object.setPrototypeOf(value, null);
  return Object.freeze(value);
}

/** Reads one own field of a proven record; a non-own key reads as absent. */
function own(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The entry's identity, rebuilt from proven fields alone. */
function projectIdentity(
  value: unknown,
  failure: M3LAgentValidationFailureFactory,
): M3LAgentIdentity {
  if (!isPlainObject(value)) {
    throw failure("entry.identity", "not-a-plain-object");
  }
  assertAllowedKeys(value, IDENTITY_KEYS, "entry.identity", failure);
  const name = requireNonBlankString(
    value,
    "name",
    "entry.identity.name",
    failure,
  );
  const modelId = readOptionalNonBlankString(
    value,
    "modelId",
    "entry.identity.modelId",
    failure,
  );
  const awsPrincipal = readOptionalNonBlankString(
    value,
    "awsPrincipal",
    "entry.identity.awsPrincipal",
    failure,
  );
  return detached({
    name,
    ...(modelId !== undefined && { modelId }),
    ...(awsPrincipal !== undefined && { awsPrincipal }),
  });
}

/**
 * The entry's target coordinates, rebuilt from proven fields alone. `region`
 * and `accountId` are emitted as own keys holding `undefined` when the action
 * declared none — the shape `M3LAgentActionRecordTarget` documents, kept
 * verbatim so the projection serializes byte-for-byte like the entry it
 * mirrors.
 */
function projectTarget(
  value: unknown,
  failure: M3LAgentValidationFailureFactory,
): M3LAgentActionRecordTarget | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw failure("entry.target", "not-a-plain-object");
  }
  assertAllowedKeys(
    value,
    DECISION_ACTION_TARGET_KEYS,
    "entry.target",
    failure,
  );
  return detached({
    profile: requireNonBlankString(
      value,
      "profile",
      "entry.target.profile",
      failure,
    ),
    region: readRequiredHoldingUndefinedString(
      value,
      "region",
      "entry.target.region",
      failure,
    ),
    accountId: readRequiredHoldingUndefinedString(
      value,
      "accountId",
      "entry.target.accountId",
      failure,
    ),
  });
}

/** The entry's outcome, rebuilt from proven fields alone. */
function projectOutcome(
  value: unknown,
  failure: M3LAgentValidationFailureFactory,
): M3LAgentDecisionOutcome {
  if (!isPlainObject(value)) {
    throw failure("entry.outcome", "not-a-plain-object");
  }
  assertAllowedKeys(value, OUTCOME_KEYS, "entry.outcome", failure);
  const dryRun = own(value, "dryRun");
  if (!isBoolean(dryRun)) {
    throw failure("entry.outcome.dryRun", "not-a-boolean");
  }
  const exitCode = readOptionalInteger(
    value,
    "exitCode",
    "entry.outcome.exitCode",
    failure,
  );
  const registryName = readOptionalNonBlankString(
    value,
    "registryName",
    "entry.outcome.registryName",
    failure,
  );
  return detached({
    dryRun,
    ...(exitCode !== undefined && { exitCode }),
    ...(registryName !== undefined && { registryName }),
  });
}

/**
 * The entry's parameter names, rebuilt as a detached copy.
 *
 * Indexed rather than spread or `for...of`: `Array.isArray` passes for a real
 * array whose own `Symbol.iterator` has been overridden, so an
 * iterator-driven copy can diverge from the array just proven — the same
 * reasoning `projectStringList` records in `internal/agent/validation.ts`.
 */
function projectParameterNames(
  value: unknown,
  failure: M3LAgentValidationFailureFactory,
): readonly string[] {
  if (!isArray(value)) {
    throw failure("entry.parameterNames", "not-an-array");
  }
  const length = value.length;
  const names: string[] = [];
  for (let index = 0; index < length; index++) {
    const name = value[index];
    if (!isString(name)) {
      throw failure("entry.parameterNames", "not-an-array-of-strings");
    }
    names.push(name);
  }
  return detached(names);
}

/**
 * The entry's scalar fields, each proven and narrowed.
 *
 * Extracted only so {@link projectAgentDecisionLogEntry} stays readable — it
 * carries no rule of its own, and the composed literal there remains the one
 * place the entry's key ORDER is stated.
 */
interface ProvenEntryScalars {
  readonly timestamp: string;
  readonly script: string;
  readonly operation: string | undefined;
  readonly kind: M3LAgentDecisionLogEntry["kind"];
  readonly shapeKey: string;
  readonly verdict: M3LAgentDecisionLogEntry["verdict"];
  readonly rule: M3LAgentDecisionLogEntry["rule"];
  readonly reason: string;
}

/** Proves every scalar field of an entry; see {@link ProvenEntryScalars}. */
function proveEntryScalars(
  entry: Readonly<Record<string, unknown>>,
  failure: M3LAgentValidationFailureFactory,
): ProvenEntryScalars {
  return {
    timestamp: requireNonBlankString(
      entry,
      "timestamp",
      "entry.timestamp",
      failure,
    ),
    script: requireNonBlankString(entry, "script", "entry.script", failure),
    operation: readRequiredHoldingUndefinedString(
      entry,
      "operation",
      "entry.operation",
      failure,
    ),
    kind: requireStringInUnion(
      entry,
      "kind",
      "entry.kind",
      isAgentActionKind,
      "not-a-known-kind",
      failure,
    ),
    shapeKey: requireNonBlankString(
      entry,
      "shapeKey",
      "entry.shapeKey",
      failure,
    ),
    verdict: requireStringInUnion(
      entry,
      "verdict",
      "entry.verdict",
      isAgentVerdict,
      "not-a-known-verdict",
      failure,
    ),
    rule: requireStringInUnion(
      entry,
      "rule",
      "entry.rule",
      isAgentPolicyRuleId,
      "not-a-known-rule-id",
      failure,
    ),
    reason: requireNonBlankString(entry, "reason", "entry.reason", failure),
  };
}

/**
 * Proves `entry` structurally and returns the library's own detached copy of
 * it — the value the writer serializes.
 *
 * @param entry - The caller's entry, trusted for nothing.
 * @param failure - Builds the boundary error; the writer passes its
 *   `ERR_INVALID_ARGUMENT` factory, so a malformed entry is reported as the
 *   caller-side violation it is rather than as a write failure.
 * @returns A detached (prototype-free, frozen) entry whose every node this
 *   library built, sharing no object by reference with `entry`.
 * @throws The error `failure` builds, when `entry` is not a plain object,
 *   carries an unknown or dangerous own key (`"__proto__"` among them), or
 *   holds a field of the wrong shape. The error names the field and the
 *   violation kind, never the offending value.
 */
export function projectAgentDecisionLogEntry(
  entry: unknown,
  failure: M3LAgentValidationFailureFactory,
): M3LAgentDecisionLogEntry {
  if (!isPlainObject(entry)) {
    throw failure("entry", "not-an-object");
  }
  assertAllowedKeys(entry, ENTRY_KEYS, "entry", failure);

  const scalars = proveEntryScalars(entry, failure);
  const identity = projectIdentity(own(entry, "identity"), failure);
  const target = projectTarget(own(entry, "target"), failure);
  const parameterNames = projectParameterNames(
    own(entry, "parameterNames"),
    failure,
  );
  const outcome = Object.hasOwn(entry, "outcome")
    ? projectOutcome(entry["outcome"], failure)
    : undefined;
  const tokens = readOptionalNonNegativeFiniteNumber(
    entry,
    "tokens",
    "entry.tokens",
    failure,
  );
  const cost = readOptionalNonNegativeFiniteNumber(
    entry,
    "cost",
    "entry.cost",
    failure,
  );

  // Key order mirrors `projectEntry`'s in `internal/agent/decision-log.ts`:
  // the projection must serialize to the same bytes as the entry it copies,
  // and JSON preserves insertion order.
  return detached({
    timestamp: scalars.timestamp,
    identity,
    script: scalars.script,
    operation: scalars.operation,
    kind: scalars.kind,
    target,
    parameterNames,
    shapeKey: scalars.shapeKey,
    verdict: scalars.verdict,
    rule: scalars.rule,
    reason: scalars.reason,
    ...(outcome !== undefined && { outcome }),
    ...(tokens !== undefined && { tokens }),
    ...(cost !== undefined && { cost }),
  });
}
