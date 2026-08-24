import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { buildTriageProcedure } from "./build-procedure.js";
import { drainQueue } from "./drain-queue.js";
import { presetPathFor } from "./explain-runbook.js";
import { loadRunbook } from "./load-runbook.js";
import { createTriageRunState } from "./preset.js";
import type {
  TriageConclusion,
  TriageEntityLookup,
  TriagePreset,
  TriageShape,
} from "./preset.js";

/** The error code a contract-violation failure in this step's own orchestration carries. */
export const TRIAGE_CODE = "ERR_DLQ_TRIAGE_RUN";

/**
 * One drained message's triage result. A discriminated union on `status`
 * rather than one flat interface with optional fields, so the illegal
 * state — a `"matched"` outcome with no conclusion, or a `"failed"` outcome
 * with one — is unrepresentable rather than merely undocumented: a
 * `"matched"`/`"unrecognized"` outcome always carries a real
 * `TriageConclusion` and no `failure`; a `"failed"`/`"aborted"` one always
 * carries a `failure` string and no conclusion. A caller must narrow on
 * `status` before reading either field.
 */
export type MessageOutcome =
  | {
      readonly messageId: string;
      readonly status: "matched" | "unrecognized";
      readonly conclusion: TriageConclusion;
      readonly failure?: undefined;
    }
  | {
      readonly messageId: string;
      readonly status: "failed" | "aborted";
      readonly conclusion?: undefined;
      readonly failure: string;
    };

/** What {@link triageQueue} needs. */
export interface TriageQueueDeps {
  readonly sqs: AWS.M3LSQSOperations;
  readonly lookup: TriageEntityLookup;
  readonly reader: Core.M3LInputFileReader;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly runbookDir: string;
  readonly queue: string;
  readonly queueUrl: string;
  readonly maxMessages: number;
  readonly visibilityTimeout: number;
  readonly signal: AbortSignal | undefined;
}

/** What {@link triageQueue} resolves with. */
export interface TriageQueueResult {
  readonly queue: string;
  readonly title: string;
  readonly depth: number;
  readonly archivePath: string;
  readonly drained: number;
  readonly outcomes: readonly MessageOutcome[];
  /**
   * The drained messages' ids, raw bodies, and receipt handles — carried
   * through so `report.ts`'s `buildTriageReport` can join each row back to
   * its body for the excerpt/length fields, without re-reading the archive,
   * AND so `execute-actions.ts`'s `applyActions` can act on the exact same
   * receipt handles this drain obtained instead of re-receiving (a fresh
   * `receive` against a queue this same drain just emptied would see
   * nothing but its own lockout — see `applyActions`'s TSDoc).
   */
  readonly messages: readonly {
    readonly messageId: string;
    readonly body: string;
    readonly receiptHandle: string;
  }[];
  /** The preset's own `escalateTo`/`followUps` — carried through for the report. */
  readonly escalateTo: string;
  readonly followUps: readonly string[];
  /**
   * The preset this pass loaded and ran, carried through (review round 2,
   * SHOULD-FIX 11) so `execute`'s destructive-apply phase can use the exact
   * preset the interactive confirmation prompt was shown against, instead of
   * re-reading the file after the prompt returns — a window during which a
   * concurrent preset write could otherwise redirect where a confirmed plan
   * sends.
   */
  readonly preset: TriagePreset;
}

/** Renders a run outcome's failure (an unexpected step throw, or an abort) as one operator-facing line. */
function describeFailure(
  error: unknown,
  boundary: TriageShape["stepId"] | undefined,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  return boundary === undefined ? detail : `${detail} (at '${boundary}')`;
}

/** Projects one procedure run outcome onto this step's own, narrower {@link MessageOutcome}. */
function toMessageOutcome(
  messageId: string,
  outcome: Core.M3LProcedureOutcome<TriageShape>,
): MessageOutcome {
  switch (outcome.status) {
    case "matched":
    case "unrecognized":
      return {
        messageId,
        conclusion: outcome.conclusion,
        status: outcome.status,
      };
    case "failed":
      return {
        messageId,
        status: outcome.status,
        failure: describeFailure(outcome.error, outcome.failedStep),
      };
    case "aborted":
      return {
        messageId,
        status: outcome.status,
        failure: describeFailure(outcome.error, outcome.abortedAt),
      };
    default: {
      const exhaustive: never = outcome;
      throw new Core.M3LError("unreachable triage procedure outcome status", {
        code: TRIAGE_CODE,
        cause: exhaustive,
      });
    }
  }
}

/**
 * Drains one dead-letter queue and runs its compiled preset once per drained
 * message, collecting every message's outcome. A **fresh**
 * `createTriageRunState()` is built for every message — reusing one state
 * object across messages would leak the previous message's selected
 * arm/entity/payload into the next one, which is the single most important
 * correctness property this module has.
 *
 * A `failed` outcome (an unexpected step throw) is collected and does not
 * stop the loop — the remaining messages still deserve a verdict. An
 * `aborted` outcome DOES stop the loop: the operator cancelled, so nothing
 * further should run.
 *
 * @param deps - The SQS operations wrapper, entity lookup, input reader,
 *   `M3LPaths`, logger, preset identity, and the paging/cancellation
 *   controls.
 * @returns The queue's title/depth/archive path plus every drained
 *   message's outcome.
 * @throws {@link Core.M3LError} Propagated, unwrapped, from `loadRunbook`
 *   or `buildTriageProcedure` when the preset cannot be loaded or compiled
 *   — this is a preset problem, not a per-message one.
 *
 * @example
 * ```typescript
 * import { AWS, Core } from "@m3l-automation/m3l-common";
 * import { triageQueue } from "./triage-queue.js";
 *
 * declare const deps: Parameters<typeof triageQueue>[0];
 * const result = await triageQueue(deps);
 * console.log(result.outcomes.length);
 * ```
 */
export async function triageQueue(
  deps: TriageQueueDeps,
): Promise<TriageQueueResult> {
  const preset = await loadRunbook(
    deps.reader,
    presetPathFor(deps.runbookDir, deps.queue),
  );
  const procedure = buildTriageProcedure(preset);

  const drainResult = await drainQueue({
    sqs: deps.sqs,
    paths: deps.paths,
    logger: deps.logger,
    queueUrl: deps.queueUrl,
    queue: deps.queue,
    maxMessages: deps.maxMessages,
    visibilityTimeout: deps.visibilityTimeout,
    signal: deps.signal,
  });

  const outcomes: MessageOutcome[] = [];
  for (const message of drainResult.messages) {
    const state = createTriageRunState();
    // A `lookup-entity.ts` failure carries the DynamoDB key in its `context`,
    // not its message, so nothing here logs it — but this call has no trace
    // sink and the pipeline above has no `persist`, so the key currently
    // reaches nowhere that serialises it. If a later slice adds either, that
    // key becomes a live leak and needs the same redaction discipline.
    const outcome = await procedure.run({
      deps: {
        preset,
        message: { messageId: message.messageId, body: message.body },
        lookup: deps.lookup,
        state,
      },
      parameters: { queue: deps.queue, messageId: message.messageId },
      ...(deps.signal !== undefined && { signal: deps.signal }),
    });
    outcomes.push(toMessageOutcome(message.messageId, outcome));
    if (outcome.status === "aborted") break;
  }

  return {
    queue: deps.queue,
    title: preset.title,
    depth: drainResult.depth,
    archivePath: drainResult.archivePath,
    drained: drainResult.messages.length,
    outcomes,
    messages: drainResult.messages.map((message) => ({
      messageId: message.messageId,
      body: message.body,
      receiptHandle: message.receiptHandle,
    })),
    escalateTo: preset.escalateTo,
    followUps: preset.followUps,
    preset,
  };
}
