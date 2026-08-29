/**
 * `internal/agent/decide` — the tier decision table behind
 * `Core.evaluateAgentAction`: the script allowlist (step 1), the operation
 * allowlist (step 2), the autonomy tier (step 4), ADR-0048's grading arms
 * (step 5), and the graded non-sensitive mutation arm (step 7).
 *
 * Private to `core/agent`; never re-exported through a public barrel. Steps 3
 * (budgets) and 6 (dry-run-first) are slice-2 arms and are not evaluated
 * here. Every arm is terminal, every arm reads the frozen record projected at
 * step 0 rather than the caller's action, and every arm carries that
 * projection on its decision.
 */

import type {
  M3LAgentActionRecord,
  M3LAgentActionRecordTarget,
} from "../../core/agent/action-types.js";
import type { M3LAgentPolicy } from "../../core/agent/policy-types.js";
import type {
  M3LAgentDecision,
  M3LAgentPolicyRuleId,
} from "../../core/agent/verdict-types.js";
import type {
  M3LDestructiveTarget,
  M3LDestructiveTargetPredicate,
} from "../../core/prompt/index.js";
import { sensitiveTargets } from "../../core/prompt/index.js";

/**
 * The action under judgement, as library-authored prose composed only from
 * `script`, `operation` and `kind`. A parameter name never appears here.
 */
function describeSubject(record: M3LAgentActionRecord): string {
  const operation =
    record.operation === undefined
      ? "no declared operation"
      : `operation "${record.operation}"`;
  return `the ${record.kind} action on script "${record.script}" (${operation})`;
}

/** ADR-0048's three target scalars, as prose. Never a parameter value. */
function describeTarget(target: M3LAgentActionRecordTarget): string {
  return `profile "${target.profile}", region "${target.region ?? "unspecified"}", account "${target.accountId ?? "unspecified"}"`;
}

/**
 * Widens the record's target back into ADR-0048's own optional-key shape for
 * the two sensitivity predicates.
 *
 * The record deliberately carries `region`/`accountId` as own keys holding
 * `undefined` (prototype-shadowing resistance); `M3LDestructiveTarget`
 * declares them optional, which under `exactOptionalPropertyTypes` means
 * "absent, or a string". Handing the record straight over would be the same
 * unsound cast the record type was just fixed to remove — a caller predicate
 * writing `if ("region" in target)` would narrow to `string` and read
 * `undefined`. So an absent scalar is omitted here, which is what the
 * predicate contract actually promises. A `sensitiveTargets` list is always a
 * non-empty list of non-blank strings, so an omitted scalar and an
 * `undefined` one grade identically.
 */
function asDestructiveTarget(
  target: M3LAgentActionRecordTarget,
): M3LDestructiveTarget {
  return {
    profile: target.profile,
    ...(target.region !== undefined ? { region: target.region } : {}),
    ...(target.accountId !== undefined ? { accountId: target.accountId } : {}),
  };
}

/** Builds the `denied` arm of the decision union. */
function denied(
  rule: M3LAgentPolicyRuleId,
  reason: string,
  record: M3LAgentActionRecord,
): M3LAgentDecision {
  return { verdict: "denied", rule, reason, action: record };
}

/** Builds the `escalate` arm of the decision union. */
function escalate(
  rule: M3LAgentPolicyRuleId,
  reason: string,
  record: M3LAgentActionRecord,
): M3LAgentDecision {
  return { verdict: "escalate", rule, reason, action: record };
}

/** Builds the `auto-approved` arm of the decision union. */
function autoApproved(
  rule: M3LAgentPolicyRuleId,
  reason: string,
  record: M3LAgentActionRecord,
): M3LAgentDecision {
  return { verdict: "auto-approved", rule, reason, action: record };
}

/**
 * Steps 5 and 7: ADR-0048's grading, ridden rather than reinterpreted, and
 * the graded non-sensitive mutation arm.
 */
function decideMutation(
  record: M3LAgentActionRecord,
  policy: M3LAgentPolicy,
  additionalSensitiveTargets: M3LDestructiveTargetPredicate | undefined,
  subject: string,
): M3LAgentDecision {
  const target = record.target;
  if (target === undefined) {
    return escalate(
      "target-ungraded-escalated",
      `${subject} is escalated: it carries no ADR-0048 target, so nothing can grade it down.`,
      record,
    );
  }

  // `Object.hasOwn`, never a plain `policy.sensitiveTargets`. The validated
  // policy omits the key when the deployment declared no grading, so a dot
  // read walks to `Object.prototype` — and with
  // `Object.prototype.sensitiveTargets = {}` this arm was skipped and a prod
  // mutation auto-approved under the policy that had opted out of grading
  // precisely so everything would escalate. Presence-by-`Object.hasOwn` is
  // the rule the whole module follows; this file is where it was missing.
  const spec = Object.hasOwn(policy, "sensitiveTargets")
    ? policy.sensitiveTargets
    : undefined;
  if (spec === undefined) {
    return escalate(
      "policy-ungraded-escalated",
      `${subject} on ${describeTarget(target)} is escalated: the policy declares no sensitiveTargets spec.`,
      record,
    );
  }

  // Guard polarity, deliberately opposite to the `allOperations !== true`
  // opt-in in `decideAgentAction` below. This one is a VERDICT, so it
  // escalates on truthiness: `additionalSensitiveTargets` is caller-supplied
  // and a JavaScript caller can return `1` or `"yes"`, and `=== true` here
  // would be a fail-open hole in the place with the widest blast radius. The
  // asymmetry between the two is load-bearing — do NOT "harmonise" them.
  //
  // The explicit ternary (rather than `additionalSensitiveTargets?.(target)
  // ?? false`) keeps "absent, contributes nothing" visually distinct from
  // "present and returned falsy".
  const graded = asDestructiveTarget(target);
  const declaredSensitive = sensitiveTargets(spec)(graded);
  const extraSensitive =
    additionalSensitiveTargets === undefined
      ? false
      : additionalSensitiveTargets(graded);
  if (declaredSensitive || extraSensitive) {
    return escalate(
      "sensitive-target-escalated",
      `${subject} on ${describeTarget(target)} is escalated: the target is graded sensitive.`,
      record,
    );
  }

  return autoApproved(
    "graded-mutation-auto-approved",
    `${subject} on ${describeTarget(target)} is auto-approved: an allowlisted mutation on a graded, non-sensitive target.`,
    record,
  );
}

/**
 * Runs the normative evaluation order over a validated policy and the frozen
 * record projected at step 0.
 *
 * @param record - The library's own frozen projection of the caller's action.
 * @param policy - The validated, branded policy.
 * @param additionalSensitiveTargets - The caller's extra sensitivity
 *   predicate, or `undefined` when absent.
 * @returns The decision — verdict, rule id, library-authored reason, and the
 *   frozen record.
 */
export function decideAgentAction(
  record: M3LAgentActionRecord,
  policy: M3LAgentPolicy,
  additionalSensitiveTargets: M3LDestructiveTargetPredicate | undefined,
): M3LAgentDecision {
  const subject = describeSubject(record);

  // Step 1 — the script allowlist. Matched verbatim: a differently-cased or
  // space-padded name is a different script.
  const grant = policy.scripts.find(
    (candidate) => candidate.script === record.script,
  );
  if (grant === undefined) {
    return denied(
      "script-not-allowlisted",
      `${subject} is denied: no grant allowlists the script.`,
      record,
    );
  }

  // Step 2 — the operation allowlist. Guard polarity, deliberately opposite
  // to the truthiness verdict in `decideMutation` above: `allOperations` is
  // an OPT-IN that widens a grant from a named operation set to the entire
  // script, so it demands strict `true` and a truthy non-`true` value must
  // never widen authority. `validateAgentPolicy` already rejects a
  // non-boolean; this is the documented second line of defence, not a
  // redundancy. Do NOT "harmonise" the two polarities.
  //
  // Both keys are read through `Object.hasOwn` for the same reason
  // `sensitiveTargets` is in `decideMutation`: a grant carries exactly ONE of
  // them, so the other is an absent own key and a plain `grant.allOperations`
  // walks to `Object.prototype`. With `Object.prototype.allOperations = true`
  // a grant of `operations: ["get-item"]` widened to the whole script and
  // this entire step was skipped.
  const allOperations = Object.hasOwn(grant, "allOperations")
    ? grant.allOperations
    : undefined;
  if (allOperations !== true) {
    const operations = Object.hasOwn(grant, "operations")
      ? grant.operations
      : undefined;
    if (
      record.operation === undefined ||
      operations === undefined ||
      !operations.includes(record.operation)
    ) {
      return denied(
        "operation-not-allowlisted",
        `${subject} is denied: the grant allowlists named operations and this is not one of them.`,
        record,
      );
    }
  }

  // Step 3 — budgets and ceilings — is slice 2 and is not evaluated here.

  // Step 4 — the autonomy tier.
  switch (record.kind) {
    case "read-only":
      return autoApproved(
        "read-only-auto-approved",
        `${subject} is auto-approved: read-only actions inside the allowlist need no review.`,
        record,
      );
    case "mutating":
      break;
    default: {
      /* v8 ignore next 3 -- unreachable: ACT-3 rejects any other kind at step 0;
         this is a compile-time exhaustiveness assertion, not a runtime path. */
      const unhandled: never = record.kind;
      const reason = `${subject} is escalated: no rule handles kind "${String(unhandled)}".`;
      return escalate("unclassifiable-escalated", reason, record);
    }
  }

  // Step 6 — dry-run-first — is slice 2 and is not evaluated here.

  return decideMutation(record, policy, additionalSensitiveTargets, subject);
}
