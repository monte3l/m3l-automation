/**
 * `internal/storage/append-only-render` — the append-only stream's entry
 * renderer, factored out of
 * `{@link "../../core/storage/M3LAppendOnlyStream.js".M3LAppendOnlyStream}`'s
 * file purely for size (ADR-0072's per-file ratchet). It is the counterpart
 * to `internal/agent/decision-log-writer.ts`'s `renderLogLine`: the same
 * "prove, project, then serialize" shape applied to the append-only stream's
 * own entry vocabulary instead of the decision log's.
 *
 * Library-internal; never re-exported through a public barrel.
 *
 * @packageDocumentation
 */

import { projectAppendOnlyEntry } from "./append-only-projection.js";
import { invalidArgument } from "./append-only-options.js";

/**
 * Proves `entry` structurally, rebuilds it as this library's own detached
 * copy, and renders the JSON text of the line the filesystem will receive.
 * The trailing newline is **not** added here: `AppendOnlyWriter` appends it,
 * so the line ceiling is measured over exactly the bytes one atomic write
 * must carry.
 *
 * What is serialized is **never the caller's object**. `JSON.stringify`
 * dispatches an inherited `toJSON`, and returns `undefined` — without
 * throwing — for one that yields `undefined`, so serializing the argument
 * directly would let a gadget on `Object.prototype` either forge the
 * persisted record or launder the text `undefined` into the stream as a line
 * no reader can parse. `projectAppendOnlyEntry` closes both by rebuilding
 * every node with a null prototype; see that module's header. The `typeof`
 * check below is the belt to that projection's braces — the projection is
 * provably serializable, so nothing should be able to make `stringify` yield
 * a non-string here, and if something does the line is never written.
 *
 * The validation and serialization run here, ahead of (and outside) the
 * writer's own append guard, because an entry that cannot be serialized is a
 * caller error, not a write failure: wrapping it in
 * {@link "../../core/storage/M3LAppendOnlyStreamError.js".M3LAppendOnlyStreamError}
 * would tell an operator the filesystem is unhealthy when the argument was.
 *
 * The parameter is `unknown` rather than
 * {@link "../../core/storage/M3LAppendOnlyStream.js".M3LAppendOnlyEntry}
 * because that is what it honestly is: `append` is a public method reached by
 * callers with no types at all, and this function's whole job is to prove the
 * shape at runtime rather than assume it. It is also what lets `append`
 * accept an `interface`-typed record, which carries no index signature.
 */
export function renderEntryLine(entry: unknown): string {
  const projection = projectAppendOnlyEntry(entry, invalidArgument);
  // Typed `unknown` on purpose: the declared return type is `string`, and the
  // whole point of this check is that a return type is not a runtime proof.
  const json: unknown = JSON.stringify(projection);
  /* v8 ignore next 3 -- unreachable: projectAppendOnlyEntry rebuilds every
     node with a null prototype (Object.create(null) for objects,
     Object.setPrototypeOf(…, null) for arrays) so an inherited toJSON gadget
     cannot rewrite the projected record, and it already rejects undefined,
     functions, and symbols — the only inputs that make JSON.stringify return
     undefined. The check is kept as the last line of defence if that
     projection contract ever regresses. */
  if (typeof json !== "string") {
    throw invalidArgument("entry", "not-json-serializable");
  }
  return json;
}
