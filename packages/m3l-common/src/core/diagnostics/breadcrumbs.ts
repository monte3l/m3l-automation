/**
 * `core/diagnostics/breadcrumbs` — a bounded, redacted ring buffer of
 * lifecycle events, attachable to any emitter exposing `on`/`off`.
 *
 * The central security contract: a library event payload is not safe to
 * store verbatim (an HTTP client's `request` event carries raw merged
 * headers — `Authorization` rides there — and its `error` event carries a
 * raw error instance; an importer's `import:item` carries the raw caller
 * record and `import:error` a raw error). Every payload is therefore
 * projected through a per-event summarizer that keeps scalars only, then
 * passed through `redactSensitiveLogValue` before it is stored.
 *
 * @packageDocumentation
 */

import { M3LError } from "../errors/index.js";
import { redactSensitiveLogValue } from "../logging/redact.js";

import { scrubUrlsInText } from "./format-error.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One redacted breadcrumb entry recorded by an {@link M3LBreadcrumbTrail}.
 *
 * @example
 * ```ts
 * import type { M3LBreadcrumb } from "@m3l-automation/m3l-common/core";
 *
 * const entry: M3LBreadcrumb = {
 *   timestamp: new Date().toISOString(),
 *   source: "M3LRetryRunner",
 *   event: "retry:attempt",
 *   payload: { attempt: 1, maxAttempts: 5 },
 * };
 * ```
 */
export interface M3LBreadcrumb {
  /** ISO-8601 timestamp captured when the breadcrumb was recorded. */
  readonly timestamp: string;
  /** The emitter label this breadcrumb was recorded under. */
  readonly source: string;
  /** The event name, verbatim from the emitter. */
  readonly event: string;
  /** The redacted, scalar-only projection of the original payload. */
  readonly payload: Readonly<
    Record<string, M3LBreadcrumbScalar | readonly M3LBreadcrumbScalar[]>
  >;
}

/**
 * The scalar value types a redacted {@link M3LBreadcrumb.payload} entry may
 * hold — everything a per-event summarizer keeps, and everything
 * `redactSensitiveLogValue` may substitute in.
 *
 * @example
 * ```ts
 * import type { M3LBreadcrumbScalar } from "@m3l-automation/m3l-common/core";
 *
 * const values: M3LBreadcrumbScalar[] = ["ok", 200, true, null];
 * ```
 */
export type M3LBreadcrumbScalar = string | number | boolean | null;

/**
 * The minimal structural shape {@link M3LBreadcrumbTrail.attach} needs from
 * an emitter: a `string`-keyed `on`/`off` pair. A real `M3LEventEmitterBase`
 * subclass (`M3LRetryRunner`, `M3LPoller`, `M3LHttpClient`, `M3LEventEmitter`)
 * satisfies this structurally — its generic
 * `on<TEvent extends keyof TEventMap & string>` signature is assignable here
 * without any adaptation.
 *
 * @example
 * ```ts
 * import type { M3LBreadcrumbSource } from "@m3l-automation/m3l-common/core";
 *
 * declare const emitter: M3LBreadcrumbSource;
 * emitter.on("tick", (payload) => console.log(payload));
 * ```
 */
export interface M3LBreadcrumbSource {
  /** Registers `handler` for `event`. */
  on(event: string, handler: (payload: unknown) => void): void;
  /** Removes a previously registered `handler` for `event`. */
  off(event: string, handler: (payload: unknown) => void): void;
}

/**
 * Constructor options for {@link M3LBreadcrumbTrail}.
 *
 * @example
 * ```ts
 * import type { M3LBreadcrumbTrailOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LBreadcrumbTrailOptions = { limit: 50 };
 * ```
 */
export interface M3LBreadcrumbTrailOptions {
  /** Maximum number of entries retained; oldest evicted first. Defaults to `100`. */
  readonly limit?: number;
}

/**
 * Options for {@link M3LBreadcrumbTrail.attach}.
 *
 * @example
 * ```ts
 * import type { M3LBreadcrumbAttachOptions } from "@m3l-automation/m3l-common/core";
 *
 * const options: M3LBreadcrumbAttachOptions = {
 *   source: "primary-client",
 *   events: ["request", "response", "error"],
 * };
 * ```
 */
export interface M3LBreadcrumbAttachOptions {
  /** Overrides the emitter's constructor-name label. */
  readonly source?: string;
  /** Overrides the default (registry-keyed) event-name list to subscribe to. */
  readonly events?: readonly string[];
}

// ---------------------------------------------------------------------------
// Scalar-read helpers — every summarizer below reads defensively so a
// foreign emitter sending a wrong-shaped payload yields a partial record,
// never a throw.
// ---------------------------------------------------------------------------

/** Narrows `value` to a plain, non-null, non-array object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a `number`-typed own property, or `undefined` when absent/mistyped. */
function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

/** Reads a `string`-typed own property, or `undefined` when absent/mistyped. */
function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** Reads a `boolean`-typed own property, or `undefined` when absent/mistyped. */
function readBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Reads an `Error`'s `name`, or `undefined` when `error` is not an `Error`. */
function readErrorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/** Reads an `M3LError`'s `code`, or `undefined` when `error` is not one. */
function readErrorCode(error: unknown): string | undefined {
  return error instanceof M3LError ? error.code : undefined;
}

/** Reads an `Error`'s `message`, or `undefined` when `error` is not an `Error`. */
function readErrorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/**
 * Reads a structural `reason: string` field off an arbitrary error-shaped
 * value (e.g. `M3LHttpClientError.reason`), without importing that class.
 */
function readErrorReason(error: unknown): string | undefined {
  if (!isPlainRecord(error)) return undefined;
  return readString(error, "reason");
}

/**
 * Reads a structural `failure.status: number` field off an arbitrary
 * error-shaped value (e.g. `M3LHttpClientError.failure`'s `"status"` arm),
 * without importing that class.
 */
function readErrorStatus(error: unknown): number | undefined {
  if (!isPlainRecord(error)) return undefined;
  const failure = error.failure;
  if (!isPlainRecord(failure)) return undefined;
  return readNumber(failure, "status");
}

/**
 * Reads `value` as a URL and returns only its `origin` and `pathname`,
 * deliberately dropping userinfo (`user:pass@`) and the entire query string —
 * both routinely carry credentials (basic-auth userinfo; `?x-api-key=`,
 * `?access_token=`, presigned-S3 `?X-Amz-Signature=`/`X-Amz-Credential=`
 * query params). Returns `undefined` on a non-string value, a parse failure,
 * or any scheme other than `http:`/`https:` — an opaque-origin scheme (e.g.
 * `data:`) reports `origin` as the literal string `"null"` and would retain
 * its entire payload verbatim, and a `blob:` URL's `origin` duplicates the
 * inner URL it wraps; neither is safe to trust here. Never falls back to the
 * raw string, since that would reintroduce the leak this helper exists to
 * close.
 *
 * A credential embedded in the PATH segment itself (e.g.
 * `/v1/keys/sk-live-abc`) is retained by design: the path is load-bearing
 * for diagnosing which endpoint failed, and only userinfo/query/fragment are
 * treated as exclusively-credential-bearing positions.
 */
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Per-event summarizers — the security-critical projection step. Each keeps
// scalars only; nothing here re-embeds a raw object, error instance, or
// caller record.
// ---------------------------------------------------------------------------

/** A projection from a raw payload record to its scalar-only summary. */
type Summarizer = (payload: Record<string, unknown>) => Record<string, unknown>;

function summarizeAttemptMax(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const attempt = readNumber(payload, "attempt");
  const maxAttempts = readNumber(payload, "maxAttempts");
  return {
    ...(attempt !== undefined && { attempt }),
    ...(maxAttempts !== undefined && { maxAttempts }),
  };
}

function summarizeAttemptOnly(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const attempt = readNumber(payload, "attempt");
  return attempt === undefined ? {} : { attempt };
}

function summarizeAttemptsOnly(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const attempts = readNumber(payload, "attempts");
  return attempts === undefined ? {} : { attempts };
}

function summarizeAttemptDelay(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const attempt = readNumber(payload, "attempt");
  const delayMs = readNumber(payload, "delayMs");
  return {
    ...(attempt !== undefined && { attempt }),
    ...(delayMs !== undefined && { delayMs }),
  };
}

function summarizeRetryScheduled(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const attempt = readNumber(payload, "attempt");
  const delayMs = readNumber(payload, "delayMs");
  const classification = readString(payload, "classification");
  return {
    ...(attempt !== undefined && { attempt }),
    ...(delayMs !== undefined && { delayMs }),
    ...(classification !== undefined && { classification }),
  };
}

function summarizeRetryFatal(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const attempt = readNumber(payload, "attempt");
  const classification = readString(payload, "classification");
  return {
    ...(attempt !== undefined && { attempt }),
    ...(classification !== undefined && { classification }),
  };
}

function summarizeImportStarted(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const source = readString(payload, "source");
  return source === undefined ? {} : { source };
}

function summarizeImportItem(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const index = readNumber(payload, "index");
  return index === undefined ? {} : { index };
}

function summarizeImportProgress(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const processed = readNumber(payload, "processed");
  const total = readNumber(payload, "total");
  return {
    ...(processed !== undefined && { processed }),
    ...(total !== undefined && { total }),
  };
}

function summarizeImportError(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const index = readNumber(payload, "index");
  const error = payload.error;
  const errorName = readErrorName(error);
  const errorCode = readErrorCode(error);
  // No errorMessage: importer error messages routinely embed the offending
  // record (ratified hub decision) — never carried, even redacted.
  return {
    ...(index !== undefined && { index }),
    ...(errorName !== undefined && { errorName }),
    ...(errorCode !== undefined && { errorCode }),
  };
}

function summarizeImportCompleted(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const processed = readNumber(payload, "processed");
  const durationMs = readNumber(payload, "durationMs");
  return {
    ...(processed !== undefined && { processed }),
    ...(durationMs !== undefined && { durationMs }),
  };
}

/**
 * Summarizes an HTTP-client `request` event. `url` is deliberately reduced to
 * `origin + pathname` — the query string and any userinfo (`user:pass@`) are
 * dropped entirely, never merely redacted, since either can carry a
 * credential (`?x-api-key=`, `?access_token=`, presigned-S3 signature
 * params, basic-auth userinfo).
 */
function summarizeRequest(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const method = readString(payload, "method");
  const url = safeUrl(payload.url);
  const headers = payload.headers;
  // Header VALUES are never captured — only the sorted list of names.
  const headerNames = isPlainRecord(headers)
    ? Object.keys(headers).sort()
    : undefined;
  return {
    ...(method !== undefined && { method }),
    ...(url !== undefined && { url }),
    ...(headerNames !== undefined && { headerNames }),
  };
}

/**
 * Summarizes an HTTP-client `response` event. `url` is deliberately reduced
 * to `origin + pathname` — the query string and any userinfo (`user:pass@`)
 * are dropped entirely, never merely redacted, since either can carry a
 * credential (`?x-api-key=`, `?access_token=`, presigned-S3 signature
 * params, basic-auth userinfo).
 */
function summarizeResponse(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const method = readString(payload, "method");
  const url = safeUrl(payload.url);
  const status = readNumber(payload, "status");
  const ok = readBoolean(payload, "ok");
  const durationMs = readNumber(payload, "durationMs");
  return {
    ...(method !== undefined && { method }),
    ...(url !== undefined && { url }),
    ...(status !== undefined && { status }),
    ...(ok !== undefined && { ok }),
    ...(durationMs !== undefined && { durationMs }),
  };
}

/**
 * Summarizes an HTTP-client `error` event. `url` is deliberately reduced to
 * `origin + pathname` — the query string and any userinfo (`user:pass@`) are
 * dropped entirely, never merely redacted, since either can carry a
 * credential (`?x-api-key=`, `?access_token=`, presigned-S3 signature
 * params, basic-auth userinfo).
 *
 * `errorMessage` is scrubbed via {@link scrubUrlsInText} before being kept:
 * `M3LHttpClientError.message` embeds the raw request URL verbatim, so the
 * very credential `url` above was sanitized to exclude would otherwise ride
 * back in through this adjacent field.
 */
function summarizeHttpError(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const method = readString(payload, "method");
  const url = safeUrl(payload.url);
  const error = payload.error;
  const errorName = readErrorName(error);
  const errorCode = readErrorCode(error);
  const reason = readErrorReason(error);
  const status = readErrorStatus(error);
  const rawErrorMessage = readErrorMessage(error);
  const errorMessage =
    rawErrorMessage === undefined
      ? undefined
      : scrubUrlsInText(rawErrorMessage);
  // HTTP errors are method/url/status-shaped, not caller data — an errorMessage
  // is carried here (redacted downstream), unlike the importer's import:error.
  return {
    ...(method !== undefined && { method }),
    ...(url !== undefined && { url }),
    ...(errorName !== undefined && { errorName }),
    ...(errorCode !== undefined && { errorCode }),
    ...(reason !== undefined && { reason }),
    ...(status !== undefined && { status }),
    ...(errorMessage !== undefined && { errorMessage }),
  };
}

/**
 * Generic fallback for an unknown event name: keeps only own enumerable
 * scalar-valued (string/number/boolean) properties, dropping objects,
 * arrays, and functions entirely.
 */
function summarizeGenericFallback(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * The 17 built-in event summarizers, keyed by event name. This registry's
 * keys double as the default `events` list for {@link M3LBreadcrumbTrail.attach}
 * when `options.events` is omitted.
 */
const SUMMARIZERS: Readonly<Record<string, Summarizer>> = {
  "retry:attempt": summarizeAttemptMax,
  "retry:scheduled": summarizeRetryScheduled,
  "retry:success": summarizeAttemptOnly,
  "retry:fatal": summarizeRetryFatal,
  "retry:exhausted": summarizeAttemptsOnly,
  "poll:attempt": summarizeAttemptMax,
  "poll:wait": summarizeAttemptDelay,
  "poll:success": summarizeAttemptOnly,
  "poll:exhausted": summarizeAttemptsOnly,
  "import:started": summarizeImportStarted,
  "import:item": summarizeImportItem,
  "import:progress": summarizeImportProgress,
  "import:error": summarizeImportError,
  "import:completed": summarizeImportCompleted,
  request: summarizeRequest,
  response: summarizeResponse,
  error: summarizeHttpError,
};

/** The registry-keyed default event names {@link M3LBreadcrumbTrail.attach} subscribes to. */
const DEFAULT_ATTACH_EVENTS: readonly string[] = Object.keys(SUMMARIZERS);

/**
 * Projects `payload` for `event` through its registered summarizer (or the
 * generic fallback for an unrecognized event name), keeping scalars only.
 * A non-record payload (`null`, a primitive, or an array) always summarizes
 * to `{}`. Never throws by itself — a hostile getter thrown while reading a
 * property propagates to the caller, which wraps this call in `try`/`catch`.
 */
function summarizePayload(
  event: string,
  payload: unknown,
): Record<string, unknown> {
  if (!isPlainRecord(payload)) return {};
  const summarizer = Object.hasOwn(SUMMARIZERS, event)
    ? SUMMARIZERS[event]
    : undefined;
  return summarizer === undefined
    ? summarizeGenericFallback(payload)
    : summarizer(payload);
}

/** Narrows `value` to an {@link M3LBreadcrumbScalar}. */
function isBreadcrumbScalar(value: unknown): value is M3LBreadcrumbScalar {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  );
}

/**
 * Narrows the `redactSensitiveLogValue` output back to the scalar-only
 * {@link M3LBreadcrumb.payload} shape. Every summarizer above already emits
 * only scalars and scalar arrays, and redaction preserves that shape (a
 * string stays a string, an array is mapped element-wise, other scalars pass
 * through unchanged) — this is a defensive narrowing pass, not an
 * assertion: an entry that unexpectedly isn't scalar-or-scalar-array shaped
 * is dropped rather than forced through with `as`.
 */
function toBreadcrumbPayload(
  value: unknown,
): Record<string, M3LBreadcrumbScalar | readonly M3LBreadcrumbScalar[]> {
  if (!isPlainRecord(value)) return {};
  const result: Record<
    string,
    M3LBreadcrumbScalar | readonly M3LBreadcrumbScalar[]
  > = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isBreadcrumbScalar(entry)) {
      result[key] = entry;
    } else if (Array.isArray(entry) && entry.every(isBreadcrumbScalar)) {
      result[key] = entry;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// M3LBreadcrumbTrail
// ---------------------------------------------------------------------------

/** Default ring-buffer size when {@link M3LBreadcrumbTrailOptions.limit} is omitted. */
const DEFAULT_LIMIT = 100;

/** Validates `limit`, throwing the shared `ERR_INVALID_ARGUMENT` code on violation. */
function assertValidLimit(limit: number): void {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > Number.MAX_SAFE_INTEGER
  ) {
    throw new M3LError(
      `M3LBreadcrumbTrail: limit must be a positive integer no greater than Number.MAX_SAFE_INTEGER, got ${String(limit)}`,
      { code: "ERR_INVALID_ARGUMENT" },
    );
  }
}

/** Reads `source.constructor.name`, falling back to `"unknown"`. */
function defaultSourceLabel(source: unknown): string {
  if (typeof source !== "object" || source === null) return "unknown";
  const ctor: unknown = (source as { constructor?: unknown }).constructor;
  if (typeof ctor === "function" && ctor.name.length > 0) {
    return ctor.name;
  }
  return "unknown";
}

/**
 * A bounded ring buffer of redacted lifecycle-event summaries.
 *
 * Attach it to any emitter exposing `on`/`off` ({@link M3LBreadcrumbSource})
 * to passively collect a trail of its recent events — useful for attaching
 * to the last few operations leading up to a failure in a run report. Every
 * recorded payload is projected through a per-event summarizer (scalars
 * only) and then redacted via `redactSensitiveLogValue` before storage, so a
 * secret riding a raw header, error instance, or caller record can never
 * reach the trail.
 *
 * @example
 * ```ts
 * import { M3LBreadcrumbTrail } from "@m3l-automation/m3l-common/core";
 * import { M3LHttpClient } from "@m3l-automation/m3l-common/core";
 *
 * const client = new M3LHttpClient({ baseUrl: "https://api.example.com" });
 * const trail = new M3LBreadcrumbTrail({ limit: 50 });
 * const detach = trail.attach(client);
 *
 * await client.get("/users/42");
 * console.log(trail.entries());
 * detach();
 * ```
 */
export class M3LBreadcrumbTrail {
  readonly #limit: number;
  #entries: M3LBreadcrumb[] = [];

  /**
   * Creates a new `M3LBreadcrumbTrail`.
   *
   * @param options - Optional options bag; `limit` defaults to `100`.
   * @throws {@link M3LError} (`ERR_INVALID_ARGUMENT`) When `limit` is not a
   *   positive integer no greater than `Number.MAX_SAFE_INTEGER`.
   */
  constructor(options: M3LBreadcrumbTrailOptions = {}) {
    const limit = options.limit ?? DEFAULT_LIMIT;
    assertValidLimit(limit);
    this.#limit = limit;
  }

  /**
   * Subscribes to `source`'s events, recording each as a breadcrumb.
   *
   * Attaching the same emitter twice registers two independent sets of
   * handlers — each subsequent emission is then recorded twice. This is
   * documented, intentional behavior; no dedupe is applied.
   *
   * A custom `options.events` name outside the built-in registry (or any
   * event a foreign emitter sends that this trail doesn't recognize) is
   * recorded through the generic fallback: every scalar-valued key is kept
   * and relies solely on `redactSensitiveLogValue` for protection — a
   * non-obviously-sensitive key name (e.g. `ssn`) is not recognized as
   * sensitive and is stored unredacted. See {@link M3LBreadcrumbTrail.record}.
   *
   * @param source - Any emitter exposing `on`/`off` — a real
   *   `M3LEventEmitterBase` subclass satisfies this structurally.
   * @param options - Optional `source` label override and `events` list
   *   override; `events` defaults to this trail's full 17-event registry.
   * @returns An idempotent detach function; calling it more than once is a
   *   no-op.
   *
   * @example
   * ```ts
   * import { M3LBreadcrumbTrail } from "@m3l-automation/m3l-common/core";
   * import { M3LPoller } from "@m3l-automation/m3l-common/core";
   *
   * const poller = new M3LPoller({ backoff: undefined as never });
   * const trail = new M3LBreadcrumbTrail();
   * const detach = trail.attach(poller, { events: ["poll:attempt"] });
   * detach();
   * ```
   */
  attach(
    source: M3LBreadcrumbSource,
    options: M3LBreadcrumbAttachOptions = {},
  ): () => void {
    const label = options.source ?? defaultSourceLabel(source);
    const events = options.events ?? DEFAULT_ATTACH_EVENTS;

    const registrations = events.map((event) => {
      const handler = (payload: unknown): void => {
        this.record(label, event, payload);
      };
      source.on(event, handler);
      return { event, handler };
    });

    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      for (const { event, handler } of registrations) {
        source.off(event, handler);
      }
    };
  }

  /**
   * Records a breadcrumb, projecting `payload` through its event summarizer
   * (or the generic scalar-only fallback) and then `redactSensitiveLogValue`.
   *
   * Never throws: a hostile payload (e.g. a throwing getter), a non-record
   * payload, or an unrecognized event name all degrade to a safe, possibly
   * empty, payload rather than propagating.
   *
   * For an `event` outside the built-in registry, every scalar-valued key is
   * kept and relies solely on `redactSensitiveLogValue` for protection —
   * that heuristic only masks keys it recognizes as sensitive by name, so a
   * non-obviously-sensitive key (e.g. `ssn`) is stored unredacted. This is
   * opt-in (a custom `options.events` list, or calling `record()` directly)
   * and intentionally not changed here — only documented.
   *
   * @param source - The emitter label to record against.
   * @param event - The event name.
   * @param payload - The raw event payload; may be any value.
   *
   * @example
   * ```ts
   * import { M3LBreadcrumbTrail } from "@m3l-automation/m3l-common/core";
   *
   * const trail = new M3LBreadcrumbTrail();
   * trail.record("custom-source", "custom:tick", { count: 1 });
   * ```
   */
  record(source: string, event: string, payload?: unknown): void {
    let safePayload: Record<
      string,
      M3LBreadcrumbScalar | readonly M3LBreadcrumbScalar[]
    >;
    try {
      const summarized = summarizePayload(event, payload);
      const redacted = redactSensitiveLogValue(summarized);
      safePayload = toBreadcrumbPayload(redacted);
    } catch {
      // A hostile getter on the payload (or any other summarize/redact
      // failure) must never propagate — this is the guarantee that keeps a
      // hostile payload from ever reaching the emitter's own stderr reporter.
      safePayload = {};
    }

    this.#entries.push({
      timestamp: new Date().toISOString(),
      source,
      event,
      payload: safePayload,
    });
    if (this.#entries.length > this.#limit) {
      this.#entries.shift();
    }
  }

  /**
   * Returns every recorded breadcrumb, oldest first.
   *
   * A fresh array is returned on every call — mutating the result never
   * affects the trail's internal state.
   *
   * @returns A snapshot of the current breadcrumbs.
   *
   * @example
   * ```ts
   * import { M3LBreadcrumbTrail } from "@m3l-automation/m3l-common/core";
   *
   * const trail = new M3LBreadcrumbTrail();
   * trail.record("s", "custom:tick", { n: 1 });
   * console.log(trail.entries());
   * ```
   */
  entries(): readonly M3LBreadcrumb[] {
    return [...this.#entries];
  }

  /**
   * Empties the trail without detaching any attached source — a subsequent
   * emission on an already-attached emitter is still recorded.
   *
   * @example
   * ```ts
   * import { M3LBreadcrumbTrail } from "@m3l-automation/m3l-common/core";
   *
   * const trail = new M3LBreadcrumbTrail();
   * trail.record("s", "custom:tick", { n: 1 });
   * trail.clear();
   * console.log(trail.entries()); // []
   * ```
   */
  clear(): void {
    this.#entries = [];
  }
}
