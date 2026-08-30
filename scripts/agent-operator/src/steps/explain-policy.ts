/**
 * `steps/explain-policy` — the deterministic, no-Bedrock operation that
 * renders a validated {@link Core.M3LAgentPolicy}'s grants, operations,
 * budgets, and discipline flags through the injected logger and returns a
 * plain summary.
 *
 * This operation never constructs a Bedrock client, spawns a process
 * directly, or touches the network by itself — its only external contact is
 * the injected {@link AgentCliSurface}, whose `list`/`doctor` methods are
 * exercised here so the CLI seam stays a real, tested code path rather than
 * only a test double. `inspect`/`dryRun` both require a script name this
 * operation never has, so they are never called.
 *
 * @packageDocumentation
 */

import type { Core } from "@m3l-automation/m3l-common";

import type { AgentCliSurface } from "../lib/cli-surface.js";
import type {
  AgentOperatorProjectedDoctorReport,
  AgentOperatorProjectedListRow,
} from "../lib/model-safety.js";

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
  /** The typed CLI adapter; only `list`/`doctor` are called here. */
  readonly surface: AgentCliSurface;
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

/**
 * Exercises the CLI seam: calls `surface.list()` and `surface.doctor()`
 * exactly once each and logs a short snapshot of each result. Never calls
 * `inspect()`/`dryRun()` — both need a script name this operation has none
 * of.
 */
async function renderCliSnapshot(
  logger: Core.M3LLogger,
  surface: AgentCliSurface,
): Promise<void> {
  const rows: readonly AgentOperatorProjectedListRow[] = await surface.list();
  logger.info("CLI scripts available", { scriptCount: rows.length });

  const report: AgentOperatorProjectedDoctorReport = await surface.doctor();
  logger.info("CLI doctor snapshot", {
    blocking: report.blocking,
    counts: report.counts,
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
 * through `deps.logger`, exercises `deps.surface.list()`/`.doctor()` exactly
 * once each, and returns a plain summary of the policy. Deterministic and
 * offline: it never constructs a Bedrock client, spawns a process, or
 * touches the network directly.
 *
 * @param deps - The validated policy, the injected logger, and the typed CLI
 *   surface.
 * @returns The rendered policy's summary.
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { explainPolicy } from "./explain-policy.js";
 * import { createAgentCliSurface } from "../lib/cli-surface.js";
 *
 * const policy = Core.validateAgentPolicy({
 *   version: 1,
 *   scripts: [{ script: "s3-report", allOperations: true }],
 * });
 * const logger = new Core.M3LLogger([new Core.M3LConsoleLoggerHandler()]);
 * const surface = createAgentCliSurface({
 *   entrypoint: "/repo/packages/m3l-cli/bin/m3l.mjs",
 *   cwd: "/repo",
 *   nodeExecPath: process.execPath,
 *   cliTimeoutMs: 30_000,
 *   dryRunTimeoutMs: 120_000,
 *   maxOutputBytes: 1_048_576,
 *   dryRunAllowlist: new Set(),
 * });
 *
 * const summary = await explainPolicy({ policy, logger, surface });
 * ```
 */
export async function explainPolicy(
  deps: ExplainPolicyDeps,
): Promise<AgentOperatorExplainPolicySummary> {
  const { policy, logger, surface } = deps;

  logger.header("Agent policy");
  for (const grant of policy.scripts) {
    renderGrant(logger, grant);
  }
  renderBudgets(logger, policy.budgets);
  renderFlags(logger, policy);
  await renderCliSnapshot(logger, surface);

  return buildSummary(policy);
}
