/**
 * `aws/bedrock-runtime/stream` — {@link invokeStream}, the implementation
 * behind {@link M3LBedrockRuntimeOperations.invokeStream}: the
 * `ConverseStream` request/response mapping, the two-phase (`hasYielded`)
 * fault-handling state machine, and the `messageStop`/`metadata` fusion
 * into {@link M3LBedrockStreamEvent}s.
 *
 * Internal module — nothing here is re-exported through
 * `aws/bedrock-runtime/index`; `client.ts`'s
 * `M3LBedrockRuntimeOperations.invokeStream()` is the only public entry
 * point, and it delegates straight to this file's {@link invokeStream}. See
 * `shared.ts`'s own doc comment for why this file imports shared machinery
 * from there rather than from `client.ts` directly (breaking a
 * `client.ts` ⇄ `stream.ts` circular import).
 *
 * @packageDocumentation
 */

import {
  ConverseStreamCommand,
  type BedrockRuntimeClient,
  type ConverseStreamCommandOutput,
  type ConverseStreamOutput,
  type TokenUsage,
} from "@aws-sdk/client-bedrock-runtime";

import { M3LOperationAbortedError } from "../../core/errors/index.js";

import {
  M3LBedrockRuntimeModelError,
  M3LBedrockRuntimeNoModelError,
  M3LBedrockRuntimeOperationError,
  M3LBedrockRuntimeStreamError,
} from "./error.js";
import {
  buildConverseInput,
  buildRetryRunner,
  classifySendFailure,
  isAborted,
  isAbortError,
  mapRole,
  readErrorName,
  STOP_REASON_LOOKUP,
} from "./shared.js";
import type {
  M3LBedrockInvokeOptions,
  M3LBedrockInvokeRequest,
  M3LBedrockStopReason,
  M3LBedrockStreamEvent,
} from "./types.js";

/** Builds the `ConverseStreamCommand` for one model attempt. See `shared.ts`'s `buildConverseInput`. */
function buildConverseStreamCommand(
  modelId: string,
  request: M3LBedrockInvokeRequest,
): ConverseStreamCommand {
  return new ConverseStreamCommand(buildConverseInput(modelId, request));
}

/**
 * Classifies a fault surfaced from **iterating** a `ConverseStream`
 * response — thrown from `.next()`, or extracted from a yielded
 * exception-shaped union member (see {@link extractExceptionChunk}) — per
 * the two-phase fault handling documented on {@link invokeStream}.
 * `hasYielded` is derived from `eventsEmitted > 0` rather than tracked as
 * an independent flag, so the two can never drift out of sync.
 *
 * Pre-boundary, delegates verbatim to `shared.ts`'s `classifySendFailure`
 * (identical to `invoke`'s rules; no mid-stream same-model retry, since a
 * stream cannot resume from a byte offset). Post-boundary,
 * `ModelStreamErrorException`/`ValidationException` keep their pre-boundary
 * error types unchanged; every other fault collapses unconditionally to
 * {@link M3LBedrockRuntimeStreamError} with `retrySafe: false` (only
 * reached once `eventsEmitted >= 1`, so a retry would duplicate delivered
 * output).
 *
 * @returns `error` unchanged, only when `hasYielded === false` and the fault
 *   is one of the two advance-fallback tiers.
 */
function classifyIterationFault(
  error: unknown,
  modelId: string,
  eventsEmitted: number,
): unknown {
  const hasYielded = eventsEmitted > 0;
  if (!hasYielded) {
    return classifySendFailure(error, modelId);
  }

  const name = readErrorName(error);
  if (name === "ModelStreamErrorException") {
    throw new M3LBedrockRuntimeModelError(
      `model ${modelId} faulted while streaming the response`,
      { modelId, cause: error },
    );
  }
  if (name === "ValidationException") {
    throw new M3LBedrockRuntimeOperationError(
      `Converse stream request rejected for model ${modelId}`,
      { cause: error, origin: "caller", retryable: false },
    );
  }
  throw new M3LBedrockRuntimeStreamError(
    `stream for model ${modelId} faulted after ${eventsEmitted} event(s) had already been yielded`,
    { modelId, eventsEmitted, retrySafe: false, cause: error },
  );
}

/** Every discriminant key of the SDK's `ConverseStreamOutput` union. */
type ConverseStreamOutputKey = keyof ConverseStreamOutput;

/**
 * Exhaustiveness table partitioning every `ConverseStreamOutput`
 * discriminant key into "exception-shaped" (one of the five members whose
 * payload is a real SDK exception instance — thrown from iteration, and
 * defensively re-checked here per the reference page's "Fault handling" §
 * footnote) versus every ordinary data/`$unknown` key. Mirrors
 * `shared.ts`'s `STOP_REASON_MEMBERS`-style `Record`-over-the-full-membership
 * idiom: because this is a `Record<ConverseStreamOutputKey, boolean>`
 * **object literal**, a future SDK version that adds a 13th
 * `ConverseStreamOutput` member is a missing-property compile error right
 * here — `pnpm typecheck` fails instead of the new member silently falling
 * through {@link extractExceptionChunk}'s loop and `mapStreamChunk`'s
 * catch-all drop branch.
 */
const CONVERSE_STREAM_OUTPUT_KEY_IS_EXCEPTION: Record<
  ConverseStreamOutputKey,
  boolean
> = {
  messageStart: false,
  contentBlockStart: false,
  contentBlockDelta: false,
  contentBlockStop: false,
  messageStop: false,
  metadata: false,
  internalServerException: true,
  modelStreamErrorException: true,
  validationException: true,
  throttlingException: true,
  serviceUnavailableException: true,
  $unknown: false,
};

/**
 * The exception-shaped subset of {@link CONVERSE_STREAM_OUTPUT_KEY_IS_EXCEPTION}
 * — derived from that table, rather than a second hand-maintained list, so
 * the two can never drift apart.
 */
const EXCEPTION_MEMBER_KEYS = (
  Object.keys(
    CONVERSE_STREAM_OUTPUT_KEY_IS_EXCEPTION,
  ) as ConverseStreamOutputKey[]
).filter((key) => CONVERSE_STREAM_OUTPUT_KEY_IS_EXCEPTION[key]);

/**
 * Extracts the exception-shaped payload from a yielded `ConverseStreamOutput`
 * chunk — one of the five exception-shaped union members (see
 * {@link EXCEPTION_MEMBER_KEYS}). Returns `undefined` for every ordinary
 * data chunk.
 *
 * Verified against the shipped SDK runtime (`@smithy/core`'s event-stream
 * deserializer) that these five are actually **thrown** from iteration,
 * never yielded as data — this check exists as defence-in-depth
 * (`docs/reference/aws/bedrock-runtime.md`'s "Fault handling" § footnote) so
 * a caller-visible outcome is identical regardless of which SDK version or
 * code path is actually in effect at runtime.
 */
function extractExceptionChunk(chunk: ConverseStreamOutput): unknown {
  for (const key of EXCEPTION_MEMBER_KEYS) {
    const value = chunk[key];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * Mutable buffer for `invokeStream`'s independently-buffered `messageStop`
 * (`stopReason`)/`metadata` (`usage`) events — fused into one `message-stop`
 * event as soon as both have arrived, regardless of which the SDK sends
 * first (the SDK's ordering is not type-guaranteed).
 */
interface StreamTerminalBuffer {
  hasStopReason: boolean;
  stopReason: string | undefined;
  hasUsage: boolean;
  usage: TokenUsage | undefined;
}

/** A fresh, empty {@link StreamTerminalBuffer}. */
function createStreamTerminalBuffer(): StreamTerminalBuffer {
  return {
    hasStopReason: false,
    stopReason: undefined,
    hasUsage: false,
    usage: undefined,
  };
}

/**
 * Narrows a raw stream-reported `stopReason` string to the closed
 * {@link M3LBedrockStopReason} membership — the same `ReadonlySet`
 * membership-check idiom `client.ts`'s `mapConverseResponse` uses for
 * `invoke`'s response. AWS's Smithy enums are open at the wire level, so a
 * value outside this set is a genuinely unexpected AWS response shape.
 */
function isKnownStopReason(value: string): value is M3LBedrockStopReason {
  return STOP_REASON_LOOKUP.has(value);
}

/**
 * Builds the fused `message-stop` event once both halves of
 * {@link StreamTerminalBuffer} are held. Only called when
 * `buffer.hasStopReason && buffer.hasUsage`.
 *
 * @throws {@link M3LBedrockRuntimeOperationError} When `stopReason` is
 *   outside the closed {@link M3LBedrockStopReason} membership, or `usage`
 *   is missing any of `inputTokens`/`outputTokens`/`totalTokens` — a
 *   malformed-but-delivered terminal value, never
 *   {@link M3LBedrockRuntimeStreamError} even if events were already
 *   yielded.
 */
function fuseStopEvent(
  modelId: string,
  buffer: StreamTerminalBuffer,
): M3LBedrockStreamEvent {
  const { stopReason, usage } = buffer;
  if (stopReason === undefined || !isKnownStopReason(stopReason)) {
    throw new M3LBedrockRuntimeOperationError(
      `Converse stream response for model ${modelId} had an unrecognized stopReason`,
    );
  }
  if (
    usage === undefined ||
    usage.inputTokens === undefined ||
    usage.outputTokens === undefined ||
    usage.totalTokens === undefined
  ) {
    throw new M3LBedrockRuntimeOperationError(
      `Converse stream response for model ${modelId} had incomplete usage`,
    );
  }
  return {
    type: "message-stop",
    stopReason,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    },
    modelId,
  };
}

interface StreamChunkStep {
  readonly event: M3LBedrockStreamEvent | undefined;
  readonly buffer: StreamTerminalBuffer;
}

/**
 * Maps one `ConverseStreamOutput` chunk — already confirmed not to be one
 * of the five exception-shaped members (see {@link extractExceptionChunk})
 * — to at most one {@link M3LBedrockStreamEvent}, mutating `buffer` for the
 * `messageStop`/`metadata` pair. `contentBlockStart`, `contentBlockStop`, a
 * `contentBlockDelta` whose delta is not text, and any other unrecognized
 * chunk are silently dropped (`undefined`) — see the "No
 * content-block-start/content-block-stop events" note in
 * `docs/reference/aws/bedrock-runtime.md`.
 *
 * @throws {@link M3LBedrockRuntimeOperationError} See {@link fuseStopEvent}.
 */
function mapStreamChunk(
  chunk: ConverseStreamOutput,
  modelId: string,
  buffer: StreamTerminalBuffer,
): StreamChunkStep {
  if (chunk.messageStart !== undefined) {
    return {
      event: {
        type: "message-start",
        role: mapRole(chunk.messageStart.role),
        modelId,
      },
      buffer,
    };
  }

  if (chunk.contentBlockDelta !== undefined) {
    const delta = chunk.contentBlockDelta.delta;
    if (delta !== undefined && typeof delta.text === "string") {
      return {
        event: {
          type: "text-delta",
          text: delta.text,
          contentBlockIndex: chunk.contentBlockDelta.contentBlockIndex ?? 0,
        },
        buffer,
      };
    }
    return { event: undefined, buffer };
  }

  if (chunk.messageStop !== undefined) {
    const nextBuffer: StreamTerminalBuffer = {
      ...buffer,
      hasStopReason: true,
      stopReason: chunk.messageStop.stopReason,
    };
    return {
      event: nextBuffer.hasUsage
        ? fuseStopEvent(modelId, nextBuffer)
        : undefined,
      buffer: nextBuffer,
    };
  }

  if (chunk.metadata !== undefined) {
    const nextBuffer: StreamTerminalBuffer = {
      ...buffer,
      hasUsage: true,
      usage: chunk.metadata.usage,
    };
    return {
      event: nextBuffer.hasStopReason
        ? fuseStopEvent(modelId, nextBuffer)
        : undefined,
      buffer: nextBuffer,
    };
  }

  // contentBlockStart, contentBlockStop, $unknown: silently dropped.
  return { event: undefined, buffer };
}

/**
 * The outcome of one model's streaming attempt (the return slot of
 * {@link attemptStream}): `undefined` for a clean, fully-fused drain, or a
 * signal to advance fallback — reachable only while `hasYielded` was still
 * `false` at the point of fault.
 */
type StreamAttemptOutcome =
  { readonly type: "advance"; readonly cause: unknown } | undefined;

/** The outcome of {@link requestStream}: either advance fallback, or a stream ready to drain. */
type StreamRequestOutcome =
  | { readonly type: "advance"; readonly cause: unknown }
  | {
      readonly type: "stream";
      readonly stream: AsyncIterable<ConverseStreamOutput>;
    };

/** The outcome of {@link pullChunk}: advance fallback, a clean end-of-stream, or one ordinary data chunk. */
type StreamPullOutcome =
  | { readonly type: "advance"; readonly cause: unknown }
  | { readonly type: "done" }
  | { readonly type: "chunk"; readonly chunk: ConverseStreamOutput };

/**
 * Sends the `ConverseStreamCommand` for one model attempt, retrying
 * `ThrottlingException`/`InternalServerException` on the same model before
 * either advancing fallback or a stream response resolves.
 *
 * @throws {@link M3LOperationAbortedError} When `signal` aborted during
 *   `send()`/retry.
 * @throws {@link M3LBedrockRuntimeOperationError} A caller/permission
 *   fault, any other unclassified rejection, or `stream === undefined` —
 *   a malformed-but-successful response, thrown with no fallback advance.
 */
async function requestStream(
  client: BedrockRuntimeClient,
  modelId: string,
  request: M3LBedrockInvokeRequest,
  signal: AbortSignal | undefined,
): Promise<StreamRequestOutcome> {
  const command = buildConverseStreamCommand(modelId, request);
  const runner = buildRetryRunner(signal);

  let output: ConverseStreamCommandOutput;
  try {
    output = await runner.run(() =>
      signal !== undefined
        ? client.send(command, { abortSignal: signal })
        : client.send(command),
    );
  } catch (error) {
    if (error instanceof M3LOperationAbortedError) throw error;
    if (isAborted(signal) && isAbortError(error)) {
      throw new M3LOperationAbortedError();
    }
    const cause = classifySendFailure(error, modelId);
    return { type: "advance", cause };
  }

  if (output.stream === undefined) {
    throw new M3LBedrockRuntimeOperationError(
      `Converse stream response for model ${modelId} had no stream`,
    );
  }
  return { type: "stream", stream: output.stream };
}

/**
 * Pulls and classifies exactly one raw chunk from the SDK's stream
 * iterator: an ordinary data chunk, a clean end-of-stream, or a fault
 * (thrown from `.next()`, or extracted from a yielded exception-shaped
 * union member — see {@link extractExceptionChunk}).
 *
 * @throws {@link M3LOperationAbortedError} When `signal` is aborted at
 *   the moment `.next()` rejects, or immediately after it resolves — the
 *   latter also gates the clean-drain path, since a destroyed socket can
 *   otherwise surface as an unremarkable end-of-stream rather than a
 *   rejection.
 * @throws {@link M3LBedrockRuntimeModelError} `ModelStreamErrorException`,
 *   on either side of the `hasYielded` boundary.
 * @throws {@link M3LBedrockRuntimeOperationError} `ValidationException`,
 *   pre-boundary.
 * @throws {@link M3LBedrockRuntimeStreamError} Post-`hasYielded`, for
 *   every fault not covered by the two exceptions above.
 */
async function pullChunk(
  iterator: AsyncIterator<ConverseStreamOutput>,
  modelId: string,
  signal: AbortSignal | undefined,
  eventsEmitted: number,
): Promise<StreamPullOutcome> {
  let result: IteratorResult<ConverseStreamOutput>;
  try {
    result = await iterator.next();
  } catch (error) {
    // Mid-stream abort is order-reversed from `invoke`'s: check
    // isAborted(signal) FIRST, before any name-based classification — a
    // destroyed socket post-send() is not reliably AbortError-shaped.
    if (isAborted(signal)) {
      throw new M3LOperationAbortedError();
    }
    const cause = classifyIterationFault(error, modelId, eventsEmitted);
    return { type: "advance", cause };
  }

  if (isAborted(signal)) {
    throw new M3LOperationAbortedError();
  }
  if (result.done) {
    return { type: "done" };
  }

  const chunk = result.value;
  const exceptionValue = extractExceptionChunk(chunk);
  if (exceptionValue !== undefined) {
    const cause = classifyIterationFault(
      exceptionValue,
      modelId,
      eventsEmitted,
    );
    return { type: "advance", cause };
  }
  return { type: "chunk", chunk };
}

/**
 * Iterates an already-obtained `ConverseStream` response, yielding a mapped
 * {@link M3LBedrockStreamEvent} for each `messageStart`/text-delta chunk
 * (see {@link mapStreamChunk}) and fusing `messageStop`/`metadata` into one
 * terminal `message-stop` event as soon as both are held. The underlying
 * SDK iterator's `.return()` is called best-effort in `finally`, regardless
 * of how iteration ends. Full `@throws` detail: {@link invokeStream}.
 *
 * @returns `undefined` on a clean, fully-fused drain, or an
 *   advance-fallback signal only when `hasYielded` was still `false` at
 *   the point of fault.
 */
async function* drainStream(
  stream: AsyncIterable<ConverseStreamOutput>,
  modelId: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<M3LBedrockStreamEvent, StreamAttemptOutcome, void> {
  const iterator = stream[Symbol.asyncIterator]();
  let buffer = createStreamTerminalBuffer();
  let eventsEmitted = 0;

  try {
    for (;;) {
      const pulled = await pullChunk(iterator, modelId, signal, eventsEmitted);
      if (pulled.type === "advance") {
        return pulled;
      }
      if (pulled.type === "done") {
        break;
      }

      const step = mapStreamChunk(pulled.chunk, modelId, buffer);
      buffer = step.buffer;
      if (step.event === undefined) {
        continue;
      }

      yield step.event;
      eventsEmitted += 1;

      // Re-check abort immediately after every yield resumes, rather
      // than draining further.
      if (isAborted(signal)) {
        throw new M3LOperationAbortedError();
      }
    }
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // best-effort: the underlying SDK stream's own teardown is leaky,
      // and a failing return() must not shadow the primary outcome above.
    }
  }

  // Unconditional — independent of hasYielded, unlike the collapse in
  // classifyIterationFault. Fires even at eventsEmitted === 0 (the
  // zero-event drain), in which case retrySafe is true: nothing reached
  // the caller yet, so re-invoking duplicates nothing. Any eventsEmitted
  // >= 1 here means a retry would duplicate already-delivered output, so
  // retrySafe is false.
  if (!buffer.hasStopReason || !buffer.hasUsage) {
    throw new M3LBedrockRuntimeStreamError(
      `stream for model ${modelId} ended without delivering both messageStop and metadata`,
      { modelId, eventsEmitted, retrySafe: eventsEmitted === 0 },
    );
  }

  return undefined;
}

/**
 * Streams one `ConverseStream` request for a single model: requests it
 * (see {@link requestStream}), then drains the resulting stream (see
 * {@link drainStream}). `yield*`-delegated from {@link invokeStream}, so a
 * caller `break`/`.return()` forwards automatically down into
 * `drainStream`'s own `finally`, which best-effort calls `.return()` on
 * the underlying SDK iterator (the SDK's own teardown does not forward
 * this itself — see the reference page's "underlying connection release"
 * note).
 *
 * @returns `undefined` on a clean, fully-fused drain (this model served
 *   the whole request). `{ type: "advance", cause }` only when
 *   `hasYielded` was still `false` at the point of fault — the caller
 *   advances to the next model. Full `@throws` detail: {@link invokeStream}.
 */
async function* attemptStream(
  client: BedrockRuntimeClient,
  modelId: string,
  request: M3LBedrockInvokeRequest,
  signal: AbortSignal | undefined,
): AsyncGenerator<M3LBedrockStreamEvent, StreamAttemptOutcome, void> {
  const requested = await requestStream(client, modelId, request, signal);
  if (requested.type === "advance") {
    return requested;
  }
  return yield* drainStream(requested.stream, modelId, signal);
}

/**
 * Streams one `ConverseStream` request, walking `models` in order on a
 * pre-first-yield availability fault until one model fully serves the
 * request or every model is exhausted. This is
 * {@link M3LBedrockRuntimeOperations.invokeStream}'s entire implementation
 * — the class method is a one-line `yield*` delegation into this function.
 * An `async function*`: calling it synchronously returns a generator and
 * performs no I/O yet — model selection, `client.send()`, and every fault
 * surface only once the caller starts iterating (the first
 * `.next()`/`for await`).
 *
 * @param client - The already-provisioned `BedrockRuntimeClient`.
 * @param models - The ordered model-id fallback list.
 * @param request - The conversation messages, optional system prompt, and
 *   optional inference tuning.
 * @param options - Optional `signal` for cooperative cancellation.
 * @returns An `AsyncGenerator` yielding {@link M3LBedrockStreamEvent}s —
 *   exactly one `message-start` (before any text), zero or more
 *   `text-delta`, and exactly one `message-stop`, last. There is no
 *   error-shaped event; every fault below is a rejection of `.next()`.
 * @throws {@link M3LBedrockRuntimeOperationError} For a transport/API-call
 *   failure not covered by the other error classes, a malformed-but-
 *   successful `send()` response (`stream === undefined`), or a malformed
 *   terminal `stopReason`/`usage` value — never retried or fallen back
 *   from, even after events have already been yielded to the caller.
 * @throws {@link M3LBedrockRuntimeModelError} When the serving model
 *   itself faults on this specific input (`ModelErrorException`/
 *   `ModelStreamErrorException`), on either side of the `hasYielded`
 *   commit boundary.
 * @throws {@link M3LBedrockRuntimeNoModelError} When every model in the
 *   fallback order is exhausted by a pre-first-yield availability fault.
 * @throws {@link M3LBedrockRuntimeStreamError} For two distinct cases: (1)
 *   a streaming-lifecycle fault once at least one event has already been
 *   yielded to the caller — past that point retry and fallback are both
 *   retired, since falling back would silently start a second, unrelated
 *   generation appended to a half-delivered reply (`retrySafe: false`);
 *   and (2), **unconditionally, independent of `hasYielded`**, a stream
 *   that drains cleanly without ever fusing a `message-stop` event,
 *   including the zero-event case (`retrySafe: true` only there).
 * @throws {@link M3LOperationAbortedError} When `options.signal` aborts
 *   before the initial `send()`, during a same-model retry backoff,
 *   between fallback attempts, while awaiting the next stream chunk, or
 *   immediately after a `yield` resumes. The mid-stream check is
 *   order-reversed from `invoke`'s: `isAborted(signal)` is tested first,
 *   before any name-based classification, since a destroyed socket
 *   post-`send()` is not reliably `AbortError`-shaped.
 */
export async function* invokeStream(
  client: BedrockRuntimeClient,
  models: readonly string[],
  request: M3LBedrockInvokeRequest,
  options?: M3LBedrockInvokeOptions,
): AsyncGenerator<M3LBedrockStreamEvent, void, void> {
  const signal = options?.signal;
  const attemptedModels: string[] = [];
  let lastCause: unknown;
  let hasLastCause = false;

  for (const modelId of models) {
    if (isAborted(signal)) {
      throw new M3LOperationAbortedError();
    }
    attemptedModels.push(modelId);

    const outcome = yield* attemptStream(client, modelId, request, signal);
    if (outcome === undefined) {
      // Fully drained: the fused message-stop event was already yielded.
      return;
    }

    // outcome.type === "advance": track the most recent fault so it can
    // chain into M3LBedrockRuntimeNoModelError's cause on exhaustion.
    lastCause = outcome.cause;
    hasLastCause = true;

    // Re-check abort before trying the next model — an abort mid-fallback
    // must stop the walk entirely.
    if (isAborted(signal)) {
      throw new M3LOperationAbortedError();
    }
  }

  throw new M3LBedrockRuntimeNoModelError(
    "every model in the fallback list was exhausted",
    {
      attemptedModels,
      ...(hasLastCause && { cause: lastCause }),
    },
  );
}
