/**
 * `internal/storage/append-only-writer-types` — the writer's VOCABULARY: what
 * an owner supplies ({@link AppendOnlyWriterOptions}), how it renders an
 * entry ({@link AppendOnlyRenderEntry}), and its own failure port
 * ({@link AppendOnlyWriterErrors}) and seal port ({@link AppendOnlySealPort}),
 * stated apart from `./append-only-writer.js`'s machinery that acts on them.
 * Split out purely for size against ADR-0072's per-file ratchet — see
 * `./append-only-sealer-types.js` for the same split applied to the sealer.
 *
 * Library-internal; never re-exported through a public barrel.
 *
 * @packageDocumentation
 */

import type { M3LError } from "../../core/errors/index.js";
import type { AppendOnlySealRequest } from "./append-only-sealer-types.js";

/**
 * How a writer turns one entry into the JSON text of its line.
 *
 * The text carries **no** trailing newline:
 * {@link "./append-only-writer.js".AppendOnlyWriter} appends it, so the line
 * ceiling is measured over exactly the bytes one atomic `write()` must
 * carry. A renderer is also where an owner's structural proof and detached
 * projection belong — it runs before any filesystem call, so an entry it
 * rejects leaves nothing behind.
 */
export type AppendOnlyRenderEntry<TEntry> = (entry: TEntry) => string;

/**
 * The two failure vocabularies a writer must raise in its owner's terms.
 *
 * Each method builds — and does not throw — the error the owner's public
 * surface documents, so the writer never has to name a domain it does not
 * know. Neither may carry a value read out of the caller's input; the byte
 * counts and the chained `cause` handed in here are all the detail there is.
 *
 * Both return an {@link M3LError}, not a bare `Error`:
 * {@link "./append-only-writer.js".AppendOnlyWriter}'s own recovery path
 * keys on `instanceof M3LError` to re-throw an already-typed failure
 * unchanged, so an owner satisfying the port with a plain `Error` would
 * silently fall out of it and have its error wrapped a second time.
 */
export interface AppendOnlyWriterErrors {
  /** The rendered line is larger than one atomic write may carry. */
  oversize(lineBytes: number, maxLineBytes: number): M3LError;
  /** The append itself failed (ELOOP, EACCES, ENOSPC, a planted link, ...). */
  appendFailed(cause: unknown): M3LError;
}

/**
 * The seal side of an {@link "./append-only-writer.js".AppendOnlyWriter},
 * taken as a port rather than the writer constructing an `AppendOnlySealer`
 * itself.
 *
 * A port keeps the writer blind to the manifest's own vocabulary —
 * constructing a sealer in the writer would mean carrying
 * `maxManifestBytes`, the owner's error builder, its failure handler, and
 * two retry bounds through options the writer has no use for. And
 * {@link "./append-only-sealer.js".AppendOnlySealer} holds its state in
 * `#private` fields, so it is not structurally fakeable — without a port
 * there is no seam at which a test can prove a sealer that THROWS still
 * leaves the append it followed resolved, which is the point of the whole
 * design (see
 * {@link "./append-only-writer.js".AppendOnlyWriter.sealAfterAppend}).
 */
export interface AppendOnlySealPort {
  /** Same signature as {@link "./append-only-sealer.js".AppendOnlySealer.sealAfterAppend}; never rejects. */
  sealAfterAppend(request: AppendOnlySealRequest): Promise<void>;
}

/**
 * The fully resolved settings one
 * {@link "./append-only-writer.js".AppendOnlyWriter} runs under.
 */
export interface AppendOnlyWriterOptions<TEntry> {
  /** The directory the segments live in; created on a cold start. */
  readonly directory: string;
  /** Rotate once the active segment has reached this many bytes. */
  readonly maxSegmentBytes: number;
  /** Rotate once the active segment has been open this many milliseconds. */
  readonly maxSegmentAgeMs: number;
  /** The largest line, newline included, one append may carry. */
  readonly maxLineBytes: number;
  /** Turns one entry into its JSON text, without a trailing newline. */
  readonly renderEntry: AppendOnlyRenderEntry<TEntry>;
  /** The owner's error vocabulary for the two failures the writer raises. */
  readonly errors: AppendOnlyWriterErrors;
  /**
   * Seals the segment the writer just rotated away from. **Required, not
   * optional** — exactly two owners construct the writer and both must
   * seal. Making it optional would let a third be added without ever
   * confronting that question, and a missing sealer would show up as nothing
   * at all: the writer's failure channel is quiet by design (a seal failure
   * is swallowed — see
   * {@link "./append-only-writer.js".AppendOnlyWriter.sealAfterAppend}). See
   * {@link AppendOnlySealPort} for why this is a port rather than a concrete
   * sealer built directly into the writer.
   */
  readonly sealer: AppendOnlySealPort;
}
