/**
 * `steps/explain-policy` — the deterministic, no-Bedrock operation that
 * renders a validated {@link Core.M3LAgentPolicy}'s grants, operations,
 * budgets, and discipline flags through the injected logger and returns a
 * plain summary.
 *
 * This operation never constructs a Bedrock client, spawns a process
 * directly, or touches the network by itself. It has no dependency on the
 * `m3l` CLI seam in this slice — that wiring (via `AgentCliSurface`) lands
 * in the follow-up PR alongside the rest of the CLI-spawning code.
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

/**
 * The plain summary {@link explainPolicy} returns, mirroring the policy
 * fields it rendered.
 *
 * @example
 * ```ts
 * import type { AgentOperatorExplainPolicySummary } from "@m3l-automation/agent-operator/steps/explain-policy.js";
 *
 * const summary: AgentOperatorExplainPolicySummary = {
 *   grantCount: 2,
 *   requireDecisionLog: true,
 *   dryRunFirst: true,
 *   hasBudgets: true,
 * };
 * ```
 */
export interface AgentOperatorExplainPolicySummary {
  /** The number of per-script grants declared in `policy.scripts`. */
  readonly grantCount: number;
  /** `policy.requireDecisionLog === true`; `false` when absent or `false`. */
  readonly requireDecisionLog: boolean;
  /** `policy.dryRunFirst === true`; `false` when absent or `false`. */
  readonly dryRunFirst: boolean;
  /** `true` when `policy.budgets` is declared at all. */
  readonly hasBudgets: boolean;
}

/** The dependencies {@link explainPolicy} takes. */
export interface ExplainPolicyDeps {
  /** The validated, deep-frozen policy to render. */
  readonly policy: Core.M3LAgentPolicy;
  /** The injected logger every rendered line is written through. */
  readonly logger: Core.M3LLogger;
}

/** Renders one script grant's name, operations, and read-only cross-check. */
function renderGrant(
  logger: Core.M3LLogger,
  grant: Core.M3LAgentScriptGrant,
): void {
  logger.info(`Grant: ${grant.script}`, {
    script: grant.script,
    allOperations: grant.allOperations === true,
    operations: grant.operations ?? [],
    readOnlyOperations: grant.readOnlyOperations ?? [],
  });
}

/** Renders the declared budgets, or notes that none are declared. */
function renderBudgets(
  logger: Core.M3LLogger,
  budgets: Core.M3LAgentBudgets | undefined,
): void {
  if (budgets === undefined) {
    logger.info("Budgets: none declared");
    return;
  }
  logger.info("Budgets", { ...budgets });
}

/** Renders the two discipline flags this policy may opt into. */
function renderFlags(
  logger: Core.M3LLogger,
  policy: Core.M3LAgentPolicy,
): void {
  logger.info("requireDecisionLog", {
    requireDecisionLog: policy.requireDecisionLog === true,
  });
  logger.info("dryRunFirst", {
    dryRunFirst: policy.dryRunFirst === true,
  });
}

/** Projects `policy` into the plain summary {@link explainPolicy} returns. */
function buildSummary(
  policy: Core.M3LAgentPolicy,
): AgentOperatorExplainPolicySummary {
  return {
    grantCount: policy.scripts.length,
    requireDecisionLog: policy.requireDecisionLog === true,
    dryRunFirst: policy.dryRunFirst === true,
    hasBudgets: policy.budgets !== undefined,
  };
}

/**
 * Renders `deps.policy`'s grants, operations, budgets, and discipline flags
 * through `deps.logger` and returns a plain summary of the policy.
 * Deterministic and offline: it never constructs a Bedrock client, spawns a
 * process, or touches the network directly.
 *
 * @param deps - The validated policy and the injected logger.
 * @returns The rendered policy's summary.
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { explainPolicy } from "./explain-policy.js";
 *
 * const policy = Core.validateAgentPolicy({
 *   version: 1,
 *   scripts: [{ script: "s3-report", allOperations: true }],
 * });
 * const logger = new Core.M3LLogger([new Core.M3LConsoleLoggerHandler()]);
 *
 * const summary = await explainPolicy({ policy, logger });
 * ```
 */
export function explainPolicy(
  deps: ExplainPolicyDeps,
): Promise<AgentOperatorExplainPolicySummary> {
  const { policy, logger } = deps;

  logger.header("Agent policy");
  for (const grant of policy.scripts) {
    renderGrant(logger, grant);
  }
  renderBudgets(logger, policy.budgets);
  renderFlags(logger, policy);

  return Promise.resolve(buildSummary(policy));
}
