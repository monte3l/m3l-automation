/**
 * `core/diagnostics/format-error` — renders and serializes an `Error`'s full
 * `cause` chain, redacting sensitive text by default.
 *
 * Distinct from `core/script/process-guards`' `serializeError`, which stays a
 * deliberately single-level, redaction-free serializer for process-fault
 * guard diagnostics; this module walks the whole chain for operator-facing
 * output (CLI failure reports, run summaries).
 *
 * @packageDocumentation
 */

import { M3LError, toError } from "../errors/index.js";
import type { M3LErrorOrigin, M3LErrorRetryable } from "../errors/index.js";
import {
  redactSensitiveLogText,
  redactSensitiveLogValue,
} from "../logging/redact.js";
import { isDangerousKey } from "../security/index.js";

/**
 * The maximum number of `cause` levels walked before the chain is truncated.
 * Not exported — an implementation detail of the walk, not a tunable.
 */
const MAX_CAUSE_DEPTH = 32;

/** Marker appended when the walk terminates on a `cause` cycle. */
const CIRCULAR_MARKER = "[circular]";

/** Marker appended when the walk is truncated by {@link MAX_CAUSE_DEPTH}. */
const MAX_DEPTH_MARKER = "[max cause depth reached]";

/** Separator joining rendered levels; contains the literal "caused by" text tests assert on. */
const CAUSED_BY_SEPARATOR = "\n\ncaused by: ";

/**
 * Options controlling {@link formatErrorChain} and {@link serializeErrorChain}
 * rendering. Both fields default to `true`.
 *
 * @example
 * ```ts
 * import type { M3LFormatErrorChainOptions } from "@m3l-automation/m3l-common/core";
 *
 * const verbatim: M3LFormatErrorChainOptions = { redact: false };
 * ```
 */
export interface M3LFormatErrorChainOptions {
  /** Whether to include stack-trace frames. Defaults to `true`. */
  readonly stacks?: boolean;
  /** Whether to redact sensitive text via `core/logging`'s redactor. Defaults to `true`. */
  readonly redact?: boolean;
}

/**
 * One level of a walked error-cause chain, as a plain serializable record.
 *
 * @example
 * ```ts
 * import type { M3LSerializedError } from "@m3l-automation/m3l-common/core";
 *
 * const level: M3LSerializedError = { name: "Error", message: "boom" };
 * ```
 */
export interface M3LSerializedError {
  /** The error's `name` (e.g. `"Error"`, `"TypeError"`). */
  readonly name: string;
  /** The error's message, redacted by default. */
  readonly message: string;
  /** The machine-readable code, present only for an {@link M3LError} level. */
  readonly code?: string;
  /** The error's stack trace, when available and not suppressed. */
  readonly stack?: string;
  /** Structured diagnostic context, present only for an {@link M3LError} level. */
  readonly context?: Record<string, unknown>;
  /**
   * Who must act to fix the failure (ADR-0035 phase 2), present only for an
   * {@link M3LError} level whose `origin` is classified — absent both for a
   * non-`M3LError` level and for an `M3LError` with no catalog classification.
   */
  readonly origin?: M3LErrorOrigin;
  /**
   * Whether re-running the failed operation without changes can plausibly
   * succeed (ADR-0035 phase 2), present only for an {@link M3LError} level
   * whose `retryable` is classified — absent both for a non-`M3LError` level
   * and for an `M3LError` with no catalog classification.
   */
  readonly retryable?: M3LErrorRetryable;
}

/** The result of walking an error's `cause` chain. */
interface WalkResult {
  /** Every level visited, root-most last, normalized to a real `Error`. */
  readonly levels: readonly Error[];
  /** Whether the walk stopped because a `cause` pointed back at a visited level. */
  readonly circular: boolean;
  /** Whether the walk stopped only because {@link MAX_CAUSE_DEPTH} was reached. */
  readonly maxDepthReached: boolean;
}

/** `toError`, guarded against a value whose coercion itself misbehaves. */
function safeToError(value: unknown): Error {
  try {
    return toError(value);
  } catch {
    return new Error("[unrepresentable error value]");
  }
}

/** Reads `.cause` off an arbitrary value, tolerating a hostile getter. */
function safeReadCause(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return (value as { cause?: unknown }).cause;
  } catch {
    return undefined;
  }
}

/** Reads `.stack` off an `Error`, tolerating a hostile getter. */
function safeReadStack(error: Error): string | undefined {
  try {
    return typeof error.stack === "string" ? error.stack : undefined;
  } catch {
    return undefined;
  }
}

/** Narrows `value` to a plain, non-null, non-array object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` can meaningfully participate in circular-reference
 * tracking. Primitives (including an identical string/number repeated at
 * every level of an otherwise-linear chain) compare by value, not identity —
 * tracking them in the visited set would falsely flag a chain like
 * `cause: "boom"` at every hop as circular. Only object-typed causes are
 * tracked; the depth cap still bounds a genuine runaway chain.
 */
function isTrackableCause(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * Walks `input`'s `cause` chain, normalizing every level via `toError` and
 * capping at {@link MAX_CAUSE_DEPTH}. Shared by {@link formatErrorChain} and
 * {@link serializeErrorChain} so both surfaces render the exact same walk.
 *
 * A `cause` of `undefined` or `null` terminates the walk normally. A `cause`
 * that resolves (by reference) to an already-visited *object* level
 * terminates the walk and sets `circular`. Reaching the depth cap while a
 * further, non-circular `cause` is still pending sets `maxDepthReached` — the
 * two flags are mutually exclusive by construction.
 */
function walkErrorChain(input: unknown): WalkResult {
  const levels: Error[] = [];
  const visited = new Set<object>();
  let current: unknown = input;
  let circular = false;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (isTrackableCause(current)) {
      visited.add(current);
    }
    levels.push(safeToError(current));

    const cause = safeReadCause(current);
    if (cause === undefined || cause === null) {
      current = undefined;
      break;
    }
    if (isTrackableCause(cause) && visited.has(cause)) {
      circular = true;
      current = undefined;
      break;
    }
    current = cause;
  }

  return {
    levels,
    circular,
    maxDepthReached: !circular && current !== undefined,
  };
}

/**
 * Matches an `http(s)://` URL-shaped substring within free text — the shape
 * {@link scrubUrlsInText} rewrites to `origin + pathname` — captured as group
 * 1 (`urlPart`) so the replacer can parse just that portion even when a
 * trailing wrapped value (see below) was also consumed by the overall match.
 * Deliberately anchored to the `http(s)://` prefix only: a `data:`/`blob:`/
 * other-scheme value is never matched, so it is left for the caller's own
 * handling rather than mangled by this pass.
 *
 * Case-insensitive (`i` flag): a scheme is case-insensitive per RFC 3986, and
 * `HTTPS://…`/`HttpS://…` is a real, non-hostile value a caller can produce
 * (e.g. `M3LHttpClient` resolving an un-normalized caller-supplied `path`
 * verbatim) — matching only the lowercase form let an uppercase-scheme URL
 * (and any credential riding its userinfo/query) through unscrubbed.
 *
 * The trailing, non-capturing group is the fix for a real leak: the primary
 * character class excludes `"`/`'`/`<`/`>` so the match never straddles a
 * quote/bracket delimiter, but that means a query value written as
 * `?token="secret"` stops the match at `token=` — consuming and dropping the
 * `key=` anchor while leaving the quoted value stranded *outside* the match,
 * unrecognizable to any anchor-based redactor once the anchor is gone. The
 * `(?<==)` lookbehind fires only when the primary match actually ended on a
 * bare `=` (i.e. the character immediately excluded was a delimiter, not part
 * of the URL itself), so a quote that merely happens to follow a complete,
 * `=`-terminated URL segment is captured and dropped together with the URL
 * rather than left behind.
 *
 * Two alternatives per quote style, tried closed-first: `"[^"]*"` (a
 * genuinely closed value, e.g. `token="secret" next` — matched up to its own
 * closing quote so unrelated trailing prose is untouched) and, only when no
 * closing quote exists anywhere in the rest of the string,
 * `"[^"\s]*` — an *unterminated* value (a truncated log line, a shell
 * fragment: `token="secret failed`) captured only up to the next whitespace
 * or end of string. Without this second alternative the whole optional group
 * fails to match at all (an unclosed `"[^"]*"` cannot match), so the bare `=`
 * anchor is dropped by group 1 while the unterminated value is left entirely
 * outside the match — worse than the closed case, since nothing recognizes a
 * key-less value. Bounding the fallback at the next whitespace keeps it
 * conservative: it can only ever extend a match that already ended
 * mid-assignment, never swallow across whitespace into unrelated following
 * prose.
 *
 * No angle-bracket alternative: `<secret>` is not excluded from
 * `core/logging`'s `EMBEDDED_SENSITIVE_PATTERN` value class (only quotes are
 * excluded there), so a sensitive-named key wrapped in angle brackets is
 * already redacted by that name-based pass before this scrub ever runs.
 * Matching `<…>` here bought no additional coverage and cost real prose: a
 * closed tag immediately after a bare `=` (`?a=<div>keepme</div>`) would be
 * silently consumed and dropped alongside the URL, corrupting unrelated
 * markup in the surrounding message.
 */
const URL_PATTERN =
  /(https?:\/\/[^\s"'<>]+)(?:(?<==)(?:"[^"]*"|'[^']*'|"[^"\s]*|'[^'\s]*))?/giu;

/**
 * Finds every `http(s)://` URL-shaped substring in `text` and rewrites it to
 * `origin + pathname`, dropping userinfo (`user:pass@`), the query string,
 * and the fragment — the three places a credential routinely rides inside an
 * otherwise-innocuous URL (basic-auth userinfo; a presigned-S3
 * `X-Amz-Signature`/`X-Amz-Credential` query param; an API key or bearer
 * token passed as `?access_token=`). Intended as a defense-in-depth pass over
 * free text (an error `message`, a `stack` frame) that embeds a raw request
 * URL — a URL-shaped leak is not something the name-based
 * `redactSensitiveLogText`/`redactSensitiveLogValue` pass recognizes by key or
 * literal name, so this scrub exists to cover it.
 *
 * Callers MUST run this AFTER the name-based `redactSensitiveLogText`/
 * `redactSensitiveLogValue` pass, never before (every call site in this
 * module follows that order). Running the URL scrub first can strip a `key=`
 * anchor immediately adjacent to a scrub stop character (`"`, `'`, a
 * newline) — e.g. `token="SECRET"` loses its `?` up through `token=` once the
 * URL match consumes it — leaving the bare value behind with no `key=` prefix
 * for the name-based redactor to recognize, which is strictly worse than
 * redacting alone. Redacting first replaces the value with the `[REDACTED]`
 * literal while the anchor is still intact, so this scrub can only ever trim
 * an already-safe placeholder, never an unredacted secret.
 *
 * Never throws: a match that fails to parse as a `URL` (or resolves to a
 * non-`http(s)` protocol) is left verbatim in the output, deferring to the
 * existing redactor rather than risking corrupted surrounding prose.
 *
 * @param text - The free text to scrub.
 * @returns `text` with every URL-shaped substring reduced to `origin + pathname`.
 *
 * @example
 * ```ts
 * import { scrubUrlsInText } from "@m3l-automation/m3l-common/core";
 *
 * scrubUrlsInText("request to https://u:p@api.example.com/v1/data?token=x failed");
 * // "request to https://api.example.com/v1/data failed"
 * scrubUrlsInText('request to https://api.example.com/data?token="x" failed');
 * // "request to https://api.example.com/data failed"
 * ```
 */
export function scrubUrlsInText(text: string): string {
  return text.replace(URL_PATTERN, (match: string, urlPart: string) => {
    try {
      // Parse only the captured `urlPart` (group 1) — never the overall
      // `match`, which may additionally include a trailing quoted value the
      // `URL` constructor would not understand. Both are dropped
      // together on success: the whole `match` is replaced by
      // `origin + pathname`, so the stranded-value defect this pattern
      // exists to fix (see the pattern's own TSDoc) cannot recur.
      const parsed = new URL(urlPart);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return match;
      }
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return match;
    }
  });
}

/**
 * Recursively applies {@link scrubUrlsInText} to every string leaf reachable
 * from `value` — a plain object's/array's nested string values — leaving
 * every other type (`number`, `boolean`, `null`, etc.) unchanged. Used to
 * scrub an `M3LError` level's `context` before it is redacted, since a
 * credential-bearing URL may be nested arbitrarily deep in caller-supplied
 * diagnostic context.
 *
 * Scrubs object **keys**, not just values: a URL used as a `context` object
 * key (e.g. a results-keyed-by-URL shape) would otherwise reach the report
 * verbatim even though the identical URL riding as a *value* gets scrubbed.
 * `isDangerousKey` is checked (on the pre-scrub key) for the same
 * prototype-pollution reason `redactSensitiveLogValue`'s own clone already
 * guards against — defense-in-depth at this construction site, not the
 * primary guard. If scrubbing collapses two distinct keys to the same
 * string, the later entry wins: `Object.entries` preserves insertion order,
 * so this is a plain, deterministic last-write-wins overwrite, never a
 * silent drop of both.
 */
function scrubUrlsInValue(value: unknown): unknown {
  if (typeof value === "string") return scrubUrlsInText(value);
  if (Array.isArray(value))
    return value.map((entry) => scrubUrlsInValue(entry));
  if (isPlainRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isDangerousKey(key)) continue;
      result[scrubUrlsInText(key)] = scrubUrlsInValue(entry);
    }
    return result;
  }
  return value;
}

/**
 * Redacts `text` when `redact` is `true`, otherwise returns it verbatim.
 * When redacting, the name-based `redactSensitiveLogText` pass runs FIRST,
 * then {@link scrubUrlsInText}. Running the URL scrub first can strip a
 * `key=` anchor immediately adjacent to a scrub stop character (`"`, `<`,
 * `>`, a newline) — e.g. `token="SECRET"` — leaving the bare value behind
 * with no `key=` prefix for the name-based redactor to recognize, which is
 * strictly worse than redacting alone. Redacting first replaces the value
 * with the `[REDACTED]` literal while the anchor is still intact, so the
 * subsequent URL scrub can only ever trim an already-safe placeholder, never
 * an unredacted secret.
 */
function maybeRedactText(text: string, redact: boolean): string {
  return redact ? scrubUrlsInText(redactSensitiveLogText(text)) : text;
}

/** Renders one level as `"Name: message [CODE]"`, plus stack frames when requested. */
function renderLevel(level: Error, redact: boolean, stacks: boolean): string {
  const code = level instanceof M3LError ? level.code : undefined;
  const codeSuffix = code === undefined ? "" : ` [${code}]`;
  const name = maybeRedactText(level.name, redact);
  const header = `${name}: ${maybeRedactText(level.message, redact)}${codeSuffix}`;

  if (!stacks) return header;

  const stack = safeReadStack(level);
  if (stack === undefined) return header;

  // Drop the stack's own leading "Name: message" line — it duplicates
  // `header` above — and keep only the frame lines.
  const frames = stack.split("\n").slice(1).join("\n");
  if (frames.length === 0) return header;

  return `${header}\n${maybeRedactText(frames, redact)}`;
}

/**
 * Redacts an `M3LError` level's `context` when `redact` is `true`, guarding
 * against a redactor that returns a non-record (proven via {@link isPlainRecord}
 * rather than asserted) so the public {@link M3LSerializedError.context} field
 * is never populated from an unproven value. Runs the name-based
 * `redactSensitiveLogValue` pass FIRST, then {@link scrubUrlsInValue} —
 * mirroring {@link maybeRedactText}'s already-established order for the same
 * reason: reversing it lets the URL scrub consume and drop a `key=` anchor
 * (e.g. a value written as `?token="secret"` immediately adjacent to a scrub
 * stop character) before the name-based redactor ever sees it, stranding an
 * unredacted value nested in `context` (e.g. `context.url`) with no anchor
 * left for anything to recognize it by. Redacting first replaces any
 * recognizable sensitive value while the anchor is still intact, so the
 * subsequent URL scrub can only ever trim an already-safe result.
 */
function redactContext(
  context: Record<string, unknown>,
  redact: boolean,
): Record<string, unknown> {
  if (!redact) return context;
  const redacted = redactSensitiveLogValue(context);
  const scrubbed = scrubUrlsInValue(redacted);
  return isPlainRecord(scrubbed) ? scrubbed : {};
}

/** Serializes one level to a plain, JSON-serializable {@link M3LSerializedError}. */
function serializeLevel(
  level: Error,
  redact: boolean,
  stacks: boolean,
): M3LSerializedError {
  const name = maybeRedactText(level.name, redact);
  const message = maybeRedactText(level.message, redact);
  const stack = stacks ? safeReadStack(level) : undefined;

  const isM3LError = level instanceof M3LError;
  const context = isM3LError ? redactContext(level.context, redact) : undefined;
  const origin = isM3LError ? level.origin : undefined;
  const retryable = isM3LError ? level.retryable : undefined;

  return {
    name,
    message,
    ...(isM3LError && { code: level.code }),
    ...(stack !== undefined && { stack: maybeRedactText(stack, redact) }),
    ...(context !== undefined && { context }),
    ...(origin !== undefined && { origin }),
    ...(retryable !== undefined && { retryable }),
  };
}

/**
 * Renders `error` and its full `cause` chain as human-readable text, one
 * level per line group, each level joined to the next by a `caused by:`
 * marker.
 *
 * Never throws for any input, including `null`/`undefined`, a non-`Error`
 * value, a `cause` cycle, or a hostile getter on `cause`/`stack`. A cycle
 * renders `[circular]`; a chain longer than 32 levels is truncated and
 * renders `[max cause depth reached]`.
 *
 * @param error - Any caught value.
 * @param options - Rendering options; both fields default to `true`.
 * @returns A multi-line string describing the full chain.
 *
 * @example
 * ```ts
 * import { formatErrorChain } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   await run();
 * } catch (error: unknown) {
 *   console.error(formatErrorChain(error));
 * }
 * ```
 */
export function formatErrorChain(
  error: unknown,
  options: M3LFormatErrorChainOptions = {},
): string {
  try {
    const stacks = options.stacks ?? true;
    const redact = options.redact ?? true;
    const { levels, circular, maxDepthReached } = walkErrorChain(error);

    const rendered = levels.map((level) => renderLevel(level, redact, stacks));
    if (circular) {
      rendered.push(CIRCULAR_MARKER);
    } else if (maxDepthReached) {
      rendered.push(MAX_DEPTH_MARKER);
    }

    return rendered.join(CAUSED_BY_SEPARATOR);
  } catch {
    return "[unrepresentable error chain]";
  }
}

/**
 * Serializes `error` and its full `cause` chain to an array of plain,
 * JSON-serializable {@link M3LSerializedError} records — the structured
 * counterpart to {@link formatErrorChain}, sharing the exact same walk (same
 * level count, order, and per-level fields).
 *
 * Never throws for any input and always returns a non-empty array (a
 * non-`Error` input is normalized to a single synthetic level).
 *
 * @param error - Any caught value.
 * @param options - Rendering options; both fields default to `true`.
 * @returns One entry per walked level, root-most last.
 *
 * @example
 * ```ts
 * import { serializeErrorChain } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   await run();
 * } catch (error: unknown) {
 *   console.log(JSON.stringify(serializeErrorChain(error)));
 * }
 * ```
 */
export function serializeErrorChain(
  error: unknown,
  options: M3LFormatErrorChainOptions = {},
): readonly M3LSerializedError[] {
  try {
    const stacks = options.stacks ?? true;
    const redact = options.redact ?? true;
    const { levels } = walkErrorChain(error);
    return levels.map((level) => serializeLevel(level, redact, stacks));
  } catch {
    return [{ name: "Error", message: "[unrepresentable error chain]" }];
  }
}
