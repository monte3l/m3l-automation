/**
 * `sqs-dead-letter-triage/steps/execute-actions` — DOES what
 * `./execute-plan.js` decided: every SQS call the execute path makes (send,
 * delete). Split from `./execute-plan.js` (pure planning) purely to stay
 * under the per-file byte ceiling (`pnpm check:file-budget`); the seam is
 * real, not a size dodge — planning is a pure function of the report while
 * application is entirely I/O, the same shape as `build-procedure.ts` /
 * `steps-graph.ts`.
 *
 * This step never re-receives: it reuses the receipt handles `drainQueue`
 * already obtained (`deps.messages`, threaded through from `triage-queue.ts`'s
 * `TriageQueueResult.messages`). A drain's own receive makes every message
 * invisible for `visibilityTimeout` seconds — re-receiving here would see
 * nothing but the drain's own lockout and misreport a guaranteed-empty page
 * as "everything was skipped". See {@link applyActions}'s TSDoc for the full
 * rationale and what a lapsed handle does instead.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { readPath } from "./preset.js";
import type { TriagePreset } from "./preset.js";
import { EXECUTE_CODE } from "./execute-plan.js";
import type { ExecutePlan } from "./execute-plan.js";

/** The SQS API's own per-call cap on batch entries (`sendBatch`/`deleteBatch`). */
const MAX_BATCH_SIZE = 10;

/** What {@link applyActions} needs. */
export interface ApplyActionsDeps {
  readonly sqs: AWS.M3LSQSOperations;
  readonly logger: Core.M3LLogger;
  /** The dead-letter queue every `"drop"`/`"move"` deletes from. */
  readonly queueUrl: string;
  /** Where a `"move"` sends; required only when the plan actually contains one. */
  readonly sourceQueueUrl: string | undefined;
  readonly preset: TriagePreset;
  readonly signal: AbortSignal | undefined;
  /**
   * The same triage pass's drained messages — `TriageQueueResult.messages`,
   * carrying each message's `receiptHandle` from the one `drainQueue` call
   * this run ever makes. `applyActions` looks a planned `messageId` up here
   * instead of re-receiving; see this module's `@packageDocumentation` and
   * {@link applyActions}'s TSDoc for why re-receiving is unsafe here.
   */
  readonly messages: readonly {
    readonly messageId: string;
    readonly body: string;
    readonly receiptHandle: string;
  }[];
}

/** What {@link applyActions} resolves with. */
export interface ApplyResult {
  readonly removed: number;
  readonly reinserted: number;
  /**
   * Planned `messageId`s absent from `deps.messages` — never acted on. With
   * handle reuse this is structurally near-impossible (every planned id
   * comes from the very drain that produced `deps.messages`), so a non-empty
   * `skipped` now signals an internal-invariant violation, not routine drift
   * — the run is demoted the same as a `failed` entry (see
   * `run-sqs-dead-letter-triage.ts`'s recovery reporting).
   */
  readonly skipped: readonly string[];
  readonly failed: readonly {
    readonly messageId: string;
    readonly reason: string;
  }[];
}

/** One message held from the drain, keyed by `messageId` for lookup by {@link classifyPlannedActions}. */
type HeldMessage = ApplyActionsDeps["messages"][number];

/** One failed send/delete entry, joined back to its `messageId` — the shape shared across every batch call this step makes. */
interface FailureEntry {
  readonly messageId: string;
  readonly reason: string;
}

/** One `"move"` action whose message was found among `deps.messages`. */
interface MoveCandidate {
  readonly messageId: string;
  readonly message: HeldMessage;
}

/** What one send pass (FIFO or standard) reports back. */
interface SendOutcome {
  readonly sentIds: readonly string[];
  readonly failed: readonly FailureEntry[];
}

/**
 * Checked once, before this step's first SQS call — never re-checked
 * mid-loop, since (unlike `drain-queue.ts`'s paging) nothing here awaits
 * across a boundary that would need TypeScript's `signal.aborted` narrowing
 * re-defeated.
 */
function checkNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Core.M3LOperationAbortedError();
  }
}

/** Splits `items` into chunks of at most `size`, preserving order. */
function chunk<T>(
  items: readonly T[],
  size: number,
): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Reads a value out of a map the caller already knows must contain `key` — an internal invariant, not a caller error. */
function mustGet<V>(map: ReadonlyMap<string, V>, key: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Core.M3LError(
      `internal invariant violated: expected drained message '${key}' to be present`,
      { code: EXECUTE_CODE },
    );
  }
  return value;
}

/**
 * Resolves the payload a `"move"` message's body carries, following the
 * same `envelope.bodyIsJson`/`envelope.payloadPath` rule `parse-envelope`
 * uses in the triage step graph (`steps-graph.ts`) — `undefined` on
 * anything that does not parse or resolve, never a thrown error, since a
 * malformed FIFO body is a per-message failure here, not a run failure.
 */
function resolvePayload(preset: TriagePreset, body: string): unknown {
  let parsed: unknown = body;
  if (preset.envelope.bodyIsJson) {
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      return undefined;
    }
  }
  const payloadPath = preset.envelope.payloadPath;
  return payloadPath === undefined ? parsed : readPath(parsed, payloadPath);
}

/** One FIFO `"move"` candidate that has a usable message group id, ready to sort and send. */
interface FifoCandidate {
  readonly messageId: string;
  readonly message: HeldMessage;
  /**
   * Narrowed to `string | number` before this type is ever constructed — see
   * {@link classifyFifoCandidates} and {@link splitByOrderValueType}. An
   * `orderBy` path that resolves to anything else (an object, an array,
   * `null`, `undefined`) is rejected as a per-message failure long before a
   * `FifoCandidate` exists for it, so {@link compareOrderValues} never has to
   * fall back to `Object`'s default stringification.
   */
  readonly orderValue: string | number;
  readonly groupId: string;
}

/** Describes a value that failed the `orderBy` string-or-number check, for the failure reason string. */
function describeOrderValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/**
 * Splits already-`orderBy`-typed FIFO candidates into one consistently-typed
 * `ready` group and a `failed` group for the minority type, when a preset's
 * `orderBy` path resolves to a mix of strings and numbers across the batch.
 * `sendFifoSequentially`'s `Array.prototype.sort` has no way to fail a single
 * entry mid-comparison, so a type mismatch between two messages is resolved
 * here, before sorting, by keeping whichever type has more members (ties
 * favour numbers) and failing the rest — never by comparing across types.
 */
function splitByOrderValueType(
  candidates: readonly FifoCandidate[],
  orderBy: string,
): {
  readonly ready: readonly FifoCandidate[];
  readonly failed: readonly FailureEntry[];
} {
  const numbers = candidates.filter(
    (candidate) => typeof candidate.orderValue === "number",
  );
  const strings = candidates.filter(
    (candidate) => typeof candidate.orderValue === "string",
  );
  if (numbers.length === 0 || strings.length === 0) {
    return { ready: candidates, failed: [] };
  }
  const preferNumbers = numbers.length >= strings.length;
  const ready = preferNumbers ? numbers : strings;
  const drop = preferNumbers ? strings : numbers;
  const keptType = preferNumbers ? "number" : "string";
  const droppedType = preferNumbers ? "string" : "number";
  const failed = drop.map((candidate): FailureEntry => ({
    messageId: candidate.messageId,
    reason: `orderBy path '${orderBy}' resolved a ${droppedType} on this message but a ${keptType} on others in the same batch; mixed types cannot be ordered together`,
  }));
  return { ready, failed };
}

/**
 * Splits FIFO `"move"` candidates into those with a usable `groupIdPath`
 * value and a string-or-number `orderBy` value (ready to sort and send) and
 * those without either (a per-message failure, never a batch failure — one
 * bad message must not block every other message in the plan, and it must
 * never be silently mis-ordered by falling back to `Object`'s default
 * stringification either).
 */
function classifyFifoCandidates(
  candidates: readonly MoveCandidate[],
  preset: TriagePreset,
  orderBy: string,
  groupIdPath: string,
): {
  readonly ready: readonly FifoCandidate[];
  readonly failed: readonly FailureEntry[];
} {
  const typed: FifoCandidate[] = [];
  const failed: FailureEntry[] = [];
  for (const candidate of candidates) {
    const payload = resolvePayload(preset, candidate.message.body);
    const groupId =
      payload === undefined ? undefined : readPath(payload, groupIdPath);
    if (typeof groupId !== "string" || groupId.length === 0) {
      failed.push({
        messageId: candidate.messageId,
        reason: `message body has no FIFO message group id at '${groupIdPath}'`,
      });
      continue;
    }
    const orderValue =
      payload === undefined ? undefined : readPath(payload, orderBy);
    if (typeof orderValue !== "string" && typeof orderValue !== "number") {
      failed.push({
        messageId: candidate.messageId,
        reason: `orderBy path '${orderBy}' did not resolve to a string or number (found ${describeOrderValue(orderValue)})`,
      });
      continue;
    }
    typed.push({
      messageId: candidate.messageId,
      message: candidate.message,
      orderValue,
      groupId,
    });
  }
  const split = splitByOrderValueType(typed, orderBy);
  return { ready: split.ready, failed: [...failed, ...split.failed] };
}

/**
 * Orders two `orderBy` values ascending; numeric when both are numbers,
 * lexical when both are strings. Both parameters are always the same
 * primitive type by the time this runs — {@link splitByOrderValueType}
 * guarantees the `ready` list it sorts is type-consistent — so the lexical
 * branch only ever stringifies an actual `string` or `number`, never an
 * object or array.
 */
function compareOrderValues(
  left: string | number,
  right: string | number,
): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right));
}

/**
 * Sends FIFO `"move"` candidates **one entry at a time**, sorted ascending
 * by `preset.orderBy`, each carrying its `groupIdPath`-derived
 * `messageGroupId`. One entry per `sendBatch` call is deliberate — SQS FIFO
 * ordering is per message group, and a single batched call gives SQS no
 * guarantee about the order it processes entries within it.
 */
async function sendFifoSequentially(
  ready: readonly FifoCandidate[],
  sourceQueueUrl: string,
  sqs: AWS.M3LSQSOperations,
): Promise<SendOutcome> {
  const sorted = [...ready].sort((left, right) =>
    compareOrderValues(left.orderValue, right.orderValue),
  );
  const sentIds: string[] = [];
  const failed: FailureEntry[] = [];
  for (const candidate of sorted) {
    const entry: AWS.M3LSQSSendEntry = {
      id: candidate.messageId,
      body: candidate.message.body,
      messageGroupId: candidate.groupId,
    };
    const response = await sqs.sendBatch(sourceQueueUrl, [entry]);
    if (response.failed.length > 0) {
      for (const failure of response.failed) {
        failed.push({
          messageId: failure.entry.id,
          reason: failure.message ?? failure.code,
        });
      }
      continue;
    }
    sentIds.push(candidate.messageId);
  }
  return { sentIds, failed };
}

/** Sends standard-queue `"move"` candidates in batches of at most {@link MAX_BATCH_SIZE}. */
async function sendStandardBatched(
  candidates: readonly MoveCandidate[],
  sourceQueueUrl: string,
  sqs: AWS.M3LSQSOperations,
): Promise<SendOutcome> {
  const sentIds: string[] = [];
  const failed: FailureEntry[] = [];
  for (const batch of chunk(candidates, MAX_BATCH_SIZE)) {
    const entries: AWS.M3LSQSSendEntry[] = batch.map((candidate) => ({
      id: candidate.messageId,
      body: candidate.message.body,
    }));
    const response = await sqs.sendBatch(sourceQueueUrl, entries);
    sentIds.push(...response.successful.map((entry) => entry.id));
    for (const failure of response.failed) {
      failed.push({
        messageId: failure.entry.id,
        reason: failure.message ?? failure.code,
      });
    }
  }
  return { sentIds, failed };
}

/** Sends every `"move"` candidate, FIFO one-at-a-time or standard-batched per `preset.fifo`. */
async function sendMoveCandidates(
  candidates: readonly MoveCandidate[],
  preset: TriagePreset,
  sourceQueueUrl: string,
  sqs: AWS.M3LSQSOperations,
): Promise<SendOutcome> {
  if (!preset.fifo) {
    return sendStandardBatched(candidates, sourceQueueUrl, sqs);
  }
  const orderBy = preset.orderBy;
  const groupIdPath = preset.groupIdPath;
  if (orderBy === undefined || groupIdPath === undefined) {
    // `load-runbook.ts`'s `requireFifoFieldsMatchFifo` enforces both
    // `orderBy` and `groupIdPath` against `fifo` at load time (PR 3b review
    // round 2, MUST-FIX 9) — this remains a defensive re-check only, for a
    // preset constructed by hand (e.g. a test double) that bypassed that
    // validation.
    throw new Core.M3LError(
      "a FIFO preset must declare both 'orderBy' and 'groupIdPath' before a reinsert can be sent",
      { code: EXECUTE_CODE },
    );
  }
  const classified = classifyFifoCandidates(
    candidates,
    preset,
    orderBy,
    groupIdPath,
  );
  const sent = await sendFifoSequentially(
    classified.ready,
    sourceQueueUrl,
    sqs,
  );
  return {
    sentIds: sent.sentIds,
    failed: [...classified.failed, ...sent.failed],
  };
}

/** One confirmed delete target, tagged with which tally it advances on success. */
interface DeleteTarget {
  readonly id: string;
  readonly receiptHandle: string;
  readonly kind: "drop" | "move";
}

/**
 * Deletes every confirmed target in batches of at most
 * {@link MAX_BATCH_SIZE}, tallying a successful delete into `removed`
 * (`"drop"`) or `reinserted` (`"move"`) by the target's own kind. A failed
 * delete is reported via `failed`, never silently dropped — see
 * {@link applyActions}'s TSDoc for why a failed delete after a successful
 * send is a recoverable duplicate, not a lost message.
 */
async function deleteConfirmed(
  targets: readonly DeleteTarget[],
  queueUrl: string,
  sqs: AWS.M3LSQSOperations,
): Promise<{
  readonly removed: number;
  readonly reinserted: number;
  readonly failed: readonly FailureEntry[];
}> {
  const kindById = new Map(targets.map((target) => [target.id, target.kind]));
  let removed = 0;
  let reinserted = 0;
  const failed: FailureEntry[] = [];
  for (const batch of chunk(targets, MAX_BATCH_SIZE)) {
    const entries: AWS.M3LSQSDeleteEntry[] = batch.map((target) => ({
      id: target.id,
      receiptHandle: target.receiptHandle,
    }));
    const response = await sqs.deleteBatch(queueUrl, entries);
    for (const success of response.successful) {
      if (kindById.get(success.id) === "drop") {
        removed += 1;
      } else {
        reinserted += 1;
      }
    }
    for (const failure of response.failed) {
      failed.push({
        messageId: failure.entry.id,
        reason: failure.message ?? failure.code,
      });
    }
  }
  return { removed, reinserted, failed };
}

/** What {@link applyActions} does with each planned action, before any SQS call. */
interface ClassifiedActions {
  /** Planned `messageId`s absent from `deps.messages` — never acted on. */
  readonly skipped: readonly string[];
  readonly dropIds: readonly string[];
  readonly moveCandidates: readonly MoveCandidate[];
}

/**
 * Sorts every planned action into `skipped` (its message is not among
 * `deps.messages`), `dropIds`, or `moveCandidates` — a `"retry"` action needs
 * no SQS call at all and is simply not carried forward.
 */
function classifyPlannedActions(
  actions: ExecutePlan["actions"],
  held: ReadonlyMap<string, HeldMessage>,
): ClassifiedActions {
  const skipped: string[] = [];
  const dropIds: string[] = [];
  const moveCandidates: MoveCandidate[] = [];

  for (const planned of actions) {
    const message = held.get(planned.messageId);
    if (message === undefined) {
      skipped.push(planned.messageId);
      continue;
    }
    switch (planned.action.action) {
      case "drop":
        dropIds.push(planned.messageId);
        break;
      case "move":
        moveCandidates.push({ messageId: planned.messageId, message });
        break;
      case "retry":
        break;
      default: {
        const exhaustive: never = planned.action;
        throw new Core.M3LError(
          "unreachable planned action while applying the execute plan",
          { code: EXECUTE_CODE, cause: exhaustive },
        );
      }
    }
  }

  return { skipped, dropIds, moveCandidates };
}

/**
 * Sends every `"move"` candidate, guarding first on `sourceQueueUrl` — a
 * plan with at least one `"move"` cannot be applied without it. Send happens
 * BEFORE any delete is even considered — see {@link applyActions}'s TSDoc
 * for why the reverse order is unrecoverable.
 */
async function sendMoves(
  moveCandidates: readonly MoveCandidate[],
  deps: ApplyActionsDeps,
): Promise<SendOutcome> {
  if (moveCandidates.length === 0) {
    return { sentIds: [], failed: [] };
  }
  if (deps.sourceQueueUrl === undefined) {
    throw new Core.M3LError(
      `the plan needs 'sourceQueueUrl' to send ${String(moveCandidates.length)} reinsert action(s), but none was supplied`,
      { code: EXECUTE_CODE },
    );
  }
  return sendMoveCandidates(
    moveCandidates,
    deps.preset,
    deps.sourceQueueUrl,
    deps.sqs,
  );
}

/** Builds every confirmed delete target: every `"drop"`, plus every successfully-sent `"move"`. */
function buildDeleteTargets(
  dropIds: readonly string[],
  sentIds: readonly string[],
  held: ReadonlyMap<string, HeldMessage>,
): readonly DeleteTarget[] {
  return [
    ...dropIds.map((id): DeleteTarget => ({
      id,
      receiptHandle: mustGet(held, id).receiptHandle,
      kind: "drop",
    })),
    ...sentIds.map((id): DeleteTarget => ({
      id,
      receiptHandle: mustGet(held, id).receiptHandle,
      kind: "move",
    })),
  ];
}

/**
 * Applies an {@link ExecutePlan} against real SQS operations: sends every
 * `"move"`, then deletes every `"drop"` and every successfully-sent `"move"`.
 *
 * Deliberately never re-receives. `drainQueue` already received these exact
 * messages once, at `visibilityTimeout` (`config.ts`'s `visibilityTimeout`
 * parameter) — a fresh `receive` here would see nothing but that same
 * lockout the drain itself created, since a queue's own most recent drain is
 * always the reason the messages are invisible. A stale re-receive attempt
 * against a self-inflicted empty page is exactly the guaranteed-no-op MUST-FIX
 * this function's current shape closes: every planned id would fall through
 * to `skipped`, `applied`/`reinserted` would stay `0`, and the run would
 * still resolve successfully. Instead, `deps.messages` carries the receipt
 * handles `drainQueue` already holds forward from the very same drain this
 * plan was built from — reused here, never re-acquired.
 *
 * **Order within a message is always send-then-delete, never the
 * reverse.** A delete-then-failed-send would lose the message permanently —
 * it is gone from the dead-letter queue and never reached its destination.
 * A failed delete *after* a successful send only yields a duplicate, which
 * is recoverable (the destination queue's own consumer, or a future
 * dead-letter cycle, sees it again). Only one of those two orderings is
 * survivable, so this function never deletes a message it has not already
 * confirmed sending for (or that needed no send at all — a `"drop"`).
 *
 * A planned `messageId` absent from `deps.messages` lands in `skipped`,
 * never acted on — with handle reuse this is structurally near-impossible
 * (every planned id comes from the same drain that produced `deps.messages`),
 * so treat a non-empty `skipped` as the internal-invariant violation it now
 * is, not routine drift. A handle that HAS lapsed by the time this runs
 * (the operator's confirmation took longer than `visibilityTimeout`) is a
 * different case: the send or delete call itself fails against SQS, and that
 * lands in `failed`, not `skipped` — the message simply stays in the
 * dead-letter queue, the safe direction.
 *
 * @param plan - The plan to apply.
 * @param deps - The SQS operations wrapper, logger, queue identity, the
 *   FIFO/routing preset, and the drain's own held messages.
 * @returns The applied counts, the skipped ids, and every failed entry.
 * @throws {@link Core.M3LError} coded `ERR_DLQ_TRIAGE_EXECUTE` when the plan
 *   needs `sourceQueueUrl` (at least one `"move"`) but none was supplied, or
 *   when a FIFO preset is missing `orderBy`/`groupIdPath`.
 * @throws {@link Core.M3LOperationAbortedError} when `deps.signal` is
 *   already aborted, checked before this step's first SQS call.
 *
 * @example
 * ```typescript
 * import { Core } from "@m3l-automation/m3l-common";
 * import { applyActions } from "./execute-actions.js";
 * import { buildExecutePlan } from "./execute-plan.js";
 *
 * declare const report: import("./report.js").TriageReport;
 * declare const deps: Omit<
 *   Parameters<typeof applyActions>[1],
 *   "logger"
 * >;
 * const plan = buildExecutePlan(report);
 * const result = await applyActions(plan, {
 *   ...deps,
 *   logger: new Core.M3LLogger([]),
 * });
 * console.log(result.removed, result.reinserted);
 * ```
 */
export async function applyActions(
  plan: ExecutePlan,
  deps: ApplyActionsDeps,
): Promise<ApplyResult> {
  checkNotAborted(deps.signal);

  const held = new Map(
    deps.messages.map((message) => [message.messageId, message]),
  );

  const { skipped, dropIds, moveCandidates } = classifyPlannedActions(
    plan.actions,
    held,
  );

  const sendOutcome = await sendMoves(moveCandidates, deps);
  const failed: FailureEntry[] = [...sendOutcome.failed];

  const deleteTargets = buildDeleteTargets(dropIds, sendOutcome.sentIds, held);

  let removed = 0;
  let reinserted = 0;
  if (deleteTargets.length > 0) {
    const deleteOutcome = await deleteConfirmed(
      deleteTargets,
      deps.queueUrl,
      deps.sqs,
    );
    removed = deleteOutcome.removed;
    reinserted = deleteOutcome.reinserted;
    failed.push(...deleteOutcome.failed);
  }

  deps.logger.step(
    `applied execute plan: removed=${String(removed)} reinserted=${String(reinserted)} skipped=${String(skipped.length)} failed=${String(failed.length)}`,
  );

  return { removed, reinserted, skipped, failed };
}
