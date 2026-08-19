/**
 * `core/diagnostics/exit-codes` — the process exit-code registry and the
 * function that maps an arbitrary caught value to one of its members.
 *
 * @packageDocumentation
 */

import type { M3LErrorOrigin } from "../errors/catalog.js";
import { classifyErrorCode } from "../errors/catalog.js";
import { M3LError } from "../errors/index.js";

/**
 * The library's exit-code registry, keyed by category.
 *
 * `SUCCESS`, `INTERRUPTED`, and `PARTIAL` are never produced by
 * {@link mapErrorToExitCode} — they are set directly by the caller (a clean
 * run, a signal-driven interruption, or a run that absorbed per-item failures)
 * rather than derived from a caught error.
 *
 * @example
 * ```ts
 * import { M3L_EXIT_CODES } from "@m3l-automation/m3l-common/core";
 *
 * process.exitCode = M3L_EXIT_CODES.EXTERNAL;
 * ```
 */
export const M3L_EXIT_CODES = {
  /** The run completed with no error. */
  SUCCESS: 0,
  /** The error could not be classified by origin or catalog code. */
  UNCLASSIFIED: 1,
  /** A caller/config error — the script or its configuration is at fault. */
  CONFIG_USAGE: 2,
  /** An external-system error — AWS, HTTP, or other out-of-process failure. */
  EXTERNAL: 3,
  /** An internal library invariant violation. */
  LIBRARY: 4,
  /** The run was interrupted by a process signal. */
  INTERRUPTED: 5,
  /** The run completed with absorbed per-item failures — neither success nor failure. */
  PARTIAL: 6,
} as const;

/**
 * The numeric union of every {@link M3L_EXIT_CODES} value.
 *
 * @example
 * ```ts
 * import type { M3LExitCode } from "@m3l-automation/m3l-common/core";
 *
 * function isFailure(code: M3LExitCode): boolean {
 *   return code !== 0;
 * }
 * ```
 */
export type M3LExitCode = (typeof M3L_EXIT_CODES)[keyof typeof M3L_EXIT_CODES];

/**
 * The subset of {@link M3LExitCode} that {@link mapErrorToExitCode} can
 * actually produce. `SUCCESS` (`0`), `INTERRUPTED` (`5`), and `PARTIAL` (`6`)
 * are set directly by the caller rather than derived from a caught error (see
 * {@link M3L_EXIT_CODES}), so this narrower union excludes all three — making
 * the "never returns 0, 5, or 6" invariant checkable by the type system,
 * not just by convention.
 *
 * @example
 * ```ts
 * import type { M3LErrorExitCode } from "@m3l-automation/m3l-common/core";
 *
 * function isConfigFault(code: M3LErrorExitCode): boolean {
 *   return code === 2;
 * }
 * ```
 */
export type M3LErrorExitCode = Exclude<
  M3LExitCode,
  | typeof M3L_EXIT_CODES.SUCCESS
  | typeof M3L_EXIT_CODES.INTERRUPTED
  | typeof M3L_EXIT_CODES.PARTIAL
>;

/**
 * Compile-time pin: fails to compile (TS2322) if a future
 * {@link M3L_EXIT_CODES} entry widens {@link M3LErrorExitCode} beyond the
 * four error codes. `Exclude` is fail-open — a new registry code joins the
 * union silently, because widening a return type is not a TypeScript error at
 * any call site. This pin converts that silent widening into a build failure:
 * when the conditional resolves to `never`, assigning `true` is TS2322.
 *
 * Expressed through the registry (`typeof M3L_EXIT_CODES.*`) so it is
 * self-maintaining and carries no bare numeric literals. The `_` prefix
 * satisfies `varsIgnorePattern: "^_"` in `no-unused-vars` without a
 * suppression comment.
 */
const _m3lErrorExitCodePin: M3LErrorExitCode extends
  | typeof M3L_EXIT_CODES.UNCLASSIFIED
  | typeof M3L_EXIT_CODES.CONFIG_USAGE
  | typeof M3L_EXIT_CODES.EXTERNAL
  | typeof M3L_EXIT_CODES.LIBRARY
  ? true
  : never = true;

/** Safely reads a string-valued own property from an unknown value. */
function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Type guard narrowing a structurally-read `origin` string to a known
 * {@link M3LErrorOrigin}. A future origin added to that union (ADR-0035
 * phase 2) fails this guard until a corresponding case is added to
 * {@link exitCodeForOrigin} — a compile error there, not a silent runtime
 * fall-through here.
 *
 * @example
 * ```ts
 * import { isM3LErrorOrigin } from "@m3l-automation/m3l-common/core";
 *
 * isM3LErrorOrigin("caller"); // true
 * isM3LErrorOrigin("some-future-origin"); // false
 * ```
 */
export function isM3LErrorOrigin(value: unknown): value is M3LErrorOrigin {
  return value === "caller" || value === "external" || value === "library";
}

/**
 * Exhaustively maps a known {@link M3LErrorOrigin} to its exit-code category.
 * The `default` branch is unreachable for any real {@link M3LErrorOrigin}
 * value; it exists purely so that adding a fourth origin without a
 * corresponding case here fails to *compile*.
 */
function exitCodeForOrigin(origin: M3LErrorOrigin): M3LErrorExitCode {
  switch (origin) {
    case "caller":
      return M3L_EXIT_CODES.CONFIG_USAGE;
    case "external":
      return M3L_EXIT_CODES.EXTERNAL;
    case "library":
      return M3L_EXIT_CODES.LIBRARY;
    default: {
      const exhaustive: never = origin;
      throw new M3LError(`unhandled error origin ${String(exhaustive)}`, {
        code: "ERR_INVALID_ARGUMENT",
      });
    }
  }
}

/**
 * Resolves an exit code for `error` without the outer never-throw guarantee
 * — split out purely to keep {@link mapErrorToExitCode} shallow so a hostile
 * getter's `try`/`catch` sits at a single nesting level.
 */
function resolveExitCode(error: unknown): M3LErrorExitCode | undefined {
  const origin = readStringProperty(error, "origin");
  const fromOrigin =
    origin !== undefined && isM3LErrorOrigin(origin)
      ? exitCodeForOrigin(origin)
      : undefined;
  if (fromOrigin !== undefined) return fromOrigin;

  const code = readStringProperty(error, "code");
  if (code === undefined) return undefined;

  const classification = classifyErrorCode(code);
  return classification === undefined
    ? undefined
    : exitCodeForOrigin(classification.origin);
}

/**
 * Maps an arbitrary caught value to a process exit code.
 *
 * Resolution order:
 *
 * 1. A structural `origin` field on the value itself (works on any plain
 *    object, not only an `M3LError` instance — this is a structural read,
 *    not an `instanceof` check).
 * 2. A catalog lookup by the value's `code` field, via
 *    {@link classifyErrorCode}.
 * 3. `M3L_EXIT_CODES.UNCLASSIFIED` (`1`) when neither resolves.
 *
 * Never throws — every read is guarded, so a hostile getter on `origin` or
 * `code` (or a circular object) still yields `1` rather than propagating.
 * Never returns `0` (`SUCCESS`), `5` (`INTERRUPTED`), or `6` (`PARTIAL`):
 * those are set directly by the caller, not derived from a caught error.
 * Never calls `process.exit()` — mapping an error to a code is a pure
 * computation; exiting the process is the caller's responsibility.
 *
 * @param error - Any caught value.
 * @returns One of `1`, `2`, `3`, or `4` from {@link M3L_EXIT_CODES}, typed
 *   precisely as {@link M3LErrorExitCode}.
 *
 * @example
 * ```ts
 * import { mapErrorToExitCode } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   await runTask();
 * } catch (error: unknown) {
 *   process.exitCode = mapErrorToExitCode(error);
 * }
 * ```
 */
export function mapErrorToExitCode(error: unknown): M3LErrorExitCode {
  try {
    return resolveExitCode(error) ?? M3L_EXIT_CODES.UNCLASSIFIED;
  } catch {
    return M3L_EXIT_CODES.UNCLASSIFIED;
  }
}
