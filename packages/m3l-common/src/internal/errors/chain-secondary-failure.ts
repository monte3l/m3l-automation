/**
 * `internal/errors/chain-secondary-failure` — attaches a cleanup-path
 * failure onto the error a caller is already about to throw, so neither
 * failure is lost.
 *
 * Library-internal; never re-exported through a public barrel. Generalised
 * from `aws/rds-data`'s own `attachRollbackFailure`, which solves the
 * identical problem (a rollback that fails while a transaction body is
 * already failing) and carries the read-back verification this library's
 * error rules require. That caller is NOT migrated onto this helper: it
 * branches on the boolean return to build a different error per arm, so the
 * migration is a behaviour-review of its own rather than a mechanical
 * substitution.
 *
 * @packageDocumentation
 */

/**
 * How far {@link chainSecondaryFailure} walks a `.cause` chain looking for
 * an open slot. Bounded so a pathological (e.g. cyclic) chain cannot loop
 * forever.
 */
const MAX_CAUSE_CHAIN_WALK = 10;

/**
 * Attaches `secondary` to the first open `.cause` slot on `primary`'s own
 * `.cause` chain, so a failure that happened *while already failing* stays
 * reachable from the error the caller ultimately throws. Checks
 * `primary.cause` itself first; when that is already taken, follows
 * `.cause` links up to {@link MAX_CAUSE_CHAIN_WALK} levels deep. An
 * already-set `.cause` at any level is never overwritten — the primary
 * failure's own diagnostic chain outranks the cleanup one.
 *
 * Every read of `.cause` (the open-slot check and the chain-walk step) and
 * the write are performed inside one `try`/`catch` per link, so a `.cause`
 * accessor whose getter or setter throws (or a `Proxy` whose `get`/`set`
 * trap throws) can never let a raw error escape this helper and mask the
 * error its caller intended to throw — that link is treated as failed and
 * the walk stops there rather than continuing past a link whose `.cause`
 * state is now unknown. After an assignment that doesn't throw, the value
 * is read back and compared against `secondary`; a `.cause` setter that
 * silently no-ops (accepts the assignment without storing it) therefore
 * does not get reported as a success.
 *
 * Returns `false` — never throws — when attachment did not happen, whether
 * because `primary` isn't an `Error`, no open slot was found within the
 * bound, a read or write at some link threw, or a write's read-back did not
 * match `secondary`. A caller that cannot chain still throws its primary
 * error: losing the cleanup detail is strictly better than replacing the
 * failure the caller actually needs to see.
 *
 * @param primary - The error already in flight, mutated in place when an
 *   open, writable slot is found.
 * @param secondary - The cleanup-path failure to chain onto it.
 * @returns `true` when `secondary` was attached and verified somewhere in
 *   `primary`'s chain, `false` otherwise.
 */
export function chainSecondaryFailure(
  primary: unknown,
  secondary: unknown,
): boolean {
  let link: Error | undefined = primary instanceof Error ? primary : undefined;
  for (
    let depth = 0;
    link !== undefined && depth < MAX_CAUSE_CHAIN_WALK;
    depth += 1
  ) {
    try {
      if (link.cause !== undefined) {
        link = link.cause instanceof Error ? link.cause : undefined;
        continue;
      }
      link.cause = secondary;
      return link.cause === secondary;
    } catch {
      // A read or write at this link threw (frozen/sealed/non-extensible
      // error, an accessor-only `.cause`, or a getter/setter that itself
      // throws). This link's `.cause` state is now unknown/untrustworthy,
      // so stop here rather than attempting to walk past it.
      return false;
    }
  }
  return false;
}
