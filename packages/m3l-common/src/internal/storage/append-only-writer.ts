/**
 * `internal/storage/append-only-writer` — the generic append-only segmented
 * JSONL writer (ADR-0061, V7 slice 2; generalized in X7 slice 2).
 *
 * Library-internal; never re-exported through a public barrel. This module
 * owns the rotation decision and the append itself, over the stateless
 * segment layer in `./append-only-segments.js`. It is deliberately blind to
 * what an entry *is*: an owner supplies a {@link AppendOnlyRenderEntry} that
 * turns one entry into the JSON text of its line, and an
 * {@link AppendOnlyWriterErrors} port that names the two failures in the
 * owner's own error vocabulary. Everything domain-specific — an entry's
 * structural proof, its detached projection, the options boundary — stays
 * with the owner, so a second audit artifact reuses this security-critical
 * append path instead of forking a second copy of it.
 *
 * No error message, and no `context` built here, ever carries a value read
 * out of the caller's input: that is the owner's port's contract, and this
 * module supplies it only byte counts and a chained `cause`. A directory path
 * can carry tenant or customer identifiers, and an entry carries payload. The
 * one path by which a caller-supplied string can still be reached from an
 * error raised here is a **chained filesystem `cause`** — Node's own
 * `ENOENT`/`EACCES`/`ELOOP` errors quote the path they failed on. That cause
 * is deliberately kept: it is the only diagnostic an operator has for a
 * broken log directory, it is Node's error rather than one composed here, and
 * it is reached only by code that walks `error.cause` explicitly.
 *
 * Two limitations are accepted rather than fixed, in the same register as the
 * `O_APPEND`/NFS caveat on {@link AppendOnlyWriter.append} and the
 * `birthtimeMs` one in `./append-only-segments.js`:
 *
 * - a `maxSegmentBytes` below `maxLineBytes` yields one entry per segment —
 *   every write finds the ceiling already crossed and rotates. That is left
 *   legal on purpose: rotation has to stay testable at sizes a test can reach
 *   in a handful of writes, and a floor tied to the line ceiling would forbid
 *   exactly those. The behaviour is correct, just wasteful, and never loses
 *   or truncates a record.
 * - `createdAtMs` on a freshly opened segment is read from the wall clock, so
 *   a clock that steps **forward** and then back can leave a segment stamped
 *   in the future, making `maxSegmentAgeMs` unreachable for it. The size
 *   ceiling and the UTC-date rollover both still bound that segment, so it
 *   cannot grow without limit or outlive its day.
 */

import { constants } from "node:fs";
import { appendFile } from "node:fs/promises";

import { M3LError } from "../../core/errors/index.js";
import type { ActiveSegment } from "./append-only-segments.js";
import {
  currentDatePrefix,
  discoverActiveSegment,
  nextSegment,
} from "./append-only-segments.js";

/**
 * `O_NOFOLLOW` where the platform has it. Typed `number | undefined` rather
 * than trusting `@types/node`'s unconditional `number`: the flag is POSIX-only
 * and Node genuinely reports it as `undefined` on Windows, where a numeric
 * `NaN` flag would make every append fail.
 */
const O_NOFOLLOW: number | undefined = constants.O_NOFOLLOW;

/**
 * The open flags for one append: the three the `"a"` shorthand stands for —
 * append, create, write-only — plus `O_NOFOLLOW`, so a segment path that has
 * been replaced by a symlink is **refused** rather than followed.
 *
 * Without it, anyone who can create a file in the log directory can redirect
 * (or silently sink) the audit trail by planting the next segment name as a
 * symlink — the append would resolve it and write outside the directory. With
 * it, `open` fails `ELOOP` and the write is reported as the loud failure it
 * is. On a platform without the flag (Windows) the value falls back to the
 * plain `"a"` trio and this defence simply does not apply.
 */
const APPEND_FLAGS: number =
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_WRONLY |
  (O_NOFOLLOW ?? 0);

/**
 * How a writer turns one entry into the JSON text of its line.
 *
 * The text carries **no** trailing newline: {@link AppendOnlyWriter} appends
 * it, so the line ceiling is measured over exactly the bytes one atomic
 * `write()` must carry. A renderer is also where an owner's structural proof
 * and detached projection belong — it runs before any filesystem call, so an
 * entry it rejects leaves nothing behind.
 */
export type AppendOnlyRenderEntry<TEntry> = (entry: TEntry) => string;

/**
 * The two failure vocabularies a writer must raise in its owner's terms.
 *
 * Each method builds — and does not throw — the error the owner's public
 * surface documents, so this module never has to name a domain it does not
 * know. Neither may carry a value read out of the caller's input; the byte
 * counts and the chained `cause` handed in here are all the detail there is.
 */
export interface AppendOnlyWriterErrors {
  /** The rendered line is larger than one atomic write may carry. */
  oversize(lineBytes: number, maxLineBytes: number): Error;
  /** The append itself failed (ELOOP, EACCES, ENOSPC, ...). */
  appendFailed(cause: unknown): Error;
}

/** The fully resolved settings one {@link AppendOnlyWriter} runs under. */
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
  /** The owner's error vocabulary for the two failures this writer raises. */
  readonly errors: AppendOnlyWriterErrors;
}

/**
 * The append-only segmented writer's guts: the byte/age/date rotation
 * decision and one `appendFile` call per entry, over the stateless segment
 * layer in `./append-only-segments.js`.
 *
 * No index file is kept and no state is carried across processes — a fresh
 * instance always re-derives the active segment from a directory listing
 * plus one `stat`, so a long-lived process and a freshly spawned one agree.
 * Rotation only ever seals the active segment (by simply no longer writing
 * to it) and opens a new one; it never prunes or truncates a segment in
 * place.
 *
 * Concurrent `write()` calls on one instance are serialized onto a tail
 * promise: each append awaits the previous one's completion. Without that,
 * two in-flight calls each resolve the active segment independently and each
 * add only their own line to `size`, so the last assignment wins and
 * byte-ceiling rotation fires a whole batch late.
 */
export class AppendOnlyWriter<TEntry> {
  private readonly directory: string;
  private readonly maxSegmentBytes: number;
  private readonly maxSegmentAgeMs: number;
  private readonly maxLineBytes: number;
  private readonly renderEntry: AppendOnlyRenderEntry<TEntry>;
  private readonly errors: AppendOnlyWriterErrors;
  private active: ActiveSegment | undefined;
  /**
   * The tail of the serialized append chain. Always settles fulfilled — a
   * rejected append is reported to its own caller only, and must not poison
   * the chain for every subsequent one.
   */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: AppendOnlyWriterOptions<TEntry>) {
    this.directory = options.directory;
    this.maxSegmentBytes = options.maxSegmentBytes;
    this.maxSegmentAgeMs = options.maxSegmentAgeMs;
    this.maxLineBytes = options.maxLineBytes;
    this.renderEntry = options.renderEntry;
    this.errors = options.errors;
  }

  /**
   * Appends one entry as a single JSON line, rotating the active segment
   * first when any ceiling is already crossed. Renders and measures the line
   * before touching the filesystem at all, so a rejected entry leaves nothing
   * behind.
   *
   * @throws Whatever the owner's {@link AppendOnlyRenderEntry} throws for an
   *   entry it refuses — a caller-side violation, raised before any
   *   filesystem call.
   * @throws The owner's `errors.oversize(...)` when the rendered line exceeds
   *   `maxLineBytes` — well-formed, but larger than this writer can durably
   *   append in one atomic write — or its `errors.appendFailed(...)` when the
   *   append itself fails for any reason, including a segment path that has
   *   been replaced by a symlink.
   */
  async write(entry: TEntry): Promise<void> {
    const line = this.renderLine(entry);
    const appended = this.tail.then(async () => {
      await this.append(line);
    });
    // Swallow only for the chain's own bookkeeping: `appended` is awaited
    // below, so the rejection is still reported to this caller.
    this.tail = appended.then(
      () => undefined,
      () => undefined,
    );
    await appended;
  }

  /**
   * Renders the exact line the filesystem will receive and proves it fits in
   * one atomic write.
   *
   * The ceiling governs the LINE, not the serialization alone: the newline is
   * part of what one `write()` must carry atomically, so an entry serializing
   * to exactly the ceiling is one byte too large. The check runs here, ahead
   * of (and outside) the append guard below, because a line too large to
   * write is not a filesystem failure and must not be reported as one.
   */
  private renderLine(entry: TEntry): string {
    const line = `${this.renderEntry(entry)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > this.maxLineBytes) {
      throw this.errors.oversize(lineBytes, this.maxLineBytes);
    }
    return line;
  }

  /** Resolves the target segment, rotating if needed, and appends `line`. */
  private async append(line: string): Promise<void> {
    try {
      const current = await this.resolveActiveSegment();
      const segment = this.shouldRotate(current)
        ? await nextSegment(this.directory, current)
        : current;

      // O_APPEND: seeking to the end and writing are one atomic step from
      // the kernel's point of view on a local filesystem, so two writers
      // interleave whole lines rather than corrupting one another. This does
      // not hold across NFS, and does not cover a write() larger than the
      // pipe/write buffer — which is exactly why `renderLine`'s ceiling
      // check runs before any of this.
      await appendFile(segment.path, line, {
        encoding: "utf8",
        flag: APPEND_FLAGS,
      });
      segment.size += Buffer.byteLength(line, "utf8");
      this.active = segment;
    } catch (cause) {
      // Drop the cached segment. `this.active` is assigned before an append
      // is known to have succeeded, and `mkdir` runs only on the
      // `this.active === undefined` branch of `resolveActiveSegment` — so a
      // log directory removed under a long-lived writer would wedge every
      // later write on this instance for the rest of the process, while a
      // freshly constructed writer recreated it and carried on. Clearing it
      // makes the next write cold-start: mkdir, then re-discover.
      this.active = undefined;
      // Already typed — re-throw unchanged rather than double-wrapping.
      if (cause instanceof M3LError) {
        throw cause;
      }
      // The owner's port builds an error carrying no `context`: everything
      // worth naming here is the directory path, which is caller input. The
      // chained `cause` is Node's own error and carries the operational
      // detail — see this module's header.
      throw this.errors.appendFailed(cause);
    }
  }

  /**
   * Whether `segment` has already crossed any rotation ceiling: its size, its
   * age, or the UTC date it is stamped with.
   *
   * The date check is what makes the module's "a freshly spawned process and
   * a long-lived one always agree" guarantee true. Cold-start discovery only
   * ever considers candidates carrying today's prefix, so without this a
   * long-lived process crossing midnight under both other ceilings would
   * keep appending to yesterday's segment while a process spawned one second
   * later opened today's.
   */
  private shouldRotate(segment: ActiveSegment): boolean {
    return (
      segment.datePrefix !== currentDatePrefix() ||
      segment.size >= this.maxSegmentBytes ||
      Date.now() - segment.createdAtMs >= this.maxSegmentAgeMs
    );
  }

  /**
   * Returns the writer's in-memory active segment, discovering it from the
   * directory (cold-start) on this instance's first call — including creating
   * the directory. Every later call on this instance reuses the cached
   * record, until an append fails and clears it.
   */
  private async resolveActiveSegment(): Promise<ActiveSegment> {
    if (this.active === undefined) {
      this.active = await discoverActiveSegment(this.directory);
    }
    return this.active;
  }
}
