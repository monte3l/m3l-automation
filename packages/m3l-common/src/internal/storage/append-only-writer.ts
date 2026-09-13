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
 * Five limitations are accepted rather than fixed, in the same register as
 * the `O_APPEND`/NFS caveat on {@link AppendOnlyWriter.append} and the
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
 * - the seal is best-effort: a seal that cannot be written never fails the
 *   append it follows, because a seal is metadata about bytes already
 *   durably appended and failing the append would discard a new auditable
 *   record to protect a proof about an older one. It is reported through the
 *   owner's failure handler instead.
 * - the manifest grows O(segments) — roughly 200 bytes per sealed segment —
 *   and is not itself rotated. Nothing in this design prunes it.
 */

import type { FileHandle } from "node:fs/promises";
import { appendFile, open } from "node:fs/promises";

import { M3LError } from "../../core/errors/index.js";
import {
  APPEND_FLAGS,
  SEGMENT_EXPECTED_LINK_COUNT,
  SEGMENT_FILE_MODE,
} from "./append-only-fs.js";
import { renderLine } from "./append-only-line-ceiling.js";
import type { ActiveSegment } from "./append-only-segments.js";
import {
  currentDatePrefix,
  discoverActiveSegment,
  nextSegment,
  segmentFileName,
} from "./append-only-segments.js";
import type { AppendOnlyRotatedSegment } from "./append-only-sealer-types.js";
import type {
  AppendOnlyRenderEntry,
  AppendOnlySealPort,
  AppendOnlyWriterErrors,
  AppendOnlyWriterOptions,
} from "./append-only-writer-types.js";

/**
 * Re-exported so every existing importer of this module keeps working
 * unchanged — see `./append-only-writer-types.js` for the definitions and
 * their full TSDoc.
 */
export type {
  AppendOnlyRenderEntry,
  AppendOnlySealPort,
  AppendOnlyWriterErrors,
  AppendOnlyWriterOptions,
};

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
 * A directory-wide `manifest.jsonl` sidecar now exists alongside the
 * segments (written through the
 * {@link "./append-only-writer-types.js".AppendOnlySealPort}, by
 * {@link "./append-only-sealer.js".AppendOnlySealer}), so "no index file is
 * kept" no longer holds without qualification. What stays true: the manifest
 * is never consulted to decide where to append — a fresh instance still
 * re-derives the active segment from a directory listing plus one `stat`, so
 * a long-lived process and a freshly spawned one still agree; the manifest
 * carries no in-memory state across processes either; and the manifest is
 * not a segment, so it is invisible to segment discovery. Rotation only ever
 * seals the active segment (by simply no longer writing to it) and opens a
 * new one; it never prunes or truncates a segment in place.
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
  private readonly sealer: AppendOnlySealPort;
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
    this.sealer = options.sealer;
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
    const line = renderLine(
      entry,
      this.maxLineBytes,
      this.renderEntry,
      this.errors,
    );
    const appended = this.tail.then(async () => await this.append(line));
    // Chained onto `this.tail`, not the promise below: lands before the next
    // append but never delays this one — that latency/ordering guarantee
    // comes from THIS placement. A seal failure never reporting through
    // `errors.appendFailed` is a separate, independent guarantee, held by
    // `sealAfterAppend`'s own `try`/`catch` rather than by this placement —
    // see its TSDoc for both guards and the mutation evidence that they are
    // distinct.
    this.tail = appended.then(
      async (rotatedFrom) => {
        await this.sealAfterAppend(rotatedFrom);
      },
      () => undefined,
    );
    await appended;
  }

  /**
   * Drains the append chain as it stands at the moment of the call: a single
   * point-in-time wait on `this.tail`, not a loop that re-reads it until it
   * stops changing.
   *
   * **Guarantees:** every `write()` call, and every manifest seal via
   * {@link "./append-only-sealer.js".AppendOnlySealer}, that was already
   * in flight when `flush()` was called has settled by the time it resolves.
   *
   * **Does not guarantee:** anything about a `write()` started concurrently
   * with, or after, this call — those are not covered, and this is a
   * point-in-time drain, not a barrier or a close. A caller who reads it as
   * "the writer is now idle forever" is wrong.
   *
   * **Never rejects.** `this.tail` always settles fulfilled by construction:
   * a rejected append is reported to its own caller only, and a seal failure
   * is swallowed by `sealAfterAppend`'s own guard. `flush()` therefore
   * reports nothing and is not an error channel — a caller wanting append
   * failures gets them from `write()`, and a caller wanting seal failures
   * supplies the owner's own failure handler. Do not "improve" this into
   * rethrowing something.
   *
   * **What it is for:** making the directory safe to remove, archive, or
   * measure — it closes the window where an in-flight seal recreates
   * `manifest.jsonl` partway through a recursive remove, which otherwise
   * surfaces as `ENOTEMPTY`.
   *
   * **Never required for correctness of the trail itself.** A process that
   * exits without calling this loses at most one seal, and that is exactly
   * what {@link "./append-only-sealer.js".AppendOnlySealer}'s cold-start
   * sweep recovers on the next writer instance.
   */
  async flush(): Promise<void> {
    await this.tail;
  }

  /**
   * Resolves the target segment, rotating if needed, proves the file the
   * write will land in is one this writer owns, and appends `line` to it.
   *
   * Returns the segment this append rotated away from — its on-disk name,
   * rendered by {@link "./append-only-segments.js".segmentFileName}, the
   * single renderer of a segment's name, never string-concatenated or taken
   * as a path basename, paired with this writer's own believed byte count
   * for it (`current.size`, untouched by this append since the bytes just
   * written land on the NEW segment) — or `undefined` when it did not
   * rotate, and only on the path where the append actually succeeded;
   * `write()` threads it to `sealAfterAppend`. The byte count travels with
   * the name because the sealer re-measures the segment at seal time and
   * defers rather than seals when the two disagree — see
   * {@link "./append-only-sealer-types.js".AppendOnlyRotatedSegment} for why.
   *
   * The whole lifecycle — `open`, `fstat`, `write`, `close` — sits under one
   * guard, so a failure at any step is reported in the owner's vocabulary
   * rather than leaking a raw Node error from the middle of it.
   *
   * The flags the segment is opened under, the mode a new one is created
   * with, and the link count proven below all live in `./append-only-fs.js`
   * ({@link "./append-only-fs.js".APPEND_FLAGS},
   * {@link "./append-only-fs.js".SEGMENT_FILE_MODE},
   * {@link "./append-only-fs.js".SEGMENT_EXPECTED_LINK_COUNT}), shared with
   * the reader rather than duplicated per consumer; each carries the reason
   * it exists.
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
  private async append(
    line: string,
  ): Promise<AppendOnlyRotatedSegment | undefined> {
    let handle: FileHandle | undefined;
    try {
      const current = await this.resolveActiveSegment();
      const rotated = this.shouldRotate(current);
      const segment = rotated
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
      return rotated
        ? {
            name: segmentFileName(current.datePrefix, current.sequence),
            byteLength: current.size,
          }
        : undefined;
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
   * Calls the sealer's port for the append that just landed, swallowing
   * everything it throws or rejects with. Four properties matter here:
   *
   * 1. **Not inside the promise `write()` awaits.** `write()` resolves once
   *    the entry is durable; this runs on `this.tail` instead, landing before
   *    the next append but never delaying this one. A seal is metadata about
   *    bytes already durably appended, so waiting on up to eight bounded
   *    segment reads on the first write would invert the design — and a
   *    process exiting before a seal runs is exactly what
   *    {@link "./append-only-sealer.js".AppendOnlySealer}'s cold-start sweep
   *    recovers.
   * 2. **Being a link in `this.tail` is what makes `this.active` trustworthy
   *    here.** The next append cannot start until this method finishes, so
   *    `this.active` cannot move under the sealer between append and seal —
   *    which is why reading it below, at seal time, is safe.
   * 3. **This method's own `try`/`catch` — not where it is called from — is
   *    what keeps a seal failure from ever being reported as an append
   *    failure through `errors.appendFailed`, and what keeps `this.tail`
   *    settling fulfilled so a later append is not poisoned.** It is defence
   *    in depth, not redundant with the sealer's documented never-rejects
   *    guarantee: the chain invariant belongs to THIS module, and this module
   *    must not depend on another module keeping its promise.
   * 4. **Called from outside `append()`'s own `try`/`finally`, on
   *    `this.tail` rather than inside the promise `write()` awaits.** This
   *    placement is what property 1 above actually depends on — the latency
   *    and ordering guarantee — and it is also what keeps `append()`'s own
   *    documented contract intact, namely that everything inside its guard is
   *    a filesystem failure reportable as `errors.appendFailed`. It is a
   *    **separate** guard from property 3: removing it would still leave a
   *    seal failure unreportable as an append failure (property 3 does not
   *    depend on call site), but `write()` would then wait on the seal before
   *    resolving.
   *
   * Properties 3 and 4 are independent, each holding a different guarantee —
   * shown by mutating this call site two ways. Moving this wrapper's own call
   * to inside `append()`'s `try` broke only the resolve-early test (property
   * 4); the `appendFailed`-routing test (property 3) stayed green, because
   * this method's own `catch` still swallowed the failure regardless of where
   * it was called from. Only inlining the raw `this.sealer.sealAfterAppend`
   * call inside `append()`'s `try` — bypassing this method's `catch` —
   * additionally broke the routing test. Do not remove either guard on the
   * strength of the other still being present.
   *
   * The guard below type-narrows `this.active`, optional on the class — it
   * proves this is set before its fields are read. Unreachable via this
   * file's wiring: a failed append rejects `appended`, whose rejection arm
   * skips this method, so it runs only once an append has assigned
   * `this.active`. Kept as defence in depth against a future change to
   * `write()`'s chaining, not a case to expect today.
   */
  private async sealAfterAppend(
    rotatedFrom: AppendOnlyRotatedSegment | undefined,
  ): Promise<void> {
    if (this.active === undefined) {
      return;
    }
    const active = segmentFileName(
      this.active.datePrefix,
      this.active.sequence,
    );
    try {
      await this.sealer.sealAfterAppend({ rotatedFrom, active });
    } catch {
      // Defence in depth — see this method's TSDoc point 3. The sealer
      // documents that it never rejects; this module does not rely on that.
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
