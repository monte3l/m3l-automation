/**
 * `agent-operator/steps/gate-tool` — the security core of V8: the door every
 * model-facing Bedrock tool handler must pass through. There are two ways
 * through it, {@link gateToolSpec} and {@link gateTwoPhaseToolSpec}, and both
 * run the same gated pass; the second runs it twice.
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
 * {@link gateTwoPhaseToolSpec} runs that same pass **twice** over one
 * described action — first as a dry run, then, only if that dry run both
 * cleared the gate and reported a clean dry-run outcome, as the real
 * mutation. Each phase is a whole pass of its own: its own sampled instant,
 * its own two audit records, its own chance to refuse. The wrapper
 * additionally re-checks `context.signal` between the phases, and phase 1's
 * reported outcome inside phase 2's pass (after its decision is recorded,
 * before it executes) — because one handler call that dispatches two
 * side-effectful executions is exactly the shape neither the dispatch layer's
 * single pre-handler abort check nor the policy (whose `dryRunFirst`
 * precondition is a strict opt-in) can guard on its own.
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
 * Which of {@link gateTwoPhaseToolSpec}'s two phases an `execute` call is
 * running — the wrapper's word, never the spec's.
 *
 * Named rather than inlined into {@link TwoPhaseAgentToolSpec}'s `execute`
 * signature for readability. Kept unexported until a two-phase spec outside
 * this module needs to name it (V9 slice 3), at which point exporting it will
 * have a real consumer.
 */
interface AgentToolPhase {
  /** `true` for phase 1 (the dry run), `false` for phase 2 (the mutation). */
  readonly dryRun: boolean;
}

/**
 * A mutating tool declaration {@link gateTwoPhaseToolSpec} gates twice: once
 * as a dry run, then — only if that dry run cleared the gate — for real.
 *
 * @remarks
 * Structurally {@link AgentToolSpec} with a different `execute` — and it is
 * DERIVED from it (`extends Omit<AgentToolSpec, "execute">`) rather than
 * restated, so a member added to a gated tool declaration cannot land on one
 * of the two entry points and silently miss the other. Only `execute`
 * differs: it receives the phase as a third argument.
 *
 * `describeAction` is called **once** for the whole call rather than once per
 * phase, and it must NOT set `dryRun` itself — the wrapper overrides it per
 * phase. That single call is the point: the spec describes *the action*, and
 * the wrapper alone decides what `dryRun` each phase carries. A spec that
 * could describe its phases separately could describe them differently, and
 * the two-phase guarantee would evaporate — see
 * {@link gateTwoPhaseToolSpec}'s remarks.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import type {
 *   AgentToolExecution,
 *   TwoPhaseAgentToolSpec,
 * } from "./gate-tool.js";
 *
 * const spec: TwoPhaseAgentToolSpec = {
 *   name: "put_item",
 *   description: "Writes one item, dry run first.",
 *   inputSchema: {},
 *   describeAction: (): Core.M3LAgentAction => ({
 *     script: "agent-operator",
 *     operation: "put-item",
 *     kind: "mutating",
 *     parameterNames: ["table"],
 *   }),
 *   execute: async (
 *     _input: unknown,
 *     _context: AWS.M3LBedrockToolContext,
 *     phase: { readonly dryRun: boolean },
 *   ): Promise<AgentToolExecution> => ({
 *     content: [{ type: "text", text: phase.dryRun ? "planned" : "applied" }],
 *     outcome: { dryRun: phase.dryRun, exitCode: 0 },
 *   }),
 * };
 * ```
 */
export interface TwoPhaseAgentToolSpec extends Omit<AgentToolSpec, "execute"> {
  /** Runs the tool's real work for `phase`, once that phase is authorized. */
  execute(
    input: unknown,
    context: AWS.M3LBedrockToolContext,
    phase: AgentToolPhase,
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
  /**
   * Sampled exactly once per gated PASS — never inside one, so a pass's
   * evaluation and both of its decision-log writes share one instant. A
   * two-phase call is two passes and therefore samples this twice, on
   * purpose: phase 1's real work sits between them, and reusing phase 1's
   * instant would misdate phase 2's evaluation and records.
   */
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
  toolName: string,
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
      toolName,
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
      toolName,
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
  toolName: string,
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
      toolName,
      "gate-tool: the post-execution decision-log write failed after " +
        "execute() had already rejected; the original execute() failure " +
        "below is still what gets thrown",
      describeCaughtChain(writeFailure),
    );
  }
  logFailure(
    deps,
    now,
    toolName,
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
  toolName: string,
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
      toolName,
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
 * Reports whether `outcome` REPORTS having been a dry run. `dryRun` is
 * declared required, but this is a producer's self-report crossing into a
 * security decision, so it is checked the same way {@link isCleanExit} checks
 * `exitCode`: an OWN property (never an inherited one a polluted prototype
 * chain could manufacture) strictly equal to `true`. Anything else — `false`,
 * a truthy non-boolean, an absent property — is not a reported dry run.
 */
function reportsDryRun(outcome: Core.M3LAgentDecisionOutcome): boolean {
  return Object.hasOwn(outcome, "dryRun") && outcome.dryRun === true;
}

/**
 * Reports whether `outcome` proves a dry run that both RAN as a dry run and
 * exited cleanly — the single predicate two separate decisions depend on:
 * whether to mint the dry-run-first credit ({@link applyDryRunCredit}) and
 * whether a two-phase call may proceed to its mutation
 * (`runTwoPhaseGatedTool`). One predicate for both, deliberately: were they
 * two, the credit could be withheld while the mutation still ran — or the
 * reverse — and a mutation would be authorized by a dry run the ledger itself
 * refused to count.
 *
 * One predicate is necessary and NOT sufficient: it has to be applied to one
 * READING as well. Both decisions therefore judge the frozen
 * {@link snapshotReportedOutcome}, never the producer's own object, whose
 * accessors can answer each caller differently.
 *
 * Both halves are self-reported by whatever produced the outcome, so both
 * fail closed: an outcome that omits either field, or reports `dryRun: false`
 * on a clean exit (which is a real run, not a plan), proves nothing.
 */
function isCleanDryRunOutcome(outcome: Core.M3LAgentDecisionOutcome): boolean {
  return reportsDryRun(outcome) && isCleanExit(outcome);
}

/**
 * Freezes ONE reading of everything a producer self-reports about the run it
 * just performed, taken the instant its `execute` resolved.
 *
 * @remarks
 * The producer owns the object it returned, and a field backed by an accessor
 * (or a Proxy) can answer differently on every read — so what splits a
 * decision is the RE-READ, not the absence of a shared predicate.
 * {@link isCleanDryRunOutcome} is already the single predicate behind both
 * the dry-run credit and the two-phase mutation guard, but one predicate
 * applied to a shifting object still yields two answers: a `dryRun` getter
 * reading `false` while the credit is decided and `true` by the time the
 * guard runs withheld the credit AND let the mutation run, with the
 * post-execution audit record stamped from a third reading again. This
 * snapshot — not the shared predicate — is what makes the credit, the audit
 * record, and the between-phase guard agree.
 *
 * Every field is read through `Object.hasOwn` for the reason
 * {@link isCleanExit} and {@link reportsDryRun} give: a snapshot must not
 * inherit a field from a polluted prototype chain. It must not INVENT one
 * either, so an outcome that never declared its own `dryRun` stays without
 * one and the library's own record validator still rejects it exactly as it
 * does today, rather than being handed a value the producer never reported.
 * That absent-`dryRun` shape is the one the declared type cannot express,
 * which is what the assertion below is for.
 */
function snapshotReportedOutcome(
  outcome: Core.M3LAgentDecisionOutcome,
): Core.M3LAgentDecisionOutcome {
  const snapshot = {
    ...(Object.hasOwn(outcome, "dryRun") ? { dryRun: outcome.dryRun } : {}),
    ...(Object.hasOwn(outcome, "exitCode")
      ? { exitCode: outcome.exitCode }
      : {}),
    ...(Object.hasOwn(outcome, "registryName")
      ? { registryName: outcome.registryName }
      : {}),
  };
  return Object.freeze(snapshot) as Core.M3LAgentDecisionOutcome;
}

/**
 * The two self-reported fields {@link isCleanDryRunOutcome} judges, rendered
 * for the logger/recovery channel so an operator can tell an absent field
 * from a present-but-wrong one. Never model-facing.
 */
function uncleanDryRunFields(
  outcome: Core.M3LAgentDecisionOutcome,
): Record<string, unknown> {
  return {
    dryRun: Object.hasOwn(outcome, "dryRun") ? outcome.dryRun : "not reported",
    exitCode: Object.hasOwn(outcome, "exitCode")
      ? outcome.exitCode
      : "not reported",
  };
}

/**
 * Names WHY `outcome` fails {@link isCleanDryRunOutcome}, for the log
 * summary. The two reasons are kept distinct because they mean different
 * things to an operator: "it did not report a dry run" is a producer
 * mislabelling what it did, while "it did not prove a clean exit" is a dry
 * run that ran and failed (or declined to say how it ended).
 */
function uncleanDryRunReason(outcome: Core.M3LAgentDecisionOutcome): string {
  return reportsDryRun(outcome)
    ? "the reported outcome did not prove a clean exit"
    : "the reported outcome did not report a dry run";
}

/**
 * Logs, at `error` level, that the dry-run-first credit for `decision`'s
 * action shape was WITHHELD. Never calls `deps.reportRecovery`: nothing was
 * refused and the call still succeeds, so demoting the run's outcome would
 * misreport a dry run that correctly reported what it reported. Without
 * this line the only signal a withheld credit leaves behind is a
 * decision-log `rule=dry-run-first` escalation on a subsequent mutating
 * attempt against the same shape — the next two-phase phase 2, or some later
 * call entirely — which never names which dry run or exit code caused it;
 * this is the missing correlation. `shapeKey` is
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
      "any mutating attempt against the same shape still requires a fresh, " +
      "clean dry run — including, on the two-phase path, the phase 2 that " +
      "was about to follow this very dry run",
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
 * 1. `outcome` fails {@link isCleanDryRunOutcome} — either it does not report
 *    a dry run at all, or its reported exit code is non-zero/absent. The
 *    first half matters as much as the second: the action was JUDGED
 *    `dryRun: true`, but the credit records what the producer says it
 *    actually DID, and a producer reporting `dryRun: false` on a clean exit
 *    just said it performed the real thing. Minting the credit from that
 *    would let a real run authorize the next real run, and the audit record
 *    would show a mutation approved under a dry-run precondition nothing
 *    ever satisfied.
 * 2. `outcome` proves a clean dry run, but
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
  if (!isCleanDryRunOutcome(outcome)) {
    logDryRunCreditWithheld(
      deps,
      decision,
      uncleanDryRunReason(outcome),
      uncleanDryRunFields(outcome),
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
 *
 * Returns the WHOLE {@link AgentToolExecution}, not just its content: a
 * multi-phase caller has to see what phase 1 reported, because "the gate
 * approved it" and "it ran clean" are different facts and only the first is
 * visible in the pass's verdict. Returning content alone is what let a failed
 * dry run fall through to a real mutation.
 */
async function runApprovedExecution(
  toolName: string,
  deps: GateToolDeps,
  decision: Core.M3LAgentDecision,
  now: number,
  execute: () => Promise<AgentToolExecution>,
): Promise<AgentToolExecution> {
  deps.ledger.recordInvocation();

  let result: AgentToolExecution;
  try {
    result = await execute();
  } catch (cause) {
    await recordExecutionFailure(toolName, deps, decision, now, cause);
    if (cause instanceof Core.M3LOperationAbortedError) throw cause;
    throw new Core.M3LError(AGENT_TOOL_REFUSAL_MESSAGES.executionFailed, {
      code: "ERR_AGENT_TOOL_EXECUTION",
      cause,
    });
  }

  // Read the producer's self-report exactly once, here, and let every
  // decision below (the credit, the audit record, and — through the returned
  // execution — a multi-phase caller's between-phase guard) judge that frozen
  // reading. The producer controls the object, so an accessor-backed field can
  // answer differently on each read: sharing `isCleanDryRunOutcome` is not
  // enough when the READS are not shared. See `snapshotReportedOutcome`.
  const outcome = snapshotReportedOutcome(result.outcome);

  if (decision.action.dryRun) {
    applyDryRunCredit(deps, decision, outcome);
  }

  await recordSuccessOutcome(toolName, deps, decision, now, outcome);
  return { content: result.content, outcome };
}

/**
 * The refused arm of {@link GatedPassResult}: the pass stopped short of
 * executing, and `content` is the model-facing refusal text.
 */
interface GatedPassRefusal {
  readonly kind: "refused";
  readonly content: readonly AWS.M3LBedrockToolResultContent[];
}

/**
 * The outcome of one gated pass, discriminated on `kind`.
 *
 * @remarks
 * A refusal and a success both hand the model content blocks, so content
 * alone cannot tell them apart — which is exactly what a multi-phase caller
 * needs to know, since a refused phase must stop the run rather than fall
 * through to the next phase. The `passed` arm additionally carries the
 * `outcome` the execution reported: passing the gate and running clean are
 * independent facts, and a multi-phase caller must be able to stop on either.
 * The discriminant is deliberately **internal**: {@link gateToolSpec}'s
 * handler unwraps it back to plain content, so the public tool-registration
 * shape is unchanged and no envelope key — nor the outcome — can ever reach
 * the model.
 */
type GatedPassResult =
  | GatedPassRefusal
  | {
      readonly kind: "passed";
      readonly content: readonly AWS.M3LBedrockToolResultContent[];
      readonly outcome: Core.M3LAgentDecisionOutcome;
    };

/**
 * The result of crossing the module's one trust boundary: either the action
 * a caller may now gate, or the refusal that boundary produced.
 */
type DescribedAction =
  | GatedPassRefusal
  | { readonly kind: "described"; readonly action: Core.M3LAgentAction };

/**
 * Calls `describe` — the spec's `describeAction`, the module's one trust
 * boundary — and turns a throw into a `malformedInput` refusal, so a
 * malformed input is rejected before anything is evaluated, recorded, or
 * executed. Shared by the single- and two-phase entry points precisely so
 * neither can grow a second, divergent version of that boundary.
 */
function describeActionOrRefuse(
  deps: GateToolDeps,
  now: number,
  toolName: string,
  describe: () => Core.M3LAgentAction,
): DescribedAction {
  try {
    return { kind: "described", action: describe() };
  } catch (cause) {
    return {
      kind: "refused",
      content: refuse(
        deps,
        now,
        toolName,
        AGENT_TOOL_REFUSAL_MESSAGES.malformedInput,
        "gate-tool: describeAction rejected the tool input; nothing was authorized",
        describeCaughtChain(cause),
      ),
    };
  }
}

/**
 * The result of judging an action: either the decision to record and act on,
 * or the refusal the evaluator's own rejection produced.
 */
type EvaluatedAction =
  | GatedPassRefusal
  | { readonly kind: "evaluated"; readonly decision: Core.M3LAgentDecision };

/**
 * Judges `action` against the policy and the ledger's snapshot, turning a
 * rejection into a `malformedInput` refusal.
 *
 * @remarks
 * `Core.evaluateAgentAction` VALIDATES the action before judging it and
 * throws `M3LAgentActionValidationError` on a malformed one, with a message
 * that names the offending field verbatim; an unrecognised `kind`, for one,
 * produces a message quoting `action.kind` and the reason it was rejected.
 * Left uncaught, that message escapes the handler, and the Bedrock dispatch
 * layer transmits a thrown handler message to the model verbatim — so the
 * module's closed-vocabulary invariant would hold everywhere except here. Nothing is recorded on this path: the throw
 * means no decision exists to record, exactly as a `describeAction` throw
 * means nothing was authorized.
 *
 * This matters most on the two-phase path, where the second evaluation
 * happens AFTER phase 1 has already executed — the one place an unhandled
 * throw would both leak and leave a half-finished mutation.
 */
function evaluateActionOrRefuse(
  toolName: string,
  deps: GateToolDeps,
  action: Core.M3LAgentAction,
  now: number,
): EvaluatedAction {
  try {
    return {
      kind: "evaluated",
      decision: Core.evaluateAgentAction({
        action,
        policy: deps.policy,
        run: deps.ledger.snapshot(now),
      }),
    };
  } catch (cause) {
    return {
      kind: "refused",
      content: refuse(
        deps,
        now,
        toolName,
        AGENT_TOOL_REFUSAL_MESSAGES.malformedInput,
        "gate-tool: the described action was rejected before it could be judged; nothing was authorized",
        describeCaughtChain(cause),
      ),
    };
  }
}

/**
 * The full gated pass over one already-derived `action`: evaluate it,
 * record-and-maybe-refuse, then (only on approval) execute and record again.
 *
 * @remarks
 * `now` is supplied by the caller rather than sampled here, so one pass
 * cannot straddle a clock tick: the evaluation and both decision-log writes
 * share a single instant. A multi-phase caller samples a fresh instant per
 * phase — each phase is its own pass, and phase 2 may begin long after phase
 * 1's real work finished, so reusing phase 1's instant would misdate phase
 * 2's audit records.
 *
 * `guardBeforeExecute` is the CALLER's own precondition — a stop the policy
 * knows nothing about — and it is consulted at exactly one point: after the
 * decision has been evaluated and its pre-execution record written, and
 * before `execute` runs. Both halves of that placement are load-bearing:
 *
 * - **After the record**, because the decision log is the audit authority and
 *   `refuse` writes nothing to it (it reports through `logger` and
 *   `reportRecovery` only). A mutation that was attempted and blocked has to
 *   leave a trace where an auditor actually looks, so the pass must get far
 *   enough to append the pre-decision entry — under the deployed policy
 *   (`dryRunFirst: true`) that is the entry carrying `rule=dry-run-first`,
 *   which is the single most informative record of the whole call. Guarding
 *   earlier would trade that record for a logger line.
 * - **Before `execute`**, because that is the side effect being prevented.
 *   The refusal therefore also leaves no post-execution outcome record: no
 *   execution happened to report on.
 *
 * The guard runs regardless of the verdict the evaluator reached, so a
 * caller's precondition cannot be silently satisfied by a permissive policy.
 * It returns refusal content to stop, or `undefined` to proceed.
 */
async function runGatedPass(
  toolName: string,
  deps: GateToolDeps,
  action: Core.M3LAgentAction,
  now: number,
  execute: () => Promise<AgentToolExecution>,
  guardBeforeExecute?: () =>
    readonly AWS.M3LBedrockToolResultContent[] | undefined,
): Promise<GatedPassResult> {
  const evaluated = evaluateActionOrRefuse(toolName, deps, action, now);
  if (evaluated.kind === "refused") return evaluated;
  const decision = evaluated.decision;

  const refusal = await recordPreDecisionAndMaybeRefuse(
    toolName,
    deps,
    decision,
    now,
  );
  if (refusal !== undefined) return { kind: "refused", content: refusal };

  // The decision is now on the audit record whatever the caller's guard says
  // next, and nothing has run yet — the one instant at which a caller-level
  // stop costs neither an audit entry nor a side effect.
  const guarded = guardBeforeExecute?.();
  if (guarded !== undefined) return { kind: "refused", content: guarded };

  const executed = await runApprovedExecution(
    toolName,
    deps,
    decision,
    now,
    execute,
  );
  return {
    kind: "passed",
    content: executed.content,
    outcome: executed.outcome,
  };
}

/**
 * The single-phase gated call: sample `now` once, cross the trust boundary,
 * then run one gated pass over whatever action it described.
 */
async function runGatedTool(
  spec: AgentToolSpec,
  deps: GateToolDeps,
  input: unknown,
  context: AWS.M3LBedrockToolContext,
): Promise<GatedPassResult> {
  const now = deps.now();

  const described = describeActionOrRefuse(deps, now, spec.name, () =>
    spec.describeAction(input),
  );
  if (described.kind === "refused") return described;

  return runGatedPass(spec.name, deps, described.action, now, () =>
    spec.execute(input, context),
  );
}

/**
 * Wraps `spec` into a gated `AWS.M3LBedrockToolRegistration` — the only way
 * a tool becomes callable by the model in this script, so "every tool is
 * gated" is structural rather than a convention a caller could forget.
 *
 * @param spec - The tool declaration to gate.
 * @param deps - See {@link GateToolDeps}.
 * @returns A registration whose `handler` runs the full authorize → record →
 *   execute → record pass documented on this module, and hands the model
 *   plain content blocks for both a refusal and a success — the pass's
 *   internal {@link GatedPassResult} discriminant never leaves this module.
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
    handler: async (
      input: unknown,
      context: AWS.M3LBedrockToolContext,
    ): Promise<readonly AWS.M3LBedrockToolResultContent[]> =>
      (await runGatedTool(spec, deps, input, context)).content,
  };
}

/** One described action, split into the two actions the wrapper gates. */
interface TwoPhaseActions {
  /** Phase 1: the same action, judged and recorded as a dry run. */
  readonly dryRun: Core.M3LAgentAction;
  /** Phase 2: the same action again, judged and recorded as the real thing. */
  readonly mutation: Core.M3LAgentAction;
}

/**
 * Splits one described `action` into the two phase actions, which differ in
 * `dryRun` and in nothing else.
 *
 * @remarks
 * Both phases derive from ONE description, and that is the whole reason the
 * spec's `describeAction` takes no phase argument: the dry-run shape key
 * (`computeAgentActionShapeKey`) hashes exactly `script`, `operation`,
 * `kind`, and `parameterNames`, and deliberately EXCLUDES `dryRun`. Phase 1's
 * credit must therefore land on precisely the key phase 2 asks about, or the
 * policy's `dryRunFirst` precondition becomes silently unsatisfiable — every
 * mutation escalating on `dry-run-first` forever, with a clean dry run in the
 * log right above it.
 *
 * "One description" is not by itself enough to guarantee that, which is what
 * this function exists to fix — a spread is shallow and reads the source once:
 *
 * - The source is read exactly ONCE, into `base`. Everything below reads that
 *   plain-object copy, so an action whose fields are getters (or a Proxy)
 *   cannot answer phase 1 and phase 2 differently.
 * - `parameterNames` is COPIED, not shared by reference. A shallow spread
 *   aliases the array, and `evaluateAgentAction` re-reads it per phase — once
 *   before phase 1 and again after phase 1's `execute` has run — so a spec
 *   that mutated its own array during phase 1 would hand phase 2 a different
 *   shape key.
 *
 * What is guaranteed after that: the two actions agree on all four hashed
 * fields for the rest of the call, whatever the spec does to the object it
 * returned. Do not add a per-phase `describeAction`, and do not go back to
 * spreading the source twice.
 */
function deriveTwoPhaseActions(action: Core.M3LAgentAction): TwoPhaseActions {
  const base = { ...action };
  const dryRun: Core.M3LAgentAction = {
    ...base,
    ...(base.parameterNames === undefined
      ? {}
      : { parameterNames: [...base.parameterNames] }),
    dryRun: true,
  };
  return { dryRun, mutation: { ...dryRun, dryRun: false } };
}

/**
 * Throws when `signal` has aborted, and is called between the two phases.
 *
 * @remarks
 * The dispatch layer (`aws/bedrock-runtime/tool-dispatch.ts`) checks the
 * signal immediately BEFORE the handler and never again — a sound contract
 * when one handler call means one side-effectful dispatch. This wrapper turns
 * one handler call into two, and the second is the one that actually mutates,
 * so a Ctrl-C raised while the dry run was running would otherwise be
 * invisible right up to the point of no return. Re-checking here is what
 * makes an abort during phase 1 prevent phase 2 rather than merely follow it.
 *
 * Throws the abort rather than refusing with vocabulary text, because ADR-0049
 * classifies an abort by `instanceof` and the dispatch layer rethrows an
 * `M3LOperationAbortedError` unwrapped to unwind the whole loop — a refusal
 * would instead be handed to the model as an ordinary tool result and the run
 * would carry on. The message is the library's own fixed, caller-independent
 * string, so nothing about this call can leak through it.
 */
function assertNotAbortedBetweenPhases(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Core.M3LOperationAbortedError();
  }
}

/**
 * Renders WHY `outcome` fails {@link isCleanDryRunOutcome}, for the
 * logger/recovery channel — the reason plus the two self-reported fields
 * behind it.
 *
 * @remarks
 * `JSON.stringify` is the one fallible step, so it is the only step wrapped:
 * it THROWS on a value that refuses to serialize (a `toJSON` that raises —
 * including an inherited one, since the field wrapper this renders is an
 * ordinary object — or a circular reference), and separately RETURNS
 * `undefined` for a value it cannot represent at all, which the declared
 * `string` return type hides. Either way the caller still owes the model a
 * refusal and an operator both report channels, so an unrenderable detail
 * degrades to a placeholder rather than taking the refusal down with it.
 */
function describeUncleanDryRun(outcome: Core.M3LAgentDecisionOutcome): string {
  const reason = uncleanDryRunReason(outcome);
  let rendered: string | undefined;
  try {
    rendered = JSON.stringify(uncleanDryRunFields(outcome));
  } catch {
    rendered = undefined;
  }
  return `${reason} (${typeof rendered === "string" ? rendered : "the reported fields could not be serialized"})`;
}

/**
 * Decides whether phase 1's reported `outcome` permits phase 2 to run,
 * returning the model-facing refusal when it does not. Used as phase 2's
 * `guardBeforeExecute`, so it fires after phase 2's decision has been
 * evaluated and recorded and before its `execute` — never as a check that
 * skips phase 2's pass altogether.
 *
 * @remarks
 * Phase 1 passing the gate says the POLICY allowed the dry run; it says
 * nothing about whether the dry run then succeeded. The policy cannot cover
 * that gap either: `dryRunFirst` is a strict opt-in, so under a policy that
 * omits it phase 2 is judged with no reference to phase 1 at all and a plan
 * that failed would be followed by the mutation it failed to plan. This
 * wrapper's own promise — "the mutation runs only after a clean dry run" —
 * must not depend on a deployment flag, so the stop lives here and applies to
 * EVERY phase-2 verdict, the auto-approved one included. Under a policy that
 * did opt into `dryRunFirst` the evaluator refuses first, on its own
 * `rule=dry-run-first`, and this guard is never consulted — which is the
 * right division: the policy speaks where it has an opinion, and this covers
 * the deployments where it has none.
 *
 * Routed through {@link refuse} rather than a bare log line: a stop the model
 * is told about must also reach `reportRecovery`, or a scheduler reading the
 * run's outcome never learns the mutation was skipped. That is on top of, not
 * instead of, phase 2's pre-decision entry in the decision log — `refuse`
 * writes no audit record itself, which is precisely why this guard runs after
 * that entry has been appended. `executionFailed` is the closest existing
 * vocabulary member and an honest one — the dry run did fail — and it
 * correctly tells the model not to retry.
 *
 * @returns Refusal content when the mutation must not run, `undefined` to
 *   proceed.
 */
function stopBeforeMutation(
  deps: GateToolDeps,
  now: number,
  toolName: string,
  outcome: Core.M3LAgentDecisionOutcome,
): readonly AWS.M3LBedrockToolResultContent[] | undefined {
  if (isCleanDryRunOutcome(outcome)) return undefined;

  // Rendered BEFORE the call, never as an argument to it: built in argument
  // position, a serialization that throws means `refuse` is never entered, so
  // a blocked mutation loses its logger line AND its `reportRecovery` entry
  // and the raw throw escapes into the dispatch layer, which relays it to the
  // model verbatim. A detail that cannot be rendered degrades to a
  // placeholder; the refusal itself is not negotiable.
  const detail = describeUncleanDryRun(outcome);

  return refuse(
    deps,
    now,
    toolName,
    AGENT_TOOL_REFUSAL_MESSAGES.executionFailed,
    "gate-tool: phase 1's dry run did not report a clean exit; refusing to run the mutation",
    detail,
  );
}

/**
 * Runs the two-phase call: cross the trust boundary once, then gate the
 * derived dry run and — only if it passed, was not aborted, and reported a
 * clean dry run — the derived mutation.
 *
 * @remarks
 * Phase 2 samples its own instant. Phase 1's real work sits between them and
 * may take arbitrarily long, so reusing phase 1's instant would misdate
 * phase 2's evaluation and both of its audit records. The between-phase
 * checks, by contrast, are still reporting on phase 1 and so reuse
 * `describedAt` rather than sampling a third instant.
 */
async function runTwoPhaseGatedTool(
  spec: TwoPhaseAgentToolSpec,
  deps: GateToolDeps,
  input: unknown,
  context: AWS.M3LBedrockToolContext,
): Promise<readonly AWS.M3LBedrockToolResultContent[]> {
  const describedAt = deps.now();
  const described = describeActionOrRefuse(deps, describedAt, spec.name, () =>
    spec.describeAction(input),
  );
  if (described.kind === "refused") return described.content;

  const phases = deriveTwoPhaseActions(described.action);

  const dryRun = await runGatedPass(
    spec.name,
    deps,
    phases.dryRun,
    describedAt,
    () => spec.execute(input, context, { dryRun: true }),
  );
  // A refused phase 1 stops the run: nothing was authorized to mutate, and
  // running phase 2 anyway would ask the gate to approve the mutation the
  // dry run was supposed to justify.
  if (dryRun.kind === "refused") return dryRun.content;

  // An abort is the caller withdrawing consent to the whole run, so it stops
  // everything — phase 2 is not evaluated and not recorded, because there is
  // no longer a decision to make about it. This is the one between-phase stop
  // that precedes phase 2's pass; the outcome stop below deliberately does
  // not.
  assertNotAbortedBetweenPhases(context.signal);

  // Phase 2 IS evaluated and recorded even though a failed dry run means it
  // will not run: `stopBeforeMutation` is handed to the pass as its
  // before-execute guard rather than checked here, so the attempt lands in
  // the decision log — see `runGatedPass`'s remarks. Phase 2's own instant is
  // sampled once and shared by its records and this refusal, so the log and
  // the recovery entry agree on when the attempt happened.
  const mutationAt = deps.now();
  const mutation = await runGatedPass(
    spec.name,
    deps,
    phases.mutation,
    mutationAt,
    () => spec.execute(input, context, { dryRun: false }),
    () => stopBeforeMutation(deps, mutationAt, spec.name, dryRun.outcome),
  );
  return mutation.content;
}

/**
 * Wraps `spec` into a gated `AWS.M3LBedrockToolRegistration` that runs the
 * mutation twice: first as a dry run, then — only if that dry run cleared
 * the gate AND reported a clean dry-run outcome — for real. Each phase is a
 * FULL gated pass (evaluate, record the decision, execute, record the
 * outcome), so a two-phase tool is never less audited than a single-phase
 * one.
 *
 * @remarks
 * `spec.describeAction` is called exactly once and both phases are derived
 * from its single result — see `deriveTwoPhaseActions` for why the two phases
 * minting an identical dry-run shape key is load-bearing rather than
 * incidental.
 *
 * Phase 1 is gated in its own right: a policy refusal, an unavailable
 * decision log, or malformed input all stop the call before anything
 * mutates, and the model gets the same {@link AGENT_TOOL_REFUSAL_MESSAGES}
 * text a single-phase refusal produces. The wrapper then stops again on an
 * abort raised during phase 1 (`assertNotAbortedBetweenPhases`, which stops
 * before phase 2 is evaluated at all) or on a dry run that ran and failed
 * (`stopBeforeMutation`, which lets phase 2 be evaluated and RECORDED first,
 * so the blocked mutation appears in the decision log, then refuses before it
 * can execute). What the model sees on success is phase 2's content — phase
 * 1's is a plan, not a result.
 *
 * Two consequences of running two full passes are deliberate, documented
 * here because neither is obvious from a call site, and both are properties
 * of the LIBRARY's metering rather than of this wrapper:
 *
 * 1. **Each call spends TWO `recordInvocation()` credits.** A policy's
 *    `budgets.maxInvocations` therefore permits half as many two-phase
 *    mutations as single-phase ones, and — because the ceiling is checked per
 *    pass — it can refuse phase 2 of a call whose phase 1 it just approved,
 *    leaving the run with a dry run and no mutation. That is the safe way to
 *    run out of budget (the plan happened, the mutation did not), so it is
 *    accepted rather than worked around; size the budget for two per
 *    two-phase tool call.
 * 2. **The dry-run credit is keyed by action SHAPE, per run.** The key hashes
 *    (`script`, `operation`, `kind`, `parameterNames`) — NOT the target, and
 *    not the tool — so a two-phase call can satisfy `dryRunFirst` for a
 *    LATER, different, single-phase mutating tool that happens to share that
 *    shape, including one aimed at a different target. Sensitivity is judged
 *    before the dry-run-first arm, so a `prod` target still escalates on its
 *    own rule; the reachable case is one non-sensitive target's dry run
 *    covering another non-sensitive target. This is the library's key
 *    definition, stated here so a policy author can see it — do not narrow it
 *    from this wrapper.
 *
 * @param spec - The mutating tool declaration to gate.
 * @param deps - See {@link GateToolDeps}.
 * @returns A registration whose `handler` runs both gated phases.
 *
 * @example
 * ```ts
 * import type { AWS } from "@m3l-automation/m3l-common";
 * import { gateTwoPhaseToolSpec } from "./gate-tool.js";
 * import type { GateToolDeps, TwoPhaseAgentToolSpec } from "./gate-tool.js";
 *
 * declare const spec: TwoPhaseAgentToolSpec;
 * declare const deps: GateToolDeps;
 *
 * const registration: AWS.M3LBedrockToolRegistration = gateTwoPhaseToolSpec(
 *   spec,
 *   deps,
 * );
 * ```
 */
export function gateTwoPhaseToolSpec(
  spec: TwoPhaseAgentToolSpec,
  deps: GateToolDeps,
): AWS.M3LBedrockToolRegistration {
  return {
    description: spec.description,
    inputSchema: spec.inputSchema,
    handler: (
      input: unknown,
      context: AWS.M3LBedrockToolContext,
    ): Promise<readonly AWS.M3LBedrockToolResultContent[]> =>
      runTwoPhaseGatedTool(spec, deps, input, context),
  };
}
