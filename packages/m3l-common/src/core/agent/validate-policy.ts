/**
 * `core/agent/validate-policy` — the boundary parser/validator that turns a
 * parsed JSON document into a branded {@link M3LAgentPolicy} (ADR-0060).
 *
 * @packageDocumentation
 */

import { registerValidatedAgentPolicy } from "../../internal/agent/brand.js";
import { validateAgentPolicyDeclaration } from "../../internal/agent/policy.js";
import type { M3LAgentPolicy } from "./policy-types.js";

/**
 * Validates a parsed policy declaration and returns a branded, deep-frozen
 * {@link M3LAgentPolicy}.
 *
 * @remarks
 * The parameter is `unknown`, not `M3LAgentPolicyDeclaration`, because the
 * real input is a parsed JSON or YAML document; typing it as the declaration
 * would be a lie that skips the entire point. This is the only door: because
 * `evaluateAgentAction` accepts only the branded type, it is structurally
 * impossible to evaluate against an unvalidated declaration.
 *
 * Every check is an **allowlist** — prove the shape valid, never try to
 * recognise it as invalid — and field presence is read with `Object.hasOwn`
 * so a non-own `"__proto__"` resolves as absent. Rejected: a non-plain-object
 * input; a `version` other than the literal `1`; a `scripts` list that is
 * absent, not an array, empty, or longer than `M3L_AGENT_MAX_SCRIPT_GRANTS`;
 * a grant that is not a plain object or whose `script` is blank; a duplicate
 * `script`; a grant with neither or both of `operations` and `allOperations`;
 * an `operations` list that is empty, over-long, non-string, blank, or
 * duplicated; an `allOperations` that is not the boolean `true`; a
 * `sensitiveTargets` that is not a plain object or omits all three of
 * `profiles` / `regions` / `accountIds`; a grading list that is not a
 * non-empty array of non-blank strings, contains duplicates, or whose entries
 * summed across the three lists exceed
 * `M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES`; any unknown key at the top level,
 * on a grant, or on the grading spec; and any key rejected by
 * `isDangerousKey`.
 *
 * The traversal is one pass: validate and project into a fresh, deep-frozen
 * structure in the same walk, then brand. Nothing downstream re-reads the
 * caller's object.
 *
 * The brand is enforced at **runtime**, not only in the type system: the
 * object returned here is recorded in a module-private `WeakSet` that
 * `evaluateAgentAction` checks at step 0. Both forgery routes produce an
 * object that is not a member and are rejected with
 * `M3LAgentActionValidationError` — a parsed document asserted to the branded
 * type, and a spread of a real policy with rewritten grants, which needs no
 * assertion at all because a spread carries the brand type across. "The
 * validator is the only door" is therefore a guarantee rather than a
 * convention.
 *
 * @param declaration - The parsed policy document, validated at this boundary.
 * @returns The validated, deep-frozen, branded policy.
 * @throws M3LAgentPolicyDeclarationError When the declaration is structurally
 *   invalid; its `context` names the offending grant index or key and the
 *   violation kind, never a value.
 *
 * @example
 * ```ts
 * import { validateAgentPolicy } from "@m3l-automation/m3l-common/core";
 *
 * const policy = validateAgentPolicy({
 *   version: 1,
 *   scripts: [
 *     { script: "s3-report", allOperations: true },
 *     { script: "dynamodb-crud", operations: ["get-item", "put-item"] },
 *   ],
 *   sensitiveTargets: { profiles: ["prod"], regions: ["eu-west-1"] },
 * });
 * ```
 */
export function validateAgentPolicy(declaration: unknown): M3LAgentPolicy {
  // The type-level brand is erased at compile time, so the deep-frozen
  // projection is also registered at runtime: `evaluateAgentAction` rejects
  // any policy-shaped object that did not come out of this call.
  return registerValidatedAgentPolicy(
    validateAgentPolicyDeclaration(declaration) as M3LAgentPolicy,
  );
}
