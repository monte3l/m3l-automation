/**
 * `core/logging/M3LJsonLoggerHandler` — one-JSON-line-per-event sink.
 *
 * @packageDocumentation
 */

import {
  assertValidFloor,
  passesFloor,
} from "../../internal/logging/levels.js";
import { isDangerousKey } from "../security/index.js";
import { M3LLogEventCategory } from "./M3LLogEventCategory.js";
import type { M3LLogLevelFloor } from "./M3LLogEventCategory.js";
import type { M3LLogEvent, M3LLoggerHandler } from "./M3LLogEvent.js";

/** A JSON scalar value: what {@link M3LJsonLoggerHandler} promotes to the top level. */
type JsonScalar = string | number | boolean | null;

/** Narrows `value` to a {@link JsonScalar}. */
function isJsonScalar(value: unknown): value is JsonScalar {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  );
}

/**
 * Envelope keys owned by the handler itself. A caller `data` field sharing
 * one of these names must never overwrite the envelope — it is routed into
 * the nested `data` object instead so the JSON payload's own shape stays
 * authoritative and unambiguous.
 */
const RESERVED_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "category",
  "message",
  "indent",
  "timestamp",
  "data",
  "correlationId",
]);

/** Builds the authoritative envelope fields (`category`/`message`/`indent`/`timestamp`/`correlationId`) for `event`. */
function buildEnvelope(event: M3LLogEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    category: event.category,
    message: event.message,
  };
  if (event.indent !== undefined) payload.indent = event.indent;
  if (event.timestamp !== undefined) {
    payload.timestamp = event.timestamp.toISOString();
  }
  if (event.correlationId !== undefined) {
    payload.correlationId = event.correlationId;
  }
  return payload;
}

/** The result of splitting `event.data` into top-level-promotable and nested-only fields. */
interface SplitDataFields {
  /** Scalar fields safe to promote onto the top-level payload. */
  readonly promoted: Record<string, unknown>;
  /** Fields that must stay nested under `data` (non-scalar, or a reserved-key collision). */
  readonly nested: Record<string, unknown>;
}

/**
 * Splits `data`'s entries into scalar fields promotable to the top level and
 * fields that must instead stay nested under `data` — because they are
 * non-scalar, or because their key collides with a reserved envelope field
 * (so promoting them would clobber `category`/`message`/`indent`/
 * `timestamp`/`data` itself). A prototype-pollution key
 * (`__proto__`/`constructor`/`prototype`) is skipped outright, reaching
 * neither object.
 */
function splitDataFields(data: Record<string, unknown>): SplitDataFields {
  const promoted: Record<string, unknown> = {};
  const nested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isDangerousKey(key)) continue;

    if (RESERVED_ENVELOPE_KEYS.has(key) || !isJsonScalar(value)) {
      nested[key] = value;
    } else {
      promoted[key] = value;
    }
  }
  return { promoted, nested };
}

/**
 * Construction options for {@link M3LJsonLoggerHandler}.
 *
 * @example
 * ```ts
 * import type { M3LJsonLoggerHandlerOptions } from "@m3l-automation/m3l-common/core";
 * import { M3LLogEventCategory } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LJsonLoggerHandlerOptions = {
 *   minLevel: M3LLogEventCategory.WARNING,
 * };
 * ```
 */
export interface M3LJsonLoggerHandlerOptions {
  /**
   * This handler's own severity floor; see
   * {@link M3LLoggerOptions.minLevel} for the full contract (composition
   * with the owning {@link M3LLogger}'s floor, the rank-tie behavior).
   */
  readonly minLevel?: M3LLogLevelFloor;
}

/**
 * Writes one newline-terminated line of JSON per {@link M3LLogEvent} to
 * `process.stdout` — one CloudWatch (or other line-oriented log collector)
 * entry per message. Scalar fields (`string | number | boolean | null`) of
 * `event.data` are promoted to the top level of the JSON payload for easy
 * querying; non-scalar fields stay nested under `data`. Empty spacer events
 * (`newline()`) are dropped entirely — no line is written.
 *
 * @example
 * ```ts
 * import { Core } from "@m3l-automation/m3l-common";
 *
 * const handler = new Core.M3LJsonLoggerHandler();
 * const logger = new Core.M3LLogger([handler]);
 * logger.success("Imported 1200 rows", { rows: 1200 });
 * ```
 */
export class M3LJsonLoggerHandler implements M3LLoggerHandler {
  readonly #minLevel: M3LLogEventCategory | undefined;

  /**
   * Creates a JSON logger handler.
   *
   * @param options - Optional construction options.
   */
  constructor(options: M3LJsonLoggerHandlerOptions = {}) {
    assertValidFloor(options.minLevel, "M3LJsonLoggerHandler");
    this.#minLevel = options.minLevel;
  }

  /**
   * Writes `event` as one JSON line, unless it is an empty spacer event.
   * Self-filters against this handler's own `minLevel` floor before
   * rendering.
   *
   * @param event - The event to render.
   */
  handle(event: M3LLogEvent): void {
    if (!passesFloor(event.category, this.#minLevel)) return;

    if (event.category === M3LLogEventCategory.TEXT && event.message === "") {
      // Spacer events carry no information worth a CloudWatch log entry.
      return;
    }

    const envelope = buildEnvelope(event);
    const { promoted, nested } = splitDataFields(event.data ?? {});
    const payload: Record<string, unknown> =
      Object.keys(nested).length > 0
        ? { ...envelope, ...promoted, data: nested }
        : { ...envelope, ...promoted };

    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * No-op: {@link M3LJsonLoggerHandler} holds no internal state to reset.
   */
  reset(): void {
    // Intentionally empty — this handler is stateless.
  }
}
