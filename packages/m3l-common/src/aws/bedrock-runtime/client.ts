/**
 * `aws/bedrock-runtime/client` — {@link M3LBedrockRuntimeOperations}, a typed
 * wrapper over the Amazon Bedrock `Converse` API so callers never import
 * `@aws-sdk/client-bedrock-runtime` command classes or touch its `Converse*`
 * types directly. See ADR-0059 for why this module exists and its scope
 * boundary against V5 (tool-use loop primitives).
 *
 * @packageDocumentation
 */

import {
  ConverseCommand,
  type BedrockRuntimeClient,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";

import { M3LOperationAbortedError } from "../../core/errors/index.js";
import { M3LBackoff } from "../../core/polling/M3LBackoff.js";
import { combineClassifiers } from "../../core/polling/classifiers.js";
import { M3LRetryRunner } from "../../core/polling/M3LRetryRunner.js";
import type { M3LRetryClassifier } from "../../core/polling/M3LRetryRunner.js";

import {
  M3LBedrockRuntimeModelError,
  M3LBedrockRuntimeNoModelError,
  M3LBedrockRuntimeOperationError,
} from "./error.js";
import type {
  M3LBedrockContentBlock,
  M3LBedrockInvocationResult,
  M3LBedrockInvokeOptions,
  M3LBedrockInvokeRequest,
  M3LBedrockMessage,
  M3LBedrockRuntimeOptions,
  M3LBedrockRuntimeRole,
  M3LBedrockStopReason,
} from "./types.js";

/** Retry-runner backoff tuning: 200ms start, 5s cap (matches `M3LPollingPolicies.awsThrottling()`). */
const RETRY_START_MS = 200;
const RETRY_CAP_MS = 5_000;

/** SDK exception names retried on the same model via {@link buildRetryRunner}. */
const SAME_MODEL_RETRY_NAMES: ReadonlySet<string> = new Set([
  "ThrottlingException",
  "InternalServerException",
]);

/** SDK exception names that advance fallback immediately — no same-model retry. */
const ADVANCE_FALLBACK_NAMES: ReadonlySet<string> = new Set([
  "ModelNotReadyException",
  "ModelTimeoutException",
  "ServiceUnavailableException",
]);

/** SDK exception names that surface as a caller/permission fault, no retry, no fallback. */
const CALLER_FAULT_NAMES: ReadonlySet<string> = new Set([
  "ValidationException",
  "AccessDeniedException",
  "ResourceNotFoundException",
  "ServiceQuotaExceededException",
]);

/**
 * The nine canonical {@link M3LBedrockStopReason} members, as a `Record`
 * rather than a hand-listed array — mirroring `internal/logging/levels.ts`'s
 * `LOG_LEVEL_FLOOR_MEMBERS` idiom. This makes the vocabulary a
 * **compile-time exhaustiveness check**: widening or narrowing
 * `M3LBedrockStopReason` without updating this object is a missing- or
 * excess-property TS error here, not a silent runtime drift between the type
 * and the set actually validated against.
 */
const STOP_REASON_MEMBERS: Record<M3LBedrockStopReason, true> = {
  end_turn: true,
  tool_use: true,
  max_tokens: true,
  stop_sequence: true,
  guardrail_intervened: true,
  content_filtered: true,
  malformed_tool_use: true,
  malformed_model_output: true,
  model_context_window_exceeded: true,
};

/**
 * Fast membership lookup for the closed {@link M3LBedrockStopReason}
 * vocabulary. AWS's Smithy enums are open at the wire level, so a
 * `stopReason` outside this set is a genuinely unexpected AWS response
 * shape, not a client-side type error — see `mapConverseResponse`.
 */
const STOP_REASON_LOOKUP: ReadonlySet<string> = new Set(
  Object.keys(STOP_REASON_MEMBERS),
);

/**
 * Returns `true` when `signal` is defined and has fired. A named function
 * rather than an inline `signal?.aborted` check prevents TypeScript's
 * control-flow narrowing from producing a TS2367 false-alarm on a second
 * check that follows an `await` (matches `aws/athena/client.ts`).
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** Reads `err.name` when `err` is an `Error`-shaped value, `undefined` otherwise. */
function readErrorName(err: unknown): string | undefined {
  return err instanceof Error ? err.name : undefined;
}

/**
 * Classifies a thrown value by SDK exception `name`: retriable exactly for
 * {@link SAME_MODEL_RETRY_NAMES}, `"unknown"` for everything else — including
 * names this module's own catch-based classification handles by advancing
 * fallback or throwing directly (never `"fatal"` here — the runner's own
 * `unknownDecision: "fatal"` is what actually stops the runner and rethrows
 * the original error unchanged).
 */
const bedrockSameModelRetryClassifier: M3LRetryClassifier = (err: unknown) => {
  const name = readErrorName(err);
  return name !== undefined && SAME_MODEL_RETRY_NAMES.has(name)
    ? "retriable"
    : "unknown";
};

/**
 * Builds a fresh {@link M3LRetryRunner} for one Converse `send()` attempt,
 * so `signal` can be threaded per call (matching `aws/athena/client.ts`'s
 * per-call runner pattern). Retries only `ThrottlingException`/
 * `InternalServerException` by name, over the same backoff as
 * `M3LPollingPolicies.awsThrottling()` — deliberately NOT that policy's
 * broader status-code classifier, which would incorrectly retry a 503
 * `ServiceUnavailableException` on the same model (see
 * `docs/reference/aws/bedrock-runtime.md`'s "Retry classifier note").
 */
function buildRetryRunner(signal: AbortSignal | undefined): M3LRetryRunner {
  return new M3LRetryRunner({
    classifier: combineClassifiers(bedrockSameModelRetryClassifier),
    backoff: M3LBackoff.exponentialJittered(RETRY_START_MS, RETRY_CAP_MS),
    unknownDecision: "fatal",
    ...(signal !== undefined && { signal }),
  });
}

/** Converts a {@link M3LBedrockMessage} into the shape `ConverseCommandInput.messages` expects. */
function toSdkMessage(message: M3LBedrockMessage): {
  role: M3LBedrockRuntimeRole;
  content: { text: string }[];
} {
  return {
    role: message.role,
    content: message.content.map((block) => ({ text: block.text })),
  };
}

/**
 * Builds the `ConverseCommand` for one model attempt. `system` and
 * `inferenceConfig` are included only when present on `request` — a
 * conditional spread, never a key set to `undefined`
 * (`exactOptionalPropertyTypes` convention). `inferenceConfig.stopSequences`
 * is copied into a fresh mutable array since the SDK's field is
 * `string[] | undefined`, not `readonly string[]`.
 */
function buildConverseCommand(
  modelId: string,
  request: M3LBedrockInvokeRequest,
): ConverseCommand {
  const inferenceConfig = request.inferenceConfig;
  return new ConverseCommand({
    modelId,
    messages: request.messages.map(toSdkMessage),
    ...(request.system !== undefined && {
      system: [{ text: request.system }],
    }),
    ...(inferenceConfig !== undefined && {
      inferenceConfig: {
        ...(inferenceConfig.maxTokens !== undefined && {
          maxTokens: inferenceConfig.maxTokens,
        }),
        ...(inferenceConfig.temperature !== undefined && {
          temperature: inferenceConfig.temperature,
        }),
        ...(inferenceConfig.topP !== undefined && {
          topP: inferenceConfig.topP,
        }),
        ...(inferenceConfig.stopSequences !== undefined && {
          stopSequences: [...inferenceConfig.stopSequences],
        }),
      },
    }),
  });
}

/**
 * Maps a response `role` to {@link M3LBedrockRuntimeRole}. The SDK's
 * `ConversationRole` also carries `"system"` (request-only in practice); any
 * value other than `"user"` maps to `"assistant"`, the only other member of
 * this V4 slice's role vocabulary.
 */
function mapRole(role: string | undefined): M3LBedrockRuntimeRole {
  return role === "user" ? "user" : "assistant";
}

/**
 * Filters a response message's content blocks down to text blocks, dropping
 * (never throwing on) any non-`text` member — the model's reply is external
 * data, not a caller mistake, so a future non-text member is tolerated
 * rather than rejected. See `docs/reference/aws/bedrock-runtime.md`'s
 * "Non-text content blocks in a reply" note.
 */
function mapContent(
  content: readonly { readonly text?: string }[] | undefined,
): M3LBedrockContentBlock[] {
  const blocks: M3LBedrockContentBlock[] = [];
  for (const block of content ?? []) {
    if (typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
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
    usage.totalTokens === undefined ||
    !STOP_REASON_LOOKUP.has(stopReason)
  ) {
    throw new M3LBedrockRuntimeOperationError(
      `Converse response for model ${modelId} was missing output/stopReason/usage`,
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
 * Classifies a `client.send()` rejection (after any same-model retry has
 * exhausted) into either advancing fallback (returning the fault as the
 * advance cause), or throwing one of this module's typed errors immediately.
 * See the fault-handling table in `docs/reference/aws/bedrock-runtime.md`.
 *
 * `ThrottlingException`/`InternalServerException` reach this function only
 * after {@link buildRetryRunner}'s retries are exhausted — that exhaustion
 * always advances fallback, never throws
 * {@link M3LBedrockRuntimeOperationError} (see the doc's "highest-value
 * regression" test).
 *
 * @returns `error` unchanged, for the two advance-fallback tiers — the
 *   caller threads it through as {@link M3LBedrockRuntimeNoModelError}'s
 *   `cause` on eventual fallback exhaustion.
 * @throws {@link M3LBedrockRuntimeModelError} For `ModelErrorException`.
 * @throws {@link M3LBedrockRuntimeOperationError} For a caller/permission
 *   fault or any other unclassified rejection.
 */
function classifySendFailure(error: unknown, modelId: string): unknown {
  const name = readErrorName(error);

  if (name !== undefined && SAME_MODEL_RETRY_NAMES.has(name)) {
    return error;
  }
  if (name !== undefined && ADVANCE_FALLBACK_NAMES.has(name)) {
    return error;
  }
  if (name === "ModelErrorException") {
    throw new M3LBedrockRuntimeModelError(
      `model ${modelId} faulted while processing the request`,
      { modelId, cause: error },
    );
  }
  if (name !== undefined && CALLER_FAULT_NAMES.has(name)) {
    throw new M3LBedrockRuntimeOperationError(
      `Converse request rejected for model ${modelId}`,
      { cause: error, origin: "caller", retryable: false },
    );
  }
  throw new M3LBedrockRuntimeOperationError(
    `Converse request failed for model ${modelId}`,
    { cause: error },
  );
}

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
   * @param request - The conversation messages, optional system prompt, and
   *   optional inference tuning.
   * @param options - Optional `signal` for cooperative cancellation.
   * @returns The mapped result from whichever model actually served the
   *   request.
   * @throws {@link M3LBedrockRuntimeOperationError} For a transport/API-call
   *   failure not covered by the other two error classes, or a
   *   malformed-but-successful response.
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
    request: M3LBedrockInvokeRequest,
    options?: M3LBedrockInvokeOptions,
  ): Promise<M3LBedrockInvocationResult> {
    const signal = options?.signal;
    const attemptedModels: string[] = [];
    let lastCause: unknown;
    let hasLastCause = false;

    for (const modelId of this.#models) {
      if (isAborted(signal)) {
        throw new M3LOperationAbortedError();
      }
      attemptedModels.push(modelId);

      const outcome = await this.#invokeOnModel(modelId, request, signal);
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
    signal: AbortSignal | undefined,
  ): Promise<ModelAttemptOutcome> {
    const command = buildConverseCommand(modelId, request);
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
      if (isAborted(signal)) {
        throw new M3LOperationAbortedError();
      }
      const cause = classifySendFailure(error, modelId);
      return { type: "advance", cause };
    }

    return { type: "success", result: mapConverseResponse(response, modelId) };
  }
}
