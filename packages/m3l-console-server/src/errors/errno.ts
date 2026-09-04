/**
 * `errors/errno` — extracts a Node filesystem failure's `errno` code, so
 * every zone can decide what to tolerate (e.g. `ENOENT`) without honouring
 * a forgeable inherited property.
 *
 * @packageDocumentation
 */

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
