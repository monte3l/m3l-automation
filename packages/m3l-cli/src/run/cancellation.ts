/**
 * `run/cancellation` — cooperative-cancellation scope for CLI dispatches
 * (U11, ADR-0049). Traps SIGINT and SIGTERM so the parent process stays alive
 * long enough to complete teardown (envelope emission, history recording), then
 * escalates on a second signal so the operator can always force-kill a stuck
 * process — an operator must never be trapped.
 *
 * @packageDocumentation
 */

import type { EventEmitter } from "node:events";

/**
 * The scope object returned by {@link createCancellationScope}: a live
 * {@link AbortSignal} the dispatch loop or in-process host can observe, and a
 * `dispose` function that removes the SIGINT/SIGTERM listeners once the
 * dispatch has exited.
 *
 * @example
 * ```ts
 * // run/cancellation is package-internal; import via the compiled relative path
 * import { createCancellationScope } from "./cancellation.js";
 *
 * const scope = createCancellationScope();
 * try {
 *   await runJob(scope.signal);
 * } finally {
 *   scope.dispose();
 * }
 * ```
 */
export interface M3LCancellationScope {
  /** Becomes aborted on the first SIGINT or SIGTERM received. */
  readonly signal: AbortSignal;
  /**
   * Removes every SIGINT and SIGTERM listener this scope registered on the
   * emitter. Idempotent — safe to call multiple times; subsequent calls are
   * no-ops because `EventEmitter.off` uses reference equality and is itself
   * a no-op when the listener is not found.
   */
  readonly dispose: () => void;
}

/**
 * Options for {@link createCancellationScope}. Both seams are injectable so
 * the test suite never fires a real SIGINT at the Vitest worker and never
 * calls a real `process.kill`.
 */
export interface M3LCancellationScopeOptions {
  /**
   * The event emitter to register SIGINT/SIGTERM listeners on. Defaults to
   * `process`. Tests inject an {@link EventEmitter} instance so no real signal
   * ever reaches the Vitest process.
   */
  readonly emitter?: EventEmitter;
  /**
   * Called exactly once when the second signal arrives, to restore the OS's
   * default termination disposition and re-raise the signal. Defaults to
   * {@link escalateBySignal}, which removes all listeners for the signal
   * before calling `process.kill` so Node's default disposition is not
   * suppressed. Tests inject a spy so the real escalation path is never
   * reached from within the test suite.
   */
  readonly killer?: (signal: string) => void;
}

/**
 * Restores the OS's default signal disposition for `signal` by removing all
 * listeners for that signal, then re-raises it at the target process so the
 * OS's default termination disposition (exit code 128 + signo) actually
 * applies.
 *
 * **Why listener removal must precede the re-raise:** Node.js suppresses a
 * signal's OS default disposition whenever at least one listener is registered
 * for it. Calling `process.kill(pid, sig)` while this scope's own
 * `sigintHandler`/`sigtermHandler` — or any sibling scope's listeners (e.g.
 * the `main.ts` survival scope and the `dynamic.ts` per-dispatch scope that
 * can both be live simultaneously) — are still attached delivers the signal
 * right back into those handlers instead of terminating the process. Using
 * `removeAllListeners` rather than removing only this scope's two handlers is
 * correct and intentional: an operator sending a second signal means
 * "force-terminate regardless of what is in flight", overriding every
 * in-process signal handler, including sibling scopes.
 *
 * The `target` parameter is injectable so tests can assert that
 * `removeAllListeners` is called *before* `kill` without actually killing the
 * Vitest worker.
 *
 * @param signal - The signal string to restore and re-raise (e.g. `"SIGINT"`).
 * @param target - The object whose listeners are cleared and whose `kill` is
 *   called. Defaults to `process`. Tests inject a fake target.
 *
 * @example
 * ```ts
 * import { escalateBySignal } from "./cancellation.js";
 *
 * // In a test: verify ordering without killing the Vitest worker
 * const ops: string[] = [];
 * escalateBySignal("SIGINT", {
 *   pid: 1,
 *   removeAllListeners(event: string) { ops.push(`remove:${event}`); },
 *   kill(_pid: number, sig: string) { ops.push(`kill:${sig}`); },
 * });
 * // ops === ["remove:SIGINT", "kill:SIGINT"]
 * ```
 */
export function escalateBySignal(
  signal: string,
  target: {
    readonly pid: number;
    removeAllListeners(event: string): void;
    kill(pid: number, signal: string): void;
  } = process,
): void {
  // Remove all listeners for this signal before re-raising so that Node's
  // default OS disposition (terminate) is restored. Without this, the signal
  // is re-delivered into the still-registered handlers and the process never
  // exits. See TSDoc above for the full rationale.
  target.removeAllListeners(signal);
  target.kill(target.pid, signal);
}

/**
 * The default escalation killer: removes all listeners for `signal` to restore
 * the OS's default disposition, then re-raises the signal at this process so
 * termination actually applies.
 *
 * Listener removal is required because Node.js suppresses a signal's OS
 * default disposition whenever any listener is registered for it. Without it,
 * `process.kill` delivers the signal back into the still-registered handlers
 * (including sibling scopes) rather than terminating the process. See
 * {@link escalateBySignal} for the full rationale.
 *
 * Defined as a named module-level function — not an inline arrow inside
 * {@link createCancellationScope} — so tests that inject their own `killer`
 * spy have no path to this real escalation code.
 */
function defaultKiller(signal: string): void {
  escalateBySignal(signal);
}

/**
 * Creates a cooperative-cancellation scope for a single CLI dispatch (U11,
 * ADR-0049).
 *
 * Registers one listener each for SIGINT and SIGTERM on `options.emitter`
 * (defaulting to `process`). A shared signal counter drives three phases:
 *
 * - **First signal** (either type): aborts the returned {@link AbortSignal}
 *   without killing the process. The dispatch may observe the abort and unwind
 *   gracefully while the parent survives to finish teardown.
 * - **Second signal** (either type): calls `options.killer` exactly once,
 *   re-raising the signal so the OS's default termination disposition applies.
 *   An operator is never trapped in a hung process.
 * - **Third and later signals**: no-op — the escalation has already been
 *   requested and nothing more needs to happen.
 *
 * Always call {@link M3LCancellationScope.dispose} in a `finally` block so
 * the SIGINT/SIGTERM listeners are removed when the dispatch exits, preventing
 * listener accumulation across successive calls.
 *
 * @param options - Optional emitter and killer overrides; defaults to
 *   `process` and {@link escalateBySignal} (which removes all listeners for
 *   the signal before re-raising, restoring the OS's default termination
 *   disposition).
 * @returns A {@link M3LCancellationScope} with an {@link AbortSignal} and an
 *   idempotent `dispose` function.
 *
 * @example
 * ```ts
 * // run/cancellation is package-internal; import via the compiled relative path
 * import { createCancellationScope } from "./cancellation.js";
 *
 * const scope = createCancellationScope();
 * try {
 *   await spawnScript(dir, argv, spawnOptions);
 * } finally {
 *   scope.dispose(); // removes SIGINT/SIGTERM listeners unconditionally
 * }
 * ```
 */
export function createCancellationScope(
  options?: M3LCancellationScopeOptions,
): M3LCancellationScope {
  const emitter: EventEmitter = options?.emitter ?? process;
  const killer = options?.killer ?? defaultKiller;
  const controller = new AbortController();
  // Boolean flags track the two one-way state transitions so the handler
  // avoids a magic-number counter. Each flag starts false and can only
  // become true — the state machine is strictly monotone.
  let aborted = false;
  let escalated = false;

  // onSignal is shared across SIGINT and SIGTERM so the state is global:
  // SIGINT then SIGTERM still escalates on the second hit, regardless of
  // which signal type arrives first (A2 contract — cross-type escalation).
  function onSignal(sig: string): void {
    if (!aborted) {
      // First signal: abort the scope's AbortSignal so the dispatch can
      // unwind cooperatively. The process is kept alive — parent survival
      // is the whole point of this scope (D11).
      aborted = true;
      controller.abort();
    } else if (!escalated) {
      // Second signal: escalate via the injected killer. An operator
      // sending two Ctrl-C must always be able to force-terminate the
      // process (A2 — no operator trapping). The default killer removes all
      // listeners for the signal before re-raising so Node's OS default
      // disposition (terminate) applies; see escalateBySignal.
      escalated = true;
      killer(sig);
    }
    // escalated === true: no-op — killer has already been called; remain
    // silent so repeated signals do not invoke the killer a second time.
  }

  const sigintHandler = (): void => {
    onSignal("SIGINT");
  };
  const sigtermHandler = (): void => {
    onSignal("SIGTERM");
  };

  emitter.on("SIGINT", sigintHandler);
  emitter.on("SIGTERM", sigtermHandler);

  // dispose() passes the exact function references we registered, so
  // EventEmitter.off uses reference-equality removal — idempotent because
  // calling off() after the listeners are already gone is a safe no-op.
  function dispose(): void {
    emitter.off("SIGINT", sigintHandler);
    emitter.off("SIGTERM", sigtermHandler);
  }

  return { signal: controller.signal, dispose };
}
