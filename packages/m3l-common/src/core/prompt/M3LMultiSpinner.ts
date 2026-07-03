/**
 * `core/prompt/M3LMultiSpinner` — concurrent, ID-tracked task spinners with a
 * backward-compatible single-spinner subset.
 *
 * @packageDocumentation
 */

import { resolveRenderTarget } from "../../internal/prompt/ansi.js";

/** Reserved task ID backing the single-spinner method subset. */
const SINGLE_SPINNER_ID = "__m3l_single_spinner__";

/** Default glyph shown when a task finishes successfully. */
const DEFAULT_SUCCESS_SYMBOL = "✔";
/** Default glyph shown when a task finishes with a failure. */
const DEFAULT_FAILURE_SYMBOL = "✖";
/** Default glyph shown when a task finishes with a warning. */
const DEFAULT_WARNING_SYMBOL = "⚠";

/**
 * The terminal glyphs used to annotate a finished task line.
 *
 * @example
 * ```ts
 * import type { M3LMultiSpinnerOptions } from "@m3l-automation/m3l-common/core";
 *
 * const symbols: M3LMultiSpinnerOptions["symbols"] = {
 *   success: "OK",
 *   failure: "FAIL",
 *   warning: "WARN",
 * };
 * ```
 */
interface M3LMultiSpinnerSymbols {
  /** Glyph shown when a task finishes successfully. Defaults to `"✔"`. */
  readonly success?: string;
  /** Glyph shown when a task finishes with a failure. Defaults to `"✖"`. */
  readonly failure?: string;
  /** Glyph shown when a task finishes with a warning. Defaults to `"⚠"`. */
  readonly warning?: string;
}

/**
 * Constructor options for {@link M3LMultiSpinner}.
 *
 * @example
 * ```ts
 * import type { M3LMultiSpinnerOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LMultiSpinnerOptions = {
 *   stream: process.stderr,
 *   interactive: false,
 * };
 * ```
 */
export interface M3LMultiSpinnerOptions {
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
  /** Overrides for the finished-task glyphs. */
  readonly symbols?: M3LMultiSpinnerSymbols;
}

/** Internal bookkeeping for a single tracked spinner task. */
interface SpinnerTask {
  text: string;
}

/**
 * Tracks concurrent, named spinner tasks and renders their state to a
 * stream. In an interactive TTY, output uses live ANSI redraw; otherwise
 * (Lambda, CI, a pipe) it degrades to one plain-text line per state change
 * with no ANSI escape sequences.
 *
 * Also exposes a backward-compatible single-spinner subset
 * (`startSpinner`/`updateSpinner`/`spinnerStop`/`spinnerFail`) that drives
 * one implicit, reserved-ID task.
 *
 * @example
 * ```ts
 * import { M3LMultiSpinner } from "@m3l-automation/m3l-common/core";
 *
 * const spinner = new M3LMultiSpinner();
 * spinner.spin("upload", "Uploading…");
 * spinner.spin("index", "Indexing…");
 * spinner.spinSucceed("upload", "Uploaded");
 * spinner.spinFail("index", "Index failed");
 * ```
 */
export class M3LMultiSpinner {
  private readonly stream: NodeJS.WritableStream | undefined;
  private readonly interactiveOption: boolean | undefined;
  private readonly successSymbol: string;
  private readonly failureSymbol: string;
  private readonly warningSymbol: string;
  private readonly tasks = new Map<string, SpinnerTask>();

  /**
   * Creates a new `M3LMultiSpinner`. Construction performs no I/O — nothing
   * is written to any stream until `spin`/`spinSucceed`/`spinFail`/`spinWarn`
   * or a single-spinner method is called.
   *
   * @param options - Optional configuration; all fields have sensible
   *   defaults for a terminal-attached process.
   */
  constructor(options: M3LMultiSpinnerOptions = {}) {
    this.stream = options.stream;
    this.interactiveOption = options.interactive;
    this.successSymbol = options.symbols?.success ?? DEFAULT_SUCCESS_SYMBOL;
    this.failureSymbol = options.symbols?.failure ?? DEFAULT_FAILURE_SYMBOL;
    this.warningSymbol = options.symbols?.warning ?? DEFAULT_WARNING_SYMBOL;
  }

  /**
   * Starts or updates a spinner task tracked by `id`. Creating a task with an
   * ID already in progress simply updates its text.
   *
   * @param id - The task's identifier, unique among concurrently-running tasks.
   * @param text - The line of text shown alongside the spinner glyph.
   */
  spin(id: string, text: string): void {
    this.tasks.set(id, { text });
    this.writeLine(text);
  }

  /**
   * Marks the task tracked by `id` as succeeded and stops tracking it. A
   * call with an unknown `id` is a no-op — it never throws.
   *
   * @param id - The task's identifier.
   * @param text - Replacement text for the final line; defaults to the
   *   task's last known text.
   */
  spinSucceed(id: string, text?: string): void {
    this.finish(id, this.successSymbol, text);
  }

  /**
   * Marks the task tracked by `id` as failed and stops tracking it. A call
   * with an unknown `id` is a no-op — it never throws.
   *
   * @param id - The task's identifier.
   * @param text - Replacement text for the final line; defaults to the
   *   task's last known text.
   */
  spinFail(id: string, text?: string): void {
    this.finish(id, this.failureSymbol, text);
  }

  /**
   * Marks the task tracked by `id` as finished with a warning and stops
   * tracking it. A call with an unknown `id` is a no-op — it never throws.
   *
   * @param id - The task's identifier.
   * @param text - Replacement text for the final line; defaults to the
   *   task's last known text.
   */
  spinWarn(id: string, text?: string): void {
    this.finish(id, this.warningSymbol, text);
  }

  /**
   * Starts the single, backward-compatible reserved-ID spinner task.
   *
   * @param message - The line of text shown alongside the spinner glyph.
   */
  startSpinner(message: string): void {
    this.spin(SINGLE_SPINNER_ID, message);
  }

  /**
   * Updates the single, backward-compatible reserved-ID spinner task.
   *
   * @param message - The replacement line of text.
   */
  updateSpinner(message: string): void {
    this.spin(SINGLE_SPINNER_ID, message);
  }

  /**
   * Stops the single, backward-compatible reserved-ID spinner task,
   * marking it succeeded.
   *
   * @param text - Replacement text for the final line; defaults to the
   *   task's last known text.
   */
  spinnerStop(text?: string): void {
    this.spinSucceed(SINGLE_SPINNER_ID, text);
  }

  /**
   * Stops the single, backward-compatible reserved-ID spinner task,
   * marking it failed.
   *
   * @param text - Replacement text for the final line; defaults to the
   *   task's last known text.
   */
  spinnerFail(text?: string): void {
    this.spinFail(SINGLE_SPINNER_ID, text);
  }

  /** Finalizes a tracked task with a glyph, or no-ops for an unknown ID. */
  private finish(id: string, symbol: string, text: string | undefined): void {
    const task = this.tasks.get(id);
    if (task === undefined) return;
    this.tasks.delete(id);
    this.writeLine(`${symbol} ${text ?? task.text}`);
  }

  /** Writes one rendered line to the destination stream. */
  private writeLine(line: string): void {
    const { stream, live } = resolveRenderTarget(
      this.stream,
      this.interactiveOption,
    );

    // Live mode redraws the current line in place; plain mode appends one
    // line per state change with no ANSI escape sequences at all.
    const rendered = live ? `\r\x1b[K${line}\n` : `${line}\n`;
    stream.write(rendered);
  }
}
