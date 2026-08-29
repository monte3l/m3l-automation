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

/** `"success"` or `"error"` for a {@link M3LBedrockToolResultBlock}; omitted means `"success"`. */
export type M3LBedrockToolResultStatus = "success" | "error";

/**
 * A model-generated request to call a tool, carried in an assistant reply's
 * `message.content` when `stopReason` is `"tool_use"`.
 */
export interface M3LBedrockToolUseBlock {
  /** Discriminant tag for {@link M3LBedrockContentBlock}. */
  readonly type: "toolUse";
  /** Opaque id correlating this call to the matching {@link M3LBedrockToolResultBlock} reply. */
  readonly toolUseId: string;
  /** The tool's name, as declared in the matching {@link M3LBedrockToolDefinition}. */
  readonly name: string;
  /**
   * The model-generated call arguments, exactly as the SDK decoded them —
   * never re-parsed, re-shaped, or validated against the tool's own
   * `inputSchema`. Narrow before use.
   */
  readonly input: unknown;
}

/** A JSON-valued {@link M3LBedrockToolResultContent} member. */
export interface M3LBedrockToolResultJsonBlock {
  /** Discriminant tag for {@link M3LBedrockToolResultContent}. */
  readonly type: "json";
  /** The JSON-serializable payload. Recursively copied on the way out — see `document.ts`'s `copyDocument`. */
  readonly json: unknown;
}

/**
 * The content carried by a {@link M3LBedrockToolResultBlock} — a deliberate
 * 2-of-6 subset of the SDK's `ToolResultContentBlock` union (`image`,
 * `document`, `video`, and `searchResult` members are out of scope; a tool
 * handler needing one constructs a raw `ConverseCommand` directly).
 */
export type M3LBedrockToolResultContent =
  M3LBedrockTextBlock | M3LBedrockToolResultJsonBlock;

/**
 * A caller's answer to a previous {@link M3LBedrockToolUseBlock}, sent on the
 * next turn. Request-side only in practice — the service never emits one in
 * an assistant reply, though it is part of {@link M3LBedrockContentBlock} and
 * so mappable in either direction.
 */
export interface M3LBedrockToolResultBlock {
  /** Discriminant tag for {@link M3LBedrockContentBlock}. */
  readonly type: "toolResult";
  /** Correlates this reply to the {@link M3LBedrockToolUseBlock} it answers. */
  readonly toolUseId: string;
  /** The tool's result content, in order. */
  readonly content: readonly M3LBedrockToolResultContent[];
  /** Whether the tool call succeeded; omitted means `"success"`. */
  readonly status?: M3LBedrockToolResultStatus;
}

/**
 * A single content block within a {@link M3LBedrockMessage}.
 *
 * A 3-member tagged union as of V5 — widened from V4's single-member union
 * (`M3LBedrockTextBlock` alone) with `toolUse`/`toolResult` members; the
 * `type` discriminant existed from V4 onward specifically so that this
 * widening would be additive. See `docs/reference/aws/bedrock-runtime.md`'s
 * "One honest caveat on 'additive'" note: a consumer exhaustively
 * `switch`ing over `block.type`, or mapping every block to `.text`, now
 * fails to compile — deliberate, and pre-announced.
 */
export type M3LBedrockContentBlock =
  M3LBedrockTextBlock | M3LBedrockToolUseBlock | M3LBedrockToolResultBlock;

/** A JSON-Schema-shaped object describing a tool's call arguments. Not validated by this library — see `M3LBedrockToolUseBlock.input`. */
export type M3LBedrockToolInputSchema = Readonly<Record<string, unknown>>;

/** One tool the model may call, declared in {@link M3LBedrockToolInvokeRequest.tools}. */
export interface M3LBedrockToolDefinition {
  /** The tool's name, referenced verbatim (case-sensitive) by {@link M3LBedrockToolChoice}'s `{ tool }` form and by reply {@link M3LBedrockToolUseBlock.name}. */
  readonly name: string;
  /** Optional human-readable description shown to the model. */
  readonly description?: string;
  /** The tool's call-argument schema, forwarded to the Converse API's `toolSpec.inputSchema.json` — recursively copied, never passed by reference. */
  readonly inputSchema: M3LBedrockToolInputSchema;
}

/**
 * Constrains which tool(s), if any, the model must call on this turn:
 * `"auto"` lets the model decide, `"any"` forces some tool call, and
 * `{ tool: name }` forces that specific tool. Deliberately **not** a tagged
 * union — the two string literals and the object arm are distinguished
 * structurally, matching the Converse API's own `toolChoice` shape.
 */
export type M3LBedrockToolChoice = "auto" | "any" | { readonly tool: string };

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

/**
 * The request to {@link M3LBedrockRuntimeOperations.invoke} — the V4
 * {@link M3LBedrockInvokeRequest} widened with optional `tools`/`toolChoice`.
 * Both added fields are optional, so every V4 request literal remains a
 * valid `invoke` argument.
 *
 * `tools` and `toolChoice` are mapped together into the Converse API's
 * single `toolConfig` field, omitted entirely when `tools` is absent **or
 * empty** — an empty array is treated as equivalent to absent throughout.
 * `invokeStream` deliberately keeps the narrower {@link M3LBedrockInvokeRequest}
 * — see the module doc's scope-boundary note.
 */
export interface M3LBedrockToolInvokeRequest extends M3LBedrockInvokeRequest {
  /** The tools the model may call this turn. An empty array is equivalent to absent. */
  readonly tools?: readonly M3LBedrockToolDefinition[];
  /** Constrains which tool(s) the model must call. A caller error when present while `tools` is absent/empty, or names a tool not in `tools`. */
  readonly toolChoice?: M3LBedrockToolChoice;
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
  /**
   * Ordered, **type-level non-empty** fallback list; `models[0]` is the
   * primary model id. The tuple type makes an empty array a compile error
   * for a caller passing a literal — but a config- or JSON-sourced
   * `string[]` can still arrive empty after being downcast to satisfy this
   * type, so the constructor also throws
   * {@link M3LBedrockRuntimeNoModelError} at construction as defense-in-depth
   * for exactly that case.
   */
  readonly models: readonly [string, ...(readonly string[])];
}

/**
 * One event yielded by {@link M3LBedrockRuntimeOperations.invokeStream}.
 * `type` is a library-owned kebab-case discriminant, not the SDK's own
 * camelCase event names — deliberate, since `"message-stop"` fuses two
 * distinct SDK events (`messageStop` for `stopReason`, `metadata` for
 * `usage`) and borrowing either name alone would mislead.
 *
 * There is no error-shaped member: every streaming fault is a rejection of
 * `.next()`, never a yielded value — see
 * {@link M3LBedrockRuntimeStreamError}.
 */
export type M3LBedrockStreamEvent =
  | M3LBedrockStreamStartEvent
  | M3LBedrockStreamTextDeltaEvent
  | M3LBedrockStreamStopEvent;

/**
 * Emitted exactly once, from the SDK's `messageStart` event, before any
 * text.
 */
export interface M3LBedrockStreamStartEvent {
  /** Discriminant tag for {@link M3LBedrockStreamEvent}. */
  readonly type: "message-start";
  /** Who authored the message being streamed — always `"assistant"` in practice. */
  readonly role: M3LBedrockRuntimeRole;
  /** The model that actually served the request — `models[0]` unless fallback advanced past it. */
  readonly modelId: string;
}

/**
 * Emitted for every `contentBlockDelta` event carrying a text delta.
 * Concatenating every `text-delta.text` in yield order reconstructs the full
 * reply text.
 */
export interface M3LBedrockStreamTextDeltaEvent {
  /** Discriminant tag for {@link M3LBedrockStreamEvent}. */
  readonly type: "text-delta";
  /** This delta's text fragment. */
  readonly text: string;
  /** From the SDK's `contentBlockIndex`; defaults to `0` when the SDK omits it. */
  readonly contentBlockIndex: number;
}

/**
 * Emitted exactly once, last, fusing the SDK's `messageStop` (`stopReason`)
 * and `metadata` (`usage`) events — buffered independently and fused as
 * soon as both have arrived, regardless of which the SDK sends first.
 */
export interface M3LBedrockStreamStopEvent {
  /** Discriminant tag for {@link M3LBedrockStreamEvent}. */
  readonly type: "message-stop";
  /** Why the model stopped generating output. */
  readonly stopReason: M3LBedrockStopReason;
  /**
   * Cumulative token usage for the whole stream, read directly from the
   * SDK's single terminal `metadata` event — there is no per-delta usage
   * field anywhere in the union, so no client-side accumulation is
   * performed.
   */
  readonly usage: M3LBedrockTokenUsage;
  /** The model that actually served the request — `models[0]` unless fallback advanced past it. */
  readonly modelId: string;
}
