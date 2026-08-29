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
  /**
   * The declared cross-check on `kind`: the operations this grant considers
   * read-only. When declared, a `read-only` claim for an operation NOT on
   * this list escalates with `kind-cross-check-escalated` instead of
   * auto-approving (see docs/reference/core/agent.md
   * § The declared cross-check on `kind`). One-directional by design: it
   * never doubts a `mutating` claim, since only a false `read-only` claim is
   * dangerous. Optional — a deployment that has not enumerated its read-only
   * operations should not be forced to guess.
   */
  readonly readOnlyOperations?: readonly string[];
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
  /**
   * The declared per-run and per-day ceilings (step 3). Absent means step 3
   * is skipped entirely — a slice-1 declaration reaches exactly the arms
   * slice 1 evaluated, in the same order, and gets the same verdict.
   */
  readonly budgets?: M3LAgentBudgets;
  /**
   * Opts into the dry-run-first discipline (step 6). Takes the same
   * strict-`true` polarity as `allOperations`, for the mirror-image reason: a
   * deployment that writes down a discipline should get it or get an error,
   * never a silent downgrade to no discipline at all. `false` is accepted and
   * means the same as absent.
   */
  readonly dryRunFirst?: boolean;
}

/**
 * The declared per-run and per-day ceilings a deployment writes down (step 3).
 *
 * @remarks
 * Every field is optional; at least one must be declared (an empty `budgets`
 * object is rejected — it would read as "this deployment governs spend" in a
 * diff while enforcing nothing). `invocationsPerRun`, `invocationsPerDay`,
 * `tokensPerRun`, and `loopIterations` must be positive, finite safe
 * integers; `costPerRun` may be fractional but must still be positive and
 * finite. A ceiling of `0` is rejected: it would be exhausted before the run
 * begins, which is a way of spelling "deny this script" that the `scripts`
 * allowlist already spells properly.
 *
 * The five ceilings are checked in a **fixed order** —
 * `invocationsPerRun`, `invocationsPerDay`, `tokensPerRun`, `costPerRun`,
 * `loopIterations` — independent of the order they are declared in.
 *
 * @example
 * ```ts
 * import type { M3LAgentBudgets } from "@m3l-automation/m3l-common/core";
 *
 * const budgets: M3LAgentBudgets = { invocationsPerRun: 50, costPerRun: 5 };
 * ```
 */
export interface M3LAgentBudgets {
  /** The per-run invocation ceiling; compared against `invocationsThisRun`. */
  readonly invocationsPerRun?: number;
  /** The per-day invocation ceiling; compared against `invocationsToday`. */
  readonly invocationsPerDay?: number;
  /** The per-run token ceiling; compared against `tokensThisRun`. */
  readonly tokensPerRun?: number;
  /**
   * The per-run cost ceiling, in the deployment's own unit; compared
   * against `costThisRun`. No type from `aws/*` crosses into this module.
   */
  readonly costPerRun?: number;
  /** The loop-iteration ceiling; compared against `loopIterations`. */
  readonly loopIterations?: number;
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
