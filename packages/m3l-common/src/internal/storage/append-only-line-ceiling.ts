/**
 * `internal/storage/append-only-line-ceiling` — the pre-filesystem
 * LINE-CEILING checks, split apart from `./append-only-writer.js`'s I/O
 * purely for size against ADR-0072's per-file ratchet.
 *
 * Library-internal; never re-exported through a public barrel. Both exports
 * here run entirely over already-resolved values — the entry, the configured
 * `maxLineBytes`, and the owner's {@link AppendOnlyRenderEntry} and
 * {@link AppendOnlyWriterErrors} ports — before
 * {@link "./append-only-writer.js".AppendOnlyWriter} ever touches the
 * filesystem: a rejected entry must leave nothing behind and must never
 * enter the writer's serialized append chain.
 *
 * @packageDocumentation
 */

import type {
  AppendOnlyRenderEntry,
  AppendOnlyWriterErrors,
} from "./append-only-writer-types.js";

/**
 * Refuses an entry that cannot possibly fit, **before** the owner's
 * renderer projects and serializes it.
 *
 * The ceiling in {@link renderLine} is exact but is only reached after a
 * full walk of the caller's graph and a `JSON.stringify` of it — up to a
 * second of synchronous, event-loop-blocking work to refuse one entry, and
 * past the engine's maximum string length a raw `RangeError` escapes
 * outside the owner's documented vocabulary. One own string value longer
 * than `maxLineBytes` is enough to know the line cannot fit: a UTF-8
 * encoding is never shorter than the string's UTF-16 length (ASCII is one
 * byte per unit, everything else more), so the comparison needs no encoding
 * pass at all.
 *
 * Only own **data** properties at the top level are read. An accessor is
 * left uninvoked on purpose — the projection in the owner's renderer is
 * where the caller's graph is read, and reading it twice would run a
 * getter's side effects twice. The check is therefore an early-out, never
 * the ceiling itself: everything it does not catch is caught exactly by
 * `renderLine`.
 *
 * The byte count handed to `errors.oversize` is the offending value's own
 * encoded size — a strict lower bound on the line it would have produced,
 * which also carries that value's JSON escaping, its key, and every sibling
 * field. Reporting the exact figure would need the serialization this check
 * exists to avoid, and it is already over the ceiling either way.
 */
function rejectObviouslyOversize<TEntry>(
  entry: TEntry,
  maxLineBytes: number,
  errors: AppendOnlyWriterErrors,
): void {
  if (typeof entry !== "object" || entry === null) {
    return;
  }
  for (const key of Object.keys(entry)) {
    const descriptor = Object.getOwnPropertyDescriptor(entry, key);
    const value: unknown = descriptor?.value;
    if (typeof value === "string" && value.length > maxLineBytes) {
      throw errors.oversize(Buffer.byteLength(value, "utf8"), maxLineBytes);
    }
  }
}

/**
 * Renders the exact line the filesystem will receive and proves it fits in
 * one atomic write.
 *
 * The ceiling governs the LINE, not the serialization alone: the newline is
 * part of what one `write()` must carry atomically, so an entry serializing
 * to exactly the ceiling is one byte too large. The check runs here, ahead
 * of (and outside) the append guard in
 * {@link "./append-only-writer.js".AppendOnlyWriter}'s own `append()`,
 * because a line too large to write is not a filesystem failure and must
 * not be reported as one.
 */
export function renderLine<TEntry>(
  entry: TEntry,
  maxLineBytes: number,
  renderEntry: AppendOnlyRenderEntry<TEntry>,
  errors: AppendOnlyWriterErrors,
): string {
  rejectObviouslyOversize(entry, maxLineBytes, errors);
  const line = `${renderEntry(entry)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > maxLineBytes) {
    throw errors.oversize(lineBytes, maxLineBytes);
  }
  return line;
}
