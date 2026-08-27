/**
 * `errors/chain-secondary-failure` — chains a cleanup failure onto the
 * cause chain of the primary failure it occurred while handling.
 *
 * @packageDocumentation
 */

/**
 * Chains `secondary` onto `primary`'s cause chain WITHOUT replacing an
 * existing `cause` — walks down the chain (`primary`'s own `cause`, then
 * that value's own `cause`, and so on) until it finds the first node whose
 * `cause` is `undefined`, and attaches `secondary` there. When `primary`
 * itself has no `cause` yet, that is the first (and only) node visited, so
 * the behaviour collapses to the simple case: `primary.cause = secondary`.
 *
 * This is for a **cleanup failure that occurs while handling another
 * failure** — e.g. a `ROLLBACK` that itself fails while unwinding a failed
 * transaction, or a `store.close()` that itself fails while unwinding a
 * failed boot. `primary` is what the caller needs to see and must always
 * propagate unchanged; `secondary` must not be allowed to shadow it, but it
 * also must not simply vanish, since it can carry real operational
 * information (e.g. a stale WAL left behind by a close that didn't
 * complete). Walking to the first free `cause` slot — rather than
 * overwriting `primary.cause` outright — preserves an existing chain, which
 * matters because `primary` reaching here is very often already a
 * constructed error whose own `cause` is the original raw failure that
 * triggered the cleanup in the first place.
 *
 * Bounded by a `seen` set against a cyclical chain, and tolerant of a
 * hostile or frozen node anywhere in the chain (best-effort): this runs on
 * the failure path, where `primary` is what matters above all else, so a
 * mutation that cannot be applied is silently skipped rather than allowed
 * to throw a new, more confusing error.
 *
 * Used by `store/executor.ts` (a failing `ROLLBACK`/`ROLLBACK TO` while
 * unwinding a failed transaction or nested savepoint) and `main.ts` (a
 * failing `store.close()` while unwinding a failed boot, when there is no
 * runtime yet — and so no logger — for the close failure to be reported
 * through instead).
 *
 * @param primary - The failure the caller actually needs to see; always
 * propagated unchanged by every caller of this function.
 * @param secondary - The cleanup failure that occurred while handling
 * `primary`.
 *
 * @example
 * ```ts
 * import { M3LError } from "@m3l-automation/m3l-common/core";
 *
 * try {
 *   riskyCleanup();
 * } catch (secondary) {
 *   chainSecondaryFailure(primary, secondary);
 * }
 * throw primary instanceof M3LError ? primary : new M3LError("cleanup failed", { cause: primary });
 * ```
 */
export function chainSecondaryFailure(
  primary: unknown,
  secondary: unknown,
): void {
  const seen = new Set<unknown>();
  let current = primary;
  while (
    current !== null &&
    typeof current === "object" &&
    !seen.has(current)
  ) {
    seen.add(current);
    const node = current as { cause?: unknown };
    let existingCause: unknown;
    try {
      existingCause = node.cause;
    } catch {
      return; // hostile getter — stop rather than risk masking the primary failure
    }
    if (existingCause === undefined) {
      try {
        node.cause = secondary;
      } catch {
        /* best-effort — losing the chained secondary failure must not mask primary */
      }
      return;
    }
    current = existingCause;
  }
}
