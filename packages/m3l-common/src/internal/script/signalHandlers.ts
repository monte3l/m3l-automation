/**
 * `internal/script/signalHandlers` — graceful-shutdown signal registration
 * for non-AWS execution environments.
 *
 * Not re-exported publicly; consumed only by `core/script/M3LScript`.
 *
 * @packageDocumentation
 */

import { serializeError } from "../../core/script/process-guards.js";

import { logBestEffortDiagnostic } from "./diagnostics.js";

/** The process signals `M3LScript` reacts to outside AWS-managed environments. */
const HANDLED_SIGNALS = ["SIGTERM", "SIGINT", "SIGQUIT"] as const;

/** One of the signals registered by {@link registerShutdownSignals}. */
type HandledSignal = (typeof HANDLED_SIGNALS)[number];

/**
 * The exit code {@link registerShutdownSignals} forces on a second signal.
 * Defaults to `1`; overridable via {@link setForcedSignalExitCode} (a direct
 * setter) or, for a scoped override that composes under nesting/overlap, via
 * {@link pushForcedSignalExitCode} — used by `runScript` (the `core/script`
 * composition-root wrapper) to force `M3L_EXIT_CODES.INTERRUPTED` for the
 * duration of a run, so a forced-exit shutdown reports the same exit code a
 * caller inspecting `process.exitCode` would expect from an interrupted run.
 */
let forcedSignalExitCode = 1;

/**
 * Overrides the exit code {@link registerShutdownSignals} forces on a second
 * shutdown signal (module-level state — applies to every subsequent second
 * signal across every registered handler, not just one instance's). Not
 * re-exported publicly; consumed only by `core/script`.
 *
 * A direct, unscoped setter — kept `(code: number) => void` (rather than
 * returning the previous value) to match its pinned type-level contract. A
 * caller that needs the override to apply only for a bounded region of code,
 * with correct restore-on-exit semantics even under nested/overlapping
 * scopes, should use {@link pushForcedSignalExitCode} instead (that is what
 * `runScript` does); reach for this setter only for an unscoped, permanent
 * change to the default.
 *
 * @param code - The exit code to force on the next second signal.
 *
 * @example
 * ```ts
 * import { setForcedSignalExitCode } from "../internal/script/signalHandlers.js";
 *
 * setForcedSignalExitCode(5);
 * ```
 */
export function setForcedSignalExitCode(code: number): void {
  forcedSignalExitCode = code;
}

/**
 * Reads the exit code {@link registerShutdownSignals} currently forces on a
 * second shutdown signal — the counterpart read side to
 * {@link setForcedSignalExitCode} and {@link pushForcedSignalExitCode}, used
 * by tests and by a caller wanting to inspect the value currently in effect.
 *
 * @returns The current forced second-signal exit code.
 *
 * @example
 * ```ts
 * import { getForcedSignalExitCode } from "../internal/script/signalHandlers.js";
 *
 * const current = getForcedSignalExitCode();
 * ```
 */
export function getForcedSignalExitCode(): number {
  return forcedSignalExitCode;
}

/**
 * Nesting depth of in-flight {@link pushForcedSignalExitCode} scopes. The
 * baseline is captured only when this transitions `0 -> 1` (outermost entry)
 * and restored only when it returns to `0` (outermost exit) — see
 * {@link pushForcedSignalExitCode} for the full rationale.
 */
let forcedSignalExitCodeDepth = 0;

/**
 * The forced-exit-code value in effect immediately before the outermost
 * still-in-flight {@link pushForcedSignalExitCode} call overrode it.
 * Restored into {@link forcedSignalExitCode} only when
 * {@link forcedSignalExitCodeDepth} returns to `0`.
 */
let forcedSignalExitCodeBaseline = 1;

/**
 * Scopes a {@link setForcedSignalExitCode}-style override to a caller-defined
 * region of code, composing correctly under nested or overlapping calls in
 * the same process (e.g. two overlapping `runScript` invocations, or a
 * `runScript` nested inside another's `mainFn`) — unlike a naive
 * "capture-the-previous-value, override, restore-the-captured-value" pattern
 * built directly on {@link getForcedSignalExitCode}/{@link setForcedSignalExitCode},
 * which is only correct for strictly sequential calls. Under overlap that
 * naive pattern corrupts state:
 *
 * ```text
 * A starts: previous=1, sets 5
 * B starts (A still running): previous=5   <- captures A's override, not the
 *                                              real baseline
 * A resolves -> restores 1                 <- wrong: B is still mid-run and
 *                                              needs 5
 * B resolves -> restores 5                 <- wrong: stuck at 5 forever, no
 *                                              run in flight
 * ```
 *
 * This function instead tracks a depth counter: the baseline is captured
 * only on the outermost entry (depth `0 -> 1`) and restored only once every
 * entry has released (depth back to `0`), so an inner call's release leaves
 * the baseline untouched and can never disturb an outer call still in
 * flight.
 *
 * @param code - The exit code to force for the duration of this scope.
 * @returns A release function to call when the scope ends. Idempotent —
 *   calling it more than once decrements the depth counter at most once per
 *   `push`, so a caller that (accidentally) releases twice cannot drive the
 *   depth negative and corrupt a sibling scope.
 *
 * @example
 * ```ts
 * import { pushForcedSignalExitCode } from "../internal/script/signalHandlers.js";
 *
 * const release = pushForcedSignalExitCode(5);
 * try {
 *   // ... run the scoped work ...
 * } finally {
 *   release();
 * }
 * ```
 */
export function pushForcedSignalExitCode(code: number): () => void {
  if (forcedSignalExitCodeDepth === 0) {
    forcedSignalExitCodeBaseline = forcedSignalExitCode;
  }
  forcedSignalExitCodeDepth += 1;
  forcedSignalExitCode = code;

  let released = false;
  return (): void => {
    if (released) {
      return;
    }
    released = true;
    forcedSignalExitCodeDepth -= 1;
    if (forcedSignalExitCodeDepth === 0) {
      forcedSignalExitCode = forcedSignalExitCodeBaseline;
    }
  };
}

/**
 * Registers `SIGTERM`/`SIGINT`/`SIGQUIT` handlers that invoke
 * `onShutdown` (best-effort, fire-and-forget) on the first receipt of any of
 * them, and force `process.exit()` with the current
 * {@link setForcedSignalExitCode} override (`1` unless overridden) on any
 * subsequent receipt of a second signal — the standard "first signal asks
 * nicely, second signal is final" shutdown pattern.
 *
 * Each call to this function installs a fresh, independent set of handlers
 * and its own "already signaled" flag; callers are responsible for calling
 * it at most once per {@link M3LScript} instance (construction time, gated
 * on non-AWS environments).
 *
 * @param onShutdown - Invoked once, on the first signal received. Its
 *   returned promise (if any) is not awaited by this function — shutdown is
 *   best-effort and must not block signal delivery.
 */
export function registerShutdownSignals(
  onShutdown: () => void | Promise<void>,
): void {
  let signaled = false;

  const handleSignal = (): void => {
    if (signaled) {
      process.exit(forcedSignalExitCode);
      return;
    }
    signaled = true;
    // Fire-and-forget: a hanging or rejecting shutdown must not prevent the
    // process from otherwise exiting naturally, and a synchronous throw from
    // a misbehaving onShutdown must not crash the signal handler itself.
    void Promise.resolve()
      .then(() => onShutdown())
      .catch((cause: unknown) => {
        // Best-effort shutdown — a failure here is not actionable from
        // inside a signal handler, but it must not vanish silently either.
        logBestEffortDiagnostic("onShutdown", serializeError(cause));
      });
  };

  for (const signal of HANDLED_SIGNALS as readonly HandledSignal[]) {
    process.on(signal, handleSignal);
  }
}
