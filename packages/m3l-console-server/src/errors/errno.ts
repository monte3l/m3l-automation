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
  return Core.errnoCodeOf(cause);
}

/**
 * The maximum number of links {@link underlyingErrnoCodeOf} inspects — the
 * caught value itself plus up to nine causes — mirroring
 * `MAX_CAUSE_CHAIN_WALK` in `packages/m3l-common/src/aws/rds-data/client.ts`.
 */
const MAX_CAUSE_CHAIN_WALK = 10;

/**
 * One link's classification during {@link underlyingErrnoCodeOf}'s walk:
 *
 * - `"stop"` — the link is not an `Error`, the walk bound forbids reading a
 *   further `.cause`, or inspecting the link threw. There is nothing further
 *   to walk to, so the overall result is `undefined`.
 * - `"decide"` — the link is the first non-`Core.M3LError` `Error` found;
 *   `code` (from {@link errnoCodeOf}, possibly itself `undefined`) is the
 *   walk's final answer.
 * - `"advance"` — the link is a `Core.M3LError` and a further link remains
 *   to inspect; `next` is its own `.cause`, read exactly once.
 */
type LinkInspection =
  | { readonly kind: "stop" }
  | { readonly kind: "decide"; readonly code: string | undefined }
  | { readonly kind: "advance"; readonly next: unknown };

/**
 * Classifies one link in {@link underlyingErrnoCodeOf}'s walk, never
 * throwing.
 *
 * Every read that could observe attacker- or caller-controlled behaviour —
 * `instanceof Error`, `instanceof Core.M3LError`, {@link errnoCodeOf}'s own
 * `Object.hasOwn` and `.code` read, and the `.cause` read — happens inside
 * ONE `try`. A HOSTILE link (a `code` getter that throws, or a Proxy whose
 * `getPrototypeOf` or `getOwnPropertyDescriptor` trap throws) therefore
 * classifies the same as a non-`Error` link: `"stop"`. Returning `undefined`
 * for a link that cannot be safely inspected is correct here — this helper
 * only builds a failure REPORT, and a hostile value on the failure path must
 * never replace or interrupt the caller's real, already-decided failure.
 *
 * @param link - The value to classify.
 * @param canAdvance - `false` once the walk bound ({@link MAX_CAUSE_CHAIN_WALK})
 *   forbids reading a further `.cause`; a `Core.M3LError` link then
 *   classifies as `"stop"` rather than reading `.cause` needlessly.
 */
function inspectCauseLink(link: unknown, canAdvance: boolean): LinkInspection {
  try {
    if (!(link instanceof Error)) {
      return { kind: "stop" };
    }
    if (!(link instanceof Core.M3LError)) {
      return { kind: "decide", code: errnoCodeOf(link) };
    }
    if (!canAdvance) {
      return { kind: "stop" };
    }
    return { kind: "advance", next: link.cause };
  } catch {
    // A hostile link — its instanceof check, Object.hasOwn, code read, or
    // cause read threw — leaves nothing further safe to read from it. Stop
    // the walk the same way a non-Error link would, rather than let a raw
    // throw escape this failure-reporting helper.
    return { kind: "stop" };
  }
}

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
 * only when a further link remains to inspect, and exactly ONCE per read.
 * A link that is not an `Error` at all (including the starting `cause`
 * itself) ends the walk with `undefined` — there is nothing further to read
 * `.cause` from. The tenth link's own `.cause` is never read, since there is
 * no eleventh link left to inspect with it.
 *
 * NOTHING this function reads from a link can escape as a raw throw —
 * `instanceof Error`, `instanceof Core.M3LError`, {@link errnoCodeOf}'s own
 * `Object.hasOwn`/`.code` read, and the `.cause` read are all classified by
 * {@link inspectCauseLink} inside one `try`/`catch` per link. A HOSTILE link
 * — a `code` getter that throws, or a Proxy whose `getPrototypeOf` or
 * `getOwnPropertyDescriptor` trap throws — ends the walk with `undefined`
 * the same as a throwing `.cause` getter or a non-`Error` link, because code
 * on this failure-reporting path must never itself throw (X8c review
 * finding, issue #1058 follow-up: this guarantee originally covered only
 * the `.cause` read, letting a hostile link elsewhere in the chain escape
 * as a raw throw).
 *
 * @param cause - Any caught value, typically an `M3LConsoleError` (or other
 *   `Core.M3LError`) that may wrap a real filesystem or driver failure.
 * @returns The first non-M3L link's own `code`, or `undefined` when `cause`
 *   is not an `Error`, every link up to the bound is a `Core.M3LError`, the
 *   first non-M3L link has no qualifying own `code`, or any link along the
 *   way cannot be safely inspected (a throwing `.cause`/`code` accessor or
 *   `instanceof` check).
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
    const inspection = inspectCauseLink(link, depth < MAX_CAUSE_CHAIN_WALK - 1);
    switch (inspection.kind) {
      case "stop":
        return undefined;
      case "decide":
        return inspection.code;
      case "advance":
        link = inspection.next;
        break;
    }
  }
  return undefined;
}
