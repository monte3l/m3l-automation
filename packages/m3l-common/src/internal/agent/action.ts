/**
 * `internal/agent/action` — step 0 of the evaluator: the twelve ACT rules over
 * the options bag, and the single traversal that projects the caller's action
 * into a frozen {@link M3LAgentActionRecord}.
 *
 * Private to `core/agent`; never re-exported through a public barrel.
 * `evaluateAgentAction` (`core/agent/evaluate.ts`) validates here first and
 * then decides from what this module returns alone — including the policy, so
 * it never re-reads any field of the caller's options bag, and a caller
 * mutating their action afterwards cannot make the decision log and the
 * verdict disagree.
 */

import type {
  M3LAgentActionKind,
  M3LAgentActionRecord,
  M3LAgentActionRecordTarget,
} from "../../core/agent/action-types.js";
import { M3L_AGENT_MAX_PARAMETER_NAMES } from "../../core/agent/action-types.js";
import { M3LAgentActionValidationError } from "../../core/agent/M3LAgentActionValidationError.js";
import type { M3LAgentPolicy } from "../../core/agent/policy-types.js";
import { M3LError } from "../../core/errors/index.js";
import type { M3LDestructiveTargetPredicate } from "../../core/prompt/index.js";
import {
  isFunction,
  isObject,
  isPlainObject,
} from "../../core/utils/guards.js";
import { isValidatedAgentPolicy } from "./brand.js";
import {
  assertAllowedKeys,
  isNonBlankString,
  projectStringList,
} from "./validation.js";

/**
 * The only own keys the options bag may carry (ACT-11).
 *
 * Deliberate for slice 2: a caller that passes slice 2's per-run state to an
 * older library fails loud here rather than silently losing its budget
 * ceilings. It also catches the plain typo — `additionalSensitiveTarget`,
 * one `s` short, which TypeScript only flags for a fresh call-site literal
 * and never for a bag built as a variable.
 */
const OPTIONS_KEYS: ReadonlySet<string> = new Set([
  "action",
  "policy",
  "additionalSensitiveTargets",
]);

/** The only own keys an action may carry (ACT-8 and ACT-9). */
const ACTION_KEYS: ReadonlySet<string> = new Set([
  "script",
  "operation",
  "kind",
  "target",
  "parameterNames",
  "dryRun",
]);

/** The three scalars ADR-0048 declares on a target (ACT-5). */
const TARGET_KEYS: ReadonlySet<string> = new Set([
  "profile",
  "region",
  "accountId",
]);

/**
 * Every {@link M3LAgentActionKind}, keyed for an `Object.hasOwn` membership
 * check rather than a hand-maintained array — adding a kind without updating
 * this map is a compile error here instead of a silently drifting runtime
 * allowlist.
 */
const AGENT_ACTION_KINDS: Record<M3LAgentActionKind, true> = {
  "read-only": true,
  mutating: true,
};

/** The shared frozen default for an action declaring no parameter names. */
const NO_PARAMETER_NAMES: readonly string[] = Object.freeze([]);

/** The validated options bag, reduced to what the decision arms read. */
export interface M3LAgentEvaluationInput {
  /** The library's own frozen projection of the caller's action. */
  readonly record: M3LAgentActionRecord;
  /**
   * The policy, proven at step 0 to be one `validateAgentPolicy` produced.
   * Returned rather than left to the caller so `evaluate.ts` never re-reads
   * `options.policy` after validating it.
   */
  readonly policy: M3LAgentPolicy;
  /** The caller's extra sensitivity predicate, or `undefined` when absent. */
  readonly additionalSensitiveTargets:
    M3LDestructiveTargetPredicate | undefined;
}

/**
 * Builds the action-validation error for a named field and violation kind.
 * The `context` carries the field, the violation, and the offending key name
 * only — never a value read out of the caller's action.
 */
function actionFailure(
  field: string,
  violation: string,
  detail?: Readonly<Record<string, unknown>>,
): M3LAgentActionValidationError {
  return new M3LAgentActionValidationError(
    `agent action: "${field}" is invalid (${violation})`,
    { context: { field, violation, ...detail } },
  );
}

/** `true` when `value` is one of the two declared autonomy tiers (ACT-3). */
function isAgentActionKind(value: unknown): value is M3LAgentActionKind {
  return typeof value === "string" && Object.hasOwn(AGENT_ACTION_KINDS, value);
}

/**
 * Reads an optional non-blank string field. Presence is `Object.hasOwn`, so a
 * non-own `"__proto__"` resolves as absent; a present-but-blank or non-string
 * value is malformed input, not "absent", and throws.
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
    throw actionFailure(field, "blank-or-non-string");
  }
  return value;
}

/** ACT-5: the target, projected into a fresh frozen three-scalar object. */
function projectTarget(value: unknown): M3LAgentActionRecordTarget {
  if (!isPlainObject(value)) {
    throw actionFailure("action.target", "not-a-plain-object");
  }
  assertAllowedKeys(value, TARGET_KEYS, "action.target", actionFailure);

  const profile = Object.hasOwn(value, "profile")
    ? value["profile"]
    : undefined;
  if (!isNonBlankString(profile)) {
    throw actionFailure("action.target.profile", "blank-or-non-string");
  }
  const region = readOptionalNonBlankString(
    value,
    "region",
    "action.target.region",
  );
  const accountId = readOptionalNonBlankString(
    value,
    "accountId",
    "action.target.accountId",
  );

  // A fresh object carrying only ADR-0048's three scalars, with `region` and
  // `accountId` present as own properties holding `undefined` when absent.
  // Copying the caller's target REFERENCE instead would leave a later
  // `action.target.profile = "prod"` able to rewrite the decision's own
  // record.
  //
  // The own-`undefined` keys are deliberate and load-bearing: an own key
  // cannot be shadowed by a polluted `Object.prototype`, whereas an omitted
  // one resolves up the prototype chain on a plain dot read. Do NOT "tidy"
  // this into a conditional spread. No assertion is needed any more — the
  // return type is `M3LAgentActionRecordTarget`, which says required keys
  // holding `undefined`, which is exactly what this builds.
  return Object.freeze({ profile, region, accountId });
}

/** ACT-7: `dryRun` is a strict opt-in — only a boolean is accepted. */
function readDryRun(record: Readonly<Record<string, unknown>>): boolean {
  if (!Object.hasOwn(record, "dryRun")) {
    return false;
  }
  const value = record["dryRun"];
  if (typeof value !== "boolean") {
    // Present-but-valueless is malformed input, not "absent": coercing to
    // `false` here would silently turn an intended dry run into a real one.
    throw actionFailure("action.dryRun", "not-a-boolean");
  }
  return value;
}

/** ACT-1 through ACT-9: the action, projected into a frozen record. */
function projectAction(value: unknown): M3LAgentActionRecord {
  if (!isPlainObject(value)) {
    throw actionFailure("action", "not-a-plain-object");
  }
  assertAllowedKeys(value, ACTION_KEYS, "action", actionFailure);

  const script = Object.hasOwn(value, "script") ? value["script"] : undefined;
  if (!isNonBlankString(script)) {
    throw actionFailure("action.script", "blank-or-non-string");
  }

  // ACT-3 fails loud rather than falling through to step 4's
  // `unclassifiable-escalated` arm: a typo'd `kind: "readonly"` that merely
  // escalated would hide a caller bug behind a verdict that looks like policy
  // working correctly.
  const kind = Object.hasOwn(value, "kind") ? value["kind"] : undefined;
  if (!isAgentActionKind(kind)) {
    throw actionFailure("action.kind", "unrecognised-kind");
  }

  const operation = readOptionalNonBlankString(
    value,
    "operation",
    "action.operation",
  );
  const target = Object.hasOwn(value, "target")
    ? projectTarget(value["target"])
    : undefined;
  const parameterNames = Object.hasOwn(value, "parameterNames")
    ? projectStringList(
        value["parameterNames"],
        "action.parameterNames",
        {
          allowEmpty: true,
          maxEntries: M3L_AGENT_MAX_PARAMETER_NAMES,
          rejectDuplicates: false,
        },
        actionFailure,
      )
    : NO_PARAMETER_NAMES;
  const dryRun = readDryRun(value);

  return Object.freeze({
    script,
    operation,
    kind,
    target,
    parameterNames,
    dryRun,
  });
}

/** ACT-10: the extra sensitivity predicate, when present, is a function. */
function readSensitivityPredicate(
  bag: Readonly<Record<string, unknown>>,
): M3LDestructiveTargetPredicate | undefined {
  if (!Object.hasOwn(bag, "additionalSensitiveTargets")) {
    return undefined;
  }
  const predicate = bag["additionalSensitiveTargets"];
  if (!isFunction(predicate)) {
    // A non-function must surface as this module's typed error, not as a bare
    // TypeError from the call site at step 5.
    throw actionFailure("additionalSensitiveTargets", "not-a-function");
  }
  // The assertion is a convenience, not a proof: `isFunction` establishes
  // "callable", never the declared `boolean` return. TRUTHINESS is the real
  // contract — `decideMutation` in `decide.ts` is deliberately built for a
  // JavaScript caller returning `1` or `"yes"`. Do NOT "tighten" that
  // evaluator to `=== true` on the strength of this type.
  return predicate as M3LDestructiveTargetPredicate;
}

/**
 * ACT-12: the policy is one `validateAgentPolicy` itself produced.
 *
 * The `unique symbol` brand on `M3LAgentPolicy` is erased at compile time, so
 * `JSON.parse(text) as M3LAgentPolicy` — and `{ ...policy, scripts: [...] }`,
 * which needs no cast because a spread keeps the brand — both put an
 * unvalidated declaration in front of the evaluator. A membership check
 * against the validator's own registry is what makes "the validator is the
 * only door" true at runtime.
 *
 * Absent and forged deliberately collapse to the same rejection: reading a
 * missing policy used to surface a bare `TypeError` from `decide.ts`, which
 * broke the `instanceof M3LError` triage this module's errors promise.
 */
function readValidatedPolicy(
  bag: Readonly<Record<string, unknown>>,
): M3LAgentPolicy {
  const policy = Object.hasOwn(bag, "policy") ? bag["policy"] : undefined;
  if (!isValidatedAgentPolicy(policy)) {
    throw actionFailure("options.policy", "not-a-validated-policy");
  }
  return policy;
}

/** The ACT rules, run in order over an options bag already proven an object. */
function validateBag(
  bag: Readonly<Record<string, unknown>>,
): M3LAgentEvaluationInput {
  assertAllowedKeys(bag, OPTIONS_KEYS, "options", actionFailure);
  const policy = readValidatedPolicy(bag);
  const record = projectAction(
    Object.hasOwn(bag, "action") ? bag["action"] : undefined,
  );
  return {
    record,
    policy,
    additionalSensitiveTargets: readSensitivityPredicate(bag),
  };
}

/**
 * Step 0: validates the whole options bag against the ACT rules and projects
 * the action once into a frozen record.
 *
 * @param options - The caller's options bag, trusted for nothing.
 * @returns The frozen action projection, the validated policy, and the
 *   validated extra predicate.
 * @throws M3LAgentActionValidationError On any ACT-rule violation; its
 *   `context` names the offending field and the violation kind, never a
 *   value.
 */
export function validateEvaluationOptions(
  options: unknown,
): M3LAgentEvaluationInput {
  if (!isObject(options)) {
    throw actionFailure("options", "not-an-object");
  }
  const bag = options as Readonly<Record<string, unknown>>;
  try {
    return validateBag(bag);
  } catch (cause) {
    // Already typed — re-throw unchanged rather than double-wrapping.
    if (cause instanceof M3LError) {
      throw cause;
    }
    // The traversal itself is a fallible operation on a hostile object: a
    // throwing accessor (`get script() { throw }`) or a Proxy trap
    // (`ownKeys()`) raises a raw error from inside a guard that reads as
    // total. Loud, but it broke the `instanceof M3LError` triage both of this
    // module's error classes promise in their own `@example`.
    //
    // `cause` IS chained. The competing precedent — `M3LCheckpointError`
    // chaining nothing because a cause's message can embed caller values — no
    // longer applies to the serialisation channel: since #734,
    // `M3LError.toJSON()` allowlists its cause projection, and a foreign
    // (non-`M3LError`) cause collapses to `{ name }` only, carrying no
    // message, stack, or own fields. The live `.cause` stays available to a
    // maintainer debugging by hand, which is the whole diagnostic value of a
    // hostile-accessor throw.
    throw new M3LAgentActionValidationError(
      `agent action: "options" is invalid (traversal-threw)`,
      {
        context: { field: "options", violation: "traversal-threw" },
        cause,
      },
    );
  }
}
