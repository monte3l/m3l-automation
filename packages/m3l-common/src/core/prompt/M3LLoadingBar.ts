/**
 * `core/prompt/M3LLoadingBar` — a percentage-driven progress bar that
 * degrades to plain-text lines outside an interactive TTY.
 *
 * @packageDocumentation
 */

import { resolveRenderTarget } from "../../internal/prompt/ansi.js";

import { M3LPromptValidationError } from "./M3LPromptValidationError.js";

/** Default number of cells rendered across the bar's full width. */
const DEFAULT_WIDTH = 30;
/** Default glyph used for the filled (complete) portion of the bar. */
const DEFAULT_COMPLETE_CHAR = "█";
/** Default glyph used for the unfilled (incomplete) portion of the bar. */
const DEFAULT_INCOMPLETE_CHAR = "░";
/** Upper bound of the accepted percentage range. */
const MAX_PERCENTAGE = 100;
/** Lower bound of the accepted percentage range. */
const MIN_PERCENTAGE = 0;

/**
 * Constructor options for {@link M3LLoadingBar}.
 *
 * @example
 * ```ts
 * import type { M3LLoadingBarOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LLoadingBarOptions = { width: 20, stream: process.stderr };
 * ```
 */
export interface M3LLoadingBarOptions {
  /** Number of cells rendered across the bar's full width. Must be positive. */
  readonly width?: number;
  /** Glyph used for the filled (complete) portion of the bar. */
  readonly completeChar?: string;
  /** Glyph used for the unfilled (incomplete) portion of the bar. */
  readonly incompleteChar?: string;
  /**
   * The destination stream. Read lazily at call time from
   * `process.stdout` when omitted — never captured at construction.
   */
  readonly stream?: NodeJS.WritableStream;
  /**
   * Forces live ANSI rendering (`true`) or plain-text rendering (`false`),
   * overriding auto-detection of
   * `M3LExecutionEnvironment.isInteractive()` + `stream.isTTY`.
   */
  readonly interactive?: boolean;
}

/**
 * Renders a percentage-driven progress bar. In an interactive TTY, updates
 * redraw the current line in place using ANSI escapes; otherwise (Lambda,
 * CI, a pipe) each `update` call appends one plain-text line with no ANSI
 * escape sequences.
 *
 * @example
 * ```ts
 * import { M3LLoadingBar } from "@m3l-automation/m3l-common/core";
 *
 * const bar = new M3LLoadingBar();
 * bar.update(0, "Starting");
 * bar.update(50, "Halfway");
 * bar.update(100, "Done");
 * ```
 */
export class M3LLoadingBar {
  private readonly width: number;
  private readonly completeChar: string;
  private readonly incompleteChar: string;
  private readonly stream: NodeJS.WritableStream | undefined;
  private readonly interactiveOption: boolean | undefined;

  /**
   * Creates a new `M3LLoadingBar`. Construction performs no I/O — nothing is
   * written to any stream until `update` is called.
   *
   * @param options - Optional configuration; all fields have sensible
   *   defaults for a terminal-attached process.
   * @throws {@link M3LPromptValidationError} When `width` is supplied and is
   *   not a positive, finite number (rejects `NaN` and `Infinity`, which would
   *   otherwise render an invisible bar or throw from `String.prototype.repeat`).
   */
  constructor(options: M3LLoadingBarOptions = {}) {
    const width = options.width ?? DEFAULT_WIDTH;
    if (!Number.isFinite(width) || width <= 0) {
      throw new M3LPromptValidationError(
        `loading bar width must be a positive finite number, received ${String(width)}`,
        { context: { width } },
      );
    }
    this.width = width;
    this.completeChar = options.completeChar ?? DEFAULT_COMPLETE_CHAR;
    this.incompleteChar = options.incompleteChar ?? DEFAULT_INCOMPLETE_CHAR;
    this.stream = options.stream;
    this.interactiveOption = options.interactive;
  }

  /**
   * Renders the bar at `percentage` complete, optionally alongside a status
   * message. `percentage` is clamped to `[0, 100]`; a non-finite value
   * (`NaN` or `Infinity`) clamps to `0` rather than throwing.
   *
   * @param percentage - Target completion percentage.
   * @param message - Optional status text shown alongside the bar.
   */
  update(percentage: number, message?: string): void {
    const clamped = Number.isFinite(percentage)
      ? Math.min(MAX_PERCENTAGE, Math.max(MIN_PERCENTAGE, percentage))
      : MIN_PERCENTAGE;

    const completeCount = Math.round((clamped / MAX_PERCENTAGE) * this.width);
    const incompleteCount = this.width - completeCount;
    const bar =
      this.completeChar.repeat(completeCount) +
      this.incompleteChar.repeat(incompleteCount);
    const line = `${bar} ${Math.round(clamped)}%${
      message !== undefined ? ` ${message}` : ""
    }`;

    const { stream, live } = resolveRenderTarget(
      this.stream,
      this.interactiveOption,
    );

    const rendered = live ? `\r\x1b[K${line}` : `${line}\n`;
    stream.write(rendered);
  }
}
