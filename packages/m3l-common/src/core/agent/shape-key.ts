/**
 * `core/agent/shape-key` — `agentActionShapeKey`, the standalone door to the
 * dry-run shape key computation (ADR-0060, slice 2 § Dry-run-first).
 *
 * @packageDocumentation
 */

import { projectAction } from "../../internal/agent/action.js";
import { M3LError } from "../errors/index.js";
import { M3LAgentActionValidationError } from "./M3LAgentActionValidationError.js";
import type { M3LAgentAction } from "./action-types.js";

/**
 * Computes the dry-run shape key for an intended action, without evaluating
 * it against a policy.
 *
 * @remarks
 * `agentActionShapeKey` and `M3LAgentActionRecord.shapeKey` are two doors to
 * one computation. After an escalation the key is already on the decision
 * (`decision.action.shapeKey`); this function exists for the moment
 * **before** any evaluation — seeding a ledger from a previous run, or from a
 * durable store — when there is no decision to read it from.
 *
 * It validates its argument by ACT-1 through ACT-9 only — every rule that is
 * about the action itself — plus the same `traversal-threw` wrapper the
 * evaluator uses, throwing `M3LAgentActionValidationError`. It cannot apply
 * ACT-10 through ACT-15: those judge the options bag, its policy, its
 * predicate, and its ledger, and this function receives none of them, so it
 * needs no policy and never throws `M3LAgentPolicyDeclarationError`.
 *
 * `context.field` reads `"action"` for every failure — this entry point
 * takes one argument, not an options bag, so there is no `"options"` to
 * report against, and no `"action.xxx"` sub-path either: naming one would
 * send a reader looking for a parameter that does not exist.
 *
 * @param action - The intended action, trusted for nothing.
 * @returns The dry-run shape key: `canonicalJsonHash` over the action's
 *   `script`, `operation`, `kind`, and sorted `parameterNames`.
 * @throws M3LAgentActionValidationError When `action` is structurally
 *   malformed; its `context` names the violation kind, never a value.
 *
 * @example
 * ```ts
 * import { agentActionShapeKey } from "@m3l-automation/m3l-common/core";
 *
 * const key = agentActionShapeKey({
 *   script: "dynamodb-crud",
 *   operation: "put-item",
 *   kind: "mutating",
 *   parameterNames: ["table", "item"],
 * });
 * // key is a 64-character lowercase hex digest
 * ```
 */
export function agentActionShapeKey(action: M3LAgentAction): string {
  try {
    return projectAction(action).shapeKey;
  } catch (cause) {
    if (cause instanceof M3LAgentActionValidationError) {
      const field = cause.context["field"];
      if (field === "action") {
        // Already reported against this function's one parameter.
        throw cause;
      }
      // This entry point has no surrounding options bag, so a nested
      // sub-field ("action.script", "action.kind", ...) — meaningful for the
      // evaluator's richer bag — is collapsed to the flat "action" here; see
      // the @remarks above and docs/reference/core/agent.md § Dry-run-first.
      throw new M3LAgentActionValidationError(cause.message, {
        context: { ...cause.context, field: "action" },
        cause,
      });
    }
    if (cause instanceof M3LError) {
      throw cause;
    }
    // A throwing accessor or Proxy trap breaks the traversal — see the same
    // handling in `internal/agent/action.ts`'s `validateEvaluationOptions`.
    throw new M3LAgentActionValidationError(
      `agent action: "action" is invalid (traversal-threw)`,
      {
        context: { field: "action", violation: "traversal-threw" },
        cause,
      },
    );
  }
}
