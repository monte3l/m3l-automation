/**
 * `agent-operator/steps/build-flow-tools` — the single `reconcile_queue`
 * single-phase, MUTATING tool that drives `m3l flow run` through
 * `AgentCliSurface.flowRun`'s fixed `mode: "mutate"` argv shape.
 *
 * @remarks
 * This module never gates anything itself — see `steps/build-health-tools.ts`'s
 * module remarks for why that split is structural. What lives here is the
 * other half: the action `reconcile_queue` submits for judgement, and the
 * single `execute` it performs once approved.
 *
 * ## `kind: "mutating"`, never `"read-only"`
 *
 * Unlike `steps/build-triage-tools.ts`'s `triage_logs`, `m3l flow run` really
 * does mutate — a flow's steps are operator-authored scripts free to write to
 * AWS. Reporting `kind: "read-only"` here would route this action through
 * `Core.decideAgentAction`'s read-only auto-approval path instead of the
 * mutating path's `dryRunFirst`/sensitivity grading, silently approving a
 * mutation with no per-call judgement at all. `kind` is therefore a fixed
 * literal in `describeAction` below, never derived from model-supplied
 * `input` — a model that could choose `kind` could choose its own autonomy
 * tier.
 *
 * ## `target.profile` is `deps.gradedProfile`, and nothing else
 *
 * `deps.gradedProfile` is a PRODUCT of `verifyFlowNames`
 * (`lib/flow-definitions.ts`): the single `aws.profile` value every step of
 * every allowlisted flow declares, established by that verifier's refusals 5
 * and 6. It must not be re-derived here, and it must NOT be the operator's
 * own resolved profile: a flow step's declared parameters are rendered as
 * argv tokens by `packages/m3l-cli`'s `flow/step.ts` — config-resolution
 * precedence level 1 in the grandchild process — so a declared step profile
 * is authoritative for that process regardless of what account the operator's
 * own CLI/config precedence resolved. Stamping the operator's profile instead
 * would grade one account while `m3l flow run` mutates a different one — the
 * same "the parent authorizes one read while the child acts on another"
 * defect class this programme has found three times already (once in
 * `build-etl-tools.ts`'s `scriptDeclaresAwsProfile` refusal, once in
 * `build-triage-tools.ts`'s `aws.profile` pin, and now here). Threading
 * `deps.gradedProfile` straight through — never re-reading it from anywhere
 * else — is what keeps the judged `target` honest.
 *
 * ## No target-command refusal
 *
 * {@link RECONCILE_TARGET_COMMAND} is a documented constant, not a runtime
 * guard: `buildTriageTools` can refuse a mismatched `scriptName` because
 * `BuildTriageToolsDeps` carries that per-call field to compare against.
 * `BuildFlowToolsDeps` has no analogous field — the command family
 * (`flow run`) is fixed unconditionally by `AgentCliSurface.flowRun`'s own
 * `buildArgv` case, already pinned by that surface's own argv tests. A
 * refusal here would compare the constant against nothing and could never
 * fire; do not add one for symmetry with `buildTriageTools`.
 *
 * ## No retry within one run — structurally, not by convention
 *
 * `execute` below closes over a per-{@link buildFlowTools}-call guard flag,
 * set the instant the first `execute` call begins, before `flowName` is even
 * read. A second `execute` call in the SAME run — whether the model retries
 * after a failure or simply calls the tool twice — is refused before
 * `surface.flowRun` is ever reached. This is the load-bearing half of the
 * fix: `buildAgentToolRegistry` holds no per-run state of its own (a fresh
 * registry is built per run, but nothing inside it remembers "already ran"
 * across calls within that run), so nothing else in the call chain prevents
 * a second, concurrent `m3l flow run` against a queue the first invocation's
 * flow run may still be draining.
 *
 * ## The INDETERMINATE rule lives HERE, not in the runner
 *
 * When `surface.flowRun` rejects with a `"timed-out"` disposition, this
 * tool's own `execute` — not `steps/run-queue-reconcile.ts` — records the
 * decision-log entry marking the run's outcome indeterminate, then rethrows
 * the original rejection unchanged. This placement is not a style choice:
 * `AWS.runBedrockToolLoop`'s tool-dispatch layer converts ANY non-abort
 * handler rejection (including this one, once `gate-tool.ts`'s
 * `runApprovedExecution` has re-wrapped it as `ERR_AGENT_TOOL_EXECUTION`)
 * into a `status: "error"` toolResult and keeps the loop running — the
 * runner's own `catch` around `runLoop` is therefore never entered for this
 * rejection at all, and a classifier placed there is dead code that no
 * execution path can reach. Recording inside `execute`, before gate-tool's
 * re-wrap ever runs, is the only point in the chain that actually observes
 * the original `M3LAgentOperatorCliError` and its `"timed-out"` disposition.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

import type { AgentCliSurface } from "../lib/cli-surface.js";
import { M3LAgentOperatorCliError } from "../lib/errors.js";
import { assertAllowedFlowName } from "../lib/flow-names.js";
import type { VerifiedFlowNames } from "../lib/flow-definitions.js";
import type { AgentDecisionRecorder } from "./decision-recorder.js";
import type { AgentToolExecution, AgentToolSpec } from "./gate-tool.js";

/**
 * The `m3l` subcommand family {@link buildFlowTools}'s one tool always
 * targets. Kept as a named, documented constant rather than a magic string —
 * see the module remarks' "no target-command refusal" section for why no
 * runtime check compares anything against it: the family is enforced at the
 * argv layer (`AgentCliSurface.flowRun`'s fixed `buildArgv` case), not
 * re-checked here.
 *
 * @example
 * ```ts
 * import { RECONCILE_TARGET_COMMAND } from "./build-flow-tools.js";
 *
 * RECONCILE_TARGET_COMMAND; // "flow"
 * ```
 */
export const RECONCILE_TARGET_COMMAND = "flow";

/**
 * The one tool name this module registers, frozen. Exported so the prompt
 * builder and the tests name the same string.
 *
 * Annotated rather than `as const satisfies …`: `tsconfig.build.json` sets
 * `isolatedDeclarations`, which rejects an exported `satisfies` expression.
 */
export const AGENT_FLOW_TOOL_NAMES: {
  readonly reconcileQueue: "reconcile_queue";
} = Object.freeze({
  reconcileQueue: "reconcile_queue",
});

/** The JSON Schema `reconcile_queue` declares: an object with one required string. */
const RECONCILE_QUEUE_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze(
  {
    type: "object",
    properties: {
      flowName: {
        type: "string",
        description:
          "A member of the operator-declared verified flow allowlist.",
      },
    },
    required: ["flowName"],
    additionalProperties: false,
  },
);

/** Dependencies {@link buildFlowTools} needs to build the `reconcile_queue` spec. */
export interface BuildFlowToolsDeps {
  /** The typed `m3l` CLI adapter `execute` drives via `surface.flowRun`. */
  readonly surface: AgentCliSurface;
  /**
   * The verified `flowAllowlist`, minted exclusively by `verifyFlowNames`.
   * Holding this brand is what proves every entry already cleared that
   * verifier's refusals (a well-formed name, no `yesSensitive` step, exactly
   * one agreed declared `aws.profile`) — never a raw, unchecked
   * `ReadonlySet<string>`.
   */
  readonly flowAllowlist: VerifiedFlowNames;
  /**
   * The single `aws.profile` every verified flow's steps agree on, stamped
   * onto every judged action's `target`. See the module remarks' "target
   * profile" section for why this must be the verifier's own product, never
   * the operator's own profile.
   */
  readonly gradedProfile: string;
  /**
   * Writes the run-level INDETERMINATE decision-log entry when
   * `surface.flowRun` rejects with a `"timed-out"` disposition. See the
   * module remarks' "INDETERMINATE rule lives HERE" section for why
   * `execute` — not `steps/run-queue-reconcile.ts` — is where this write
   * must happen.
   */
  readonly decisionRecorder: AgentDecisionRecorder;
  /**
   * The run's own preflight decision (`GatedOperationSetup.decision`),
   * stamped onto the INDETERMINATE entry exactly as the evaluator returned
   * it for this run — never re-derived or re-judged here.
   */
  readonly decision: Core.M3LAgentDecision;
  /**
   * The single instant `GatedOperationSetup` sampled at prepare time
   * (`GatedOperationSetup.now`), reused verbatim for the INDETERMINATE
   * entry so it cannot straddle a clock tick relative to the rest of the
   * run's own audit trail.
   */
  readonly now: number;
  /**
   * The script's logger — where a failed INDETERMINATE decision-log write is
   * logged. Mirrors `steps/run-queue-reconcile.ts`'s `RunQueueReconcileDeps`,
   * which is the runner threading this straight through from `script.logger`.
   */
  readonly logger: Core.M3LLogger;
  /**
   * Bound from `script.reportRecovery` — files a recovery entry for a failed
   * INDETERMINATE decision-log write, demoting the run to `partial` instead
   * of letting the loss go unobserved. Mirrors
   * `steps/run-queue-reconcile.ts`'s `RunQueueReconcileDeps`.
   */
  readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
}

/**
 * Extracts the single `flowName` a model-supplied `input` may carry, or
 * throws before anything is authorized. Copies `build-etl-tools.ts`'s
 * `readPresetName` structure verbatim: `Array.isArray` first (a `[]` would
 * otherwise pass a naive `typeof === "object"` check), then `typeof`/`null`,
 * then `Object.hasOwn` (never a bracket read or the `in` operator, both of
 * which can answer from a polluted prototype chain), then the string check,
 * then {@link assertAllowedFlowName} (which performs both the shape check
 * and the allowlist-membership check in one call).
 *
 * @remarks
 * Every rejection is re-wrapped as this module's own
 * `ERR_AGENT_OPERATOR_FLOW`, chaining the original as `cause`.
 * {@link assertAllowedFlowName} throws `ERR_AGENT_OPERATOR_CONFIG` — the
 * right code at its own surface (`lib/flow-names.ts` is a standalone seam),
 * but misleading at a tool boundary: a model supplying `--dry-run` is not an
 * operator-configuration fault. `build-triage-tools.ts` and
 * `build-etl-tools.ts` set this precedent with their own domain code
 * (`ERR_AGENT_OPERATOR_PRESET`); this module uses its own
 * (`ERR_AGENT_OPERATOR_FLOW`), matching `lib/flow-definitions.ts`'s own
 * `assertFlowNameOnAllowlist` helper, which performs the identical
 * translation for the same reason. The shared validator's code is never
 * changed — only wrapped at this call site, with the chain preserved.
 *
 * No thrown message ever echoes `flowName`: it is model-supplied, and a
 * rejected value is exactly the thing least safe to quote back.
 *
 * @throws {@link M3LAgentOperatorCliError} coded `ERR_AGENT_OPERATOR_FLOW`
 *   when `input` is an array, is not a plain object, does not carry its own
 *   string `flowName`, or when the shape check or the allowlist-membership
 *   check inside {@link assertAllowedFlowName} rejects the name.
 */
function readFlowName(
  input: unknown,
  flowAllowlist: VerifiedFlowNames,
): string {
  // Reject an array outright, before the shape check ever runs: `typeof []
  // === "object"`, so an array would otherwise reach the shape check exactly
  // like a plain object. An array is not the plain-object shape
  // `RECONCILE_QUEUE_SCHEMA` declares, and it is the one shape
  // `snapshotInputOrRefuse` (gate-tool.ts) deliberately leaves
  // un-snapshotted.
  if (Array.isArray(input)) {
    throw new M3LAgentOperatorCliError(
      "the tool input must be an object carrying a 'flowName'",
      "ERR_AGENT_OPERATOR_FLOW",
    );
  }
  if (typeof input !== "object" || input === null) {
    throw new M3LAgentOperatorCliError(
      "the tool input must be an object carrying a 'flowName'",
      "ERR_AGENT_OPERATOR_FLOW",
    );
  }
  // `Object.hasOwn`, never a bracket or dot read: a model can send
  // `{"__proto__": {"flowName": "…"}}`, and an inherited read would answer
  // from the prototype chain for a key this input never declared.
  if (!Object.hasOwn(input, "flowName")) {
    throw new M3LAgentOperatorCliError(
      "the tool input must carry its own 'flowName' property",
      "ERR_AGENT_OPERATOR_FLOW",
    );
  }
  const raw = (input as Record<string, unknown>)["flowName"];
  if (typeof raw !== "string") {
    throw new M3LAgentOperatorCliError(
      "the tool input's 'flowName' must be a string",
      "ERR_AGENT_OPERATOR_FLOW",
    );
  }
  try {
    return assertAllowedFlowName(raw, flowAllowlist);
  } catch (cause) {
    throw new M3LAgentOperatorCliError(
      "the tool input's 'flowName' is not an allowed flow name",
      "ERR_AGENT_OPERATOR_FLOW",
      { cause },
    );
  }
}

/**
 * The fixed, non-echoing message a second `execute` call within one run is
 * refused with. Never interpolated with `flowName` or any other
 * model-supplied value — see the module remarks' "no retry within one run"
 * section for why the refusal fires unconditionally, before `flowName` is
 * even read.
 */
const SECOND_INVOCATION_REFUSED_MESSAGE =
  "reconcile_queue has already been invoked once this run; a second " +
  "invocation is refused because it could mutate a queue the first " +
  "invocation's flow run may still be draining";

/**
 * Whether `error` is the one rejection this tool treats specially: a
 * `flowRun` timeout whose downstream effects are unknown. Moved here from
 * `steps/run-queue-reconcile.ts` — see this module's remarks' "INDETERMINATE
 * rule lives HERE" section for why the runner can never observe this shape.
 *
 * @remarks
 * `error.context` is read into a local exactly once, and `disposition` is
 * then read from that SAME local exactly once — never re-read from
 * `error.context` a second time — because a producer-controlled object
 * could answer a repeated property read differently each time. Membership is
 * checked with `Object.hasOwn`, never the `in` operator, which would also
 * answer from the prototype chain.
 */
function isIndeterminateTimeout(error: unknown): boolean {
  if (!(error instanceof M3LAgentOperatorCliError)) return false;
  if (error.code !== "ERR_AGENT_OPERATOR_CLI_SPAWN") return false;
  const context: Record<string, unknown> = error.context;
  if (!Object.hasOwn(context, "disposition")) return false;
  const disposition = context["disposition"];
  return disposition === "timed-out";
}

/**
 * Records the run's outcome as indeterminate — `exitCode` deliberately
 * omitted, never `0` or any other guessed value.
 *
 * @remarks
 * A failing decision-log write is never propagated: the caller is about to
 * rethrow `surface.flowRun`'s own timeout rejection unchanged, and that
 * original rejection — not a secondary audit-write failure — is the one this
 * tool must surface. But a failure here is uniquely costly to lose silently:
 * `requireDecisionLog` is set, and this is the one entry that records "this
 * run's AWS effects are indeterminate" — losing it without a trace means the
 * audit trail is missing exactly the record a timed-out flow run needs most,
 * while the run still reports its original failure. So the failure is
 * logged and reported as an absorbed failure (demoting the run to `partial`)
 * rather than swallowed. This mirrors `steps/conclusion-tail.ts`'s
 * `recordConsumption`: a `finally`-adjacent best-effort step must never
 * shadow the real error it runs alongside, but "must not shadow" is not
 * "must not observe".
 *
 * The reporting call itself — `reportRecovery` and the `recordedAt` it
 * builds — sits in its own nested `try`, whose `catch` logs through
 * `logger.error` rather than letting the reporting call's own failure
 * replace the decision-log write failure that is actually the one that
 * matters. That nested `try`/`catch` only catches a SYNCHRONOUS throw — see
 * `conclusion-tail.ts`'s module remarks for why that is the whole of the
 * real `reportRecovery` port's contract.
 *
 * @throws Never — every failure along this path, including one from the
 *   absorbed-failure reporting path itself, is logged rather than
 *   propagated, so it can never replace the caller's original `flowRun`
 *   rejection.
 */
async function recordIndeterminateOutcome(
  decisionRecorder: AgentDecisionRecorder,
  decision: Core.M3LAgentDecision,
  now: number,
  logger: Core.M3LLogger,
  reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void,
): Promise<void> {
  try {
    await decisionRecorder.record({
      decision,
      now,
      outcome: { dryRun: false },
    });
  } catch (cause) {
    logger.error(
      "the INDETERMINATE decision-log entry for a timed-out reconcile_queue flow run could not be written; the audit trail is missing the one record marking this run's AWS effects as unknown",
      { cause: Core.serializeErrorChain(cause, { redact: true }) },
    );
    try {
      reportRecovery({
        item: "reconcile-queue-indeterminate-decision-log",
        error: Core.serializeErrorChain(cause, { redact: true }),
        recordedAt: new Date(now).toISOString(),
      });
    } catch (reportingCause) {
      // A last-resort reporter must never be the thing that replaces the
      // decision-log write failure above — see this function's remarks and
      // `conclusion-tail.ts`'s `recordConsumption`, which establishes the
      // same shape.
      logger.error(
        "reporting the reconcile-queue indeterminate-decision-log recovery entry also failed; the decision-log write failure above is the one that matters",
        { cause: Core.serializeErrorChain(reportingCause, { redact: true }) },
      );
    }
  }
}

/**
 * The subset of {@link BuildFlowToolsDeps} `reconcileQueueSpec` needs,
 * captured once as locals by {@link buildFlowTools} rather than threaded
 * through as the `deps` object itself — mirrors `build-triage-tools.ts`'s
 * `TriageLogsSpecLocals`. Capturing locals immediately means every judged
 * `target` this tool will ever report comes from the SAME point-in-time
 * snapshot of `deps`, and a caller mutating `deps` after `buildFlowTools` has
 * returned cannot retroactively change it.
 */
interface ReconcileQueueSpecLocals {
  readonly surface: AgentCliSurface;
  readonly flowAllowlist: VerifiedFlowNames;
  readonly gradedProfile: string;
  readonly decisionRecorder: AgentDecisionRecorder;
  readonly decision: Core.M3LAgentDecision;
  readonly now: number;
  /** See {@link BuildFlowToolsDeps.logger}. */
  readonly logger: Core.M3LLogger;
  /** See {@link BuildFlowToolsDeps.reportRecovery}. */
  readonly reportRecovery: (entry: Core.M3LRunRecoveryEntry) => void;
  /**
   * One fresh mutable guard per {@link buildFlowTools} call — therefore one
   * per run. `invoked` is a property on this object (not a `let` inside
   * `reconcileQueueSpec` itself) so `buildFlowTools` can hand every call the
   * SAME guard while still passing the rest of `locals` by value.
   */
  readonly executionGuard: { invoked: boolean };
}

/** Builds the `reconcile_queue` spec over `locals`. */
function reconcileQueueSpec(locals: ReconcileQueueSpecLocals): AgentToolSpec {
  const {
    surface,
    flowAllowlist,
    gradedProfile,
    decisionRecorder,
    decision,
    now,
    logger,
    reportRecovery,
    executionGuard,
  } = locals;
  return {
    name: AGENT_FLOW_TOOL_NAMES.reconcileQueue,
    description:
      "Run one allowlisted, verified m3l flow (e.g. a queue-reconciliation flow). Mutating.",
    inputSchema: RECONCILE_QUEUE_SCHEMA,
    describeAction: (input: unknown): Core.M3LAgentAction => {
      readFlowName(input, flowAllowlist);
      return {
        script: "m3l",
        operation: "run",
        // Fixed, never derived from input: a model that could choose `kind`
        // could choose its own autonomy tier. See the module remarks'
        // "`kind: mutating`" section for why this really is `"mutating"`,
        // unlike `triage_logs`.
        kind: "mutating",
        // `gradedProfile`, never re-derived: see the module remarks' "target
        // profile" section.
        target: { profile: gradedProfile },
        parameterNames: ["flowName"],
      };
    },
    execute: async (input: unknown, _context): Promise<AgentToolExecution> => {
      // Refuse a second call BEFORE `flowName` is even read — see the module
      // remarks' "no retry within one run" section. The flag is set
      // synchronously, before any `await`, so a second call arriving in the
      // same tick as the first (not merely a later retry) is refused too.
      if (executionGuard.invoked) {
        throw new M3LAgentOperatorCliError(
          SECOND_INVOCATION_REFUSED_MESSAGE,
          "ERR_AGENT_OPERATOR_ESCALATED",
        );
      }
      executionGuard.invoked = true;
      // Re-read rather than thread the name down from `describeAction`: the
      // gate calls the two independently, and a cached name would be a
      // second source of truth to keep in step.
      const flowName = readFlowName(input, flowAllowlist);
      try {
        const envelope = await surface.flowRun(flowName, { mode: "mutate" });
        return {
          content: [{ type: "json", json: envelope }],
          outcome: {
            // Fixed `false`, never derived: `flowRun` is always called with
            // `mode: "mutate"` here — there is no dry-run phase for this
            // tool.
            dryRun: false,
            exitCode: envelope.exitCode,
          },
        };
      } catch (cause) {
        // See the module remarks' "INDETERMINATE rule lives HERE" section:
        // this is the one point in the whole call chain that still sees the
        // original rejection, before `gate-tool.ts` re-wraps it.
        if (isIndeterminateTimeout(cause)) {
          await recordIndeterminateOutcome(
            decisionRecorder,
            decision,
            now,
            logger,
            reportRecovery,
          );
        }
        throw cause;
      }
    },
  };
}

/**
 * Builds the flow tool specs: exactly one, `reconcile_queue`.
 *
 * @param deps - See {@link BuildFlowToolsDeps}.
 * @returns The one `reconcile_queue` spec, in a frozen array. Never gated
 *   here: hand the result to `gateToolSpec` (via `buildAgentToolRegistry`),
 *   the only door.
 *
 * @example
 * ```ts
 * import { buildFlowTools } from "./build-flow-tools.js";
 * import type { BuildFlowToolsDeps } from "./build-flow-tools.js";
 *
 * declare const deps: BuildFlowToolsDeps;
 *
 * const specs = buildFlowTools(deps);
 * ```
 */
export function buildFlowTools(
  deps: BuildFlowToolsDeps,
): readonly AgentToolSpec[] {
  // Captured as locals immediately so every judged `target` this tool will
  // ever report is decided from the SAME point-in-time snapshot of `deps` —
  // see `ReconcileQueueSpecLocals`'s remarks.
  const {
    surface,
    flowAllowlist,
    gradedProfile,
    decisionRecorder,
    decision,
    now,
    logger,
    reportRecovery,
  } = deps;
  // One fresh guard per `buildFlowTools` call — therefore one per run. See
  // the module remarks' "no retry within one run" section.
  const executionGuard = { invoked: false };
  return Object.freeze([
    reconcileQueueSpec({
      surface,
      flowAllowlist,
      gradedProfile,
      decisionRecorder,
      decision,
      now,
      logger,
      reportRecovery,
      executionGuard,
    }),
  ]);
}
