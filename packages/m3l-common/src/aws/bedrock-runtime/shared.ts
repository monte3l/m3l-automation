/**
 * `aws/bedrock-runtime/shared` — machinery genuinely shared by both
 * `client.ts` (`M3LBedrockRuntimeOperations.invoke`) and `stream.ts`
 * (`invokeStream`'s implementation): abort-signal helpers, the SDK
 * exception-`name` classifier, the retry-runner construction, the
 * `ConverseCommandInput`/`ConverseStreamCommandInput`-shared request
 * mapping, and the closed {@link M3LBedrockStopReason} membership check.
 *
 * Split out as its own leaf module (rather than living in `client.ts`, with
 * `stream.ts` importing from it) specifically to avoid a `client.ts` ⇄
 * `stream.ts` circular import: `client.ts` imports `stream.ts`'s
 * `invokeStream` for `M3LBedrockRuntimeOperations.invokeStream()`'s thin
 * delegation, so `stream.ts` cannot also import from `client.ts`
 * (`import-x/no-cycle`, `maxDepth: Infinity`, is a hard repo-wide gate).
 * Internal module — nothing here is re-exported through
 * `aws/bedrock-runtime/index`.
 *
 * @packageDocumentation
 */

import type { ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";

import { M3LBackoff } from "../../core/polling/M3LBackoff.js";
import { combineClassifiers } from "../../core/polling/classifiers.js";
import { M3LRetryRunner } from "../../core/polling/M3LRetryRunner.js";
import type { M3LRetryClassifier } from "../../core/polling/M3LRetryRunner.js";

import {
  M3LBedrockRuntimeModelError,
  M3LBedrockRuntimeOperationError,
} from "./error.js";
import { copyDocument } from "./tools.js";
import type { M3LBedrockPlainDocument } from "./tools.js";
import type {
  M3LBedrockContentBlock,
  M3LBedrockInvokeRequest,
  M3LBedrockMessage,
  M3LBedrockRuntimeRole,
  M3LBedrockStopReason,
  M3LBedrockToolResultContent,
  M3LBedrockToolResultStatus,
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
 * shape, not a client-side type error — see `client.ts`'s
 * `mapConverseResponse` and `stream.ts`'s `isKnownStopReason`.
 */
export const STOP_REASON_LOOKUP: ReadonlySet<string> = new Set(
  Object.keys(STOP_REASON_MEMBERS),
);

/**
 * Returns `true` when `signal` is defined and has fired. A named function
 * rather than an inline `signal?.aborted` check prevents TypeScript's
 * control-flow narrowing from producing a TS2367 false-alarm on a second
 * check that follows an `await` (matches `aws/athena/client.ts`).
 */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Returns `true` when `err` is an `AbortError` thrown by the AWS SDK when
 * an `abortSignal` fires during an in-flight `send()`.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** Reads `err.name` when `err` is an `Error`-shaped value, `undefined` otherwise. */
export function readErrorName(err: unknown): string | undefined {
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
export function buildRetryRunner(
  signal: AbortSignal | undefined,
): M3LRetryRunner {
  return new M3LRetryRunner({
    classifier: combineClassifiers(bedrockSameModelRetryClassifier),
    backoff: M3LBackoff.exponentialJittered(RETRY_START_MS, RETRY_CAP_MS),
    unknownDecision: "fatal",
    ...(signal !== undefined && { signal }),
  });
}

/**
 * The shape one mapped {@link M3LBedrockContentBlock} takes in
 * `ConverseCommandInput.messages[].content` — a 3-arm union mirroring the
 * SDK's `ContentBlock`'s `text`/`toolUse`/`toolResult` members exactly (see
 * `types.ts`'s "Why the tool discriminants are camelCase" note). Declared
 * locally, rather than importing the SDK's own `ContentBlock`, so this
 * module states exactly the subset it produces.
 */
type SdkContentItem =
  | { readonly text: string }
  | {
      readonly toolUse: {
        readonly toolUseId: string;
        readonly name: string;
        readonly input: M3LBedrockPlainDocument;
      };
    }
  | {
      readonly toolResult: {
        readonly toolUseId: string;
        // NOT `readonly (...)[]` — the SDK's `ToolResultBlock.content` field
        // is a plain mutable array (`ToolResultContentBlock[] | undefined`);
        // a `readonly` array type is not assignable to it, and this literal
        // is what `client.ts`/`stream.ts` hand straight to `new
        // ConverseCommand(...)`.
        readonly content: (
          { readonly text: string } | { readonly json: M3LBedrockPlainDocument }
        )[];
        readonly status?: M3LBedrockToolResultStatus;
      };
    };

/**
 * Maps one {@link M3LBedrockToolResultContent} member to the SDK's
 * `ToolResultContentBlock` shape, recursively copying a `json` payload — see
 * `tools.ts`'s `copyDocument`.
 */
function mapToolResultContentItem(
  item: M3LBedrockToolResultContent,
): { readonly text: string } | { readonly json: M3LBedrockPlainDocument } {
  switch (item.type) {
    case "text":
      return { text: item.text };
    case "json":
      return { json: copyDocument(item.json, 0) };
    default: {
      const exhaustive: never = item;
      throw new M3LBedrockRuntimeOperationError(
        `unhandled tool-result content type: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * Maps one {@link M3LBedrockContentBlock} to `ConverseCommandInput`'s
 * per-block shape. An exhaustive `switch` over the 3-member union — adding
 * a fourth member becomes a compile error here, not a silent drop.
 *
 * `toolUse.input` is forwarded exactly as supplied (a cast to
 * {@link M3LBedrockPlainDocument}, never a recursive copy) — the doc's
 * recursive-copy rule names only `inputSchema` and a `json` tool-result
 * payload, not `toolUse.input`. `toolResult.status` is included only when
 * present (a conditional spread, never a key set to `undefined` —
 * `exactOptionalPropertyTypes`).
 */
function mapContentBlockToSdk(block: M3LBedrockContentBlock): SdkContentItem {
  switch (block.type) {
    case "text":
      return { text: block.text };
    case "toolUse":
      return {
        toolUse: {
          toolUseId: block.toolUseId,
          name: block.name,
          input: block.input as M3LBedrockPlainDocument,
        },
      };
    case "toolResult":
      return {
        toolResult: {
          toolUseId: block.toolUseId,
          content: block.content.map(mapToolResultContentItem),
          ...(block.status !== undefined && { status: block.status }),
        },
      };
    default: {
      const exhaustive: never = block;
      throw new M3LBedrockRuntimeOperationError(
        `unhandled content block type: ${String(exhaustive)}`,
      );
    }
  }
}

/** Converts a {@link M3LBedrockMessage} into the shape `ConverseCommandInput.messages` expects. */
function toSdkMessage(message: M3LBedrockMessage): {
  role: M3LBedrockRuntimeRole;
  content: SdkContentItem[];
} {
  return {
    role: message.role,
    content: message.content.map(mapContentBlockToSdk),
  };
}

/**
 * Shape shared by `ConverseCommandInput` and `ConverseStreamCommandInput`
 * for this slice — both request types are field-identical for the
 * `modelId`/`messages`/`system`/`inferenceConfig`/`toolConfig` surface this
 * wrapper exposes. `toolConfig` is only ever populated by `client.ts`
 * (`invoke`'s `M3LBedrockToolInvokeRequest`) — `stream.ts` never supplies
 * one, since `invokeStream` keeps the narrower V4 request type.
 */
export interface ConverseInput {
  readonly modelId: string;
  readonly messages: {
    role: M3LBedrockRuntimeRole;
    content: SdkContentItem[];
  }[];
  readonly system?: { text: string }[];
  readonly inferenceConfig?: {
    readonly maxTokens?: number;
    readonly temperature?: number;
    readonly topP?: number;
    readonly stopSequences?: string[];
  };
  readonly toolConfig?: ToolConfiguration;
}

/**
 * Builds the plain request-input object shared by `client.ts`'s
 * `buildConverseCommand` and `stream.ts`'s `buildConverseStreamCommand` —
 * `ConverseCommandInput` and `ConverseStreamCommandInput` are field-identical
 * for this slice's surface. `system`, `inferenceConfig`, and `toolConfig`
 * are included only when present — a conditional spread, never a key set to
 * `undefined` (`exactOptionalPropertyTypes` convention).
 * `inferenceConfig.stopSequences` is copied into a fresh mutable array since
 * the SDK's field is `string[] | undefined`, not `readonly string[]`.
 *
 * `toolConfig` is already-built (via `tools.ts`'s `buildToolConfig`, called
 * once by `client.ts`'s `invoke` before the fallback loop) rather than
 * derived from `request` here — `request`'s own type stays
 * `M3LBedrockInvokeRequest`, so `stream.ts` can keep calling this function
 * without ever naming `tools`/`toolChoice`.
 */
export function buildConverseInput(
  modelId: string,
  request: M3LBedrockInvokeRequest,
  toolConfig?: ToolConfiguration,
): ConverseInput {
  const inferenceConfig = request.inferenceConfig;
  return {
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
    ...(toolConfig !== undefined && { toolConfig }),
  };
}

/**
 * Maps a response `role` to {@link M3LBedrockRuntimeRole}. The SDK's
 * `ConversationRole` also carries `"system"` (request-only in practice); any
 * value other than `"user"` maps to `"assistant"`, the only other member of
 * this V4 slice's role vocabulary.
 */
export function mapRole(role: string | undefined): M3LBedrockRuntimeRole {
  return role === "user" ? "user" : "assistant";
}

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
 *   caller threads it through as `M3LBedrockRuntimeNoModelError`'s `cause`
 *   on eventual fallback exhaustion.
 * @throws {@link M3LBedrockRuntimeModelError} For `ModelErrorException`
 *   (single-shot, from `send()`) or `ModelStreamErrorException` (streaming,
 *   only ever observed from iterating a stream — `invoke` never sees this
 *   name since it never reaches `send()` for `ConverseStreamCommand`).
 * @throws {@link M3LBedrockRuntimeOperationError} For a caller/permission
 *   fault or any other unclassified rejection.
 */
export function classifySendFailure(error: unknown, modelId: string): unknown {
  const name = readErrorName(error);

  if (name !== undefined && SAME_MODEL_RETRY_NAMES.has(name)) {
    return error;
  }
  if (name !== undefined && ADVANCE_FALLBACK_NAMES.has(name)) {
    return error;
  }
  if (name === "ModelErrorException" || name === "ModelStreamErrorException") {
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
