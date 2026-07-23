/**
 * `core/logging/M3LLogger` — the logger facade over an ordered handler
 * array.
 *
 * @packageDocumentation
 */

import { getErrorMessage } from "../errors/index.js";
import { serializeErrorChain } from "../diagnostics/format-error.js";
import {
  assertValidFloor,
  passesFloor,
} from "../../internal/logging/levels.js";
import { M3LLogEventCategory } from "./M3LLogEventCategory.js";
import type { M3LLogLevelFloor } from "./M3LLogEventCategory.js";
import type { M3LLogEvent, M3LLoggerHandler } from "./M3LLogEvent.js";
import { M3LTableFormatter } from "./M3LTableFormatter.js";
import type { M3LTableOptions } from "./M3LTableFormatter.js";

/** Placeholder message used when reading an error's own `.message` throws (a hostile getter). */
const UNREADABLE_MESSAGE_PLACEHOLDER = "[unreadable error message]";

/**
 * `getErrorMessage`, guarded against a caught value whose own `message`
 * getter throws. `errorFrom` runs from a `catch` block, so the caught value
 * is never under this library's control — an `Error` subclass (or a
 * post-construction `Object.defineProperty` override) can make reading
 * `.message` itself throw, which would otherwise make `errorFrom` itself
 * throw a *new* exception out of the caller's own `catch`, hiding the
 * original failure entirely. Falls back to a fixed placeholder rather than
 * propagating.
 */
function safeGetErrorMessage(error: unknown): string {
  try {
    return getErrorMessage(error);
  } catch {
    return UNREADABLE_MESSAGE_PLACEHOLDER;
  }
}

/**
 * Optional construction options for {@link M3LLogger}.
 *
 * @example
 * ```ts
 * import { M3LLogger } from "@m3l-automation/m3l-common/core";
 * import type { M3LLoggerOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LLoggerOptions = { correlationId: "run-1234" };
 * const logger = new M3LLogger([], options);
 * ```
 */
export interface M3LLoggerOptions {
  /**
   * A per-run trace identifier stamped onto every {@link M3LLogEvent} this
   * logger dispatches. Lets a downstream aggregator (CloudWatch Insights, a
   * log collector) group all the lines emitted during one script run or
   * Lambda invocation. Not a secret — redaction helpers pass it through
   * untouched.
   */
  readonly correlationId?: string;
  /**
   * The minimum {@link M3LLogLevelFloor} this logger admits (ADR-0035 phase
   * 3, narrowed from the full {@link M3LLogEventCategory} union in the
   * review fix round). Defaults to `undefined`, meaning no floor — every
   * category is admitted, preserving pre-A3 behaviour exactly.
   *
   * The severity ranking (`src/internal/logging/levels.ts`) has deliberate
   * ties — the categories are presentational groupings, not a ladder in
   * their own right, so `text`/`step`/`info`/`section`/`header` all rank
   * `1`. {@link M3LLogLevelFloor} keeps only `info` as the one spellable
   * floor for that tie, but the runtime tie itself is unaffected: a floor of
   * `INFO` still admits `text`/`step`/`section`/`header` **events**, since
   * `passesFloor` compares by rank, not by exact category match.
   *
   * A per-handler `minLevel` (see {@link M3LConsoleLoggerHandlerOptions},
   * {@link M3LJsonLoggerHandlerOptions}, {@link M3LFileLoggerHandlerOptions})
   * composes with this floor — **the stricter of the two wins**, since each
   * handler self-filters independently of the logger's own floor check.
   */
  readonly minLevel?: M3LLogLevelFloor;
}

/**
 * Fans structured {@link M3LLogEvent} messages out to an ordered array of
 * handlers — console, file, JSON, or any custom sink implementing the
 * internal handler port. Every message method produces exactly one event
 * carrying the matching {@link M3LLogEventCategory}; table methods render
 * the table up front and emit it as a single `TEXT` event.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const logger = new Core.M3LLogger([
 *   new Core.M3LConsoleLoggerHandler(),
 *   new Core.M3LJsonLoggerHandler(),
 * ]);
 *
 * logger.header("Import run");
 * logger.step("Reading source file");
 * logger.success("Imported 1200 rows", { rows: 1200 });
 * ```
 */
export class M3LLogger {
  readonly #handlers: readonly M3LLoggerHandler[];
  readonly #formatter = new M3LTableFormatter();
  readonly #correlationId: string | undefined;
  readonly #minLevel: M3LLogEventCategory | undefined;

  /**
   * Creates a logger over the given ordered handler array.
   *
   * @param handlers - The handlers to fan events out to, in call order. An
   *   empty array is accepted; message methods then become no-ops.
   * @param options - Optional construction options. When `correlationId` is
   *   supplied, it is stamped onto every event this logger dispatches. When
   *   `minLevel` is supplied, an event below that floor is dropped before any
   *   handler sees it (see {@link M3LLoggerOptions.minLevel}).
   */
  constructor(
    handlers: readonly M3LLoggerHandler[],
    options?: M3LLoggerOptions,
  ) {
    assertValidFloor(options?.minLevel, "M3LLogger");
    this.#handlers = handlers;
    this.#correlationId = options?.correlationId;
    this.#minLevel = options?.minLevel;
  }

  /** Emits a `TEXT` event. */
  text(message: string, data?: Record<string, unknown>): void {
    this.emit(M3LLogEventCategory.TEXT, message, data);
  }

  /** Emits a `STEP` event. */
  step(message: string, data?: Record<string, unknown>): void {
    this.emit(M3LLogEventCategory.STEP, message, data);
  }

  /** Emits an `INFO` event. */
  info(message: string, data?: Record<string, unknown>): void {
    this.emit(M3LLogEventCategory.INFO, message, data);
  }

  /** Emits a `SUCCESS` event. */
  success(message: string, data?: Record<string, unknown>): void {
    this.emit(M3LLogEventCategory.SUCCESS, message, data);
  }

  /** Emits a `WARNING` event. */
  warning(message: string, data?: Record<string, unknown>): void {
    this.emit(M3LLogEventCategory.WARNING, message, data);
  }

  /** Emits an `ERROR` event. */
  error(message: string, data?: Record<string, unknown>): void {
    this.emit(M3LLogEventCategory.ERROR, message, data);
  }

  /** Emits a `FATAL` event. */
  fatal(message: string, data?: Record<string, unknown>): void {
    this.emit(M3LLogEventCategory.FATAL, message, data);
  }

  /** Emits a `SECTION` event. */
  section(message: string, data?: Record<string, unknown>): void {
    this.emit(M3LLogEventCategory.SECTION, message, data);
  }

  /** Emits a `HEADER` event. */
  header(message: string, data?: Record<string, unknown>): void {
    this.emit(M3LLogEventCategory.HEADER, message, data);
  }

  /** Emits a spacer event: `TEXT` category with an empty message. */
  newline(): void {
    this.emit(M3LLogEventCategory.TEXT, "");
  }

  /**
   * Emits an `ERROR` event from an arbitrary caught value (ADR-0035 phase
   * 3) — the `unknown` parameter type reflects that this is called from a
   * `catch` block, where the caught value's type is never statically known.
   * `data` carries the full recursive `cause` chain (via
   * {@link serializeErrorChain}, redacted by default) plus the outermost
   * level's `code`/`context` when present, promoted for easy top-level
   * querying by a downstream log collector. Never throws, even for a
   * non-`Error` value (a thrown string, `null`) or for an `Error` whose own
   * `message`/`stack` getter itself throws (a hostile getter) — the event is
   * still emitted, falling back to a fixed placeholder message when `error`'s
   * own message cannot be read, mirroring {@link serializeErrorChain}'s own
   * hostile-getter tolerance for the chain it builds.
   *
   * @param error - Any caught value.
   * @param message - Optional message override; when omitted, falls back to
   *   `error`'s own message.
   * @example
   * ```ts
   * import { Core } from "@m3l-automation/m3l-common";
   *
   * const logger = new Core.M3LLogger([new Core.M3LConsoleLoggerHandler()]);
   * try {
   *   await run();
   * } catch (error: unknown) {
   *   logger.errorFrom(error);
   * }
   * ```
   */
  errorFrom(error: unknown, message?: string): void {
    const chain = serializeErrorChain(error);
    const first = chain[0];
    const resolvedMessage = message ?? safeGetErrorMessage(error);
    const data: Record<string, unknown> = {
      chain,
      ...(first?.code !== undefined ? { code: first.code } : {}),
      ...(first?.context !== undefined ? { context: first.context } : {}),
    };
    this.emit(M3LLogEventCategory.ERROR, resolvedMessage, data);
  }

  /**
   * Starts a timing measurement and returns a plain callable that, when
   * invoked, emits a `DEBUG` event carrying `label` and the elapsed duration
   * in milliseconds as `durationMs` (ADR-0035 phase 3). Deliberately a plain
   * `() => void` — **not** a `Disposable` — since `Symbol.dispose` is
   * unavailable under this project's `lib: ["es2024"]` target.
   *
   * @param label - A human-readable name for the measured span.
   * @returns A callable that emits the `DEBUG` timing event when invoked.
   * @example
   * ```ts
   * import { Core } from "@m3l-automation/m3l-common";
   *
   * const logger = new Core.M3LLogger([new Core.M3LConsoleLoggerHandler()]);
   * const stop = logger.time("import-step");
   * await importData();
   * stop();
   * ```
   */
  time(label: string): () => void {
    const start = performance.now();
    return (): void => {
      const durationMs = performance.now() - start;
      this.emit(M3LLogEventCategory.DEBUG, label, { label, durationMs });
    };
  }

  /**
   * Renders `rows` as a table (via {@link M3LTableFormatter}) and emits the
   * result as a single `TEXT` event.
   *
   * @param rows - The rows to render.
   * @param options - Table rendering options.
   */
  table(
    rows: readonly Record<string, unknown>[],
    options?: M3LTableOptions,
  ): void {
    this.emitTable(rows, options);
  }

  /**
   * Renders `rows` as a minimal (`border-less`) table and emits the result
   * as a single `TEXT` event, unless `options` explicitly overrides the
   * border style.
   *
   * @param rows - The rows to render.
   * @param options - Table rendering options; `border` defaults to
   *   `"border-less"`.
   */
  simpleTable(
    rows: readonly Record<string, unknown>[],
    options?: M3LTableOptions,
  ): void {
    this.emitTable(rows, { border: "border-less", ...options });
  }

  /**
   * Renders a flat record as a two-column (`key`, `value`) table and emits
   * the result as a single `TEXT` event.
   *
   * @param record - The key-value pairs to render.
   * @param options - Table rendering options.
   */
  keyValueTable(
    record: Record<string, unknown>,
    options?: M3LTableOptions,
  ): void {
    const rows = Object.entries(record).map(([key, value]) => ({
      key,
      value,
    }));
    this.emitTable(rows, options);
  }

  /** Builds and dispatches a single event carrying `category`/`message`/`data`. */
  private emit(
    category: M3LLogEventCategory,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const timestamp = new Date();
    const event: M3LLogEvent =
      data === undefined
        ? { category, message, timestamp, ...this.correlationIdField() }
        : {
            category,
            message,
            data,
            timestamp,
            ...this.correlationIdField(),
          };
    this.dispatch(event);
  }

  /** Renders `rows` to a table string and dispatches it as a `TEXT` event. */
  private emitTable(
    rows: readonly Record<string, unknown>[],
    options?: M3LTableOptions,
  ): void {
    const rendered = this.#formatter.format(rows, options);
    this.dispatch({
      category: M3LLogEventCategory.TEXT,
      message: rendered,
      timestamp: new Date(),
      ...this.correlationIdField(),
    });
  }

  /**
   * Returns `{ correlationId }` when this logger was constructed with one,
   * or an empty object otherwise — a conditional spread so the field is
   * genuinely absent (not `undefined`) under `exactOptionalPropertyTypes`.
   */
  private correlationIdField(): { readonly correlationId?: string } {
    return this.#correlationId !== undefined
      ? { correlationId: this.#correlationId }
      : {};
  }

  /**
   * Fans `event` out to every handler in constructor order, unless this
   * logger's own `minLevel` floor rejects it first — checked once, here,
   * so every emission path (`emit`/`emitTable`/`newline`) is covered
   * uniformly rather than re-checked per message method. A handler that
   * throws is isolated so it cannot prevent the remaining handlers from
   * receiving the event — logging must never crash the caller — but the
   * failure is not silently discarded: it is written to `process.stderr` as
   * a last-resort, best-effort diagnostic since the library must not log
   * through its own handler chain by default.
   */
  private dispatch(event: M3LLogEvent): void {
    if (!passesFloor(event.category, this.#minLevel)) return;

    for (const handler of this.#handlers) {
      try {
        handler.handle(event);
      } catch (cause) {
        // Handler error isolation: a misbehaving handler must not block the
        // rest of the fan-out. We deliberately do not rethrow (that would
        // defeat isolation) and do not swallow silently either — write a
        // best-effort diagnostic directly to stderr, bypassing the handler
        // chain itself to avoid recursive failure. Prefer the stack (falling
        // back to the message) so the diagnostic is actionable; the event's
        // own `message`/`data` are never included, since they may carry
        // caller-supplied content.
        const detail =
          cause instanceof Error
            ? (cause.stack ?? cause.message)
            : String(cause);
        process.stderr.write(
          `m3l-logging: handler threw while handling a "${event.category}" event: ${detail}\n`,
        );
      }
    }
  }
}
