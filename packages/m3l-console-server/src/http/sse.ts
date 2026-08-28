/**
 * `http/sse` — the Server-Sent Events wire-format encoder (X4, ADR-0066).
 *
 * This module encodes exactly three SSE frame shapes: a data frame
 * ({@link encodeSseFrame}), a comment/heartbeat ({@link encodeSseComment}),
 * and a retry directive ({@link encodeSseRetry}). It is deliberately
 * socket-free — it never touches `node:http` — so it can be unit-tested as a
 * pure string transform and reused by any transport that eventually writes
 * its output to the wire.
 *
 * **The one rule this module is built on.** `{@link M3LSseFrame.data}` is
 * arbitrary, attacker-influenced script output: it is sanitized, never
 * rejected. Every *other* value this module touches — a frame's `id`, an
 * `event` name, a comment's `text`, `encodeSseRetry`'s `retryMs` — is an
 * internal control value supplied only by our own code, so a bad one is a
 * defect, not attacker input. Those are validated and throw rather than
 * sanitized, because silently sanitizing a value that should never be wrong
 * would mask the defect instead of surfacing it. This asymmetry is
 * deliberate: rejecting a caller-authored `event` name that happens to
 * contain a stray newline is cheap and safe (it can only come from a bug),
 * while sanitizing attacker-influenced `data` is the only frame-forging
 * defense available — a raw `\r` reaching the wire lets script output inject
 * a synthetic line, so it is normalized away rather than trusted.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";

/**
 * One SSE frame's fields, prior to encoding.
 *
 * @example
 * ```ts
 * const frame: M3LSseFrame = {
 *   id: 1,
 *   event: "run.output",
 *   data: "hello world",
 * };
 * ```
 */
export interface M3LSseFrame {
  /**
   * The frame's `Last-Event-ID` value. Omit rather than pass `0`: ids are
   * 1-based, and an emitted `id: 0` would make a reconnecting client send
   * `Last-Event-ID: 0`, which `stream/event-stream.ts`'s
   * `resolveResumeDecision` reads as "replay everything retained" — a
   * silent duplicate-delivery bug. Must be a positive integer when present.
   */
  readonly id?: number;
  /** The frame's event name — an internal constant such as `"run.output"`. */
  readonly event: string;
  /** Arbitrary payload data, potentially attacker-influenced script output. */
  readonly data: string;
}

/**
 * Asserts that an internal control value (never attacker data) satisfies
 * `predicate`, throwing `ERR_CONSOLE_INTERNAL` otherwise.
 *
 * Centralizes the "this value comes from our own code, so a bad one is a
 * defect" check shared by {@link encodeSseFrame}'s `id`/`event` validation,
 * {@link encodeSseComment}'s `text` validation, and {@link encodeSseRetry}'s
 * `retryMs` validation — the three are structurally identical, differing
 * only in the predicate and the message.
 *
 * @param value - The control value being validated.
 * @param predicate - Returns `true` when `value` is acceptable.
 * @param message - The error message when `predicate` returns `false`.
 */
function assertInternalValue<Value>(
  value: Value,
  predicate: (value: Value) => boolean,
  message: string,
): void {
  if (!predicate(value)) {
    throw new M3LConsoleError("ERR_CONSOLE_INTERNAL", message);
  }
}

/** `true` when `id` is a positive (non-zero) integer. */
function isPositiveInteger(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

/** `true` when `text` contains neither `\n` nor `\r`. */
function hasNoNewline(text: string): boolean {
  return !text.includes("\n") && !text.includes("\r");
}

/**
 * Normalizes `\r\n` and lone `\r` in `data` to `\n`, then splits on `\n`.
 *
 * This is the module's security-relevant step: `data` is attacker-influenced
 * script output, and a raw `\r` reaching the wire unnormalized would let that
 * output forge a frame boundary (many SSE parsers treat `\r` as a line
 * terminator in its own right). Normalizing before splitting means every
 * line ending is handled uniformly regardless of which one the source used.
 *
 * @param data - The raw payload.
 * @returns One entry per line, preserving empty lines (including a trailing
 *   one — see {@link encodeSseFrame}'s trailing-newline behavior).
 */
function splitSanitizedLines(data: string): readonly string[] {
  return data.replace(/\r\n|\r/gu, "\n").split("\n");
}

/**
 * Encodes one SSE data frame: an optional `id:` line, an `event:` line, one
 * `data:` line per line of `data` (sanitized — see the module's rule above),
 * then a terminating blank line.
 *
 * @param frame - The frame's fields.
 * @returns The encoded frame, ready to write to the wire.
 * @throws {@link M3LConsoleError} with code `ERR_CONSOLE_INTERNAL` when `id`
 *   is present but not a positive integer, or when `event` contains `\n` or
 *   `\r`.
 *
 * @example
 * ```ts
 * import { encodeSseFrame } from "@m3l-automation/m3l-console-server/http/sse.js";
 *
 * const wire = encodeSseFrame({ id: 1, event: "run.output", data: "hello" });
 * // "id: 1\nevent: run.output\ndata: hello\n\n"
 * ```
 */
export function encodeSseFrame(frame: M3LSseFrame): string {
  if (frame.id !== undefined) {
    assertInternalValue(
      frame.id,
      isPositiveInteger,
      `SSE frame id must be a positive integer, got ${String(frame.id)}`,
    );
  }
  assertInternalValue(
    frame.event,
    hasNoNewline,
    `SSE frame event name must not contain a newline or carriage return, got ${JSON.stringify(frame.event)}`,
  );

  const idLine = frame.id === undefined ? "" : `id: ${String(frame.id)}\n`;
  const eventLine = `event: ${frame.event}\n`;
  const dataLines = splitSanitizedLines(frame.data)
    .map((line) => `data: ${line}\n`)
    .join("");

  return `${idLine}${eventLine}${dataLines}\n`;
}

/**
 * Encodes an SSE comment frame (`: <text>`), typically used as a
 * heartbeat/keep-alive.
 *
 * @param text - The comment text — an internal control value, never
 *   caller/attacker data.
 * @returns The encoded comment frame.
 * @throws {@link M3LConsoleError} with code `ERR_CONSOLE_INTERNAL` when
 *   `text` contains `\n` or `\r`.
 *
 * @example
 * ```ts
 * import { encodeSseComment } from "@m3l-automation/m3l-console-server/http/sse.js";
 *
 * const heartbeat = encodeSseComment("keep-alive");
 * // ": keep-alive\n\n"
 * ```
 */
export function encodeSseComment(text: string): string {
  assertInternalValue(
    text,
    hasNoNewline,
    `SSE comment text must not contain a newline or carriage return, got ${JSON.stringify(text)}`,
  );

  return `: ${text}\n\n`;
}

/**
 * Encodes an SSE `retry:` directive, telling the client how long to wait
 * before reconnecting.
 *
 * @param retryMs - The retry interval in milliseconds. `0` is valid (retry
 *   immediately).
 * @returns The encoded retry frame.
 * @throws {@link M3LConsoleError} with code `ERR_CONSOLE_INTERNAL` when
 *   `retryMs` is not a non-negative integer.
 *
 * @example
 * ```ts
 * import { encodeSseRetry } from "@m3l-automation/m3l-console-server/http/sse.js";
 *
 * const retry = encodeSseRetry(5000);
 * // "retry: 5000\n\n"
 * ```
 */
export function encodeSseRetry(retryMs: number): string {
  assertInternalValue(
    retryMs,
    (value) => Number.isInteger(value) && value >= 0,
    `SSE retry ms must be a non-negative integer, got ${String(retryMs)}`,
  );

  return `retry: ${retryMs}\n\n`;
}
