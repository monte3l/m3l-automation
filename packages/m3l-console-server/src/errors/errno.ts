/**
 * `errors/errno` — extracts a Node filesystem failure's `errno` code, so
 * every zone can decide what to tolerate (e.g. `ENOENT`) without honouring
 * a forgeable inherited property. Also exports {@link underlyingErrnoCodeOf},
 * which walks past any number of wrapping `Core.M3LError` layers to find
 * that same own `code` on the first non-M3L link underneath them.
 *
 * @packageDocumentation
 */

import { Core } from "@monte3l/m3l-common";

/**
 * The `errno` code a Node filesystem failure carries as its OWN property, or
 * `undefined` for any value that is not one.
 *
 * OWNERSHIP IS PART OF THE CHECK, not a nicety. Whatever the caller tolerates
 * is decided from this code, so honouring an INHERITED `code` would make
 * that outcome forgeable at a distance: one `Error.prototype.code = "ENOENT"`
 * anywhere in the process, or a `get code()` on the prototype of any thrown
 * subclass, and every non-matching failure would quietly present as the
 * tolerated one, with no warning at all. Node's own errno errors always set
 * `code` as an own property, so requiring ownership costs no real path
 * anything — which is also why the guard is unreachable from any current
 * `node:fs` call site and is instead covered by calling this function
 * directly.
 *
 * Reads `.code` ONCE into a local and narrows the local, never the property
 * expression: a getter may answer differently on each read, so a
 * `typeof x.code === "string" ? x.code : …` chain is two reads of a value
 * that only one of them validated. `Object.hasOwn` tests for the property
 * without reading it, so the ownership guard adds no second read.
 *
 * Lives in `errors/` because it is the one zone every other zone may
 * import — `eslint.config.js`'s `no-restricted-paths` lists `errors` in
 * every zone's `except` — which is what lets both `runs/` and `telemetry/`
 * share this one copy: `telemetry/` may not import `runs/`, which is why
 * two near-identical copies existed before this module was hoisted out.
 *
 * @param cause - Any caught value, typically from a `node:fs` call.
 * @returns The own `code` string, or `undefined` when `cause` is not an
 * `Error`, has no own `code` property, or that property is not a string.
 *
 * @example
 * ```ts
 * import { readFileSync } from "node:fs";
 *
 * try {
 *   readFileSync("/does/not/exist");
 * } catch (cause) {
 *   if (errnoCodeOf(cause) === "ENOENT") {
 *     // tolerate a missing file
 *   }
 * }
 * ```
 */
export function errnoCodeOf(cause: unknown): string | undefined {
  if (!(cause instanceof Error) || !Object.hasOwn(cause, "code")) {
    return undefined;
  }
  const code: unknown = (cause as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

/** The maximum number of links {@link underlyingErrnoCodeOf} inspects — the caught value itself plus up to nine causes — mirroring `MAX_CAUSE_CHAIN_WALK` in `packages/m3l-common/src/aws/rds-data/client.ts`. */
const MAX_CAUSE_CHAIN_WALK = 10;

/**
 * The `errno`-shaped own `code` of the first NON-`Core.M3LError` `Error` link
 * found by walking `cause` and then its `.cause` chain, or `undefined` when
 * no such link exists within the walked bound.
 *
 * `errnoCodeOf` reads only its argument's own `code` — for a driver that
 * wraps a real filesystem failure inside one or more `Core.M3LError` layers
 * (e.g. `M3LConsoleError` → `Core.M3LAppendOnlyStreamReadError` → a
 * `node:fs` error), calling it on the outermost caught value just returns
 * the M3L code (e.g. `"ERR_CONSOLE_INTERNAL"`), never the underlying errno.
 * This function exists to see past that wrapping.
 *
 * A link that `instanceof Core.M3LError` is SKIPPED rather than inspected:
 * its own `code` is this project's own vocabulary (`M3LConsoleErrorCode`,
 * `M3L_ERROR_CODES`, …), never a Node errno, so reading it here would be as
 * wrong as reading a random property. The walk instead steps to that link's
 * own `.cause` looking for the real failure underneath.
 *
 * The FIRST non-`Core.M3LError` link — not the last, not the deepest —
 * decides the result, and the walk stops there. A code sitting deeper than
 * that link belongs to some OTHER, unrelated error one layer further down
 * (see the "first non-M3L link decides" test in `errno.test.ts`), and
 * returning it would misattribute one failure's code to a different one.
 * The result is {@link errnoCodeOf} on that link, verbatim — including a
 * non-POSIX Node code such as `"ERR_SQLITE_ERROR"`, which is returned
 * deliberately: it IS the underlying cause, even though it does not look
 * like a traditional `"E…"` errno name.
 *
 * The walk is bounded by {@link MAX_CAUSE_CHAIN_WALK}: it inspects at most
 * ten links — the caught value itself plus up to nine causes — because a
 * `.cause` chain is caller-constructed data, not a structure this module
 * controls, and an accidental or adversarial cycle (say, `a.cause = b` and
 * `b.cause = a`) would otherwise loop forever. A link's `.cause` is read
 * only when a further link remains to inspect, and exactly ONCE per read,
 * inside a `try`/`catch`: a throwing getter ends the walk with `undefined`
 * rather than propagating, because code on this failure-reporting path
 * must never itself throw. A link that is not an `Error` at all (including
 * the starting `cause` itself) also ends the walk with `undefined` — there
 * is nothing further to read `.cause` from. The tenth link's own `.cause`
 * is never read, since there is no eleventh link left to inspect with it.
 *
 * @param cause - Any caught value, typically an `M3LConsoleError` (or other
 *   `Core.M3LError`) that may wrap a real filesystem or driver failure.
 * @returns The first non-M3L link's own `code`, or `undefined` when `cause`
 *   is not an `Error`, every link up to the bound is a `Core.M3LError`, or
 *   the first non-M3L link has no qualifying own `code`.
 *
 * @example
 * ```ts
 * import { Core } from "@monte3l/m3l-common";
 *
 * try {
 *   await readAuditTrail();
 * } catch (cause) {
 *   // cause: M3LConsoleError -> Core.M3LAppendOnlyStreamReadError -> ENOTDIR
 *   if (underlyingErrnoCodeOf(cause) === "ENOTDIR") {
 *     // the real fs failure, not the wrapping M3L code
 *   }
 * }
 * ```
 */
export function underlyingErrnoCodeOf(cause: unknown): string | undefined {
  let link: unknown = cause;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_WALK; depth += 1) {
    if (!(link instanceof Error)) {
      return undefined;
    }
    if (!(link instanceof Core.M3LError)) {
      return errnoCodeOf(link);
    }
    if (depth === MAX_CAUSE_CHAIN_WALK - 1) {
      // This is the last link the bound allows inspecting — there is no
      // further link to walk to, so reading `.cause` here would be a wasted
      // (and, for a hostile getter, needlessly risky) read.
      return undefined;
    }
    try {
      link = link.cause;
    } catch {
      // A `.cause` getter that itself throws leaves this link's downstream
      // state unknowable — stop here rather than risk propagating a raw
      // throw out of a failure-reporting helper.
      return undefined;
    }
  }
  return undefined;
}
