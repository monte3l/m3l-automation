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
 * broken stream directory, it is Node's error rather than one composed here, and
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
 * - an append resolves once the write has reached the operating system's page
 *   cache, not once it has reached the platter: nothing here calls `fsync`.
 *   A machine that loses power immediately after a resolved append can come
 *   back up without that line. An owner that needs crash durability has to
 *   flush at its own artifact boundary; per-append `fsync` is deliberately
 *   not paid on a path a shipped consumer already writes on every decision.
 */

import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { appendFile, open } from "node:fs/promises";

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
 * Without it, anyone who can create a file in the stream directory can
 * redirect (or silently sink) the audit trail by planting the next segment
 * name as a symlink — the append would resolve it and write outside the
 * directory. With it, `open` fails `ELOOP` and the write is reported as the
 * loud failure it is. On a platform without the flag (Windows) the value
 * falls back to the plain `"a"` trio and this defence simply does not apply.
 *
 * `O_NOFOLLOW` covers a **symlink** at the final path component and nothing
 * else; a **hardlink** is a second directory entry for one inode, so `open`
 * succeeds and the flag never fires. That half is closed separately, by the
 * `nlink` check in {@link AppendOnlyWriter.append}.
 */
const APPEND_FLAGS: number =
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_WRONLY |
  (O_NOFOLLOW ?? 0);

/**
 * The permission mode a segment file is **created** with: owner read/write
 * only, matching the mode this repo already applies to a console session's
 * artifacts (`m3l-console-server/src/sessions/artifacts.ts`) for the same
 * class of data.
 *
 * The mode is applied by `open` on creation only, and the process umask can
 * only **remove** bits from it — never add one. A segment that already exists
 * keeps whatever mode it was created with, and a directory a caller has
 * loosened by hand is not tightened back here.
 */
const SEGMENT_FILE_MODE = 0o600;

/**
 * The number of directory entries a segment this writer owns may have.
 *
 * Exactly one. A freshly created segment has one name; a segment adopted on a
 * cold start was created by this same writer and has one too. More than one
 * means somebody else has linked the inode into a second place, which is the
 * hardlink variant of the redirection `O_NOFOLLOW` refuses for symlinks.
 */
const SEGMENT_EXPECTED_LINK_COUNT = 1;

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
 *
 * Both return an {@link M3LError}, not a bare `Error`: this writer's own
 * recovery path keys on `instanceof M3LError` to re-throw an already-typed
 * failure unchanged, so an owner satisfying the port with a plain `Error`
 * would silently fall out of it and have its error wrapped a second time.
 */
export interface AppendOnlyWriterErrors {
  /** The rendered line is larger than one atomic write may carry. */
  oversize(lineBytes: number, maxLineBytes: number): M3LError;
  /** The append itself failed (ELOOP, EACCES, ENOSPC, a planted link, ...). */
  appendFailed(cause: unknown): M3LError;
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
 * The `cause` chained under the owner's `appendFailed(...)` when a segment
 * path turns out to carry more than one directory entry.
 *
 * The kernel reports no failure for this — `open` on a hardlink succeeds —
 * so there is no Node error to chain and one has to be composed. It is a
 * plain `Error` rather than an {@link M3LError} on purpose: it occupies
 * exactly the slot Node's own `ELOOP`/`EACCES` errors occupy on this path, it
 * is never thrown (what is thrown is always the owner's typed error), and
 * minting a library error code here would put a domain this module does not
 * own into the shared catalog. It names the link count and nothing else —
 * never the segment path, which is caller input.
 */
function plantedLinkCause(linkCount: number): Error {
  return new Error(
    `append-only writer: segment has ${String(linkCount)} directory entries, ` +
      `expected ${String(SEGMENT_EXPECTED_LINK_COUNT)}`,
  );
}

/**
 * The append-only segmented writer's guts: the byte/age/date rotation
 * decision and one guarded `open`-`fstat`-`write`-`close` per entry, over the
 * stateless segment layer in `./append-only-segments.js`.
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
   *   `maxLineBytes` — well-formed, but larger than this writer can append in
   *   one atomic write — or its `errors.appendFailed(...)` when the append
   *   itself fails for any reason, including a segment path that has been
   *   replaced by a symlink or hardlinked into a second directory entry.
   *
   * @remarks Resolving means the line has reached the operating system's page
   *   cache, not the platter — see this module's header on `fsync`.
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
   * Refuses an entry that cannot possibly fit, **before** the owner's
   * renderer projects and serializes it.
   *
   * The ceiling in {@link AppendOnlyWriter.renderLine} is exact but is only
   * reached after a full walk of the caller's graph and a `JSON.stringify`
   * of it — up to a second of synchronous, event-loop-blocking work to refuse
   * one entry, and past the engine's maximum string length a raw
   * `RangeError` escapes outside the owner's documented vocabulary. One own
   * string value longer than `maxLineBytes` is enough to know the line cannot
   * fit: a UTF-8 encoding is never shorter than the string's UTF-16 length
   * (ASCII is one byte per unit, everything else more), so the comparison
   * needs no encoding pass at all.
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
  private rejectObviouslyOversize(entry: TEntry): void {
    if (typeof entry !== "object" || entry === null) {
      return;
    }
    for (const key of Object.keys(entry)) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      const value: unknown = descriptor?.value;
      if (typeof value === "string" && value.length > this.maxLineBytes) {
        throw this.errors.oversize(
          Buffer.byteLength(value, "utf8"),
          this.maxLineBytes,
        );
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
   * of (and outside) the append guard below, because a line too large to
   * write is not a filesystem failure and must not be reported as one.
   */
  private renderLine(entry: TEntry): string {
    this.rejectObviouslyOversize(entry);
    const line = `${this.renderEntry(entry)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > this.maxLineBytes) {
      throw this.errors.oversize(lineBytes, this.maxLineBytes);
    }
    return line;
  }

  /**
   * Resolves the target segment, rotating if needed, proves the file the
   * write will land in is one this writer owns, and appends `line` to it.
   *
   * The whole lifecycle — `open`, `fstat`, `write`, `close` — sits under one
   * guard, so a failure at any step is reported in the owner's vocabulary
   * rather than leaking a raw Node error from the middle of it.
   *
   * The `nlink` check is what closes the hardlink half of segment
   * redirection. `O_NOFOLLOW` refuses a **symlink** at the final path
   * component, but a **hardlink** is simply a second name for one inode:
   * `open` succeeds, `stat` reports the target's real size, and the record
   * lands in a file somebody else owns with no error and no signal. Checking
   * that the file has exactly one directory entry refuses that.
   *
   * It is deliberately `fstat` on the handle the write then goes through,
   * never a path-based `stat`: a path check would prove something about
   * whatever the name resolved to at check time and leave a window for it to
   * be re-pointed before the write. There is no such window for a file
   * descriptor — it names the inode itself.
   *
   * What the check buys is narrow and worth stating: it refuses an **already
   * planted** link at a segment path. It cannot stop somebody hardlinking a
   * segment this writer has already created and is holding open, and it
   * cannot see a link created between two appends to the same cached segment
   * (each append opens afresh, so that one is caught on the next write, not
   * mid-write).
   */
  private async append(line: string): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      const current = await this.resolveActiveSegment();
      const segment = this.shouldRotate(current)
        ? await nextSegment(this.directory, current)
        : current;

      handle = await open(segment.path, APPEND_FLAGS, SEGMENT_FILE_MODE);
      const stats = await handle.stat();
      if (stats.nlink !== SEGMENT_EXPECTED_LINK_COUNT) {
        throw this.errors.appendFailed(plantedLinkCause(stats.nlink));
      }

      // O_APPEND: seeking to the end and writing are one atomic step from
      // the kernel's point of view on a local filesystem, so two writers
      // interleave whole lines rather than corrupting one another. This does
      // not hold across NFS, and does not cover a write() larger than the
      // pipe/write buffer — which is exactly why `renderLine`'s ceiling
      // check runs before any of this.
      //
      // `appendFile` is handed the HANDLE, not the path: the bytes must go
      // through the very descriptor `nlink` was proven on, or the proof is a
      // check-then-open race against whatever the name resolves to next.
      await appendFile(handle, line, { encoding: "utf8" });
      segment.size += Buffer.byteLength(line, "utf8");
      this.active = segment;
    } catch (cause) {
      // Drop the cached segment. `this.active` is assigned before an append
      // is known to have succeeded, and `mkdir` runs only on the
      // `this.active === undefined` branch of `resolveActiveSegment` — so a
      // stream directory removed under a long-lived writer would wedge every
      // later write on this instance for the rest of the process, while a
      // freshly constructed writer recreated it and carried on. Clearing it
      // makes the next write cold-start: mkdir, then re-discover.
      this.active = undefined;
      // Already typed — re-throw unchanged rather than double-wrapping. The
      // planted-link refusal above arrives here already built by the owner's
      // port, and takes this branch.
      if (cause instanceof M3LError) {
        throw cause;
      }
      // The owner's port builds an error carrying no `context`: everything
      // worth naming here is the directory path, which is caller input. The
      // chained `cause` is Node's own error and carries the operational
      // detail — see this module's header.
      throw this.errors.appendFailed(cause);
    } finally {
      // Best-effort: a failing close must not replace the real outcome above
      // — on the success path the bytes are already handed to the kernel, and
      // on the failure path the caller needs the original cause, not EBADF.
      try {
        await handle?.close();
      } catch {
        /* ignore — the append outcome above is what matters */
      }
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
