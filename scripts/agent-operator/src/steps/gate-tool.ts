/**
 * `agent-operator/steps/gate-tool` — the security core of V8: the single
 * door every model-facing Bedrock tool handler must pass through.
 *
 * @remarks
 * {@link gateToolSpec} wraps an {@link AgentToolSpec} into a
 * `AWS.M3LBedrockToolRegistration` whose `handler` runs the full authorize →
 * record → execute → record pass, in that exact order, for every call:
 *
 * 1. Sample `now` once (`deps.now()`) and reuse it for the evaluation and
 *    both decision-log writes, so one pass cannot straddle a clock tick.
 * 2. `spec.describeAction(input)` is the module's one trust boundary — a
 *    throw here means nothing is authorized and nothing runs.
 * 3. `Core.evaluateAgentAction` judges the action against the policy and the
 *    ledger's current snapshot.
 * 4. The decision is recorded **before** any branch on its verdict — for
 *    every verdict, not only an approval — which is what makes the audit
 *    log a log rather than a success record, and doubles as the
 *    decision-log-availability probe. A refusal (escalate, denied, or an
 *    unwritable log) never throws; it returns refusal text so the loop
 *    keeps running, because the Bedrock tool-dispatch layer transmits a
 *    thrown handler message to the model verbatim (no secret redaction) —
 *    returning text keeps the wording under this module's control.
 * 5. Only once approved does execution run, count as an invocation, and get
 *    a second, post-execution audit record.
 *
 * Every model-facing string this module can produce is a member of
 * {@link AGENT_TOOL_REFUSAL_MESSAGES} — never a caught error's message, a
 * path, an errno, or a script name. The real detail always goes to
 * `deps.logger` and `deps.reportRecovery` instead.
 *
 * `Core.M3LOperationAbortedError` thrown by `execute` passes through
 * `instanceof`-intact: ADR-0049 classifies an abort by `instanceof`, so
 * wrapping it here would misclassify a Ctrl-C on this path.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import type { AgentDecisionRecorder } from "./decision-recorder.js";
import type { AgentRunLedger } from "./run-ledger.js";

/**
 * What a gated tool's `execute` produced: the content to hand back to the
 * model, and the outcome to stamp onto the post-execution audit record.
 *
 * @example
 * ```ts
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import type { AgentToolExecution } from "./gate-tool.js";
 *
 * const execution: AgentToolExecution = {
 *   content: [{ type: "text", text: "ok" } satisfies AWS.M3LBedrockToolResultContent],
 *   outcome: { dryRun: false, exitCode: 0 },
 * };
 * ```
 */
export interface AgentToolExecution {
  /** The content blocks handed back to the model on success. */
  readonly content: readonly AWS.M3LBedrockToolResultContent[];
  /** Stamped onto the post-execution audit record. */
  readonly outcome: Core.M3LAgentDecisionOutcome;
}

/**
 * A tool declaration this module gates before it ever reaches the model.
 *
 * @remarks
 * `describeAction` is the **one trust boundary**: the `kind` (and every
 * other judged field) it returns must come from this declaration, never
 * from the model-supplied `input` — deriving `kind` from model output would
 * let a model assert its own autonomy tier. Throwing from `describeAction`
 * is how a malformed/unrecognised `input` is rejected before anything is
 * authorized.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import type { AgentToolExecution, AgentToolSpec } from "./gate-tool.js";
 *
 * const spec: AgentToolSpec = {
 *   name: "explain_policy",
 *   description: "Explains the deployed agent policy.",
 *   inputSchema: {},
 *   describeAction: (): Core.M3LAgentAction => ({
 *     script: "agent-operator",
 *     operation: "explain-policy",
 *     kind: "read-only",
 *   }),
 *   execute: async (
 *     _input: unknown,
 *     _context: AWS.M3LBedrockToolContext,
 *   ): Promise<AgentToolExecution> => ({
 *     content: [{ type: "text", text: "ok" }],
 *     outcome: { dryRun: false, exitCode: 0 },
 *   }),
 * };
 * ```
 */
export interface AgentToolSpec {
  /** The tool name the model calls; validated by `buildAgentToolRegistry`. */
  readonly name: string;
  /** The tool description surfaced to the model. */
  readonly description: string;
  /** The tool's JSON Schema input declaration. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /**
   * Derives the action to authorize from `input`. See the interface remarks
   * for the trust-boundary rule. Throws on malformed input before anything
   * is authorized.
   */
  describeAction(input: unknown): Core.M3LAgentAction;
  /** Runs the tool's real work, once authorized. */
  execute(
    input: unknown,
    context: AWS.M3LBedrockToolContext,
  ): Promise<AgentToolExecution>;
}

/**
 * Dependencies {@link gateToolSpec} needs to authorize, meter, and audit
 * every call.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { GateToolDeps } from "./gate-tool.js";
 *
 * declare const policy: Core.M3LAgentPolicy;
 * declare const ledger: import("./run-ledger.js").AgentRunLedger;
 * declare const recorder: import("./decision-recorder.js").AgentDecisionRecorder;
 *
 * const deps: GateToolDeps = {
 *   policy,
 *   ledger,
 *   recorder,
 *   now: () => Date.now(),
 *   logger: new Core.M3LLogger([]),
 *   reportRecovery: () => {
 *     // absorbed-failure reporting
 *   },
 * };
 * ```
 */
export interface GateToolDeps {
  /** The validated deployment policy every action is judged against. */
  readonly policy: Core.M3LAgentPolicy;
  /** The mutable per-run counters `Core.evaluateAgentAction` reads. */
  readonly ledger: AgentRunLedger;
  /** Writes the two audit records every gated call produces (or refuses on). */
  readonly recorder: AgentDecisionRecorder;
  /** Sampled exactly once per gated call. */
  readonly now: () => number;
  /** Receives the real, unredacted detail behind every refusal/failure. */
  readonly logger: Core.M3LLogger;
  /** Demotes the run's outcome so a refusal is never invisible to a scheduler. */
  readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
}

/**
 * The closed, exhaustively-reachable vocabulary of model-facing refusal
 * text. No handler in this module may ever return or throw a string outside
 * this set to the model — the real detail always goes to `logger`/
 * `reportRecovery` instead.
 *
 * @example
 * ```ts
 * import { AGENT_TOOL_REFUSAL_MESSAGES } from "./gate-tool.js";
 *
 * console.log(AGENT_TOOL_REFUSAL_MESSAGES.notAuthorized);
 * ```
 */
export const AGENT_TOOL_REFUSAL_MESSAGES = {
  notAuthorized: "This action was not authorized by policy. Do not retry it.",
  malformedInput: "The tool input was rejected. Check the declared schema.",
  auditUnavailable:
    "The audit log is unavailable, so no action can be authorized. Stop and report this.",
  executionFailed: "The tool failed to execute. Do not retry it.",
} as const;

/** Wraps `message` as the sole content block a refusal returns to the model. */
function refusalContent(
  message: string,
): readonly AWS.M3LBedrockToolResultContent[] {
  return [{ type: "text", text: message }];
}

/**
 * Builds the {@link Core.M3LRunRecoveryEntry} every refusal/failure path
 * reports, `item` naming the tool so a scheduler reading only
 * `recoveryTotal` still learns which gate refused.
 */
function recoveryEntry(
  item: string,
  now: number,
  detail: string,
): Core.M3LRunRecoveryEntry {
  return {
    item,
    error: [{ name: "Error", message: detail }],
    recordedAt: new Date(now).toISOString(),
  };
}

/**
 * Renders the FULL cause chain of `cause` verbatim (no redaction, no
 * truncation) for the logger/recovery channel — the "real detail" half of
 * the split this module's security rests on. Never used for model-facing
 * text.
 */
function describeCaughtChain(cause: unknown): string {
  return Core.serializeErrorChain(cause, { redact: false })
    .map((level) => level.message)
    .join(" | ");
}

/** Logs the real detail and reports the refusal/failure as an absorbed one. */
function logFailure(
  deps: GateToolDeps,
  now: number,
  toolName: string,
  logSummary: string,
  detail: string,
): void {
  deps.logger.error(logSummary, { tool: toolName, detail });
  deps.reportRecovery(recoveryEntry(toolName, now, detail));
}

/** Logs, reports, and builds the model-facing refusal content in one call. */
function refuse(
  deps: GateToolDeps,
  now: number,
  toolName: string,
  message: string,
  logSummary: string,
  detail: string,
): readonly AWS.M3LBedrockToolResultContent[] {
  logFailure(deps, now, toolName, logSummary, detail);
  return refusalContent(message);
}

/**
 * Writes the pre-execution audit record for `decision` and decides whether
 * to refuse.
 *
 * @remarks
 * The write happens for every verdict, before any branch on it — that is
 * what makes this an audit log rather than a success log. A write failure
 * refuses immediately, observing the log as unavailable; a write that
 * succeeded but judged the action escalate/denied observes the log as
 * available (a later pass can then rely on that observation) and refuses.
 * Only a write that succeeded AND an auto-approved verdict returns
 * `undefined`, letting the caller proceed to execution.
 *
 * @returns Refusal content when the caller must stop, `undefined` to proceed.
 */
async function recordPreDecisionAndMaybeRefuse(
  spec: AgentToolSpec,
  deps: GateToolDeps,
  decision: Core.M3LAgentDecision,
  now: number,
): Promise<readonly AWS.M3LBedrockToolResultContent[] | undefined> {
  try {
    await deps.recorder.record({ decision, now });
  } catch (cause) {
    deps.ledger.observeDecisionLog(false);
    return refuse(
      deps,
      now,
      spec.name,
      AGENT_TOOL_REFUSAL_MESSAGES.auditUnavailable,
      "gate-tool: the pre-execution decision-log write failed; refusing without authorizing execution",
      describeCaughtChain(cause),
    );
  }

  if (!Core.isAgentActionAutoApproved(decision)) {
    deps.ledger.observeDecisionLog(true);
    return refuse(
      deps,
      now,
      spec.name,
      AGENT_TOOL_REFUSAL_MESSAGES.notAuthorized,
      "gate-tool: the policy did not auto-approve this action",
      `verdict=${decision.verdict} rule=${decision.rule}`,
    );
  }

  return undefined;
}

/**
 * Step 7's failure branch: records the outcome for a crashed action (exit
 * code omitted — none exists, since the action never completed) and logs
 * the caught detail. Does not decide what to (re)throw — the caller does,
 * since an abort must pass through unchanged while every other cause
 * becomes a vocabulary-only message.
 *
 * @remarks
 * `cause` (the `execute()` failure) is PRIMARY: its classification (an
 * `M3LOperationAbortedError` vs. anything else) drives the exit code per
 * ADR-0049, and the caller's existing logic decides what to (re)throw from
 * it. The post-execution audit write attempted here can itself fail (e.g.
 * the decision log is unavailable) — when it does, this function observes
 * the log as unavailable and reports the write failure loudly through
 * `logger`/`reportRecovery`, but does NOT rethrow it. Letting the write
 * failure escape would replace `cause` as the thrown value in the caller,
 * discarding the original failure's classification and never running the
 * caller's abort pass-through. This is not silently swallowing the write
 * failure — it is still surfaced through logger, `reportRecovery`, AND
 * `ledger.observeDecisionLog(false)` — it simply never becomes the thrown
 * value. Do not "fix" this back into a rethrow.
 */
async function recordExecutionFailure(
  spec: AgentToolSpec,
  deps: GateToolDeps,
  decision: Core.M3LAgentDecision,
  now: number,
  cause: unknown,
): Promise<void> {
  const outcome: Core.M3LAgentDecisionOutcome = {
    dryRun: decision.action.dryRun,
  };
  try {
    await deps.recorder.record({ decision, now, outcome });
  } catch (writeFailure) {
    deps.ledger.observeDecisionLog(false);
    logFailure(
      deps,
      now,
      spec.name,
      "gate-tool: the post-execution decision-log write failed after " +
        "execute() had already rejected; the original execute() failure " +
        "below is still what gets thrown",
      describeCaughtChain(writeFailure),
    );
  }
  logFailure(
    deps,
    now,
    spec.name,
    "gate-tool: the tool's execute() rejected; the action already ran",
    describeCaughtChain(cause),
  );
}

/**
 * Writes the post-execution audit record. A failure here rethrows the
 * writer's own (already-typed) error unchanged after observing the log as
 * unavailable and logging the detail — the action already ran, so a lost
 * audit record is never absorbed quietly.
 */
async function recordSuccessOutcome(
  spec: AgentToolSpec,
  deps: GateToolDeps,
  decision: Core.M3LAgentDecision,
  now: number,
  outcome: Core.M3LAgentDecisionOutcome,
): Promise<void> {
  try {
    await deps.recorder.record({ decision, now, outcome });
  } catch (cause) {
    deps.ledger.observeDecisionLog(false);
    logFailure(
      deps,
      now,
      spec.name,
      "gate-tool: the post-execution decision-log write failed; the action already ran",
      describeCaughtChain(cause),
    );
    throw cause;
  }
}

/**
 * Reports whether `outcome` REPORTS a clean exit — not whether the
 * underlying process actually exited cleanly. `outcome.exitCode` is
 * self-reported by whatever produced it: `lib/cli-surface.ts`'s run paths
 * declare `isAcceptableExitCode: () => true`, so the real spawn exit code is
 * discarded there and only the envelope's own `exitCode` ever reaches this
 * predicate. Verifying the reported code against the process's actual
 * disposition is the producer's job, not this predicate's — this predicate
 * only checks that `exitCode` is an OWN property (never inherited —
 * `Object.hasOwn`, not `in`/property access, because a polluted prototype
 * chain must not manufacture a pass) equal to `0`. `exitCode` is declared
 * optional, so an outcome that omits it entirely is a legal shape — and, per
 * the fail-closed rule below, an unproven one.
 */
function isCleanExit(outcome: Core.M3LAgentDecisionOutcome): boolean {
  return Object.hasOwn(outcome, "exitCode") && outcome.exitCode === 0;
}

/**
 * Logs, at `error` level, that the dry-run-first credit for `decision`'s
 * action shape was WITHHELD. Never calls `deps.reportRecovery`: nothing was
 * refused and the call still succeeds, so demoting the run's outcome would
 * misreport a dry run that correctly reported what it reported. Without
 * this line the only signal a withheld credit leaves behind is a
 * decision-log `rule=dry-run-first` escalation on some LATER mutating
 * attempt against the same shape, which never names which dry run or exit
 * code caused it — this is the missing correlation. `shapeKey` is
 * deliberately never included: it is opaque to an operator, matching
 * {@link AgentRunLedger.recordDryRunShape}'s own ceiling error, which
 * likewise declines to echo it.
 */
function logDryRunCreditWithheld(
  deps: GateToolDeps,
  decision: Core.M3LAgentDecision,
  reason: string,
  detail: Record<string, unknown>,
): void {
  deps.logger.error(
    `gate-tool: withheld the dry-run-first credit for this action shape (${reason}); ` +
      "a later mutating attempt against the same shape will still require " +
      "a fresh, clean dry run",
    {
      script: decision.action.script,
      operation: decision.action.operation,
      ...detail,
    },
  );
}

/**
 * Decides and applies the dry-run-shape credit for `outcome`, only ever
 * called for a `dryRun: true` action.
 *
 * @remarks
 * Two distinct reasons withhold the credit, both fail-closed and both
 * logged (never rethrown, never reported through `reportRecovery`):
 *
 * 1. `outcome` itself fails {@link isCleanExit} — a non-zero or absent
 *    reported exit code must never be mistaken for one that ran clean.
 * 2. `outcome` proves a clean exit, but
 *    `deps.ledger.recordDryRunShape` still throws because the library's
 *    per-run shape ceiling (`Core.M3L_AGENT_MAX_DRY_RUN_SHAPES`) is already
 *    reached. This throw is pre-existing and was previously unhandled at
 *    this call site — left unwrapped it would skip the post-execution audit
 *    record entirely for an action that already ran, and escape into the
 *    Bedrock dispatch layer, which transmits a thrown handler message to
 *    the model verbatim. A ceiling exhaustion is exactly a withheld credit,
 *    so it is handled identically to case 1: logged, then the call
 *    continues.
 *
 * Neither case turns the call into a failure: the caller still resolves,
 * still returns `result.content`, and still writes the post-execution audit
 * record with whatever outcome `execute` actually reported.
 */
function applyDryRunCredit(
  deps: GateToolDeps,
  decision: Core.M3LAgentDecision,
  outcome: Core.M3LAgentDecisionOutcome,
): void {
  if (!isCleanExit(outcome)) {
    logDryRunCreditWithheld(
      deps,
      decision,
      "the reported outcome did not prove a clean exit",
      Object.hasOwn(outcome, "exitCode")
        ? { exitCode: outcome.exitCode }
        : { exitCode: "not reported" },
    );
    return;
  }

  try {
    deps.ledger.recordDryRunShape(decision.action.shapeKey);
  } catch (cause) {
    logDryRunCreditWithheld(
      deps,
      decision,
      "the ledger's per-run dry-run-shape ceiling was already reached",
      { detail: describeCaughtChain(cause) },
    );
  }
}

/**
 * Runs the approved path: counts the invocation, executes, applies the
 * dry-run-shape credit (see {@link applyDryRunCredit} — only ever attempted
 * for a `dryRun: true` action), and writes the post-execution audit record.
 *
 * @remarks
 * Dry-run-shape credit gates a real mutation later (the policy's
 * `dryRunFirst` precondition) rather than being an observation about what
 * happened — so it is a precondition, and a precondition fails closed.
 * Withholding the credit never turns the call into a failure — it still
 * resolves, still returns `result.content`, and still writes the
 * post-execution audit record with whatever outcome `execute` actually
 * reported.
 */
async function runApprovedExecution(
  spec: AgentToolSpec,
  deps: GateToolDeps,
  decision: Core.M3LAgentDecision,
  now: number,
  input: unknown,
  context: AWS.M3LBedrockToolContext,
): Promise<readonly AWS.M3LBedrockToolResultContent[]> {
  deps.ledger.recordInvocation();

  let result: AgentToolExecution;
  try {
    result = await spec.execute(input, context);
  } catch (cause) {
    await recordExecutionFailure(spec, deps, decision, now, cause);
    if (cause instanceof Core.M3LOperationAbortedError) throw cause;
    throw new Core.M3LError(AGENT_TOOL_REFUSAL_MESSAGES.executionFailed, {
      code: "ERR_AGENT_TOOL_EXECUTION",
      cause,
    });
  }

  if (decision.action.dryRun) {
    applyDryRunCredit(deps, decision, result.outcome);
  }

  await recordSuccessOutcome(spec, deps, decision, now, result.outcome);
  return result.content;
}

/**
 * The full gated pass: sample `now` once, derive the action, evaluate it,
 * record-and-maybe-refuse, then (only on approval) execute and record again.
 */
async function runGatedTool(
  spec: AgentToolSpec,
  deps: GateToolDeps,
  input: unknown,
  context: AWS.M3LBedrockToolContext,
): Promise<readonly AWS.M3LBedrockToolResultContent[]> {
  const now = deps.now();

  let action: Core.M3LAgentAction;
  try {
    action = spec.describeAction(input);
  } catch (cause) {
    return refuse(
      deps,
      now,
      spec.name,
      AGENT_TOOL_REFUSAL_MESSAGES.malformedInput,
      "gate-tool: describeAction rejected the tool input; nothing was authorized",
      describeCaughtChain(cause),
    );
  }

  const decision = Core.evaluateAgentAction({
    action,
    policy: deps.policy,
    run: deps.ledger.snapshot(now),
  });

  const refusal = await recordPreDecisionAndMaybeRefuse(
    spec,
    deps,
    decision,
    now,
  );
  if (refusal !== undefined) return refusal;

  return runApprovedExecution(spec, deps, decision, now, input, context);
}

/**
 * Wraps `spec` into a gated `AWS.M3LBedrockToolRegistration` — the only way
 * a tool becomes callable by the model in this script, so "every tool is
 * gated" is structural rather than a convention a caller could forget.
 *
 * @param spec - The tool declaration to gate.
 * @param deps - See {@link GateToolDeps}.
 * @returns A registration whose `handler` runs the full authorize → record →
 *   execute → record pass documented on this module.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { gateToolSpec } from "./gate-tool.js";
 * import type { AgentToolSpec, GateToolDeps } from "./gate-tool.js";
 *
 * declare const spec: AgentToolSpec;
 * declare const deps: GateToolDeps;
 *
 * const registration: AWS.M3LBedrockToolRegistration = gateToolSpec(
 *   spec,
 *   deps,
 * );
 * ```
 */
export function gateToolSpec(
  spec: AgentToolSpec,
  deps: GateToolDeps,
): AWS.M3LBedrockToolRegistration {
  return {
    description: spec.description,
    inputSchema: spec.inputSchema,
    handler: (
      input: unknown,
      context: AWS.M3LBedrockToolContext,
    ): Promise<readonly AWS.M3LBedrockToolResultContent[]> =>
      runGatedTool(spec, deps, input, context),
  };
}
