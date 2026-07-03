/**
 * `core/exporters/internal/onceErrorEmitter` — one-shot `export:error`
 * emission guard shared by the CSV/JSON/HTML stream writers.
 *
 * Private to `core/exporters`: never re-exported through the module barrel.
 *
 * @packageDocumentation
 */

import type { M3LError } from "../../errors/index.js";

/**
 * Wraps an `export:error` emitter so it fires at most once. A stream
 * writer's `append()` and `close()` each independently catch failures on the
 * same underlying `M3LWriteStreamLifecycle`; without this guard, a failure
 * surfaced by `append()` would emit again when a caller's `finally` block
 * also calls `close()` (which hits the lifecycle's cached-error fast-path).
 *
 * @param emit - The underlying emit function to guard.
 * @returns A function with the same signature as `emit`, callable safely
 *   more than once — only the first call has an effect.
 */
export function onceErrorEmitter(
  emit: (error: M3LError) => void,
): (error: M3LError) => void {
  let fired = false;
  return (error: M3LError) => {
    if (fired) return;
    fired = true;
    emit(error);
  };
}
