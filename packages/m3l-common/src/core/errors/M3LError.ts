/**
 * Typed error hierarchy for `@m3l-automation/m3l-common`.
 *
 * All library errors extend `M3LError` so callers can `catch (e)` and narrow
 * by `instanceof M3LError`, then further by `e.code` or a subclass check.
 * This keeps the error surface structured and avoids throwing bare strings.
 *
 * @packageDocumentation
 */

import { classifyErrorCode } from "./catalog.js";
import type { M3LErrorOrigin, M3LErrorRetryable } from "./catalog.js";

/**
 * Constructor options for {@link M3LError}.
 *
 * `code` is required; `context` and `cause` are optional enrichment fields.
 *
 * @example
 * ```ts
 * const opts: M3LErrorOptions = {
 *   code: "ERR_NOT_FOUND",
 *   context: { id: "user-42" },
 *   cause: new Error("db miss"),
 * };
 * ```
 */
export interface M3LErrorOptions {
  /** Machine-readable error code, e.g. `"ERR_NOT_FOUND"`. */
  readonly code: string;
  /**
   * Arbitrary key-value pairs for structured diagnostics.
   * Defaults to `{}` when omitted.
   */
  readonly context?: Record<string, unknown>;
  /**
   * The underlying cause of this error.
   * Typed `unknown` because any thrown value may be caught.
   */
  readonly cause?: unknown;
  /**
   * Who must act to fix this failure. Defaults to the classification
   * {@link classifyErrorCode} derives from `code` via the built-in catalog
   * (`M3L_ERROR_CATALOG`); pass this explicitly only to override that default
   * for a specific instance. `undefined` when `code` has no catalog entry.
   */
  readonly origin?: M3LErrorOrigin;
  /**
   * Whether re-running the failed operation without changes can plausibly
   * succeed. Defaults to the classification {@link classifyErrorCode} derives
   * from `code` via the built-in catalog (`M3L_ERROR_CATALOG`); pass this
   * explicitly only to override that default for a specific instance.
   * `undefined` when `code` has no catalog entry.
   */
  readonly retryable?: M3LErrorRetryable;
}

/**
 * The maximum number of nested {@link M3LError} `cause` hops that
 * {@link M3LError.toJSON} will recurse through before collapsing the
 * remainder of the chain to a terminal {@link M3LErrorCauseJSON} marker.
 *
 * This bounds both the output size and the recursion depth for a
 * pathologically long (but non-cyclic) cause chain; the exact value is an
 * implementation detail, not a contract other code should depend on.
 */
const MAX_CAUSE_DEPTH = 8;

/** Terminal marker name emitted when a genuine cause cycle is detected. */
const CIRCULAR_CAUSE_NAME = "[circular]";

/** Terminal marker name emitted when {@link MAX_CAUSE_DEPTH} is reached. */
const MAX_DEPTH_CAUSE_NAME = "[max cause depth reached]";

/** Fallback name for a foreign value whose type cannot be safely identified. */
const UNKNOWN_CAUSE_NAME = "[unknown]";

/**
 * Matches a plain identifier-shaped string: letters, digits, underscore, and
 * `$`, one to 100 characters, fully anchored. Deliberately a single character
 * class with a single bounded quantifier — no alternation, no nested
 * quantifiers — so it cannot backtrack pathologically regardless of input.
 * The length cap discards any derived name that is untrustworthy (implausibly
 * long) in favour of a safer fallback.
 */
const SAFE_CAUSE_NAME_PATTERN = /^[A-Za-z0-9_$]{1,100}$/;

/**
 * Validates that `value` is a plain, non-empty, length-capped,
 * identifier-shaped string — rejecting anything that could smuggle
 * attacker-controlled text (spaces, `=`, quotes, newlines, punctuation) through
 * a `name`/`constructor.name` channel.
 */
function isSafeCauseName(value: unknown): value is string {
  return typeof value === "string" && SAFE_CAUSE_NAME_PATTERN.test(value);
}

/**
 * Reads `value.name` under a `try`/`catch` so a throwing getter (own or
 * inherited) cannot propagate, then validates the result with
 * {@link isSafeCauseName}.
 */
function readNameSafely(value: object): string | undefined {
  try {
    const candidate: unknown = (value as { name?: unknown }).name;
    return isSafeCauseName(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derives a type name via `Object.getPrototypeOf(value).constructor.name` —
 * never via `Object.prototype.toString.call(value)`, which consults the
 * spoofable `Symbol.toStringTag` and would let an attacker-controlled object
 * report an arbitrary type name. Reading the constructor off the *prototype*
 * (rather than `value.constructor` directly) also means an own,
 * attacker-defined `constructor` property on `value` itself cannot influence
 * the result. Every step is wrapped so a hostile Proxy trap (e.g.
 * `getPrototypeOf` itself throwing) cannot propagate.
 */
function readConstructorNameSafely(value: object): string | undefined {
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === null || typeof prototype !== "object") {
      return undefined;
    }
    const constructor: unknown = (prototype as { constructor?: unknown })
      .constructor;
    if (typeof constructor !== "function") {
      return undefined;
    }
    const name: unknown = constructor.name;
    return isSafeCauseName(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every object actually constructed via the `M3LError` constructor (recorded
 * at the end of the constructor, so it covers every subclass too). `instanceof`
 * alone cannot distinguish a genuine instance from a forgery that merely has
 * `M3LError.prototype` grafted onto it via `Object.create`/
 * `Object.setPrototypeOf` — the prototype chain is identical either way, and
 * a forged object can carry own `name`/`message`/`code`/`context`/etc.
 * properties that read back perfectly normally (no throwing getter to catch).
 * A `WeakSet` keyed on object identity closes that gap without retaining
 * anything past garbage collection.
 */
const GENUINE_M3L_ERROR_INSTANCES = new WeakSet<object>();

/** `instanceof M3LError`, guarded against a hostile Proxy's `getPrototypeOf` trap. */
function isM3LErrorInstance(value: unknown): value is M3LError {
  try {
    return value instanceof M3LError;
  } catch {
    return false;
  }
}

/**
 * `instanceof M3LError` AND actually constructed via the `M3LError`
 * constructor — not merely an object wearing `M3LError.prototype`. See
 * {@link GENUINE_M3L_ERROR_INSTANCES} for why `instanceof` alone is
 * insufficient here. `WeakSet.prototype.has` performs an identity check with
 * no property reads or trap invocations on `value`, so this is safe to call
 * on a hostile Proxy without a `try`/`catch`.
 */
function isGenuineM3LErrorInstance(value: unknown): value is M3LError {
  return isM3LErrorInstance(value) && GENUINE_M3L_ERROR_INSTANCES.has(value);
}

/** `instanceof Error`, guarded against a hostile Proxy's `getPrototypeOf` trap. */
function isErrorInstance(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

/**
 * Derives the safe name for a foreign (non-`M3LError`) `Error` cause: its own
 * `.name`, falling back to its constructor name, falling back to the fixed
 * literal `"Error"`.
 */
function deriveErrorCauseName(cause: Error): string {
  return readNameSafely(cause) ?? readConstructorNameSafely(cause) ?? "Error";
}

/**
 * Derives the safe type identifier for a cause that is neither `undefined`,
 * an `M3LError`, nor a plain `Error` — a plain object, a null-prototype
 * object, a primitive, a `Symbol`, a function, or a hostile Proxy. Never
 * reads the value's own data (e.g. its own `.name`, if any) — only its
 * constructor-derived type name, or a `typeof` tag for primitives, which
 * requires zero property reads on the value itself.
 */
function deriveForeignCauseName(cause: unknown): string {
  if (cause === null) {
    return "null";
  }

  if (typeof cause === "object" || typeof cause === "function") {
    return readConstructorNameSafely(cause) ?? UNKNOWN_CAUSE_NAME;
  }

  // A primitive (string/number/boolean/bigint/symbol): the `typeof` tag
  // itself is the safe name, with zero property reads on `cause`.
  return typeof cause;
}

/**
 * Derives the safe fallback name for an `M3LError`-shaped cause whose field
 * reads could not be trusted (see {@link serializeM3LErrorCauseSafely}): its
 * own `.name`, falling back to its constructor name, falling back to the
 * fixed literal `"M3LError"`. Mirrors {@link deriveErrorCauseName}'s pattern
 * for a foreign `Error`.
 */
function deriveM3LErrorCauseFallbackName(cause: object): string {
  return (
    readNameSafely(cause) ?? readConstructorNameSafely(cause) ?? "M3LError"
  );
}

/**
 * Serialises a *genuine* `M3LError`-shaped `cause` (already verified by
 * {@link isGenuineM3LErrorInstance}) for {@link resolveCauseForJSON}. Genuine
 * identity rules out a forged prototype, but not a genuine instance whose
 * fields were poisoned with a throwing getter *after* construction (e.g. via
 * `Object.defineProperty` on a reference the caller still holds) — wrapping
 * the recursive read in `try`/`catch` and degrading to the same terminal
 * {@link M3LErrorCauseJSON} shape used for foreign causes closes that
 * residual gap too: a genuine, untampered cause still serialises in full,
 * while a genuine-but-tampered one degrades to `{ name: <safe fallback> }`
 * instead of throwing.
 */
function serializeM3LErrorCauseSafely(
  cause: M3LError,
  depth: number,
  seen: WeakSet<object>,
): M3LErrorJSON | M3LErrorCauseJSON {
  try {
    return serializeM3LError(cause, depth, seen);
  } catch {
    return { name: deriveM3LErrorCauseFallbackName(cause) };
  }
}

/**
 * Resolves a `cause` value (either `M3LError.cause` itself, or a nested one
 * found while recursing) to its allowlisted `toJSON()` projection. See
 * {@link M3LError.toJSON} for the full resolution rule.
 */
function resolveCauseForJSON(
  cause: unknown,
  depth: number,
  seen: WeakSet<object>,
): M3LErrorJSON | M3LErrorCauseJSON | undefined {
  if (cause === undefined) {
    return undefined;
  }

  if (isGenuineM3LErrorInstance(cause)) {
    if (seen.has(cause)) {
      return { name: CIRCULAR_CAUSE_NAME };
    }
    if (depth >= MAX_CAUSE_DEPTH) {
      return { name: MAX_DEPTH_CAUSE_NAME };
    }
    return serializeM3LErrorCauseSafely(cause, depth, seen);
  }

  // Reached by a foreign `Error`, but also by an object merely *wearing*
  // `M3LError.prototype` (a hostile Proxy over a real instance, or a plain
  // object with the prototype grafted on) — `M3LError.prototype` chains
  // through `Error.prototype`, so both pass `isErrorInstance` and degrade to
  // a safe type-name-only projection here instead of a full serialise.
  if (isErrorInstance(cause)) {
    return { name: deriveErrorCauseName(cause) };
  }

  return { name: deriveForeignCauseName(cause) };
}

/**
 * Builds the full {@link M3LErrorJSON} record for `error`, recursing into its
 * `cause` chain via {@link resolveCauseForJSON}. Never calls `error.toJSON()`
 * itself — this module-private helper is the single source of truth for the
 * shape, so a hostile subclass override of `toJSON` cannot reintroduce
 * arbitrary data under this boundary.
 */
function serializeM3LError(
  error: M3LError,
  depth: number,
  seen: WeakSet<object>,
): M3LErrorJSON {
  seen.add(error);
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    context: error.context,
    cause: resolveCauseForJSON(error.cause, depth + 1, seen),
    stack: error.stack,
    origin: error.origin,
    retryable: error.retryable,
  };
}

/**
 * The terminal shape for a foreign (non-`M3LError`) `cause` in
 * {@link M3LErrorJSON.cause}: a safe type discriminator only, never the
 * original value's own data.
 *
 * @example
 * ```ts
 * import type { M3LErrorCauseJSON } from "@m3l-automation/m3l-common/core";
 *
 * const terminal: M3LErrorCauseJSON = { name: "Error" };
 * ```
 */
export interface M3LErrorCauseJSON {
  /**
   * A safe type discriminator for the original cause: either an
   * identifier-shaped type name (the cause's own `.name` or its constructor
   * name), or one of the fixed marker literals `"[unknown]"`, `"[circular]"`,
   * or `"[max cause depth reached]"` — none of which are identifier-shaped.
   */
  readonly name: string;
}

/**
 * The plain-record shape returned by {@link M3LError.toJSON}.
 *
 * Only `cause` is allowlisted by this shape — every other field is carried
 * verbatim from the source `M3LError` instance, unchanged from before this
 * fix. In particular `context` (see its field doc below) is passed through
 * unredacted; this type is not a general "safe to log" guarantee for the
 * whole record, only for the `cause` channel.
 *
 * @example
 * ```ts
 * import type { M3LErrorJSON } from "@m3l-automation/m3l-common/core";
 *
 * function logSafely(json: M3LErrorJSON): void {
 *   console.error(JSON.stringify(json));
 * }
 * ```
 */
export interface M3LErrorJSON {
  /** The error's `name`, carried verbatim from the source instance. */
  readonly name: string;
  /** The error's `message`, carried verbatim from the source instance. */
  readonly message: string;
  /** The error's machine-readable `code`, carried verbatim. */
  readonly code: string;
  /**
   * The error's structured diagnostic `context`, passed through **verbatim
   * and unredacted** — this field is NOT covered by this method's `cause`
   * allowlist. Redacting its contents, if needed, is a separate, existing
   * concern (`core/logging`'s `redactSensitiveLogValue`).
   */
  readonly context: Readonly<Record<string, unknown>>;
  /**
   * The allowlisted projection of the source error's `cause` — never the
   * live `cause` value by reference. See {@link M3LError.toJSON} for the
   * full resolution rule.
   */
  readonly cause: M3LErrorJSON | M3LErrorCauseJSON | undefined;
  /** The error's `stack`, carried verbatim from the source instance. */
  readonly stack: string | undefined;
  /** The error's resolved `origin`, carried verbatim from the source instance. */
  readonly origin: M3LErrorOrigin | undefined;
  /** The error's resolved `retryable`, carried verbatim from the source instance. */
  readonly retryable: M3LErrorRetryable | undefined;
}

/**
 * Base error class for the `@m3l-automation/m3l-common` library.
 *
 * Extends the built-in `Error` with a mandatory machine-readable `code`,
 * an optional structured `context` bag, and proper cause-chaining via
 * `options.cause`. Subclasses automatically pick up their class name as
 * `error.name` through `new.target.name`.
 *
 * @example
 * ```ts
 * class NotFoundError extends M3LError {}
 *
 * throw new NotFoundError("user not found", {
 *   code: "ERR_NOT_FOUND",
 *   context: { userId: "u-42" },
 *   cause: dbError,
 * });
 * ```
 */
export class M3LError extends Error {
  /** Machine-readable error code for programmatic handling. */
  readonly code: string;

  /** Structured diagnostic context attached to this error. */
  readonly context: Record<string, unknown>;

  /**
   * The underlying cause; typed `unknown` because any thrown value can be
   * caught and wrapped.
   */
  override readonly cause: unknown;

  /**
   * Who must act to fix this failure. Resolved as: an explicit
   * `options.origin` wins; otherwise the classification
   * {@link classifyErrorCode} derives from `options.code` via the built-in
   * catalog; otherwise `undefined` for a code the catalog does not classify.
   *
   * Because the default is catalog-derived rather than pinned per subclass,
   * `error.origin` types as `M3LErrorOrigin | undefined` at a catch site —
   * it does not narrow to a literal the way `code` can on a subclass that
   * overrides it.
   */
  readonly origin: M3LErrorOrigin | undefined;

  /**
   * Whether re-running the failed operation without changes can plausibly
   * succeed. Resolved as: an explicit `options.retryable` wins; otherwise the
   * classification {@link classifyErrorCode} derives from `options.code` via
   * the built-in catalog; otherwise `undefined` for a code the catalog does
   * not classify.
   *
   * Because the default is catalog-derived rather than pinned per subclass,
   * `error.retryable` types as `M3LErrorRetryable | undefined` at a catch
   * site — it does not narrow to a literal the way `code` can on a subclass
   * that overrides it.
   *
   * @remarks
   * `"situational"` (see {@link M3LErrorRetryable}) is truthy, so
   * `if (err.retryable)` is almost never the right check on a caught
   * instance. Test `err.retryable === true` for "definitely safe to retry
   * without further inspection"; any other value — including
   * `"situational"` — means inspect the instance before deciding.
   */
  readonly retryable: M3LErrorRetryable | undefined;

  /**
   * Creates a new `M3LError`.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Required options bag carrying `code`, optional `context`,
   *   optional `cause`, and optional `origin`/`retryable` overrides.
   */
  constructor(message: string, options: M3LErrorOptions) {
    super(message);

    this.name = new.target.name;
    this.code = options.code;
    this.context = options.context ?? {};
    this.cause = options.cause;

    const classification = classifyErrorCode(options.code);
    this.origin = options.origin ?? classification?.origin;
    this.retryable = options.retryable ?? classification?.retryable;

    // Capture a clean stack trace, excluding the constructor frame.
    // Guard for environments (e.g. some test runners) that lack this V8 API.
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    }

    // Record genuine construction for isGenuineM3LErrorInstance — see
    // GENUINE_M3L_ERROR_INSTANCES for why instanceof alone is insufficient.
    GENUINE_M3L_ERROR_INSTANCES.add(this);
  }

  /**
   * Serialises the error to a plain, JSON-safe record suitable for structured
   * logging or a run report.
   *
   * `name`, `message`, `code`, `context`, `stack`, `origin`, and `retryable`
   * are carried verbatim from the instance fields — `context` in particular
   * is untouched by this fix: it is a deliberate, pre-existing
   * library-authored diagnostic channel with a known, enumerable shape (not
   * an opaque foreign value like `cause`), and redacting its contents is a
   * separate, existing concern (`core/logging`'s `redactSensitiveLogValue`).
   * `cause` (this method's projection) is allowlisted rather than returned by
   * reference (F31, GitHub #727): a *genuinely constructed* `M3LError` cause
   * (not merely one wearing `M3LError`'s prototype — `instanceof` alone
   * cannot tell those apart) recurses to that error's own full
   * {@link M3LErrorJSON} shape, up to a fixed depth cap (a cycle in the chain
   * is detected separately and collapses to a fixed marker rather than
   * exhausting the depth budget) — if any field read on that genuine cause
   * throws (e.g. a getter poisoned after construction), it degrades to the
   * same safe terminal shape as a foreign cause instead of throwing; a cause
   * that is merely an `instanceof M3LError` forgery (a hostile Proxy, or a
   * plain object with `M3LError.prototype` grafted on) is treated like any
   * other `Error` and collapses to `{ name: cause.name }` only — never its
   * own (possibly forged) `context`/`message`/etc.; any other `Error` cause
   * likewise collapses to `{ name: cause.name }` only; anything else (a plain
   * object, a null-prototype object, a primitive, a `Symbol`, a hostile
   * Proxy) collapses to a safe
   * constructor-derived type name only. This closes the leak where a caught
   * SDK exception's own-enumerable fields (e.g. a smithy `ServiceException`'s
   * `$response`/`$metadata`, or a `message` set as a plain property after
   * construction) reached a log or run report by reference.
   *
   * `error.cause` itself — the live instance field — is completely
   * unchanged by this method: a caller can still narrow on the real value via
   * `instanceof` or read its full contents directly. Only this `toJSON()`
   * projection is allowlisted.
   *
   * The result can still throw from `JSON.stringify` if `context` contains a
   * circular reference or another non-serialisable value — that risk is
   * unchanged, since `context` is caller-controlled and out of scope for this
   * fix.
   *
   * @returns The {@link M3LErrorJSON} record described above.
   */
  toJSON(): M3LErrorJSON {
    return serializeM3LError(this, 0, new WeakSet());
  }
}
