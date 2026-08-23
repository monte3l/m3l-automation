import { Core } from "@m3l-automation/m3l-common";
import type { AWS } from "@m3l-automation/m3l-common";

import { writeJsonArtifact } from "./write-artifact.js";

/** The error code every guard failure in this step carries. */
export const DRAIN_CODE = "ERR_DLQ_TRIAGE_DRAIN";

/** The SQS API's own per-call cap on `MaxNumberOfMessages`. */
const MAX_PAGE_SIZE = 10;

/**
 * The accumulated raw-body byte budget one drain will hold before it stops
 * paging early, even if `maxMessages` has not been reached. SQS bodies are
 * producer-controlled up to 256 KiB each, and the archive write below does
 * one whole-value `JSON.stringify` — Node's max string length
 * (536,870,888 chars) is reachable at roughly 2,000 max-size messages, and
 * that write is exactly the step this drain cannot retry cheaply (every
 * drained message is already invisible for `visibilityTimeout` seconds by
 * the time it would fail). 64 MiB gives ~100x headroom over the default
 * `maxMessages=100` worst case (~25 MiB) while stopping well short of the
 * failure zone for an operator who raises the cap, as the contract page
 * invites. A constant, not a config parameter, on purpose — the default is
 * safe for the documented default `maxMessages`, and an operator who needs
 * a different ceiling can be revisited if that ever happens in practice.
 */
export const DRAIN_BYTE_BUDGET = 67_108_864; // 64 MiB (64 * 1024 * 1024)

/** One drained message, kept in full — the archive is the last place a raw body is ever whole. */
interface DrainedMessage {
  readonly messageId: string;
  readonly receiptHandle: string;
  readonly body: string;
}

/** What {@link drainQueue} needs. */
export interface DrainQueueDeps {
  readonly sqs: AWS.M3LSQSOperations;
  readonly paths: Core.M3LPaths;
  readonly logger: Core.M3LLogger;
  readonly queueUrl: string;
  /** Preset id — names the archive artifact. */
  readonly queue: string;
  /** Total cap across every page combined. */
  readonly maxMessages: number;
  readonly visibilityTimeout: number;
  readonly signal: AbortSignal | undefined;
}

/** What {@link drainQueue} resolves with. */
export interface DrainResult {
  readonly messages: readonly DrainedMessage[];
  /** The archive's path, relative to the output directory. */
  readonly archivePath: string;
  /** `ApproximateNumberOfMessages` observed at the start of the drain. */
  readonly depth: number;
  /**
   * `true` when the drain stopped early because {@link DRAIN_BYTE_BUDGET}
   * was reached before `maxMessages` or an empty page — the queue may still
   * hold undrained messages. Always `false` on an ordinary drain.
   */
  readonly truncated: boolean;
}

/**
 * Re-checked through a function, never inlined, so TypeScript's narrowing of
 * `signal.aborted` to `false` (from a previous check) does not survive past
 * the `await`s between loop iterations — a mutable external property can
 * genuinely change while this function is suspended.
 */
function checkNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Core.M3LOperationAbortedError();
  }
}

/** Builds the archive artifact's name for this drain, from the queue and current time. */
function archiveNameFor(queue: string, now: Date): string {
  // Colons are not filename-safe on every platform this script's operators
  // run on, so the ISO timestamp is rendered with `-` in their place.
  return `${queue}/drain-${now.toISOString().replaceAll(":", "-")}.json`;
}

/** What {@link accumulatePage} reports back to `drainQueue` about one page. */
interface AccumulatePageResult {
  /** How many NEW (not-yet-seen) messages this page contributed. */
  readonly addedFromPage: number;
  /** The running total of drained body bytes, after this page. */
  readonly drainedBytes: number;
  /** `true` when {@link DRAIN_BYTE_BUDGET} was reached mid-page. */
  readonly truncated: boolean;
}

/**
 * Folds one received page into `messages`/`seen` (both mutated in place),
 * deduplicating by `messageId` and stopping early once `maxMessages` or
 * {@link DRAIN_BYTE_BUDGET} is reached. Extracted from `drainQueue`'s loop
 * body purely to keep that function's own cognitive complexity within this
 * project's ceiling — no behavior lives here that couldn't be inlined.
 */
function accumulatePage(
  page: readonly AWS.M3LSQSReceivedMessage[],
  seen: Set<string>,
  messages: DrainedMessage[],
  drainedBytesSoFar: number,
  maxMessages: number,
): AccumulatePageResult {
  let addedFromPage = 0;
  let drainedBytes = drainedBytesSoFar;
  let truncated = false;
  for (const received of page) {
    if (seen.has(received.messageId)) continue;
    seen.add(received.messageId);
    addedFromPage += 1;
    drainedBytes += received.body.length;
    messages.push({
      messageId: received.messageId,
      receiptHandle: received.receiptHandle,
      body: received.body,
    });
    if (messages.length >= maxMessages) break;
    if (drainedBytes >= DRAIN_BYTE_BUDGET) {
      truncated = true;
      break;
    }
  }
  return { addedFromPage, drainedBytes, truncated };
}

/**
 * Reads a dead-letter queue's current depth, then pages
 * `AWS.M3LSQSOperations.receive` until an empty page comes back,
 * `maxMessages` is spent, or {@link DRAIN_BYTE_BUDGET} accumulated body
 * bytes is reached, deduplicating by `messageId` across pages (SQS can
 * redeliver a message within a single drain). A full page that contributes
 * zero new unique ids also stops the loop — at the legal
 * `visibilityTimeout=0`, a drained message stays immediately visible, so an
 * unbroken loop would re-receive the same page forever. The full drained
 * set — raw bodies included — is archived via {@link writeJsonArtifact}
 * **before** this function returns, so a message can never be triaged (and
 * later, in a later slice, acted on) without a durable record of it having
 * existed.
 *
 * This is a plain read: 3b re-receives at execute time rather than holding
 * these receipt handles for a later gate, so a stale handle expiring
 * between triage and execute is never this function's problem.
 *
 * @param deps - The SQS operations wrapper, `M3LPaths`, logger, queue
 *   identity, and the paging/visibility/cancellation controls.
 * @returns The deduplicated messages, the archive's relative path, and the
 *   queue depth observed at the start of the drain.
 * @throws {@link Core.M3LOperationAbortedError} When `deps.signal` is
 *   already aborted, checked before the queue-depth read and again at the
 *   top of every page.
 * @throws Whatever the archive write rejects with, unwrapped — an
 *   unarchived drain must fail the run rather than hand back messages no
 *   record exists of.
 *
 * @example
 * ```typescript
 * import { AWS, Core } from "@m3l-automation/m3l-common";
 * import { drainQueue } from "./drain-queue.js";
 *
 * declare const sqs: AWS.M3LSQSOperations;
 * const result = await drainQueue({
 *   sqs,
 *   paths: new Core.M3LPaths(),
 *   logger: new Core.M3LLogger([]),
 *   queueUrl: "https://sqs.example/orders-dlq",
 *   queue: "orders-dlq",
 *   maxMessages: 100,
 *   visibilityTimeout: 1800,
 *   signal: undefined,
 * });
 * console.log(result.messages.length);
 * ```
 */
export async function drainQueue(deps: DrainQueueDeps): Promise<DrainResult> {
  checkNotAborted(deps.signal);

  const attributes = await deps.sqs.getQueueAttributes(deps.queueUrl);
  const depth = attributes.approximateNumberOfMessages;

  const seen = new Set<string>();
  const messages: DrainedMessage[] = [];
  let drainedBytes = 0;
  let truncated = false;

  while (messages.length < deps.maxMessages && !truncated) {
    checkNotAborted(deps.signal);

    const remaining = deps.maxMessages - messages.length;
    const page = await deps.sqs.receive(deps.queueUrl, {
      maxMessages: Math.min(remaining, MAX_PAGE_SIZE),
      visibilityTimeout: deps.visibilityTimeout,
    });
    if (page.length === 0) break;

    const accumulated = accumulatePage(
      page,
      seen,
      messages,
      drainedBytes,
      deps.maxMessages,
    );
    drainedBytes = accumulated.drainedBytes;
    truncated = accumulated.truncated;

    // A full page that contributed no new message makes no progress. SQS
    // duplicate delivery inside the visibility window is the ordinary case
    // this also covers; `visibilityTimeout=0` is the pathological one — the
    // page would otherwise be identical forever and the drain would never
    // terminate.
    if (accumulated.addedFromPage === 0) break;
  }

  const now = new Date();
  const archivePath = archiveNameFor(deps.queue, now);
  await writeJsonArtifact(deps.paths, archivePath, {
    queue: deps.queue,
    queueUrl: deps.queueUrl,
    depth,
    generatedAt: now.toISOString(),
    truncated,
    messages,
  });

  deps.logger.step(
    truncated
      ? `drained ${String(messages.length)} message(s) from '${deps.queue}' (stopped early: ${String(DRAIN_BYTE_BUDGET)} byte budget reached, queue may hold more)`
      : `drained ${String(messages.length)} message(s) from '${deps.queue}'`,
    { archivePath, depth, truncated, drainedBytes },
  );

  return { messages, archivePath, depth, truncated };
}
