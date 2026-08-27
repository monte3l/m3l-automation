/**
 * `cli/errors` — the `M3LCliError` hierarchy and its exit-code mapping.
 *
 * The m3l CLI raises exactly one error class, discriminated by a closed
 * `code` union, so `main.ts` can map any thrown value to a stable process
 * exit code without inspecting error internals.
 *
 * @packageDocumentation
 */

import { Core } from "@m3l-automation/m3l-common";

/**
 * The closed set of machine-readable error codes the m3l CLI raises.
 *
 * @example
 * ```ts
 * function isUsageError(code: M3LCliErrorCode): boolean {
 *   return code === "ERR_CLI_UNKNOWN_COMMAND" || code === "ERR_CLI_UNKNOWN_SCRIPT";
 * }
 * ```
 */
export type M3LCliErrorCode =
  | "ERR_CLI_UNKNOWN_COMMAND"
  | "ERR_CLI_UNKNOWN_SCRIPT"
  | "ERR_CLI_CONFIG_IMPORT"
  | "ERR_CLI_WORKSPACE_NOT_FOUND"
  | "ERR_CLI_SCRIPT_NOT_BUILT"
  | "ERR_CLI_SPAWN_FAILED"
  | "ERR_CLI_UNKNOWN_PARAMETER"
  | "ERR_CLI_INVALID_PARAMETER_VALUE"
  | "ERR_CLI_DOCTOR_FAILED"
  | "ERR_CLI_PRESET_INVALID"
  | "ERR_CLI_SCAFFOLD_INVALID"
  | "ERR_CLI_SCAFFOLD_EXISTS"
  | "ERR_CLI_SCAFFOLD_FAILED"
  | "ERR_CLI_COMMAND_MODULE_INVALID"
  | "ERR_CLI_IN_PROCESS_FAILED"
  | "ERR_CLI_COMMAND_MODULE_IMPORT_FAILED"
  | "ERR_CLI_IN_PROCESS_UNSUPPORTED";

/**
 * The closed set of process exit codes the m3l CLI ever resolves to: `0`
 * (success), `1` (general failure), `2` (usage error).
 *
 * @example
 * ```ts
 * function describeExitCode(code: M3LCliExitCode): string {
 *   return code === 0 ? "success" : code === 2 ? "usage error" : "failure";
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- literal-type members, not magic runtime values; 0/1/2 are the exhaustive exit-code contract itself
export type M3LCliExitCode = 0 | 1 | 2;

/**
 * Constructor options for {@link M3LCliError}.
 */
interface M3LCliErrorOptions {
  /** The underlying failure that caused this error, if any. */
  readonly cause?: unknown;
  /** Human-readable "did you mean…" candidates for a usage-class error. */
  readonly suggestions?: readonly string[];
}

/**
 * The single error class the m3l CLI raises, discriminated by
 * {@link M3LCliErrorCode}. Extends `Core.M3LError` so callers can still
 * narrow via `instanceof Core.M3LError`.
 *
 * @example
 * ```ts
 * // extends Core.M3LError, so `instanceof Core.M3LError` still narrows it
 * throw new M3LCliError(
 *   "ERR_CLI_UNKNOWN_SCRIPT",
 *   "unknown script 'lst'",
 *   { suggestions: ["list"] },
 * );
 * ```
 */
export class M3LCliError extends Core.M3LError {
  /** The specific failure mode within the m3l CLI. */
  override readonly code: M3LCliErrorCode;

  /** "Did you mean…" candidates; empty when none apply. */
  readonly suggestions: readonly string[];

  /**
   * Creates a new `M3LCliError`.
   *
   * @param code - The specific failure mode.
   * @param message - Human-readable description of the failure.
   * @param options - Optional `cause` and `suggestions`.
   */
  constructor(
    code: M3LCliErrorCode,
    message: string,
    options: M3LCliErrorOptions = {},
  ) {
    super(message, { code, cause: options.cause });
    this.code = code;
    this.suggestions = options.suggestions ?? [];
  }
}

/** Exit code for every non-`M3LCliError` value, and the fallback within the map below. */
const GENERAL_EXIT_CODE: M3LCliExitCode = 1;

/**
 * Maps every {@link M3LCliErrorCode} to its exit code (analogous to a shell
 * "incorrect usage" convention for the usage-class codes). A `Record`
 * keyed by the full error-code union — rather than a `ReadonlySet` of the
 * usage-class subset — forces a compile error the moment a new
 * `M3LCliErrorCode` is added without an explicit exit-code decision for it.
 */
const EXIT_CODE_BY_ERROR_CODE: Record<M3LCliErrorCode, M3LCliExitCode> = {
  ERR_CLI_UNKNOWN_COMMAND: 2,
  ERR_CLI_UNKNOWN_SCRIPT: 2,
  ERR_CLI_CONFIG_IMPORT: GENERAL_EXIT_CODE,
  ERR_CLI_WORKSPACE_NOT_FOUND: GENERAL_EXIT_CODE,
  ERR_CLI_SCRIPT_NOT_BUILT: GENERAL_EXIT_CODE,
  ERR_CLI_SPAWN_FAILED: GENERAL_EXIT_CODE,
  ERR_CLI_UNKNOWN_PARAMETER: 2,
  ERR_CLI_INVALID_PARAMETER_VALUE: 2,
  ERR_CLI_DOCTOR_FAILED: GENERAL_EXIT_CODE,
  ERR_CLI_PRESET_INVALID: GENERAL_EXIT_CODE,
  ERR_CLI_SCAFFOLD_INVALID: 2,
  ERR_CLI_SCAFFOLD_EXISTS: 2,
  ERR_CLI_SCAFFOLD_FAILED: GENERAL_EXIT_CODE,
  ERR_CLI_COMMAND_MODULE_INVALID: GENERAL_EXIT_CODE,
  ERR_CLI_IN_PROCESS_FAILED: GENERAL_EXIT_CODE,
  ERR_CLI_COMMAND_MODULE_IMPORT_FAILED: GENERAL_EXIT_CODE,
  ERR_CLI_IN_PROCESS_UNSUPPORTED: 2,
};

/**
 * Resolves the process exit code for a thrown/caught value.
 *
 * @param error - Any value caught at the CLI's top level.
 * @returns `2` for a usage-class {@link M3LCliError} (any code the
 *   {@link EXIT_CODE_BY_ERROR_CODE} map assigns exit code `2`), `1` for
 *   every other `M3LCliError` and any non-`M3LCliError` value.
 *
 * @example
 * ```ts
 * const code = exitCodeForError(
 *   new M3LCliError("ERR_CLI_UNKNOWN_COMMAND", "unknown command 'foo'"),
 * );
 * // 2
 * ```
 */
export function exitCodeForError(error: unknown): M3LCliExitCode {
  if (error instanceof M3LCliError) {
    return EXIT_CODE_BY_ERROR_CODE[error.code];
  }
  return GENERAL_EXIT_CODE;
}
