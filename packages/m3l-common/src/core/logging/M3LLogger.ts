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
 * consumer's "additive only" contract. Each side is normalized to a strict
 * `=== true` individually (not just the combined `||` result): `isSecret`'s
 * `boolean` return type is trusted only as far as its declared type, and a
 * caller crossing that boundary (an untyped/JS/cast path) with a truthy
 * non-boolean must not short-circuit `||` and silently poison the other
 * side's contribution.
 */
function mergeSecrets(
  a: M3LSecretNamesPort | undefined,
  b: M3LSecretNamesPort | undefined,
): M3LSecretNamesPort | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return {
    isSecret: (name: string) =>
      a.isSecret(name) === true || b.isSecret(name) === true,
  };
}

/** Fallback message substituted when redaction itself fails (never the original text). */
const REDACTION_FAILED_PLACEHOLDER = "[m3l-logging: message redaction failed]";

/**
 * Writes a best-effort stderr diagnostic for a redaction failure — a hostile
 * `secrets.isSecret` implementation, or a structural failure (circular
 * reference, excessive depth) in the message/data being redacted — mirroring
 * `dispatch()`'s own adjacent per-handler-failure diagnostic convention.
 * Never includes the original message/data, since either may carry the very
 * secret redaction was trying to protect. Wrapped in its own try/catch: a
 * hostile `cause` (a `stack`/`message` getter, or `toString`, that itself
 * throws) must not defeat the very isolation this helper exists to provide —
 * a second-order failure here falls back to a fixed, detail-free line rather
 * than propagating.
 */
function reportRedactionFailure(
  category: M3LLogEventCategory,
  cause: unknown,
): void {
  try {
    const detail =
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    process.stderr.write(
      `m3l-logging: redaction failed while emitting a "${category}" event: ${detail}\n`,
    );
  } catch {
    process.stderr.write(
      `m3l-logging: redaction failed while emitting a "${category}" event (unreadable failure detail)\n`,
    );
  }
}

/**
 * Wraps `secrets` so a throwing `isSecret` implementation can never escape to
 * a caller. This matters beyond `M3LLogger`'s own direct redaction calls: an
 * unguarded `secrets` handed to {@link serializeErrorChain} would throw
 * INSIDE that function's own body, which is wrapped in an unconditional,
 * silent catch-all (`core/diagnostics/format-error.ts`) that swallows the
 * exception and returns a generic placeholder chain — discarding the error's
 * real chain/context with no diagnostic at all. Guarding `isSecret` here
 * means the throw is caught at the call site, reported, and the name is
 * conservatively treated as secret (redacted) rather than the surrounding
 * redaction/serialization step losing everything it was building. A
 * redaction *decision* that can't be trusted should fail toward hiding a
 * value, never toward exposing it.
 */
function guardSecrets(
  secrets: M3LSecretNamesPort | undefined,
  category: M3LLogEventCategory,
): M3LSecretNamesPort | undefined {
  if (secrets === undefined) return undefined;
  return {
    isSecret: (name: string): boolean => {
      try {
        return secrets.isSecret(name) === true;
      } catch (cause) {
        reportRedactionFailure(category, cause);
        return true;
      }
    },
  };
}

/**
 * Redacts `data` via {@link redactSensitiveLogValue}, proving (via
 * {@link isPlainObject}, never asserting) that the result is still a plain
 * record before returning it — mirroring `core/diagnostics/format-error.ts`'s
 * `redactContext` "proven, not asserted" pattern. `undefined` in yields
 * `undefined` out; a redactor that somehow returns a non-record falls back
 * to `{}` rather than populating the event with an unproven shape. `secrets`
 * is expected to already be {@link guardSecrets}-wrapped by the caller.
 */
function redactData(
  data: Record<string, unknown> | undefined,
  secrets: M3LSecretNamesPort | undefined,
): Record<string, unknown> | undefined {
  if (data === undefined) return undefined;
  const redacted = redactSensitiveLogValue(data, { secrets });
  return isPlainObject(redacted) ? redacted : {};
}

/**
 * Redacts each of `rows` via {@link redactData} against a
 * {@link guardSecrets}-wrapped `secrets`, isolating a STRUCTURAL redaction
 * failure (e.g. a circular row) into a single placeholder row rather than
 * letting it propagate out of a table method or crash the caller — a hostile
 * `secrets.isSecret` no longer reaches this outer catch at all, since
 * `guardSecrets` already handles it per-key. Used both for `table`/
 * `simpleTable`'s row-shaped input directly, and for `keyValueTable`'s flat
 * record (passed as the sole element of a one-row array) so a declared
 * secret is matched against the record's OWN field name (e.g. `tenantRef`)
 * before it is ever transformed into the column-shaped `{ key, value }`
 * pairs `M3LTableFormatter` renders — the transformed shape's literal
 * `"value"` column key would never itself match a heuristic or declared
 * secret name.
 */
function redactRowsSafely(
  rows: readonly Record<string, unknown>[],
  secrets: M3LSecretNamesPort | undefined,
): readonly Record<string, unknown>[] {
  const guarded = guardSecrets(secrets, M3LLogEventCategory.TEXT);
  try {
    return rows.map((row) => redactData(row, guarded) ?? {});
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
 * widens it with caller-declared secret names. A throwing `secrets.isSecret`
 * is guarded per-key (via an internal `guardSecrets` wrapper): the offending
 * name is conservatively treated as secret (redacted) and a best-effort
 * stderr diagnostic is reported, without losing the rest of the
 * message/data. A try/catch around each redaction call remains only as a
 * last-resort net for a genuinely STRUCTURAL failure (a circular reference,
 * excessive depth) — never propagating out of a message method.
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
   * it builds — or for a hostile `options.secrets` (a throwing accessor on
   * the property itself, or a throwing `isSecret` implementation): a
   * throwing `isSecret` is caught per name during chain-building and
   * conservatively treated as secret, with a best-effort stderr diagnostic,
   * so the real chain is preserved rather than lost wholesale to
   * `serializeErrorChain`'s own silent internal catch-all.
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
    // Reading `options.secrets` is itself guarded: a hostile ACCESSOR getter
    // (as opposed to a hostile `isSecret` METHOD, guarded separately below via
    // `guardSecrets`) must not throw out of `errorFrom` before redaction even
    // begins.
    let secretsOverride: M3LSecretNamesPort | undefined;
    try {
      secretsOverride = options?.secrets;
    } catch (cause) {
      reportRedactionFailure(M3LLogEventCategory.ERROR, cause);
      secretsOverride = undefined;
    }
    // guardSecrets wraps the merged port BEFORE it reaches serializeErrorChain:
    // that function's own body is wrapped in an unconditional, silent
    // catch-all with no diagnostic, so an unguarded throw here would vanish
    // along with the entire real chain it was building. Guarding per-key here
    // means a throwing `isSecret` degrades to "treat this one name as secret"
    // instead of losing the whole chain.
    const secrets = guardSecrets(
      mergeSecrets(this.#secrets, secretsOverride),
      M3LLogEventCategory.ERROR,
    );
    const chain = serializeErrorChain(error, { secrets });
    const first = chain[0];
    const resolvedMessage = message ?? safeGetErrorMessage(error);
    const data: Record<string, unknown> = {
      chain,
      ...(first?.code !== undefined ? { code: first.code } : {}),
      ...(first?.context !== undefined ? { context: first.context } : {}),
    };
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
   * this single call. A throwing `secrets.isSecret` is guarded per-key by
   * `guardSecrets` before it ever reaches the try/catch below, so that
   * try/catch remains only as a last-resort net for a genuinely STRUCTURAL
   * redaction failure (a pathological `data` shape, e.g. a circular
   * reference) — mirroring `M3LBreadcrumbTrail.record()`'s identical "must
   * never propagate" guarantee over the same underlying redaction call —
   * substituting a fixed placeholder message and reporting a best-effort
   * stderr diagnostic rather than throwing out of a message method or
   * crashing the caller.
   */
  private emit(
    category: M3LLogEventCategory,
    message: string,
    data?: Record<string, unknown>,
    secretsOverride?: M3LSecretNamesPort,
  ): void {
    const secrets = guardSecrets(
      mergeSecrets(this.#secrets, secretsOverride),
      category,
    );
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
        secrets: guardSecrets(this.#secrets, M3LLogEventCategory.TEXT),
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
