/**
 * `store/failures` — pure classification of `node:sqlite` and store-layer
 * failures into a closed {@link M3LStoreFailureKind}, and the single place
 * that maps a `(kind, phase)` pair to an {@link M3LConsoleErrorCode}.
 *
 * Deliberately has **no `node:sqlite` import and no I/O** — that purity is
 * what lets every failure branch here be covered from unit tests, without a
 * real file lock, a real corrupt database, or a real second writer. Only
 * `store/sqlite-driver.ts` talks to the builtin directly.
 *
 * @packageDocumentation
 */

import { M3LConsoleError } from "../errors/console-error.js";
import type { M3LConsoleErrorCode } from "../errors/console-error.js";

/**
 * The closed set of failure kinds a store operation can be classified
 * into, independent of which phase (`open` / `migrate` / `query`) it
 * occurred in.
 *
 * @example
 * ```ts
 * function isRetryCandidate(kind: M3LStoreFailureKind): boolean {
 *   return kind === "busy";
 * }
 * ```
 */
export type M3LStoreFailureKind =
  | "busy"
  | "closed"
  | "constraint"
  | "outOfRange"
  | "unopenable"
  | "sql"
  | "unknown";

/**
 * The phase of the store lifecycle a failure occurred in. `"migrate"` is
 * reserved for PR B (the migration runner); it is not yet produced by
 * anything in PR A.
 *
 * @example
 * ```ts
 * const phase: M3LStorePhase = "query";
 * ```
 */
export type M3LStorePhase = "open" | "migrate" | "query";

/**
 * Reads a string property off an unknown value, tolerating a hostile
 * (throwing) getter. Used on the failure path, where the caught value is by
 * definition untrusted — a classifier that itself throws while inspecting a
 * hostile error object would replace the original failure with a confusing
 * new one.
 */
function readStringProperty(value: object, key: string): string | undefined {
  try {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a numeric property off an unknown value, tolerating a hostile
 * (throwing) getter, exactly like {@link readStringProperty}.
 */
function readNumberProperty(value: object, key: string): number | undefined {
  try {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "number" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** The mask that reduces an extended SQLite result code to its primary (low) byte. */
const SQLITE_PRIMARY_CODE_MASK = 0xff;

/** Primary SQLite result codes this classifier discriminates on (https://www.sqlite.org/rescode.html). */
const SQLITE_PRIMARY_BUSY = 5;
const SQLITE_PRIMARY_LOCKED = 6;
const SQLITE_PRIMARY_READONLY = 8;
const SQLITE_PRIMARY_CORRUPT = 11;
const SQLITE_PRIMARY_CANTOPEN = 14;
const SQLITE_PRIMARY_NOTADB = 26;
const SQLITE_PRIMARY_CONSTRAINT = 19;

/**
 * Classifies a `SQLITE_ERROR`'s extended `errcode`, masked to its primary
 * (low) byte via `& 0xff` — never on the raw extended literal, since
 * distinct extended codes (e.g. `1299` for NOT NULL and `2067` for UNIQUE)
 * share the same primary code (`19`, constraint).
 */
function classifySqliteErrorCode(
  errcode: number | undefined,
): M3LStoreFailureKind {
  if (errcode === undefined) return "sql";
  const primaryCode = errcode & SQLITE_PRIMARY_CODE_MASK;

  if (
    primaryCode === SQLITE_PRIMARY_BUSY ||
    primaryCode === SQLITE_PRIMARY_LOCKED
  ) {
    return "busy";
  }
  if (
    primaryCode === SQLITE_PRIMARY_READONLY ||
    primaryCode === SQLITE_PRIMARY_CORRUPT ||
    primaryCode === SQLITE_PRIMARY_CANTOPEN ||
    primaryCode === SQLITE_PRIMARY_NOTADB
  ) {
    return "unopenable";
  }
  if (primaryCode === SQLITE_PRIMARY_CONSTRAINT) return "constraint";
  return "sql";
}

/**
 * Classifies a caught value into a {@link M3LStoreFailureKind}, in a fixed
 * order:
 *
 * 1. Not an object (or `null`) → `"unknown"`.
 * 2. `code === "ERR_INVALID_STATE"` → `"closed"`. Checked **before** the
 *    `ERR_SQLITE_ERROR` branch — a retry loop that treated a closed handle
 *    as merely `"busy"` would spin forever against it.
 * 3. `code === "ERR_OUT_OF_RANGE"` → `"outOfRange"` (a missing
 *    `setReadBigInts(true)` call, i.e. a code defect rather than an
 *    operational one).
 * 4. `code === "ERR_SQLITE_ERROR"` → classified further by
 *    {@link classifySqliteErrorCode}, on `errcode & 0xff`.
 * 5. Anything else → `"unknown"`.
 *
 * Tolerates a hostile (throwing) `code`/`errcode` getter: a classifier used
 * on the failure path must never itself throw.
 *
 * @param cause - The value caught from a store operation.
 * @returns The classified failure kind.
 *
 * @example
 * ```ts
 * try {
 *   // ... a store operation
 * } catch (cause) {
 *   const kind = classifyStoreFailure(cause);
 *   if (kind === "busy") {
 *     // classify honestly — do not retry (ADR-0069)
 *   }
 * }
 * ```
 */
export function classifyStoreFailure(cause: unknown): M3LStoreFailureKind {
  if (typeof cause !== "object" || cause === null) return "unknown";

  const code = readStringProperty(cause, "code");
  if (code === "ERR_INVALID_STATE") return "closed";
  if (code === "ERR_OUT_OF_RANGE") return "outOfRange";
  if (code === "ERR_SQLITE_ERROR") {
    return classifySqliteErrorCode(readNumberProperty(cause, "errcode"));
  }
  return "unknown";
}

/** The allow-listed context keys `storeError` ever forwards into the error it builds. Never `sql`, bound parameters, `expandedSQL`, `errstr`, or a row. */
const ALLOWED_CONTEXT_KEYS = [
  "location",
  "schemaVersion",
  "version",
  "name",
  "sqliteCode",
  "sqlitePrimaryCode",
] as const;

/**
 * Builds the safe, allow-listed context object `storeError` attaches to the
 * `M3LConsoleError` it returns, dropping every key not in
 * {@link ALLOWED_CONTEXT_KEYS}. This is what makes leak discipline
 * unconditional: a caller cannot accidentally widen the leaked surface by
 * passing a context bag built from a failing statement's diagnostic
 * surface (`sql`, bound parameters, `expandedSQL`, `errstr`, a row).
 */
function buildSafeContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const safeContext: Record<string, unknown> = {};
  if (context === undefined) return safeContext;
  for (const key of ALLOWED_CONTEXT_KEYS) {
    if (key in context) {
      safeContext[key] = context[key];
    }
  }
  return safeContext;
}

/**
 * Maps `(kind, phase)` to the `M3LConsoleErrorCode` that names it. The same
 * `"unopenable"` kind is `_OPEN_FAILED` at boot and `_QUERY_FAILED`
 * mid-request — the phase is what disambiguates. `phase: "migrate"` is not
 * reachable in PR A (there is no migration runner yet), so it is not
 * handled here; it is added alongside `ERR_CONSOLE_STORE_MIGRATION_FAILED`
 * in PR B.
 */
function mapToErrorCode(
  kind: M3LStoreFailureKind,
  phase: M3LStorePhase,
): M3LConsoleErrorCode {
  if (kind === "busy") return "ERR_CONSOLE_STORE_BUSY";
  if (kind === "closed") return "ERR_CONSOLE_STORE_CLOSED";
  return phase === "query"
    ? "ERR_CONSOLE_STORE_QUERY_FAILED"
    : "ERR_CONSOLE_STORE_OPEN_FAILED";
}

/**
 * Builds the `M3LConsoleError` for a classified store failure.
 *
 * Leak discipline is non-negotiable: `context` is filtered down to the
 * allow-listed keys (`location`, `schemaVersion`, `version`, `name`,
 * `sqliteCode`, `sqlitePrimaryCode`) before being attached — any other key
 * (`sql`, bound parameters, `expandedSQL`, `errstr`, a row) is silently
 * dropped, never forwarded. `message` must likewise never interpolate SQL
 * text or a bound value; callers are expected to pass a message that was
 * written to be safe, not one built from the failing statement.
 *
 * @param kind - The failure kind, from {@link classifyStoreFailure}.
 * @param phase - Which lifecycle phase the failure occurred in.
 * @param message - A safe, non-interpolated human-readable message.
 * @param cause - The original caught value, chained as `cause`.
 * @param context - Optional diagnostic detail; filtered to the allow-list.
 * @returns A `M3LConsoleError` carrying the mapped code.
 *
 * @example
 * ```ts
 * function toConsoleError(cause: unknown): M3LConsoleError {
 *   const kind = classifyStoreFailure(cause);
 *   return storeError(kind, "query", "store query failed", cause, {
 *     location: "console.sqlite",
 *   });
 * }
 * ```
 */
export function storeError(
  kind: M3LStoreFailureKind,
  phase: M3LStorePhase,
  message: string,
  cause: unknown,
  context?: Record<string, unknown>,
): M3LConsoleError {
  return new M3LConsoleError(mapToErrorCode(kind, phase), message, {
    cause,
    context: buildSafeContext(context),
  });
}
