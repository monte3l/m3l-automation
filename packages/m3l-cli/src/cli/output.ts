/**
 * `cli/output` — TTY/env-aware color resolution and the `M3LCliOutput`
 * writer facade every m3l CLI command renders through.
 *
 * @packageDocumentation
 */

import { styleText } from "node:util";

/** The last C0 control code point (`0x1F`); `0x00`–this range is banned. */
const C0_CONTROL_MAX = 0x1f;
/** The `DEL` code point (`0x7F`), banned alongside the C0 controls. */
const DEL_CODE_POINT = 0x7f;
/** The first C1 control code point (`0x80`). */
const C1_CONTROL_MIN = 0x80;
/** The last C1 control code point (`0x9F`). */
const C1_CONTROL_MAX = 0x9f;
/** The first Unicode bidi embedding/override code point (`U+202A`). */
const BIDI_EMBEDDING_OVERRIDE_MIN = 0x202a;
/** The last Unicode bidi embedding/override code point (`U+202E`). */
const BIDI_EMBEDDING_OVERRIDE_MAX = 0x202e;
/** The first Unicode bidi isolate code point (`U+2066`). */
const BIDI_ISOLATE_MIN = 0x2066;
/** The last Unicode bidi isolate code point (`U+2069`). */
const BIDI_ISOLATE_MAX = 0x2069;

/**
 * Checks whether a single Unicode code point is one this module strips from
 * attacker-influencable text before it ever reaches a terminal-rendered
 * channel: C0 controls (`0x00`–`0x1F`, including `ESC` `0x1B`) plus `DEL`
 * (`0x7F`), C1 controls (`0x80`–`0x9F`), and the Unicode bidi
 * embedding/override (`U+202A`–`U+202E`) and isolate (`U+2066`–`U+2069`)
 * controls — the ranges a terminal could interpret as an escape sequence or
 * a directional override rather than literal text.
 *
 * @param codePoint - A single Unicode code point, e.g. from
 *   `String.prototype.codePointAt`.
 * @returns Whether `codePoint` must be stripped.
 */
function isDisallowedTerminalCodePoint(codePoint: number): boolean {
  const isC0OrDel = codePoint <= C0_CONTROL_MAX || codePoint === DEL_CODE_POINT;
  const isC1 = codePoint >= C1_CONTROL_MIN && codePoint <= C1_CONTROL_MAX;
  const isBidiEmbeddingOrOverride =
    codePoint >= BIDI_EMBEDDING_OVERRIDE_MIN &&
    codePoint <= BIDI_EMBEDDING_OVERRIDE_MAX;
  const isBidiIsolate =
    codePoint >= BIDI_ISOLATE_MIN && codePoint <= BIDI_ISOLATE_MAX;
  return isC0OrDel || isC1 || isBidiEmbeddingOrOverride || isBidiIsolate;
}

/**
 * Strips control characters and Unicode bidi direction overrides from
 * attacker-influencable text before it reaches a terminal-rendered channel
 * (e.g. a prompt's prefilled `default`, or a rendered summary cell) — a
 * per-code-point filter (no regex, so no backtracking risk) built from
 * {@link isDisallowedTerminalCodePoint}'s banned ranges.
 *
 * Every other code point (including printable Unicode outside the banned
 * ranges) passes through unchanged, so this is a no-op for benign text.
 *
 * @param text - The raw text to sanitize.
 * @returns `text` with every disallowed code point removed.
 *
 * @example
 * ```ts
 * import { sanitizeTerminalText } from "./output.js";
 *
 * sanitizeTerminalText("us-east-1"); // "us-east-1" — unchanged
 * ```
 */
export function sanitizeTerminalText(text: string): string {
  let result = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || !isDisallowedTerminalCodePoint(codePoint)) {
      result += char;
    }
  }
  return result;
}

/**
 * Resolves whether ANSI color styling should be applied, given a stream's
 * TTY-ness and the process environment.
 *
 * Precedence: `FORCE_COLOR` present and not equal to `"0"` forces color on
 * (even off a non-TTY); otherwise `NO_COLOR` (any value) or
 * `NODE_DISABLE_COLORS` present forces color off (even on a TTY); otherwise
 * the decision falls back to `isTTY`.
 *
 * @param isTTY - Whether the target stream is attached to a terminal.
 * @param env - The environment variables to consult.
 * @returns Whether ANSI styling should be applied.
 *
 * @example
 * ```ts
 * const colorEnabled = resolveColorEnabled(process.stdout.isTTY === true, process.env);
 * // true when stdout is a TTY and no NO_COLOR/NODE_DISABLE_COLORS override is set
 * ```
 */
export function resolveColorEnabled(
  isTTY: boolean,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (Object.hasOwn(env, "FORCE_COLOR") && env["FORCE_COLOR"] !== "0") {
    return true;
  }
  if (
    Object.hasOwn(env, "NO_COLOR") ||
    Object.hasOwn(env, "NODE_DISABLE_COLORS")
  ) {
    return false;
  }
  return isTTY;
}

/**
 * The minimal writable-stream shape `createOutput` targets — structurally
 * compatible with `process.stdout`/`process.stderr` and an array-collecting
 * test stub.
 */
export interface M3LCliOutputStream {
  /** Writes `text` to the underlying sink. */
  write(text: string): unknown;
  /** Whether this stream is attached to a terminal. */
  readonly isTTY?: boolean | undefined;
}

/**
 * Constructor options for {@link createOutput}.
 */
export interface M3LCliOutputOptions {
  /** The stream `info`/`heading` write to. */
  readonly stdout: M3LCliOutputStream;
  /** The stream `error` writes to. */
  readonly stderr: M3LCliOutputStream;
  /** The environment consulted for color-override precedence. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The CLI's writer facade: newline-terminated `info`/`heading`/`error`
 * output, with per-stream color resolution.
 */
export interface M3LCliOutput {
  /** Whether `stdout` output is styled. */
  readonly colorEnabled: boolean;
  /** Writes an unstyled informational line to stdout. */
  info(text: string): void;
  /** Writes an error line to stderr, styled red when stderr is a TTY. */
  error(text: string): void;
  /** Writes a bold heading line to stdout, styled when stdout is a TTY. */
  heading(text: string): void;
}

/**
 * Creates an {@link M3LCliOutput} bound to the given streams.
 *
 * Color is resolved independently per stream: `stdout`'s TTY-ness drives
 * `info`/`heading` styling, `stderr`'s drives `error` styling — both subject
 * to the same env-override precedence via {@link resolveColorEnabled}.
 *
 * @param options - The target streams and the environment to resolve color
 *   overrides against; `env` defaults to `process.env` when omitted.
 * @returns A ready-to-use {@link M3LCliOutput}.
 *
 * @example
 * ```ts
 * const output = createOutput({ stdout: process.stdout, stderr: process.stderr });
 * output.heading("Scripts");
 * output.info("2 scripts found");
 * ```
 */
export function createOutput(options: M3LCliOutputOptions): M3LCliOutput {
  const env = options.env ?? process.env;
  const stdoutColorEnabled = resolveColorEnabled(
    options.stdout.isTTY === true,
    env,
  );
  const stderrColorEnabled = resolveColorEnabled(
    options.stderr.isTTY === true,
    env,
  );

  return {
    colorEnabled: stdoutColorEnabled,
    info(text: string): void {
      options.stdout.write(`${text}\n`);
    },
    heading(text: string): void {
      const rendered = stdoutColorEnabled
        ? styleText(["bold"], text, { validateStream: false })
        : text;
      options.stdout.write(`${rendered}\n`);
    },
    error(text: string): void {
      const rendered = stderrColorEnabled
        ? styleText(["red"], text, { validateStream: false })
        : text;
      options.stderr.write(`${rendered}\n`);
    },
  };
}
