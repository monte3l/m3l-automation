/**
 * `aws/bedrock-runtime/client` — {@link M3LBedrockRuntimeOperations}, a typed
 * wrapper over the Amazon Bedrock `Converse` API so callers never import
 * `@aws-sdk/client-bedrock-runtime` command classes or touch its `Converse*`
 * types directly. See ADR-0059 for why this module exists and its scope
 * boundary against V5 (tool-use loop primitives).
 *
 * `invoke()`'s single-shot request/response mapping lives here in full;
 * `invokeStream()` is a thin delegation into `stream.ts`'s exported
 * `invokeStream` function, which holds the entire streaming implementation
 * (kept in a separate file per ADR-0072's per-file size ratchet). Machinery
 * genuinely shared by both — abort-signal helpers, the SDK exception-`name`
 * classifier, the retry-runner construction, and the request-mapping
 * helpers — lives in `shared.ts`, imported by both this file and
 * `stream.ts` (see `shared.ts`'s own doc comment for why `stream.ts` cannot
 * import from this file directly).
 *
 * @packageDocumentation
 */

import {
  ConverseCommand,
  type BedrockRuntimeClient,
  type ConverseCommandOutput,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";

import { M3LOperationAbortedError } from "../../core/errors/index.js";

import {
  M3LBedrockRuntimeNoModelError,
  M3LBedrockRuntimeOperationError,
} from "./error.js";
import {
  buildConverseInput,
  buildRetryRunner,
  classifySendFailure,
  isAborted,
  isAbortError,
  mapRole,
  STOP_REASON_LOOKUP,
} from "./shared.js";
import { invokeStream as invokeStreamImpl } from "./stream.js";
import { buildToolConfig, mapToolUseBlock } from "./tools.js";
import type {
  M3LBedrockContentBlock,
  M3LBedrockInvocationResult,
  M3LBedrockInvokeOptions,
  M3LBedrockInvokeRequest,
  M3LBedrockRuntimeOptions,
  M3LBedrockStreamEvent,
  M3LBedrockToolInvokeRequest,
} from "./types.js";

/** Builds the `ConverseCommand` for one model attempt. See `shared.ts`'s `buildConverseInput`. */
function buildConverseCommand(
  modelId: string,
  request: M3LBedrockInvokeRequest,
  toolConfig: ToolConfiguration | undefined,
): ConverseCommand {
  return new ConverseCommand(buildConverseInput(modelId, request, toolConfig));
}

/**
 * Maps a response message's content blocks onto {@link M3LBedrockContentBlock},
 * keeping both `text` and well-formed `toolUse` blocks (V4 dropped every
 * non-`text` member; V5 keeps `toolUse` since `result.message.content` is the
 * caller's input to the tool-use loop). Any other block this wrapper cannot
 * represent — including a malformed `toolUse` (missing/non-string
 * `toolUseId`/`name`) — is dropped rather than thrown on: the model's reply
 * is external data, not a caller mistake. See
 * `docs/reference/aws/bedrock-runtime.md`'s "Unrepresentable content blocks
 * in a reply" note for the drop-vs-refuse rule.
 *
 * @throws {@link M3LBedrockRuntimeOperationError} When a `toolUse` block
 *   carries the SDK marker `type: "server_tool_use"` (see `tools.ts`'s
 *   `mapToolUseBlock`) — Bedrock already executed that tool server-side, so
 *   mapping it would risk a second, duplicate execution.
 */
function mapContent(
  content:
    | readonly { readonly text?: string; readonly toolUse?: unknown }[]
    | undefined,
): M3LBedrockContentBlock[] {
  const blocks: M3LBedrockContentBlock[] = [];
  for (const block of content ?? []) {
    if (typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    const toolUse = mapToolUseBlock(block);
    if (toolUse !== undefined) {
      blocks.push(toolUse);
    }
  }
  return blocks;
}

/**
 * Maps a successful `ConverseCommandOutput` onto {@link M3LBedrockInvocationResult}.
 *
 * @throws {@link M3LBedrockRuntimeOperationError} When `output`/`stopReason`/
 *   `usage` is missing, `output` matches the `$UnknownMember` arm rather than
 *   carrying a `message` (a malformed-but-HTTP-successful response), or
 *   `stopReason` is not one of the nine documented
 *   {@link M3LBedrockStopReason} members — AWS's Smithy enums are open at the
 *   wire level, so a future SDK/service value is not a client-side type
 *   error, but it is still a shape this wrapper refuses to silently admit
 *   into a type callers switch on exhaustively.
 */
function mapConverseResponse(
  response: ConverseCommandOutput,
  modelId: string,
): M3LBedrockInvocationResult {
  const message = response.output?.message;
  const stopReason = response.stopReason;
  const usage = response.usage;

  if (
    message === undefined ||
    stopReason === undefined ||
    usage === undefined ||
    usage.inputTokens === undefined ||
    usage.outputTokens === undefined ||
    usage.totalTokens === undefined
  ) {
    throw new M3LBedrockRuntimeOperationError(
      `Converse response for model ${modelId} was missing output/stopReason/usage`,
    );
  }

  if (!STOP_REASON_LOOKUP.has(stopReason)) {
    throw new M3LBedrockRuntimeOperationError(
      `Converse response for model ${modelId} had an unrecognized stopReason`,
    );
  }

  return {
    modelId,
    message: {
      role: mapRole(message.role),
      content: mapContent(message.content),
    },
    stopReason: stopReason,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    },
  };
}

/** The outcome of one model attempt: a mapped result, or a signal to advance fallback. */
type ModelAttemptOutcome =
  | { readonly type: "success"; readonly result: M3LBedrockInvocationResult }
  | { readonly type: "advance"; readonly cause: unknown };

/**
 * Typed wrapper over the Amazon Bedrock Converse API
 * (`M3LBedrockRuntimeOperations.invoke`), translating request/response
 * shapes into plain, library-owned types (see `aws/bedrock-runtime/types`) so
 * a caller never imports `@aws-sdk/client-bedrock-runtime`.
 *
 * Wraps an already-provisioned `BedrockRuntimeClient` — obtain one from
 * `script.aws.clients.bedrockRuntime` and inject it here, along with an
 * ordered model-id fallback list; this class never constructs its own client
 * from a profile/region, and — unlike every other `AWSServiceProvider.*`
 * wrapper — has no cached convenience getter, since the fallback list is
 * inherently caller-specific configuration.
 *
 * @example
 * ```ts
 * import type { M3LScript } from "@m3l-automation/m3l-common/core";
 * import { M3LBedrockRuntimeOperations } from "@m3l-automation/m3l-common/aws";
 *
 * export async function run(script: M3LScript): Promise<void> {
 *   const ops = new M3LBedrockRuntimeOperations(
 *     script.aws.clients.bedrockRuntime,
 *     { models: ["anthropic.claude-opus-5", "anthropic.claude-sonnet-5"] },
 *   );
 *   const result = await ops.invoke({
 *     messages: [
 *       { role: "user", content: [{ type: "text", text: "Summarize this run." }] },
 *     ],
 *   });
 *   script.logger.info("model replied", { stopReason: result.stopReason });
 * }
 * ```
 */
export class M3LBedrockRuntimeOperations {
  readonly #client: BedrockRuntimeClient;
  readonly #models: readonly string[];

  /**
   * Creates a new `M3LBedrockRuntimeOperations`.
   *
   * @param client - An already-provisioned `BedrockRuntimeClient`, typically
   *   `script.aws.clients.bedrockRuntime`.
   * @param options - `{ models }`, an ordered, non-empty model-id fallback
   *   list; `models[0]` is the primary model id.
   * @throws {@link M3LBedrockRuntimeNoModelError} When `models` is empty —
   *   a caller/config error, not deferred to the first `invoke` call.
   */
  constructor(client: BedrockRuntimeClient, options: M3LBedrockRuntimeOptions) {
    if (options.models.length === 0) {
      throw new M3LBedrockRuntimeNoModelError(
        "M3LBedrockRuntimeOperations requires a non-empty models list",
        { attemptedModels: [] },
      );
    }
    this.#client = client;
    this.#models = options.models;
  }

  /**
   * Sends one `Converse` request, walking `models[]` in order on an
   * availability fault until one succeeds or every model is exhausted.
   *
   * @param request - The conversation messages, optional system prompt,
   *   optional inference tuning, and (V5) optional `tools`/`toolChoice`.
   * @param options - Optional `signal` for cooperative cancellation.
   * @returns The mapped result from whichever model actually served the
   *   request.
   * @throws {@link M3LBedrockRuntimeOperationError} For a transport/API-call
   *   failure not covered by the other two error classes, a
   *   malformed-but-successful response, or one of the two documented
   *   caller errors for a malformed `tools`/`toolChoice` combination (see
   *   `tools.ts`'s `buildToolConfig`) — request-shape validation runs
   *   **before** the `AbortSignal` check below, so a malformed request is
   *   refused even under an already-aborted signal.
   * @throws {@link M3LBedrockRuntimeModelError} When the serving model itself
   *   faults on this specific input (`ModelErrorException`).
   * @throws {@link M3LBedrockRuntimeNoModelError} When every model in the
   *   fallback order is exhausted by availability faults.
   * @throws {@link M3LOperationAbortedError} When `options.signal` aborts
   *   before the initial `send()`, during a same-model retry backoff, or
   *   between fallback attempts. The fallback walk stops immediately — it
   *   never advances to the next model on abort.
   */
  async invoke(
    request: M3LBedrockToolInvokeRequest,
    options?: M3LBedrockInvokeOptions,
  ): Promise<M3LBedrockInvocationResult> {
    // Validated and built once, up front — before the AbortSignal check
    // below and before any model is attempted — so both documented caller
    // errors (`toolChoice` without `tools`, or naming a tool absent from
    // `tools`) are never promoted to M3LOperationAbortedError under an
    // already-aborted signal, and never depend on which model is tried
    // first.
    const toolConfig = buildToolConfig(request);
    const signal = options?.signal;
    const attemptedModels: string[] = [];
    let lastCause: unknown;
    let hasLastCause = false;

    for (const modelId of this.#models) {
      if (isAborted(signal)) {
        throw new M3LOperationAbortedError();
      }
      attemptedModels.push(modelId);

      const outcome = await this.#invokeOnModel(
        modelId,
        request,
        toolConfig,
        signal,
      );
      if (outcome.type === "success") {
        return outcome.result;
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

  /**
   * Sends one `Converse` request for a single model, retrying
   * `ThrottlingException`/`InternalServerException` on the same model before
   * either mapping a successful response or signaling the caller to advance
   * fallback.
   *
   * @throws {@link M3LOperationAbortedError} When `signal` aborted during the
   *   `send()`/retry attempt.
   * @throws {@link M3LBedrockRuntimeModelError} For `ModelErrorException`.
   * @throws {@link M3LBedrockRuntimeOperationError} For a caller/permission
   *   fault, any other unclassified rejection, or a malformed-but-successful
   *   response.
   */
  async #invokeOnModel(
    modelId: string,
    request: M3LBedrockInvokeRequest,
    toolConfig: ToolConfiguration | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ModelAttemptOutcome> {
    const command = buildConverseCommand(modelId, request, toolConfig);
    const runner = buildRetryRunner(signal);

    let response: ConverseCommandOutput;
    try {
      response = await runner.run(() =>
        signal !== undefined
          ? this.#client.send(command, { abortSignal: signal })
          : this.#client.send(command),
      );
    } catch (error) {
      if (error instanceof M3LOperationAbortedError) throw error;
      if (isAborted(signal) && isAbortError(error)) {
        throw new M3LOperationAbortedError();
      }
      const cause = classifySendFailure(error, modelId);
      return { type: "advance", cause };
    }

    return { type: "success", result: mapConverseResponse(response, modelId) };
  }

  /**
   * Streams one `ConverseStream` request, walking `models[]` in order on a
   * pre-first-yield availability fault until one model fully serves the
   * request or every model is exhausted. An `async function*`: calling it
   * synchronously returns a generator and performs no I/O yet — model
   * selection, `client.send()`, and every fault surface only once the
   * caller starts iterating (the first `.next()`/`for await`). The entire
   * implementation lives in `stream.ts`'s `invokeStream` — this method is a
   * one-line `yield*` delegation into it.
   *
   * @param request - The conversation messages, optional system prompt, and
   *   optional inference tuning.
   * @param options - Optional `signal` for cooperative cancellation.
   * @returns An `AsyncGenerator` yielding {@link M3LBedrockStreamEvent}s —
   *   exactly one `message-start` (before any text), zero or more
   *   `text-delta`, and exactly one `message-stop`, last. There is no
   *   error-shaped event; every fault below is a rejection of `.next()`.
   * @throws {@link M3LBedrockRuntimeOperationError} For a transport/API-call
   *   failure not covered by the other error classes, a malformed-but-
   *   successful `send()` response (`stream === undefined`), a malformed
   *   terminal `stopReason`/`usage` value, or — checked first, before model
   *   selection — a structurally-typed `request` that carries `tools`/
   *   `toolChoice` anyway (`origin: caller`, `retryable: false`; see the
   *   module doc's scope-boundary note). Never retried or fallen back
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
   * @example
   * ```ts
   * let reply = "";
   * for await (const event of ops.invokeStream({
   *   messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
   * })) {
   *   if (event.type === "text-delta") reply += event.text;
   * }
   * ```
   */
  async *invokeStream(
    request: M3LBedrockInvokeRequest,
    options?: M3LBedrockInvokeOptions,
  ): AsyncGenerator<M3LBedrockStreamEvent, void, void> {
    if (hasToolConfig(request)) {
      throw new M3LBedrockRuntimeOperationError(
        "invokeStream does not support tools/toolChoice — streaming tool-use is out of scope for V5; use invoke() instead",
        { origin: "caller", retryable: false },
      );
    }
    yield* invokeStreamImpl(this.#client, this.#models, request, options);
  }
}

/**
 * Returns `true` when `request` carries an own `tools` or `toolChoice`
 * property, even though its declared type is the narrower
 * {@link M3LBedrockInvokeRequest} (which has neither field). This guard is
 * load-bearing, not decorative: a compile probe confirmed that TypeScript's
 * structural typing rejects a tool-bearing **object literal** passed
 * directly to `invokeStream` (an excess-property error — see the dedicated
 * `@ts-expect-error` test), but still **admits** a structurally-typed
 * non-literal `M3LBedrockToolInvokeRequest` value assigned through a
 * variable or a downcast, since structural width subtyping only rejects
 * excess properties on literals. Without this runtime check, that
 * non-literal case would silently reach `stream.ts` and have its
 * `tools`/`toolChoice` fields dropped mid-stream rather than refused.
 */
function hasToolConfig(request: M3LBedrockInvokeRequest): boolean {
  return (
    Object.hasOwn(request, "tools") || Object.hasOwn(request, "toolChoice")
  );
}
