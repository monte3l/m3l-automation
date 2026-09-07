/**
 * `agent-operator/steps/flow-prompt` — the system and user prompts for the
 * `queue-reconcile` workload's `reconcile_queue` tool conversation.
 *
 * @remarks
 * This operation exposes exactly **one** tool, `reconcile_queue`, and it is
 * MUTATING rather than read-only, so the system prompt is explicit that at
 * most one flow may be run and that the model should decline in plain text
 * when reconciliation is not warranted. The user prompt's only configured
 * value is the operator-verified flow allowlist — every name in it already
 * passed `verifyFlowNames` before this prompt is built, never a raw,
 * unverified value.
 *
 * @packageDocumentation
 */

/**
 * The system prompt handed to `runBedrockToolLoop` as the conversation's
 * `system` for the `queue-reconcile` workload.
 *
 * @returns The fixed, script-authored system prompt.
 *
 * @example
 * ```ts
 * import { queueReconcileSystemPrompt } from "./flow-prompt.js";
 *
 * const system = queueReconcileSystemPrompt();
 * ```
 */
export function queueReconcileSystemPrompt(): string {
  return (
    "You are an operator agent authorized to reconcile a message queue by " +
    "running at most one pre-approved, verified m3l flow. Call " +
    "reconcile_queue with the target flow's name if reconciliation is " +
    "warranted; otherwise reply in plain text explaining why no action is " +
    "needed."
  );
}

/**
 * Builds the opening user turn naming the operator-verified flow allowlist.
 *
 * @param flowNames - The operator-verified flow names for this run. Every
 *   entry already passed `verifyFlowNames` before this prompt is built.
 * @returns The opening user message text.
 *
 * @example
 * ```ts
 * import { queueReconcileUserPrompt } from "./flow-prompt.js";
 *
 * const text = queueReconcileUserPrompt(["nightly-queue-drain"]);
 * ```
 */
export function queueReconcileUserPrompt(flowNames: readonly string[]): string {
  return `The operator-verified flow allowlist is: ${flowNames.join(", ")}.`;
}
