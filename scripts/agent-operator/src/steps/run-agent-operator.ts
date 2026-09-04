/**
 * `agent-operator/steps/run-agent-operator` — dispatches `agent-operator`'s
 * two declared operations (`health-check`, `explain-policy`) over a closed
 * `switch`, per ADR-0055.
 *
 * Both operations live in their own step modules — `steps/run-health-check`
 * and `steps/explain-policy` — so this file stays what its name says: a
 * dispatcher. `health-check` moved out when the model loop landed; keeping it
 * inline would have pushed one function past the scripts zone's
 * `max-lines-per-function` budget and buried the workload's own ordering
 * constraints inside a `switch`.
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
import { runHealthCheck } from "./run-health-check.js";

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
   * an absorbed per-action failure demotes the run's outcome to `"partial"`
   * (exit `6`) instead of a silent `"success"`. `health-check` now uses it
   * for exactly that: every fleet anomaly, every gated refusal, and an
   * absorbed loop-ceiling breach are reported through here.
   * `explain-policy` is fully deterministic and still absorbs nothing.
   */
  readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
  /**
   * The provisioned AWS client facade from `script.aws`, or `undefined` when
   * stage 5 never ran. `health-check` needs it for the Bedrock client;
   * `explain-policy` never reads it, which is why it is not asserted here —
   * a deterministic operation must not require AWS to have been provisioned.
   */
  readonly aws: Core.M3LScript["aws"];
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
 * Derives the absolute host workspace-root path for `cli-surface.ts`'s
 * workspace-root scrub, reading the same `paths.getProjectRoot()` seam
 * `resolve-runtime.ts`'s `resolveCliEntrypoint` uses for its own default.
 * Returns `undefined` — disabling the scrub, never failing the run — when
 * `getProjectRoot()` throws `Core.M3LPathResolutionError` (standalone mode,
 * where there is no monorepo root to scrub against). The degradation is
 * logged as a warning rather than absorbed silently: with the scrub off,
 * absolute host paths in CLI output reach the model unmasked, and an
 * operator reading the run log must be able to see that that happened. Any
 * other failure is rethrown unchanged — only the documented standalone-mode
 * signal degrades.
 */
function deriveWorkspaceRoot(
  paths: Core.M3LPaths,
  logger: Core.M3LLogger,
): string | undefined {
  try {
    return paths.getProjectRoot();
  } catch (cause) {
    if (!(cause instanceof Core.M3LPathResolutionError)) throw cause;
    logger.warning(
      "workspace-root scrub disabled: the project root could not be resolved (standalone mode), so absolute host paths in CLI output are no longer masked before the model reads them",
      { scrub: "workspace-root", enabled: false },
    );
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
  const workspaceRoot = deriveWorkspaceRoot(deps.paths, deps.logger);

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
    // `includeDryRunProbes` is the gate; the allowlist is inert on its own.
    // Fail closed — an unset or false flag hands the surface an EMPTY set, so
    // a `dryRunAllowlist` left in config (or added ahead of the flag) can
    // never silently arm the destructive `dry-run` tool.
    dryRunAllowlist: runtime.includeDryRunProbes
      ? new Set(runtime.dryRunAllowlist)
      : new Set<string>(),
    // Forwarded verbatim: `resolve-runtime` has already validated every
    // entry's name and workspace-relative path, and this map is the ONLY
    // input the surface's `run` consults. Dropping it (or passing an empty
    // map) leaves the operator's declared grant inert: every mutating call
    // rejects with `cli-surface.ts`'s fixed `PRESET_NAME_REJECTION_MESSAGE`,
    // which is identical across all of its rejection arms (each arm's real
    // reason rides as an operator-only `cause`), so the wiring defect is
    // indistinguishable from an undeclared preset — hence the required option.
    presetAllowlist: runtime.presetAllowlist,
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
 *   for an unresolvable/unknown `command` value. Each operation's own failure
 *   modes are documented on its step module: `steps/run-health-check.ts` for
 *   `health-check` (policy, decision log, budget state, escalation, and the
 *   Bedrock errors it deliberately does NOT absorb), and
 *   `steps/load-policy.ts` / `steps/resolve-runtime.ts` for `explain-policy`.
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
 *     // every fleet anomaly and gated refusal arrives here
 *   },
 *   aws: undefined,
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
      // `deps` is forwarded whole rather than destructured field by field:
      // `RunHealthCheckDeps` is a structural subset of this seam, so a field
      // added there is a compile error here rather than a silently dropped
      // dependency.
      return runHealthCheck(deps);
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
