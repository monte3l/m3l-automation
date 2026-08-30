/**
 * `agent-operator/steps/run-agent-operator` — dispatches `agent-operator`'s
 * two declared operations (`health-check`, `explain-policy`) over a closed
 * `switch`, per ADR-0055.
 *
 * @packageDocumentation
 */

import { dirname } from "node:path";

import { Core } from "@m3l-automation/m3l-common";

import type { AGENT_OPERATOR_COMMAND_DECLARATIONS } from "../config.js";
import { AGENT_OPERATOR_COMMANDS, POLICY_FILE_DEFAULT } from "../config.js";
import { createAgentCliSurface } from "../lib/cli-surface.js";
import { M3LAgentOperatorCliError } from "../lib/errors.js";
import { explainPolicy } from "./explain-policy.js";
import { loadAgentPolicy } from "./load-policy.js";
import { resolveAgentOperatorRuntime } from "./resolve-runtime.js";

/** The literal union of {@link AGENT_OPERATOR_COMMAND_DECLARATIONS}' names. */
type AgentOperatorCommand =
  (typeof AGENT_OPERATOR_COMMAND_DECLARATIONS)[number]["name"];

/**
 * Dependencies for {@link runAgentOperator}. Every dependency `mainFn` reads
 * off `Core.M3LScript` is injected here rather than reached for as a global,
 * so this dispatcher stays unit-testable without a real `M3LScript` run.
 */
export interface RunAgentOperatorDeps {
  /** The resolved configuration store (`command`, `modelId`, `policyFile`, …). */
  readonly config: Core.M3LConfig;
  /** The script's logger, threaded through to `explain-policy`'s rendering. */
  readonly logger: Core.M3LLogger;
  /** The script's `M3LPaths` port, for the policy file and `cliEntrypoint` default. */
  readonly paths: Core.M3LPaths;
  /** The script's cooperative-cancellation signal, forwarded to the CLI seam. */
  readonly signal: AbortSignal;
  /**
   * Bound from `script.reportRecovery` (never the whole `script` object), so
   * a future per-action absorbed failure demotes the run's outcome to
   * `"partial"` instead of a silent `"success"`. Neither operation in this
   * offline slice absorbs a per-item failure — `health-check` fails closed
   * and `explain-policy` is fully deterministic — so this is unused today;
   * it is threaded onto the seam now so a follow-up slice does not have to
   * change this dispatcher's signature to gain it.
   */
  readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
}

/**
 * Narrows a resolved `command` string to the declared operation union.
 * `Core.deriveOperationNames`/the parameter's `operations` declaration
 * already enforce this membership at config-load time — this re-check exists
 * only so the dispatch `switch` below can be proven exhaustive by the
 * compiler, not because an out-of-set value is expected at runtime.
 */
function isKnownCommand(value: string): value is AgentOperatorCommand {
  const known: readonly string[] = AGENT_OPERATOR_COMMANDS;
  return known.includes(value);
}

/**
 * `health-check`'s PR 1 behaviour: declared in the schema (so the CLI's
 * `list`/`inspect` surfaces it) but not implemented in this offline slice.
 * Throws rather than silently succeeding or performing a no-op run — the
 * model-driven workload lands in a follow-up slice.
 */
function runHealthCheck(): never {
  throw new M3LAgentOperatorCliError(
    "'health-check' is declared but not implemented in this release; the model-driven workload lands in a follow-up slice",
    "ERR_AGENT_OPERATOR_CONFIG",
  );
}

/**
 * Derives the absolute host workspace-root path for `cli-surface.ts`'s
 * workspace-root scrub, reading the same `paths.getProjectRoot()` seam
 * `resolve-runtime.ts`'s `resolveCliEntrypoint` uses for its own default.
 * Returns `undefined` — disabling the scrub, never failing the run — when
 * `getProjectRoot()` throws `Core.M3LPathResolutionError` (standalone mode,
 * where there is no monorepo root to scrub against).
 */
function deriveWorkspaceRoot(paths: Core.M3LPaths): string | undefined {
  try {
    return paths.getProjectRoot();
  } catch (cause) {
    if (!(cause instanceof Core.M3LPathResolutionError)) throw cause;
    return undefined;
  }
}

/**
 * Runs the deterministic, no-Bedrock `explain-policy` operation end to end:
 * loads the policy, resolves the typed runtime settings (including the
 * `maxIterations` vs `budgets.loopIterations` cross-check), builds the CLI
 * seam, and renders the policy through {@link explainPolicy}.
 */
async function runExplainPolicy(deps: RunAgentOperatorDeps): Promise<void> {
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_AGENT_OPERATOR_CONFIG",
  });
  const policyFile =
    accessor.optionalString("policyFile") ?? POLICY_FILE_DEFAULT;
  const policy = await loadAgentPolicy({ paths: deps.paths, policyFile });
  const runtime = resolveAgentOperatorRuntime({
    config: deps.config,
    policy,
    paths: deps.paths,
  });
  const workspaceRoot = deriveWorkspaceRoot(deps.paths);

  const surface = createAgentCliSurface({
    entrypoint: runtime.cliEntrypoint,
    // The CLI resolves its own project/data roots from its own entrypoint's
    // location, not from this script's cwd — so the entrypoint's own
    // directory is a stable spawn `cwd` that works whether `cliEntrypoint`
    // came from the monorepo default or an explicit standalone override.
    cwd: dirname(runtime.cliEntrypoint),
    nodeExecPath: process.execPath,
    cliTimeoutMs: runtime.cliTimeoutMs,
    dryRunTimeoutMs: runtime.dryRunTimeoutMs,
    maxOutputBytes: runtime.maxOutputBytes,
    dryRunAllowlist: new Set(runtime.dryRunAllowlist),
    signal: deps.signal,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  });

  await explainPolicy({ policy, logger: deps.logger, surface });
}

/**
 * Dispatches `agent-operator`'s two declared operations over a closed
 * `switch` with a `never` exhaustiveness arm (ADR-0055).
 *
 * @param deps - See {@link RunAgentOperatorDeps}.
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_CONFIG`
 *   for `health-check` (not implemented in this slice) and for an
 *   unresolvable/unknown `command` value. `explain-policy`'s other failure
 *   modes are documented on `steps/load-policy.ts` and
 *   `steps/resolve-runtime.ts`.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import { runAgentOperator } from "./run-agent-operator.js";
 *
 * declare const config: Core.M3LConfig;
 * declare const logger: Core.M3LLogger;
 * declare const paths: Core.M3LPaths;
 * declare const signal: AbortSignal;
 *
 * await runAgentOperator({
 *   config,
 *   logger,
 *   paths,
 *   signal,
 *   reportRecovery: () => {
 *     // absorbed-failure reporting lands in a follow-up slice
 *   },
 * });
 * ```
 */
export async function runAgentOperator(
  deps: RunAgentOperatorDeps,
): Promise<void> {
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_AGENT_OPERATOR_CONFIG",
  });
  const rawCommand = accessor.requiredString("command", "run-agent-operator");
  if (!isKnownCommand(rawCommand)) {
    throw new M3LAgentOperatorCliError(
      "'command' must be one of the declared agent-operator operations",
      "ERR_AGENT_OPERATOR_CONFIG",
    );
  }

  switch (rawCommand) {
    case "health-check":
      return runHealthCheck();
    case "explain-policy":
      return runExplainPolicy(deps);
    default: {
      const exhaustive: never = rawCommand;
      throw new M3LAgentOperatorCliError(
        "'command' must be one of the declared agent-operator operations",
        "ERR_AGENT_OPERATOR_CONFIG",
        { context: { unexpectedCommand: exhaustive } },
      );
    }
  }
}
