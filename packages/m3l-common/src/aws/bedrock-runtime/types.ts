/**
 * `aws/bedrock-runtime/types` — plain, library-owned request/response types
 * for {@link M3LBedrockRuntimeOperations}, verbatim from
 * `docs/reference/aws/bedrock-runtime.md`'s "Plain types" section.
 *
 * @packageDocumentation
 */

/** A Converse message's role — Bedrock's `system` role is expressed via {@link M3LBedrockInvokeRequest.system} instead. */
export type M3LBedrockRuntimeRole = "user" | "assistant";

/** A single text content block within a {@link M3LBedrockMessage}. */
export interface M3LBedrockTextBlock {
  /** Discriminant tag for {@link M3LBedrockContentBlock}. */
  readonly type: "text";
  /** The block's plain text. */
  readonly text: string;
}

/**
 * A single content block within a {@link M3LBedrockMessage}.
 *
 * Deliberately a single-member tagged union in this V4 slice — see
 * `docs/reference/aws/bedrock-runtime.md`'s scope-boundary note. V5 widens
 * this with `toolUse`/`toolResult` members; the `type` discriminant exists
 * from V4 onward specifically so that widening is additive.
 */
export type M3LBedrockContentBlock = M3LBedrockTextBlock;

/** A single message in a Converse conversation. */
export interface M3LBedrockMessage {
  /** Who authored this message. */
  readonly role: M3LBedrockRuntimeRole;
  /** The message's content blocks, in order. */
  readonly content: readonly M3LBedrockContentBlock[];
}

/**
 * Why the model stopped generating output. Mirrors the SDK's `StopReason`
 * enum verbatim — no library-side renaming, since callers reasoning about
 * "why did the model stop" benefit from the same vocabulary AWS's own docs
 * use.
 */
export type M3LBedrockStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "guardrail_intervened"
  | "content_filtered"
  | "malformed_tool_use"
  | "malformed_model_output"
  | "model_context_window_exceeded";

/** Token usage for one Converse call. */
export interface M3LBedrockTokenUsage {
  /** Tokens sent in the request to the model. */
  readonly inputTokens: number;
  /** Tokens the model generated for the request. */
  readonly outputTokens: number;
  /** The sum of `inputTokens` and `outputTokens`. */
  readonly totalTokens: number;
}

/** Inference tuning parameters forwarded to the Converse API unchanged. */
export interface M3LBedrockInferenceConfig {
  /** Maximum number of tokens to generate. */
  readonly maxTokens?: number;
  /** Sampling temperature. */
  readonly temperature?: number;
  /** Nucleus sampling probability mass. */
  readonly topP?: number;
  /** Sequences that stop generation when produced. */
  readonly stopSequences?: readonly string[];
}

/**
 * The request to {@link M3LBedrockRuntimeOperations.invoke}.
 *
 * `system`, when present, is sent as a single Converse `SystemContentBlock`
 * text member (`[{ text: system }]`) — the SDK's richer system-block union
 * (guard content, cache points) is not exposed; a caller needing those
 * constructs a raw `ConverseCommand` directly.
 */
export interface M3LBedrockInvokeRequest {
  /** The conversation's messages, in order. */
  readonly messages: readonly M3LBedrockMessage[];
  /** An optional system prompt. */
  readonly system?: string;
  /** Optional inference tuning parameters. */
  readonly inferenceConfig?: M3LBedrockInferenceConfig;
}

/** Per-call options for {@link M3LBedrockRuntimeOperations.invoke}. */
export interface M3LBedrockInvokeOptions {
  /**
   * Optional `AbortSignal` for cooperative cancellation (ADR-0049). Passed as
   * `{ abortSignal: signal }` on the underlying `client.send()` call.
   */
  readonly signal?: AbortSignal;
}

/** The result of a successful {@link M3LBedrockRuntimeOperations.invoke} call. */
export interface M3LBedrockInvocationResult {
  /** The model's reply message. */
  readonly message: M3LBedrockMessage;
  /** Why the model stopped generating output. */
  readonly stopReason: M3LBedrockStopReason;
  /** Token usage for this call. */
  readonly usage: M3LBedrockTokenUsage;
  /** The model that actually served the request — `models[0]` unless fallback advanced past it. */
  readonly modelId: string;
}

/** Constructor options for {@link M3LBedrockRuntimeOperations}. */
export interface M3LBedrockRuntimeOptions {
  /** Ordered, non-empty fallback list; `models[0]` is the primary model id. */
  readonly models: readonly string[];
}
