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
   * Called exactly once when the second signal arrives, to re-raise it at
   * this process so its default OS disposition (termination) applies. Defaults
   * to `(sig) => process.kill(process.pid, sig)`. Tests inject a spy so the
   * real `process.kill` path is never reached from within the test suite.
   */
  readonly killer?: (signal: string) => void;
}

/**
 * The default escalation killer: re-raises the received signal at this
 * process so the OS's default disposition (immediate termination) applies.
 *
 * Defined as a named module-level function — not an inline arrow inside
 * {@link createCancellationScope} — so tests that inject their own `killer`
 * spy have no path to this real `process.kill` call.
 */
function defaultKiller(signal: string): void {
  process.kill(process.pid, signal);
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
 *   `process` and `process.kill(process.pid, sig)`.
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
      // process (A2 — no operator trapping).
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
