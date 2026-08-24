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
import { redactSensitiveLogText, redactSensitiveLogValue } from "./redact.js";
import type { M3LSecretNamesPort } from "./redact.js";
import { isPlainObject } from "../utils/guards.js";

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
 * Merges two optional {@link M3LSecretNamesPort}s additively: when only one
 * side is defined, returns it unchanged; when both are defined, returns a
 * port whose `isSecret` is true if EITHER side's `isSecret` is true (a
 * union, never a narrowing) — mirroring every other `M3LRedactOptions`
 * consumer's "additive only" contract.
 */
function mergeSecrets(
  a: M3LSecretNamesPort | undefined,
  b: M3LSecretNamesPort | undefined,
): M3LSecretNamesPort | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return { isSecret: (name: string) => a.isSecret(name) || b.isSecret(name) };
}

/**
 * Redacts `data` via {@link redactSensitiveLogValue}, proving (via
 * {@link isPlainObject}, never asserting) that the result is still a plain
 * record before returning it — mirroring `core/diagnostics/format-error.ts`'s
 * `redactContext` "proven, not asserted" pattern. `undefined` in yields
 * `undefined` out; a redactor that somehow returns a non-record falls back
 * to `{}` rather than populating the event with an unproven shape.
 */
function redactData(
  data: Record<string, unknown> | undefined,
  secrets: M3LSecretNamesPort | undefined,
): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  const redacted = redactSensitiveLogValue(data, { secrets });
  return isPlainObject(redacted) ? redacted : {};
}

/** Fallback message substituted when redaction itself fails (never the original text). */
const REDACTION_FAILED_PLACEHOLDER = "[m3l-logging: message redaction failed]";

/**
 * Writes a best-effort stderr diagnostic for a redaction failure — a hostile
 * `secrets.isSecret` implementation, or a structural failure (circular
 * reference, excessive depth) in the message/data being redacted — mirroring
 * `dispatch()`'s own adjacent per-handler-failure diagnostic convention.
 * Never includes the original message/data in the diagnostic, since either
 * may carry the very secret redaction was trying to protect.
 */
function reportRedactionFailure(
  category: M3LLogEventCategory,
  cause: unknown,
): void {
  const detail =
    cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
  process.stderr.write(
    `m3l-logging: redaction failed while emitting a "${category}" event: ${detail}\n`,
  );
}

/**
 * Redacts each of `rows` via {@link redactData}, isolating a redaction
 * failure into a single placeholder row rather than letting it propagate out
 * of a table method or crash the caller — mirrors `emit`'s own try/catch
 * isolation around the identical underlying redaction call. Used both for
 * `table`/`simpleTable`'s row-shaped input directly, and for
 * `keyValueTable`'s flat record (passed as the sole element of a one-row
 * array) so a declared secret is matched against the record's OWN field
 * name (e.g. `tenantRef`) before it is ever transformed into the
 * column-shaped `{ key, value }` pairs `M3LTableFormatter` renders — the
 * transformed shape's literal `"value"` column key would never itself match
 * a heuristic or declared secret name.
 */
function redactRowsSafely(
  rows: readonly Record<string, unknown>[],
  secrets: M3LSecretNamesPort | undefined,
): readonly Record<string, unknown>[] {
  try {
    return rows.map((row) => redactData(row, secrets) ?? {});
  } catch (cause) {
    reportRedactionFailure(M3LLogEventCategory.TEXT, cause);
    return [{ error: REDACTION_FAILED_PLACEHOLDER }];
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
  /**
   * An optional port additively widening the redactor's built-in key-name
   * heuristic with caller-declared secret names — e.g.
   * `deriveSecretsSpecifier` over a script's config schema. This is
   * consulted alongside the built-in heuristic on every event this logger
   * emits (`message` and `data` alike, plus rendered table output); it never
   * narrows what the heuristic alone would already redact. See
   * {@link M3LErrorFromOptions.secrets} for the additional, per-call
   * widening `errorFrom`'s third parameter accepts on top of this
   * constructor-level port.
   */
  readonly secrets?: M3LSecretNamesPort | undefined;
}

/**
 * Optional options accepted by {@link M3LLogger.errorFrom}'s third
 * parameter — an additive, per-call widening of this logger's own
 * constructor-level {@link M3LLoggerOptions.secrets}, merged (union, never
 * narrowed) for this one call only.
 */
export interface M3LErrorFromOptions {
  readonly secrets?: M3LSecretNamesPort | undefined;
}

/**
 * Fans structured {@link M3LLogEvent} messages out to an ordered array of
 * handlers — console, file, JSON, or any custom sink implementing the
 * internal handler port. Every message method produces exactly one event
 * carrying the matching {@link M3LLogEventCategory}; table methods render
 * the table up front and emit it as a single `TEXT` event.
 *
 * Every event this logger dispatches — including rendered table output — is
 * redacted before any handler ever sees it: a built-in key-name heuristic
 * runs unconditionally, and {@link M3LLoggerOptions.secrets} additively
 * widens it with caller-declared secret names. A redaction failure (a
 * hostile `secrets.isSecret`, a pathological payload) is itself isolated —
 * it substitutes a fixed placeholder and reports a best-effort stderr
 * diagnostic rather than propagating out of a message method.
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
  readonly #secrets: M3LSecretNamesPort | undefined;

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
    this.#secrets = options?.secrets;
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
   * non-`Error` value (a thrown string, `null`), for an `Error` whose own
   * `message`/`stack` getter itself throws (a hostile getter) — mirroring
   * {@link serializeErrorChain}'s own hostile-getter tolerance for the chain
   * it builds — or for a hostile `options.secrets.isSecret`/constructor-level
   * `secrets.isSecret` implementation that itself throws while redacting the
   * chain: that failure is isolated the same way a redaction failure in any
   * other message method is (a best-effort stderr diagnostic, never the
   * original message/data), falling back to an empty `data` rather than
   * losing the event entirely.
   *
   * @param error - Any caught value.
   * @param message - Optional message override; when omitted, falls back to
   *   `error`'s own message.
   * @param options - Optional; `options.secrets` additively widens redaction
   *   for this one call, merged with this logger's own constructor-level
   *   {@link M3LLoggerOptions.secrets} (union, never narrowed).
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
  errorFrom(
    error: unknown,
    message?: string,
    options?: M3LErrorFromOptions,
  ): void {
    // Captured once, reused for both the chain-building merge below and the
    // `emit` call at the end — `emit` re-merges with `this.#secrets` itself,
    // so a single read here keeps the two merges from ever disagreeing were
    // `options` a non-idempotent getter.
    const secretsOverride = options?.secrets;
    const secrets = mergeSecrets(this.#secrets, secretsOverride);
    const resolvedMessage = message ?? safeGetErrorMessage(error);
    let data: Record<string, unknown>;
    try {
      const chain = serializeErrorChain(error, { secrets });
      const first = chain[0];
      data = {
        chain,
        ...(first?.code !== undefined ? { code: first.code } : {}),
        ...(first?.context !== undefined ? { context: first.context } : {}),
      };
    } catch (cause) {
      // A hostile `secrets.isSecret` (or an equally hostile `error` shape
      // `serializeErrorChain`'s own tolerance doesn't already cover) must
      // never propagate out of `errorFrom` — this is the only call in this
      // method that can reach a caller-declared `secrets` port before
      // `emit`'s own isolation gets a chance to run. Falls back to an empty
      // `data`; the event is still emitted with the resolved message.
      reportRedactionFailure(M3LLogEventCategory.ERROR, cause);
      data = {};
    }
    this.emit(
      M3LLogEventCategory.ERROR,
      resolvedMessage,
      data,
      secretsOverride,
    );
  }

  /**
   * Starts a timing measurement and returns a plain callable that, when
   * invoked, emits a `DEBUG` event carrying `label` and the elapsed duration
   * in milliseconds as `durationMs` (ADR-0035 phase 3). Deliberately a plain
   * `() => void` — **not** a `Disposable` — since `Symbol.dispose` is
   * unavailable under this project's configured `lib` target (the disposable
   * types live in `lib.esnext.disposable.d.ts`, not yet folded into a stable
   * `esYYYY` lib).
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
   * result as a single `TEXT` event. Each row's values are redacted (by the
   * built-in heuristic, plus this logger's own {@link M3LLoggerOptions.secrets})
   * BEFORE rendering — table methods have no per-call `secrets` override seam.
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
   * border style. Redacted the same way as {@link M3LLogger.table}.
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
   * the result as a single `TEXT` event. `record` is redacted BEFORE the
   * `{ key, value }` transform below, so a declared secret is matched
   * against its own original field name (e.g. `tenantRef`) — the transformed
   * column literally named `"value"` would never itself match a heuristic or
   * declared secret name.
   *
   * @param record - The key-value pairs to render.
   * @param options - Table rendering options.
   */
  keyValueTable(
    record: Record<string, unknown>,
    options?: M3LTableOptions,
  ): void {
    const [redactedRecord] = redactRowsSafely([record], this.#secrets);
    const rows = Object.entries(redactedRecord ?? {}).map(([key, value]) => ({
      key,
      value,
    }));
    this.emitTable(rows, options);
  }

  /**
   * Builds and dispatches a single event carrying `category`/`message`/`data`,
   * redacted (via {@link redactSensitiveLogText}/{@link redactSensitiveLogValue})
   * against this logger's own constructor-level `secrets`
   * ({@link M3LLoggerOptions.secrets}) merged additively with `secretsOverride`
   * when a caller (currently only {@link M3LLogger.errorFrom}) supplies one for
   * this single call. A redaction failure (a hostile `secrets.isSecret`, a
   * pathological `data` shape) is isolated — mirroring
   * `M3LBreadcrumbTrail.record()`'s identical "must never propagate"
   * guarantee over the same underlying redaction call — substituting a fixed
   * placeholder message and reporting a best-effort stderr diagnostic rather
   * than throwing out of a message method or crashing the caller.
   */
  private emit(
    category: M3LLogEventCategory,
    message: string,
    data?: Record<string, unknown>,
    secretsOverride?: M3LSecretNamesPort,
  ): void {
    const secrets = mergeSecrets(this.#secrets, secretsOverride);
    let redactedMessage: string;
    let redactedData: Record<string, unknown> | undefined;
    try {
      redactedMessage = redactSensitiveLogText(message, { secrets });
      redactedData = redactData(data, secrets);
    } catch (cause) {
      reportRedactionFailure(category, cause);
      redactedMessage = REDACTION_FAILED_PLACEHOLDER;
      redactedData = undefined;
    }
    const timestamp = new Date();
    const event: M3LLogEvent =
      redactedData === undefined
        ? {
            category,
            message: redactedMessage,
            timestamp,
            ...this.correlationIdField(),
          }
        : {
            category,
            message: redactedMessage,
            data: redactedData,
            timestamp,
            ...this.correlationIdField(),
          };
    this.dispatch(event);
  }

  /**
   * Redacts `rows` (via {@link redactRowsSafely}, against this logger's own
   * constructor-level `secrets` — table methods have no per-call override
   * seam), renders the redacted rows to a table string, and dispatches it as
   * a `TEXT` event. `M3LTableFormatter` renders box-drawn/aligned columns
   * with no `:`/`=` separator between a column name and its value, so
   * redacting only the RENDERED string (as an earlier version of this method
   * did) can never match a sensitive value — the row-level redaction here
   * runs first, against the still-structured data, for that reason. A final
   * {@link redactSensitiveLogText} pass over the rendered string is kept as
   * cheap, idempotent defense-in-depth (an already-redacted value never
   * re-matches). Any failure in either redaction step — a hostile
   * `secrets.isSecret`, a pathological row shape — is isolated the same way
   * `emit` isolates its own redaction failure.
   */
  private emitTable(
    rows: readonly Record<string, unknown>[],
    options?: M3LTableOptions,
  ): void {
    const redactedRows = redactRowsSafely(rows, this.#secrets);
    let redactedMessage: string;
    try {
      const rendered = this.#formatter.format(redactedRows, options);
      redactedMessage = redactSensitiveLogText(rendered, {
        secrets: this.#secrets,
      });
    } catch (cause) {
      reportRedactionFailure(M3LLogEventCategory.TEXT, cause);
      redactedMessage = REDACTION_FAILED_PLACEHOLDER;
    }
    this.dispatch({
      category: M3LLogEventCategory.TEXT,
      message: redactedMessage,
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
