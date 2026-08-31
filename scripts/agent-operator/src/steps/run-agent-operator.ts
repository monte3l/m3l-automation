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
import {
  AGENT_NAME_DEFAULT,
  AGENT_OPERATOR_COMMANDS,
  POLICY_FILE_DEFAULT,
} from "../config.js";
import { createAgentCliSurface } from "../lib/cli-surface.js";
import { M3LAgentOperatorCliError } from "../lib/errors.js";
import { AgentDecisionRecorder, agentIdentity } from "./decision-recorder.js";
import { explainPolicy } from "./explain-policy.js";
import { loadAgentPolicy } from "./load-policy.js";
import { runDecisionLogPreflight } from "./preflight-log.js";
import { resolveAgentOperatorRuntime } from "./resolve-runtime.js";
import { AgentRunLedger } from "./run-ledger.js";

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
   * offline slice absorbs a per-item failure — `health-check`'s audit spine
   * either completes or throws, and `explain-policy` is fully deterministic
   * — so this is unused today;
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
 * The action `health-check` submits for judgement: the operation itself,
 * asserted `read-only` because it reads a policy file and appends to the
 * audit log and mutates nothing else. `kind` is asserted by this script from
 * its own ADR-0055 declaration, never derived from model output.
 *
 * `parameterNames` lists **every** config parameter a `health-check` run
 * actually resolves — `command` for the dispatch, then the four the audit
 * spine reads (`policyFile`, `decisionLogDir`, `agentName`, `modelId`) — not
 * merely the dispatch one. The list feeds the audit record *and*
 * `Core.agentActionShapeKey`, which hashes
 * `{ script, operation, kind, parameterNames }`: an understated list both
 * under-reports the entry and yields a key that cannot match a later, fuller
 * declaration of the same action, silently defeating dry-run-first shape
 * matching. Keep it in step with what {@link runHealthCheck} reads.
 */
function healthCheckAction(): Core.M3LAgentAction {
  return {
    script: "agent-operator",
    operation: "health-check",
    kind: "read-only",
    parameterNames: [
      "command",
      "policyFile",
      "decisionLogDir",
      "agentName",
      "modelId",
    ],
  };
}

/**
 * Builds the decision recorder for a `health-check` run: the real
 * `Core.M3LAgentDecisionLog` behind the script-local writer port, stamped
 * with the configured `agentName`/`modelId` identity.
 *
 * `decisionLogDir` and `modelId` are threaded through `agentIdentity` /
 * a conditional options bag rather than assigned directly, because an absent
 * config value is `undefined` and both the identity and the log's options bag
 * read presence with `Object.hasOwn` — a present key holding `undefined`
 * throws.
 */
function buildDecisionRecorder(
  accessor: Core.M3LConfigAccessor,
): AgentDecisionRecorder {
  const directory = accessor.optionalString("decisionLogDir");
  const writer =
    directory === undefined
      ? new Core.M3LAgentDecisionLog()
      : new Core.M3LAgentDecisionLog({ directory });
  return new AgentDecisionRecorder({
    identity: agentIdentity({
      name: accessor.optionalString("agentName") ?? AGENT_NAME_DEFAULT,
      modelId: accessor.optionalString("modelId"),
    }),
    writer,
  });
}

/**
 * Fails the run when the concluding verdict is not an auto-approval, so a run
 * the policy declined can never resolve as a clean exit 0.
 *
 * The gate is `Core.isAgentActionAutoApproved` deliberately. A
 * `verdict !== "allow"` test would be dead code — the closed verdict set is
 * `auto-approved | escalate | denied`, with no `"allow"` member — and
 * `verdict !== "denied"` would wave every escalation through, which is the
 * whole defect. Asking the library's own predicate also means a future
 * verdict added to that set is judged by the library, not by a literal
 * comparison here that would silently misclassify it.
 *
 * `ERR_AGENT_OPERATOR_ESCALATED`, not `ERR_AGENT_OPERATOR_POLICY`: the policy
 * is fine here — it worked and declined. Nor
 * `ERR_AGENT_OPERATOR_DECISION_LOG`: the log was perfectly writable, and both
 * entries are already durable by the time this throws.
 *
 * Only the library-authored `verdict`/`rule` are surfaced. No config value
 * (`agentName`, `modelId`, `decisionLogDir`, `policyFile`) reaches the message
 * or the context — an operator reads those off their own configuration, and a
 * surfaced error is the wrong place for a filesystem path or a model id.
 */
function assertConclusionAutoApproved(decision: Core.M3LAgentDecision): void {
  if (Core.isAgentActionAutoApproved(decision)) return;
  throw new M3LAgentOperatorCliError(
    "the run concluded without an auto-approved verdict: the deployment policy declined to auto-approve this action, so it requires human escalation",
    "ERR_AGENT_OPERATOR_ESCALATED",
    { context: { verdict: decision.verdict, rule: decision.rule } },
  );
}

/**
 * `health-check`'s behaviour in this offline slice: the **audit spine**, and
 * nothing beyond it. It loads the declared policy, builds the run ledger,
 * and runs the two-phase decision-log preflight — then, **only if the
 * concluding verdict is an auto-approval**, reports that the model-driven
 * workload is what remains pending and resolves cleanly. A conclusion the
 * policy declined throws instead, so a declined run cannot exit 0.
 *
 * The order is load-bearing and proven by failure injection: the policy load
 * precedes the preflight, so an unloadable policy leaves no audit artefact
 * behind. Nothing here spawns the `m3l` CLI — this operation is entirely
 * offline.
 */
async function runHealthCheck(deps: RunAgentOperatorDeps): Promise<void> {
  const accessor = new Core.M3LConfigAccessor({
    config: deps.config,
    code: "ERR_AGENT_OPERATOR_CONFIG",
  });
  const policyFile =
    accessor.optionalString("policyFile") ?? POLICY_FILE_DEFAULT;
  const policy = await loadAgentPolicy({ paths: deps.paths, policyFile });
  deps.logger.info("agent policy loaded", { step: "policy-loaded" });

  const ledger = new AgentRunLedger();
  const result = await runDecisionLogPreflight({
    policy,
    ledger,
    recorder: buildDecisionRecorder(accessor),
    action: healthCheckAction(),
    // Sampled once, here: the ledger and the evaluator both read the clock
    // the caller hands them, so every phase of this turn agrees on `now`.
    now: Date.now(),
  });
  deps.logger.info("decision-log preflight complete", {
    step: "preflight-complete",
    // The verdicts, not the reason prose: `reason` is library-authored but
    // composed from the action under judgement, and the entry already carries
    // it into the audit log.
    bootstrapVerdict: result.bootstrapDecision.verdict,
    bootstrapRule: result.bootstrapDecision.rule,
    verdict: result.decision.verdict,
    rule: result.decision.rule,
  });

  // After the logging, and after the preflight has made BOTH entries durable:
  // the audit trail must be complete before the escalation surfaces, or the
  // throw would lose the very verdict it is refusing on.
  assertConclusionAutoApproved(result.decision);

  deps.logger.info(
    "health-check complete: the audit spine is in place and the model-driven workload is still pending; it lands in a follow-up slice",
    { step: "model-loop-pending" },
  );
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
 *   for an unresolvable/unknown `command` value, coded
 *   `ERR_AGENT_OPERATOR_POLICY` when the declared policy file cannot be
 *   loaded, coded `ERR_AGENT_OPERATOR_DECISION_LOG` when either of
 *   `health-check`'s audit entries cannot be written, and coded
 *   `ERR_AGENT_OPERATOR_ESCALATED` when `health-check`'s run concluded on a
 *   verdict the policy did not auto-approve (both audit entries are durable
 *   before that throw). `explain-policy`'s other failure modes are documented
 *   on `steps/load-policy.ts` and `steps/resolve-runtime.ts`.
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
