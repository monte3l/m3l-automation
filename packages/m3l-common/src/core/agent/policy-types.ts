/**
 * `core/agent/policy-types` — the declared authority a deployment writes down,
 * its structural ceilings, and the branded policy only `validateAgentPolicy`
 * can produce (ADR-0060).
 *
 * @packageDocumentation
 */

import type { M3LSensitiveTargetSpec } from "../prompt/index.js";

/**
 * One script's grant inside an {@link M3LAgentPolicyDeclaration}.
 *
 * @remarks
 * Exactly one of `operations` (non-empty) or `allOperations === true` must be
 * present. Neither and both are declaration errors. **Omission never means
 * "everything"** — a whole-script grant has to be written down, so a typo'd
 * key can never silently widen authority.
 *
 * @example
 * ```ts
 * import type { M3LAgentScriptGrant } from "@m3l-automation/m3l-common/core";
 *
 * const grant: M3LAgentScriptGrant = {
 *   script: "dynamodb-crud",
 *   operations: ["get-item", "put-item"],
 * };
 * ```
 */
export interface M3LAgentScriptGrant {
  /** The script name this grant authorizes, matched verbatim. */
  readonly script: string;
  /**
   * The allowlisted operation **names** (ADR-0055's vocabulary carried as
   * plain strings). No type from `core/config` is imported: a caller derives
   * the names it allowlists and hands them over as data.
   */
  readonly operations?: readonly string[];
  /**
   * Widens the grant from a named operation set to the entire script. A
   * strict opt-in: only the boolean `true` is accepted.
   */
  readonly allOperations?: boolean;
}

/**
 * The plain-JSON, preset-storable declaration of an agent's authority.
 *
 * @remarks
 * The declaration round-trips `JSON.parse(JSON.stringify(x))`
 * byte-identically, which is what makes it storable in a preset and
 * reviewable in a diff. `sensitiveTargets` is ADR-0048's own
 * `M3LSensitiveTargetSpec`, imported: its **presence** is the grading opt-in,
 * so a deployment writes one sensitivity policy that both the destructive
 * gate and this authorization layer read.
 *
 * @example
 * ```ts
 * import type { M3LAgentPolicyDeclaration } from "@m3l-automation/m3l-common/core";
 *
 * const declaration: M3LAgentPolicyDeclaration = {
 *   version: 1,
 *   scripts: [{ script: "s3-report", allOperations: true }],
 *   sensitiveTargets: { profiles: ["prod"] },
 * };
 * ```
 */
export interface M3LAgentPolicyDeclaration {
  /** The declaration format version. Only the literal `1` is accepted. */
  readonly version: 1;
  /** The per-script grants; non-empty, with no duplicate `script`. */
  readonly scripts: readonly M3LAgentScriptGrant[];
  /**
   * ADR-0048's grading spec. Present means "this deployment grades targets";
   * absent means every mutation escalates as ungraded.
   */
  readonly sensitiveTargets?: M3LSensitiveTargetSpec;
}

/**
 * A validated, deep-frozen, **branded** policy.
 *
 * @remarks
 * Only `validateAgentPolicy` can produce one, and `evaluateAgentAction`
 * accepts only this type. The `unique symbol` brand is erased at compile
 * time, so on its own it stops nothing: `JSON.parse(text) as M3LAgentPolicy`
 * compiles, and so does `{ ...policy, scripts: [...] }`, which needs no cast
 * at all because a spread carries the brand across. The guarantee is
 * enforced at **runtime** instead — `validateAgentPolicy` records the exact
 * frozen object it returns in a module-private `WeakSet`, and step 0 of the
 * evaluator (ACT-12) rejects any policy object that is not a member with
 * `M3LAgentActionValidationError`. That is what makes "the validator is the
 * only door" a guarantee rather than a convention.
 *
 * @example
 * ```ts
 * import { validateAgentPolicy } from "@m3l-automation/m3l-common/core";
 * import type { M3LAgentPolicy } from "@m3l-automation/m3l-common/core";
 *
 * const policy: M3LAgentPolicy = validateAgentPolicy({
 *   version: 1,
 *   scripts: [{ script: "s3-report", allOperations: true }],
 * });
 * ```
 */
export type M3LAgentPolicy = M3LAgentPolicyDeclaration & {
  readonly __m3lAgentPolicyBrand: unique symbol;
};

/**
 * The ceiling on {@link M3LAgentPolicyDeclaration.scripts}.
 *
 * A **reject-above** bound: `length > 128` throws
 * `M3LAgentPolicyDeclarationError`, `length === 128` is accepted.
 *
 * @example
 * ```ts
 * import { M3L_AGENT_MAX_SCRIPT_GRANTS } from "@m3l-automation/m3l-common/core";
 *
 * const room = M3L_AGENT_MAX_SCRIPT_GRANTS; // 128
 * ```
 */
export const M3L_AGENT_MAX_SCRIPT_GRANTS = 128;

/**
 * The ceiling on {@link M3LAgentScriptGrant.operations}.
 *
 * A **reject-above** bound: `length > 128` throws
 * `M3LAgentPolicyDeclarationError`, `length === 128` is accepted.
 *
 * @example
 * ```ts
 * import { M3L_AGENT_MAX_OPERATIONS_PER_GRANT } from "@m3l-automation/m3l-common/core";
 *
 * const room = M3L_AGENT_MAX_OPERATIONS_PER_GRANT; // 128
 * ```
 */
export const M3L_AGENT_MAX_OPERATIONS_PER_GRANT = 128;

/**
 * The ceiling on the grading spec's entries, **summed across all three lists**
 * (`profiles` + `regions` + `accountIds`).
 *
 * @remarks
 * The bound is a total rather than a per-list bound, because the cost the
 * ceiling exists to bound is the whole spec's size. A **reject-above** bound:
 * a total `> 256` throws `M3LAgentPolicyDeclarationError`, `=== 256` is
 * accepted.
 *
 * @example
 * ```ts
 * import { M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES } from "@m3l-automation/m3l-common/core";
 *
 * const room = M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES; // 256
 * ```
 */
export const M3L_AGENT_MAX_SENSITIVE_TARGET_ENTRIES = 256;
